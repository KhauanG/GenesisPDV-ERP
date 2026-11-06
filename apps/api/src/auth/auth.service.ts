import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  MENSAGEM_CREDENCIAIS_INVALIDAS,
  temAcessoErp,
  type Login,
  type MotivoFalhaLogin,
  type RespostaEu,
  type RespostaLogin,
  type TrocarSenha,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { ErroApi } from '../comum/erros.js';
import type { Configuracao } from '../config/configuracao.js';
import { historicoLogins, lojas, sessoesUsuario, usuarios } from '../database/empresa/schema/index.js';
import type { AssinadorJwt } from '../seguranca/jwt.js';
import { gerarHashSenha, verificarSenha } from '../seguranca/senhas.js';
import { gerarSegredo, sha256Hex } from '../seguranca/tokens.js';
import type { ContextoEmpresa } from '../tenancy/contexto.js';
import type { EmpresaResolvida, ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';

export interface MetaRequisicao {
  ip: string | null;
  userAgent: string | null;
  requisicaoId: string | null;
}

/**
 * Claims do token de acesso do ERP (ERP 4.1, 2.1): `emp` = código, `eid` = id da empresa, `perm_versao` =
 * `usuarios.permissoes_versao` na emissão. Informativo: o guard relê a versão no banco a cada requisição (a fonte da
 * verdade), então um token antigo nunca carrega permissões removidas.
 */
export interface ClaimsErp {
  sub: string;
  emp: number;
  eid: string;
  sid: string;
  perm_versao: number;
  master: boolean;
  tsp: boolean;
}

export interface ResultadoSessao {
  resposta: RespostaLogin;
  refreshToken: string;
  refreshExpiraEm: Date;
}

/** Sessão autenticada de uma requisição do ERP (montada pelo guard). */
export interface SessaoErp {
  usuarioId: string;
  usuarioNome: string;
  login: string;
  codigo: number;
  master: boolean;
  senhaProvisoria: boolean;
  sessaoId: string;
  permissoes: ReadonlySet<string>;
  lojas: readonly string[] | null;
  /** Estoques permitidos (decisão 149, `estoques/permitidos.ts`); `null` = todos (Master ou `estoques.todos`). */
  estoques: readonly string[] | null;
  /** `usuarios.limite_desconto_pct` (decimal em texto): teto do que este usuário pode conceder a outro. */
  limiteDescontoPct: string;
  empresa: ContextoEmpresa;
}

type LinhaUsuario = typeof usuarios.$inferSelect;

class FalhaLogin {
  constructor(readonly erro: ErroApi) {}
}

const formatarMinutos = (ate: Date) => Math.max(1, Math.ceil((ate.getTime() - Date.now()) / 60_000));

const erroBloqueado = (ate: Date) =>
  ErroApi.naoAutenticado(`Usuário bloqueado temporariamente. Tente em ${formatarMinutos(ate)} minutos.`);

/** Sessão ainda aberta da família (a sucessora da rotação), ou `null` se a família foi encerrada. */
export async function sessaoAbertaDaFamilia(db: DbEmpresa, familiaId: string) {
  const [aberta] = await db
    .select()
    .from(sessoesUsuario)
    .where(and(eq(sessoesUsuario.familiaId, familiaId), isNull(sessoesUsuario.encerradaEm)))
    .limit(1);
  return aberta ?? null;
}

export class AuthService {
  constructor(
    private readonly config: Configuracao,
    private readonly tenancy: Tenancy,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly auditoria: AuditoriaService,
    private readonly permissoes: PermissoesEfetivas,
    private readonly jwt: AssinadorJwt,
  ) {}

  async login(entrada: Login, meta: MetaRequisicao): Promise<ResultadoSessao> {
    const empresa = await this.resolvedor.porCodigo(entrada.codigoEmpresa);
    if (!empresa || empresa.excluida) {
      await verificarSenha(null, entrada.senha);
      throw ErroApi.naoAutenticado(MENSAGEM_CREDENCIAIS_INVALIDAS);
    }
    this.resolvedor.verificarAcessoErp(empresa, 'antes_credenciais');
    if (empresa.status === 'provisionando') this.resolvedor.verificarAcessoErp(empresa, 'depois_credenciais');
    const contexto = this.resolvedor.contexto(empresa);

    return this.tenancy.executarNaEmpresa(contexto, async () => {
      const cx = this.tenancy.cx();
      // A verificação argon2 (CPU) fica fora da transação: a trava de versão (MD 1.5) não pode esperar por ela.
      const [lido] = await cx.consulta((db) =>
        db
          .select()
          .from(usuarios)
          .where(and(sql`lower(${usuarios.login}) = ${entrada.login}`, isNull(usuarios.excluidoEm))),
      );
      const bloqueadoLido = lido?.bloqueadoAte && lido.bloqueadoAte > new Date() ? lido.bloqueadoAte : null;
      const senhaOk = !bloqueadoLido && (await verificarSenha(lido?.senhaHash, entrada.senha));

      const resultado = await cx.transacao(
        async (tx) => {
          const origemBase: OrigemAcao = {
            origem: 'erp',
            ip: meta.ip,
            userAgent: meta.userAgent,
            requisicaoId: meta.requisicaoId,
          };
          const [u] = lido
            ? await tx.select().from(usuarios).where(eq(usuarios.id, lido.id)).for('update')
            : [];

          const negar = async (motivo: MotivoFalhaLogin, erro: ErroApi, usuario?: LinhaUsuario) => {
            await this.registrarTentativa(tx, entrada.login, usuario?.id ?? null, false, motivo, meta);
            await this.auditoria.registrar(
              tx,
              { ...origemBase, usuarioId: usuario?.id ?? null, usuarioNome: usuario?.nome ?? null },
              {
                acao: 'login_negado',
                entidade: 'login',
                registroId: usuario?.id ?? null,
                localizacao: 'Login ERP',
                descricao: `Login negado para "${entrada.login}": ${motivo}`,
              },
            );
            return new FalhaLogin(erro);
          };
          const invalido = ErroApi.naoAutenticado(MENSAGEM_CREDENCIAIS_INVALIDAS);

          if (!u) return negar('senha_invalida', invalido);
          // Vale a linha travada: tentativas em paralelo que chegam depois do bloqueio são recusadas mesmo com a
          // senha certa.
          const bloqueadoAte =
            bloqueadoLido ?? (u.bloqueadoAte && u.bloqueadoAte > new Date() ? u.bloqueadoAte : null);
          if (bloqueadoAte) return negar('bloqueado', erroBloqueado(bloqueadoAte), u);
          if (!senhaOk || u.senhaHash !== lido!.senhaHash) {
            await this.registrarFalhaSenha(tx, u.id, u.nome, meta);
            return negar('senha_invalida', invalido, u);
          }
          if (!u.ativo || u.totem) return negar('usuario_inativo', invalido, u);
          if (u.demissao && u.demissao <= new Date().toISOString().slice(0, 10))
            return negar('demitido', invalido, u);

          // Só depois de credenciais válidas a empresa suspensa é informada (ERP 4.1).
          try {
            this.resolvedor.verificarAcessoErp(empresa, 'depois_credenciais');
          } catch (e) {
            return negar('empresa_suspensa', e as ErroApi, u);
          }

          const acesso = await this.permissoes.obter(tx, empresa.id, u);
          if (!u.master && !temAcessoErp(acesso.permissoes)) {
            return negar('usuario_inativo', ErroApi.semPermissao('Seu usuário não tem acesso ao ERP.'), u);
          }

          await tx
            .update(usuarios)
            .set({ tentativasFalhas: 0, bloqueadoAte: null, ultimoLoginEm: new Date() })
            .where(eq(usuarios.id, u.id));
          const sessao = await this.criarSessao(tx, u.id, uuidv7(), null, meta);
          await this.registrarTentativa(tx, entrada.login, u.id, true, null, meta);
          await this.auditoria.registrar(
            tx,
            { ...origemBase, usuarioId: u.id, usuarioNome: u.nome },
            {
              acao: 'login',
              entidade: 'login',
              registroId: u.id,
              localizacao: 'Login ERP',
              descricao: 'Login no ERP',
            },
          );
          return { usuario: u, ...sessao };
        },
        // Só quem pode gravar `usuarios` (tabela sincronizável) pega a trava de versão da empresa (MD 1.5): login de
        // usuário inexistente ou já bloqueado grava só os logs (`historico_logins`, `auditoria`).
        { travaVersao: !!lido && !bloqueadoLido },
      );

      if (resultado instanceof FalhaLogin) throw resultado.erro;
      return this.montarResultado(
        empresa,
        resultado.usuario,
        resultado.sessaoId,
        resultado.refreshToken,
        resultado.expiraEm,
      );
    });
  }

  async refresh(refreshToken: string | undefined, meta: MetaRequisicao): Promise<ResultadoSessao> {
    const { empresa, segredo } = await this.empresaDoRefresh(refreshToken);
    const hash = sha256Hex(segredo);
    const contexto = this.resolvedor.contexto(empresa);
    const r = await this.tenancy.executarNaEmpresa(contexto, () =>
      this.tenancy.cx().transacao(async (tx) => {
        const [s] = await tx
          .select()
          .from(sessoesUsuario)
          .where(eq(sessoesUsuario.refreshTokenHash, hash))
          .for('update');
        if (!s) return new FalhaLogin(ErroApi.naoAutenticado());
        if (s.encerradaEm) {
          if (s.motivoEncerramento === 'rotacionada') {
            // O mesmo cookie em requisições simultâneas (aba dupla, repetição após timeout) não é roubo: dentro
            // da janela de tolerância, com a sucessora ainda aberta, recusa sem derrubar a família.
            const tolerancia = this.config.sessao.toleranciaRefreshSegundos * 1000;
            if (
              Date.now() - s.encerradaEm.getTime() <= tolerancia &&
              (await sessaoAbertaDaFamilia(tx, s.familiaId))
            ) {
              return new FalhaLogin(ErroApi.refreshConcorrente());
            }
            // Refresh já usado reapareceu: possível roubo. Derruba todas as sessões do usuário (ERP 4.1).
            await tx
              .update(sessoesUsuario)
              .set({ encerradaEm: new Date(), motivoEncerramento: 'reuso_detectado' })
              .where(and(eq(sessoesUsuario.usuarioId, s.usuarioId), isNull(sessoesUsuario.encerradaEm)));
            await this.auditoria.registrar(
              tx,
              {
                origem: 'sistema',
                usuarioId: s.usuarioId,
                ip: meta.ip,
                userAgent: meta.userAgent,
                requisicaoId: meta.requisicaoId,
              },
              {
                acao: 'logout',
                entidade: 'sessoes_usuario',
                registroId: s.id,
                localizacao: 'Login ERP',
                descricao: 'Reuso de refresh token detectado: todas as sessões do usuário foram encerradas',
              },
            );
          }
          return new FalhaLogin(ErroApi.naoAutenticado());
        }
        // `ultimo_uso_em` = última requisição autenticada real (o guard grava); o refresh agendado não conta.
        const ultimoUso = s.ultimoUsoEm ?? s.criadoEm;
        const inativa = Date.now() - ultimoUso.getTime() > this.config.sessao.inatividadeMinutos * 60_000;
        if (s.expiraEm <= new Date() || inativa) {
          await tx
            .update(sessoesUsuario)
            .set({ encerradaEm: new Date(), motivoEncerramento: 'expirada' })
            .where(eq(sessoesUsuario.id, s.id));
          return new FalhaLogin(ErroApi.naoAutenticado());
        }
        const [u] = await tx.select().from(usuarios).where(eq(usuarios.id, s.usuarioId));
        if (!u || !this.usuarioPodeEntrar(u)) {
          await tx
            .update(sessoesUsuario)
            .set({ encerradaEm: new Date(), motivoEncerramento: 'encerrada_admin' })
            .where(eq(sessoesUsuario.id, s.id));
          return new FalhaLogin(ErroApi.naoAutenticado());
        }
        await tx
          .update(sessoesUsuario)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'rotacionada' })
          .where(eq(sessoesUsuario.id, s.id));
        const nova = await this.criarSessao(tx, u.id, s.familiaId, s.expiraEm, meta, ultimoUso);
        return { usuario: u, ...nova };
      }),
    );
    if (r instanceof FalhaLogin) throw r.erro;
    this.resolvedor.verificarAcessoErp(empresa, 'depois_credenciais');
    return this.montarResultado(empresa, r.usuario, r.sessaoId, r.refreshToken, r.expiraEm);
  }

  async logout(refreshToken: string | undefined, meta: MetaRequisicao): Promise<void> {
    let alvo: Awaited<ReturnType<AuthService['empresaDoRefresh']>>;
    try {
      alvo = await this.empresaDoRefresh(refreshToken);
    } catch {
      return;
    }
    const contexto = this.resolvedor.contexto(alvo.empresa);
    await this.tenancy.executarNaEmpresa(contexto, () =>
      this.tenancy.cx().transacao(async (tx) => {
        const [s] = await tx
          .update(sessoesUsuario)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'logout' })
          .where(
            and(
              eq(sessoesUsuario.refreshTokenHash, sha256Hex(alvo.segredo)),
              isNull(sessoesUsuario.encerradaEm),
            ),
          )
          .returning();
        if (!s) return;
        const [u] = await tx
          .select({ nome: usuarios.nome })
          .from(usuarios)
          .where(eq(usuarios.id, s.usuarioId));
        await this.auditoria.registrar(
          tx,
          {
            origem: 'erp',
            usuarioId: s.usuarioId,
            usuarioNome: u?.nome,
            ip: meta.ip,
            userAgent: meta.userAgent,
            requisicaoId: meta.requisicaoId,
          },
          {
            acao: 'logout',
            entidade: 'login',
            registroId: s.usuarioId,
            localizacao: 'Login ERP',
            descricao: 'Saída do ERP',
          },
        );
      }),
    );
  }

  /** Troca de senha (ERP 4.2), obrigatória quando a senha é provisória. Encerra as outras sessões. */
  async trocarSenha(sessao: SessaoErp, entrada: TrocarSenha, meta: MetaRequisicao): Promise<RespostaLogin> {
    const empresa = await this.resolvedor.porId(sessao.empresa.empresaId);
    if (!empresa) throw ErroApi.naoAutenticado();
    const cx = this.tenancy.cx();
    // argon2 fora da transação (a trava de versão não espera por CPU).
    const [atual] = await cx.consulta((db) =>
      db.select().from(usuarios).where(eq(usuarios.id, sessao.usuarioId)),
    );
    if (!atual) throw ErroApi.naoAutenticado();
    if (atual.bloqueadoAte && atual.bloqueadoAte > new Date()) throw erroBloqueado(atual.bloqueadoAte);
    if (!(await verificarSenha(atual.senhaHash, entrada.senhaAtual))) {
      // Senha atual errada conta como tentativa de login: um token roubado não serve para adivinhar a senha.
      const bloqueio = await cx.transacao((tx) => this.registrarFalhaSenha(tx, atual.id, atual.nome, meta), {
        travaVersao: true,
      });
      if (bloqueio) throw erroBloqueado(bloqueio);
      throw new ErroApi('VALIDACAO', 'Senha atual incorreta.', {
        campos: { senhaAtual: ['Senha atual incorreta'] },
      });
    }
    if (await verificarSenha(atual.senhaHash, entrada.novaSenha)) {
      throw new ErroApi('VALIDACAO', 'A nova senha deve ser diferente da atual.', {
        campos: { novaSenha: ['Igual à atual'] },
      });
    }
    const novoHash = await gerarHashSenha(entrada.novaSenha);
    const r = await cx.transacao(
      async (tx) => {
        const [u] = await tx.select().from(usuarios).where(eq(usuarios.id, sessao.usuarioId)).for('update');
        // Senha trocada por outra requisição entre a verificação e a transação.
        if (!u || u.senhaHash !== atual.senhaHash) return new FalhaLogin(ErroApi.naoAutenticado());
        if (u.bloqueadoAte && u.bloqueadoAte > new Date())
          return new FalhaLogin(erroBloqueado(u.bloqueadoAte));
        const [atualizado] = await tx
          .update(usuarios)
          .set({
            senhaHash: novoHash,
            senhaProvisoria: false,
            senhaAlteradaEm: new Date(),
            tentativasFalhas: 0,
          })
          .where(eq(usuarios.id, u.id))
          .returning();
        await tx
          .update(sessoesUsuario)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'senha_alterada' })
          .where(
            and(
              eq(sessoesUsuario.usuarioId, u.id),
              isNull(sessoesUsuario.encerradaEm),
              ne(sessoesUsuario.id, sessao.sessaoId),
            ),
          );
        await this.auditoria.registrar(
          tx,
          {
            origem: 'erp',
            usuarioId: u.id,
            usuarioNome: u.nome,
            ip: meta.ip,
            userAgent: meta.userAgent,
            requisicaoId: meta.requisicaoId,
          },
          {
            acao: 'senha_alterada',
            entidade: 'usuarios',
            registroId: u.id,
            localizacao: 'Trocar senha',
            descricao: u.senhaProvisoria
              ? 'Troca obrigatória da senha provisória'
              : 'Senha alterada pelo usuário',
          },
        );
        return atualizado!;
      },
      { travaVersao: true },
    );
    if (r instanceof FalhaLogin) throw r.erro;
    const { resposta } = await this.montarResultado(empresa, r, sessao.sessaoId, '', new Date());
    return resposta;
  }

  async eu(sessao: SessaoErp): Promise<RespostaEu> {
    const lista = await this.tenancy.cx().consulta((db) =>
      db
        .select({
          id: lojas.id,
          codigo: lojas.codigo,
          nome: lojas.nome,
          ativa: lojas.ativa,
          tipoEmissao: lojas.tipoEmissao,
          tipo: lojas.tipo,
          treino: lojas.treino,
          estoqueId: lojas.estoqueId,
        })
        .from(lojas)
        .where(isNull(lojas.excluidoEm))
        .orderBy(lojas.ordem, lojas.codigo),
    );
    // O estoque da loja só vai a quem pode vê-lo (decisão 149): liberar a loja não libera o estoque dela.
    const comEstoque = lista.map((l) => ({
      ...l,
      estoqueId: sessao.estoques === null || sessao.estoques.includes(l.estoqueId) ? l.estoqueId : null,
    }));
    return {
      usuario: {
        id: sessao.usuarioId,
        codigo: sessao.codigo,
        nome: sessao.usuarioNome,
        login: sessao.login,
        master: sessao.master,
        senhaProvisoria: sessao.senhaProvisoria,
      },
      empresa: { codigo: sessao.empresa.codigo, nome: sessao.empresa.nome },
      permissoes: [...sessao.permissoes].sort(),
      lojas: sessao.lojas === null ? comEstoque : comEstoque.filter((l) => sessao.lojas!.includes(l.id)),
      todasLojas: sessao.lojas === null,
    };
  }

  usuarioPodeEntrar(u: LinhaUsuario): boolean {
    if (!u.ativo || u.excluidoEm || u.totem) return false;
    return !(u.demissao && u.demissao <= new Date().toISOString().slice(0, 10));
  }

  /**
   * Tentativa errada (login ou senha atual na troca): incremento atômico na linha travada e bloqueio ao atingir o
   * limite (ERP 4.1). Exige transação com a trava de versão (`usuarios` é sincronizável). Devolve o fim do bloqueio
   * quando esta tentativa bloqueou.
   */
  private async registrarFalhaSenha(
    tx: DbEmpresa,
    usuarioId: string,
    usuarioNome: string,
    meta: MetaRequisicao,
  ): Promise<Date | null> {
    const [{ tentativas }] = (await tx
      .update(usuarios)
      .set({ tentativasFalhas: sql`${usuarios.tentativasFalhas} + 1` })
      .where(eq(usuarios.id, usuarioId))
      .returning({ tentativas: usuarios.tentativasFalhas })) as [{ tentativas: number }];
    if (tentativas < this.config.login.maxTentativas) return null;
    const ate = new Date(Date.now() + this.config.login.bloqueioMinutos * 60_000);
    await tx
      .update(usuarios)
      .set({ tentativasFalhas: 0, bloqueadoAte: ate })
      .where(eq(usuarios.id, usuarioId));
    await this.auditoria.registrar(
      tx,
      {
        origem: 'sistema',
        usuarioId,
        usuarioNome,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requisicaoId: meta.requisicaoId,
      },
      {
        acao: 'bloqueio',
        entidade: 'usuarios',
        registroId: usuarioId,
        localizacao: 'Login ERP',
        descricao: `Usuário bloqueado por ${this.config.login.bloqueioMinutos} minutos após ${tentativas} tentativas`,
      },
    );
    return ate;
  }

  async verificarToken(token: string): Promise<ClaimsErp | null> {
    const c = await this.jwt.verificar<ClaimsErp & { [k: string]: unknown }>(token);
    if (!c || typeof c.sub !== 'string' || typeof c.eid !== 'string' || typeof c.emp !== 'number')
      return null;
    return c;
  }

  private async empresaDoRefresh(
    token: string | undefined,
  ): Promise<{ empresa: EmpresaResolvida; segredo: string }> {
    const m = token?.match(/^(\d{6})\.([A-Za-z0-9_-]{20,})$/);
    if (!m) throw ErroApi.naoAutenticado();
    const empresa = await this.resolvedor.porCodigo(Number(m[1]));
    if (!empresa || empresa.excluida) throw ErroApi.naoAutenticado();
    this.resolvedor.verificarAcessoErp(empresa, 'antes_credenciais');
    return { empresa, segredo: m[2]! };
  }

  private async criarSessao(
    tx: DbEmpresa,
    usuarioId: string,
    familiaId: string,
    expiraEm: Date | null,
    meta: MetaRequisicao,
    ultimoUsoEm: Date = new Date(),
  ): Promise<{ sessaoId: string; refreshToken: string; expiraEm: Date }> {
    const segredo = gerarSegredo();
    const sessaoId = uuidv7();
    const expira = expiraEm ?? new Date(Date.now() + this.config.sessao.refreshDias * 86_400_000);
    await tx.insert(sessoesUsuario).values({
      id: sessaoId,
      usuarioId,
      refreshTokenHash: sha256Hex(segredo),
      familiaId,
      expiraEm: expira,
      ultimoUsoEm,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    });
    return { sessaoId, refreshToken: segredo, expiraEm: expira };
  }

  private async registrarTentativa(
    tx: DbEmpresa,
    login: string,
    usuarioId: string | null,
    sucesso: boolean,
    motivo: MotivoFalhaLogin | null,
    meta: MetaRequisicao,
  ): Promise<void> {
    await tx.insert(historicoLogins).values({
      ocorridoEm: new Date(),
      origem: 'erp',
      usuarioId,
      loginInformado: login.slice(0, 60),
      sucesso,
      motivoFalha: motivo,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    });
  }

  private async montarResultado(
    empresa: EmpresaResolvida,
    u: LinhaUsuario,
    sessaoId: string,
    segredo: string,
    refreshExpiraEm: Date,
  ): Promise<ResultadoSessao> {
    const claims: ClaimsErp = {
      sub: u.id,
      emp: empresa.codigo,
      eid: empresa.id,
      sid: sessaoId,
      perm_versao: u.permissoesVersao,
      master: u.master,
      tsp: u.senhaProvisoria,
    };
    const { token, expiraEm } = await this.jwt.assinar({ ...claims });
    return {
      resposta: {
        tokenAcesso: token,
        expiraEm: expiraEm.toISOString(),
        trocarSenha: u.senhaProvisoria,
        empresa: { codigo: empresa.codigo, nome: empresa.nomeFantasia ?? empresa.razaoSocial },
        usuario: {
          id: u.id,
          codigo: u.codigo,
          nome: u.nome,
          login: u.login,
          master: u.master,
          senhaProvisoria: u.senhaProvisoria,
        },
      },
      refreshToken: `${empresa.codigo}.${segredo}`,
      refreshExpiraEm,
    };
  }
}
