import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  type StreamableFile,
} from '@nestjs/common';
import {
  ajustesPermissoesSchema,
  alterarUsuarioSchema,
  calcularPermissoesEfetivas,
  criarUsuarioSchema,
  definirPinSchema,
  type PermissoesUsuario,
  type RespostaSenhaRedefinida,
  validarPin,
  exportacaoQuerySchema,
  filtroUsuariosSchema,
  LIMITE_EXPORTACAO,
  type FiltroUsuarios,
  limiteDeslocamento,
  ordenacao,
  ORDENACOES_USUARIOS,
  type Pagina,
  type RespostaUsuarioGravado,
  type UsuarioDetalhe,
  type UsuarioResumo,
} from '@genesis/shared';
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { ErroApi } from '../comum/erros.js';
import { arquivoExportacao, garantirPodeExportar, type ColunaExportacao } from '../comum/exportacao.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import {
  estoques,
  lojas,
  municipios,
  perfis,
  perfisPermissoes,
  sessoesUsuario,
  usuarios,
  usuariosEstoques,
  usuariosLojas,
  usuariosPermissoes,
} from '../database/empresa/schema/index.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { estoqueVisivel } from '../estoques/permitidos.js';
import { garantirMunicipio } from '../lojas/municipio.js';
import { recalcularRelevancia } from '../pessoas/relevancia.js';
import {
  garantirLimiteHash,
  gerarHashPin,
  gerarHashSenha,
  gerarSenhaProvisoria,
} from '../seguranca/senhas.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

type LinhaUsuario = typeof usuarios.$inferSelect;

const LOCALIZACAO = 'Cadastros › Usuários';

const colunasOrdenacao: Record<(typeof ORDENACOES_USUARIOS)[number], SQL | typeof usuarios.codigo> = {
  codigo: usuarios.codigo,
  nome: sql`${usuarios.nome}`,
  login: sql`${usuarios.login}`,
  perfil: sql`${perfis.nome}`,
  ultimo_login_em: sql`${usuarios.ultimoLoginEm}`,
  ativo: sql`${usuarios.ativo}`,
};

const escaparLike = (v: string) => v.replace(/[%_\\]/g, (c) => `\\${c}`);
const hoje = () => new Date().toISOString().slice(0, 10);

/** Campos do formulário que mudam o acesso: alterá-los incrementa `permissoes_versao` (ERP 2.1, "Cache"). */
const iguais = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Limite numérico também é permissão: ninguém concede desconto maior que o próprio (Master não tem teto). */
function garantirLimiteDesconto(sessao: SessaoErp, valor: string | number): void {
  if (sessao.master) return;
  if (Number(valor) > Number(sessao.limiteDescontoPct)) {
    throw new ErroApi('SEM_PERMISSAO', 'Você não pode conceder limite de desconto maior que o seu.', {
      campos: { limiteDescontoPct: [`Máximo ${Number(sessao.limiteDescontoPct)}%`] },
    });
  }
}

/**
 * Usuários visíveis para quem tem lojas restritas (decisão 92): os que têm ao menos uma loja em comum, os sem loja
 * nenhuma (que não são Master) e o próprio. Master (todas as lojas) e usuários só de outras lojas ficam ocultos —
 * CPF, RG, endereço e último acesso são dados pessoais da loja em que a pessoa trabalha.
 */
export function usuarioVisivel(sessao: SessaoErp, coluna: SQL = sql`${usuarios.id}`): SQL | undefined {
  if (sessao.lojas === null) return undefined;
  const lojasSessao = sessao.lojas.length
    ? sql`ul.loja_id in (${sql.join(
        sessao.lojas.map((l) => sql`${l}::uuid`),
        sql`, `,
      )})`
    : sql`false`;
  return sql`(${coluna} = ${sessao.usuarioId}::uuid or exists (
    select 1 from usuarios ux where ux.id = ${coluna} and not ux.master and (
      exists (select 1 from usuarios_lojas ul where ul.usuario_id = ux.id and ul.excluido_em is null and ${lojasSessao})
      or not exists (select 1 from usuarios_lojas ul where ul.usuario_id = ux.id and ul.excluido_em is null))))`;
}

function condicoesListagem(q: FiltroUsuarios, sessao: SessaoErp): { onde: SQL | undefined; ordem: SQL[] } {
  const ord = ordenacao(q) ?? { campo: 'nome', direcao: 'asc' };
  const coluna = colunasOrdenacao[ord.campo as keyof typeof colunasOrdenacao];
  if (!coluna) {
    throw new ErroApi('VALIDACAO', 'Ordenação inválida.', {
      campos: { ordenar: [`Use um de: ${ORDENACOES_USUARIOS.join(', ')}`] },
    });
  }
  const termo = q.nome?.trim();
  const busca = termo ? `%${escaparLike(termo)}%` : undefined;
  const onde = and(
    isNull(usuarios.excluidoEm),
    usuarioVisivel(sessao),
    q.situacao === 'ativos' ? eq(usuarios.ativo, true) : undefined,
    q.situacao === 'inativos' ? eq(usuarios.ativo, false) : undefined,
    q.perfilId ? eq(usuarios.perfilId, q.perfilId) : undefined,
    busca
      ? or(
          ilike(usuarios.nome, busca),
          ilike(usuarios.login, busca),
          // ERP 1.2: colar o código ou o UUID no filtro principal acha o registro.
          /^\d{1,9}$/.test(termo!) ? eq(usuarios.codigo, Number(termo)) : undefined,
          z.uuid().safeParse(termo).success ? eq(usuarios.id, termo!) : undefined,
        )
      : undefined,
    q.lojaId
      ? or(
          eq(usuarios.master, true),
          sql`exists (select 1 from usuarios_lojas ul where ul.usuario_id = ${usuarios.id} and ul.loja_id = ${q.lojaId} and ul.excluido_em is null)`,
        )
      : undefined,
  );
  return { onde, ordem: [ord.direcao === 'asc' ? asc(coluna) : desc(coluna), asc(usuarios.codigo)] };
}

function consultaResumo(db: DbEmpresa) {
  return db
    .select({
      id: usuarios.id,
      codigo: usuarios.codigo,
      nome: usuarios.nome,
      login: usuarios.login,
      perfilId: usuarios.perfilId,
      perfilNome: perfis.nome,
      master: usuarios.master,
      ativo: usuarios.ativo,
      ultimoLoginEm: usuarios.ultimoLoginEm,
      versao: usuarios.versao,
    })
    .from(usuarios)
    .leftJoin(perfis, eq(perfis.id, usuarios.perfilId))
    .$dynamic();
}

type LinhaResumo = Awaited<ReturnType<typeof consultaResumo>>[number];

const resumoUsuario = (l: LinhaResumo): UsuarioResumo => ({
  ...l,
  ultimoLoginEm: l.ultimoLoginEm?.toISOString() ?? null,
});

const COLUNAS_EXPORTACAO: ColunaExportacao<LinhaResumo>[] = [
  { rotulo: 'Cód.', valor: (u) => u.codigo },
  { rotulo: 'Nome', valor: (u) => u.nome },
  { rotulo: 'Login', valor: (u) => u.login },
  { rotulo: 'Perfil', valor: (u) => (u.master ? 'Master' : u.perfilNome) },
  { rotulo: 'Último acesso', valor: (u) => u.ultimoLoginEm },
  { rotulo: 'Ativo', valor: (u) => u.ativo },
];

const PERMISSAO_RH = 'usuarios.ver_dados_rh';

/** Salário só é gravado/visto por quem tem `usuarios.ver_dados_rh` (ERP 11.2); sem ela o valor atual fica. */
function semDadosRh<T extends { salario?: string | null }>(sessao: SessaoErp, dados: T): T {
  if (sessao.permissoes.has(PERMISSAO_RH)) return dados;
  const { salario: _s, ...resto } = dados;
  return resto as T;
}

/** Usuários (ERP 11.1, 11.2): Dados Gerais, lojas e estoques permitidos, PIN do PDV, ajustes de permissão, senha. */
@Controller('usuarios')
export class UsuariosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('usuarios.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<UsuarioResumo>> {
    const q = validar(filtroUsuariosSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const { onde, ordem } = condicoesListagem(q, sessao);
    return this.s.tenancy.cx().consulta(async (db) => {
      const linhas = await consultaResumo(db)
        .where(onde)
        .orderBy(...ordem)
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(usuarios).where(onde);
      return {
        itens: linhas.map(resumoUsuario),
        total: total?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /** Exportar da listagem (ERP 3.1, 1.8): mesmos filtros e ordenação, todas as linhas. */
  @Permissao('usuarios.ver')
  @Get('exportar')
  async exportar(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<StreamableFile> {
    garantirPodeExportar(sessao, 'usuarios');
    const q = validar(filtroUsuariosSchema.extend(exportacaoQuerySchema.shape), query);
    const { onde, ordem } = condicoesListagem(q, sessao);
    const linhas = await this.s.tenancy.cx().transacao(async (tx) => {
      const [total] = await tx.select({ n: count() }).from(usuarios).where(onde);
      if ((total?.n ?? 0) > LIMITE_EXPORTACAO) {
        throw new ErroApi(
          'REGRA_NEGOCIO',
          `A exportação passa de ${LIMITE_EXPORTACAO.toLocaleString('pt-BR')} linhas. Refine os filtros.`,
        );
      }
      const linhas = await consultaResumo(tx)
        .where(onde)
        .orderBy(...ordem);
      const { formato, pagina: _p, tamanho: _t, ...filtros } = q;
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'exportar',
        entidade: 'usuarios',
        localizacao: LOCALIZACAO,
        descricao: `Exportação ${formato.toUpperCase()} com ${linhas.length} linha(s)`,
        depois: { formato, filtros, linhas: linhas.length },
      });
      return linhas;
    });
    return arquivoExportacao(q.formato, 'Usuarios', COLUNAS_EXPORTACAO, linhas);
  }

  @Permissao('usuarios.ver')
  @Get(':id')
  async obter(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<UsuarioDetalhe> {
    const usuarioId = validar(z.uuid(), id);
    return this.s.tenancy.cx().consulta(async (db) => {
      const d = await this.detalhe(db, usuarioId, sessao);
      if (!d) throw ErroApi.naoEncontrado('Usuário não encontrado.');
      return d;
    });
  }

  @Permissao('usuarios.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RespostaUsuarioGravado> {
    const {
      senha,
      lojas: lojasInformadas,
      estoques: estoquesInformados,
      ...todos
    } = validar(criarUsuarioSchema, corpo);
    const dados = semDadosRh(sessao, todos);
    if (dados.master && !sessao.master) {
      throw ErroApi.semPermissao('Só um usuário Master pode criar outro Master.');
    }
    garantirLimiteDesconto(sessao, dados.limiteDescontoPct);
    const senhaGerada = senha ? undefined : gerarSenhaProvisoria();
    // argon2 fora da transação (transação curta, MD 1.5).
    const senhaHash = await gerarHashSenha(senha ?? senhaGerada!);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await this.garantirUnicos(tx, dados);
        await garantirMunicipio(tx, dados.municipioIbge, dados.uf);
        if (dados.perfilId) await this.garantirPerfil(tx, sessao, dados.perfilId);
        const lojasFinais = dados.master ? [] : await this.resolverLojas(tx, sessao, lojasInformadas, []);
        const [novo] = await tx
          .insert(usuarios)
          .values({
            ...dados,
            senhaHash,
            senhaProvisoria: true,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning();
        if (lojasFinais.length) {
          await tx.insert(usuariosLojas).values(
            lojasFinais.map((lojaId) => ({
              usuarioId: novo!.id,
              lojaId,
              criadoPorId: sessao.usuarioId,
              atualizadoPorId: sessao.usuarioId,
            })),
          );
        }
        const estoquesFinais = await this.gravarEstoques(tx, sessao, novo!.id, estoquesInformados);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'usuarios',
          registroId: novo!.id,
          localizacao: LOCALIZACAO,
          depois: { ...novo, lojas: lojasFinais, estoques: estoquesFinais },
        });
        return novo!.id;
      },
      { travaVersao: true },
    );
    const usuario = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao));
    return { usuario: usuario!, ...(senhaGerada ? { senhaProvisoria: senhaGerada } : {}) };
  }

  @Permissao('usuarios.editar')
  @Put(':id')
  async alterar(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RespostaUsuarioGravado> {
    const usuarioId = validar(z.uuid(), id);
    const {
      versao,
      lojas: lojasInformadas,
      estoques: estoquesInformados,
      ...todos
    } = validar(alterarUsuarioSchema, corpo);
    const dados = semDadosRh(sessao, todos);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(usuarios)
          .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        if (antes.versao !== versao) await this.conflito(tx, antes);
        const lojasAntes = await this.lojasDoUsuario(tx, usuarioId);
        const codigo = dados.codigo ?? antes.codigo;

        if (antes.master && !sessao.master) {
          throw ErroApi.semPermissao('Só um usuário Master pode alterar outro Master.');
        }
        await this.garantirAlvoSubordinado(tx, sessao, antes);
        if (Number(dados.limiteDescontoPct) !== Number(antes.limiteDescontoPct)) {
          garantirLimiteDesconto(sessao, dados.limiteDescontoPct);
        }
        if (dados.master !== antes.master && !sessao.master) {
          throw ErroApi.semPermissao('Só um usuário Master pode marcar ou desmarcar a flag Master.');
        }
        if (usuarioId === sessao.usuarioId) {
          const mudou =
            dados.master !== antes.master ||
            dados.perfilId !== antes.perfilId ||
            Number(dados.limiteDescontoPct) !== Number(antes.limiteDescontoPct) ||
            (!dados.master && !iguais([...new Set(lojasInformadas)], lojasAntes));
          if (mudou) {
            throw ErroApi.semPermissao(
              'Você não pode alterar o próprio perfil, lojas, limite de desconto nem a flag Master.',
            );
          }
        }
        const lojasFinais = dados.master
          ? lojasAntes
          : await this.resolverLojas(tx, sessao, lojasInformadas, lojasAntes);
        const mudouAcesso =
          dados.master !== antes.master ||
          dados.perfilId !== antes.perfilId ||
          !iguais(lojasFinais, lojasAntes);
        if (antes.master && antes.ativo && (!dados.master || !dados.ativo)) {
          await this.garantirOutroMaster(tx, usuarioId);
        }
        await this.garantirUnicos(tx, { ...dados, codigo }, usuarioId);
        await garantirMunicipio(tx, dados.municipioIbge, dados.uf);
        if (dados.perfilId && dados.perfilId !== antes.perfilId) {
          await this.garantirPerfil(tx, sessao, dados.perfilId);
        }

        const [depois] = await tx
          .update(usuarios)
          .set({
            ...dados,
            codigo,
            atualizadoPorId: sessao.usuarioId,
            ...(mudouAcesso ? { permissoesVersao: sql`${usuarios.permissoesVersao} + 1` } : {}),
          })
          .where(and(eq(usuarios.id, usuarioId), eq(usuarios.versao, versao)))
          .returning();
        if (!depois) await this.conflito(tx, antes);
        if (!dados.master) await this.gravarLojas(tx, sessao, usuarioId, lojasAntes, lojasFinais);
        // Vínculo `usuarios.pessoa_id` = motivo `funcionario` da pessoa (MD 3.5.4; D19).
        const pessoasVinculadas = [antes.pessoaId, depois!.pessoaId].filter((p): p is string => !!p);
        await recalcularRelevancia(tx, pessoasVinculadas);
        const estoquesAntes = await this.estoquesDoUsuario(tx, usuarioId);
        const estoquesFinais = await this.gravarEstoques(tx, sessao, usuarioId, estoquesInformados);
        const origem = origemDaRequisicao(req);
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'editar',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          antes: { ...antes, lojas: lojasAntes, estoques: estoquesAntes },
          depois: { ...depois, lojas: lojasFinais, estoques: estoquesFinais },
        });
        if (mudouAcesso) {
          await this.s.auditoria.registrar(tx, origem, {
            acao: 'permissoes_alteradas',
            entidade: 'usuarios',
            registroId: usuarioId,
            localizacao: LOCALIZACAO,
            antes: { master: antes.master, perfilId: antes.perfilId, lojas: lojasAntes },
            depois: { master: dados.master, perfilId: dados.perfilId, lojas: lojasFinais },
          });
        }
      },
      { travaVersao: true },
    );
    const usuario = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, usuarioId, sessao));
    return { usuario: usuario! };
  }

  @Permissao('usuarios.excluir')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const usuarioId = validar(z.uuid(), id);
    if (usuarioId === sessao.usuarioId) {
      throw new ErroApi('REGRA_NEGOCIO', 'Você não pode excluir o próprio usuário.');
    }
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(usuarios)
          .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        if (antes.master && !sessao.master) {
          throw ErroApi.semPermissao('Só um usuário Master pode excluir outro Master.');
        }
        await this.garantirAlvoSubordinado(tx, sessao, antes);
        if (antes.master && antes.ativo) await this.garantirOutroMaster(tx, usuarioId);
        await tx
          .update(usuarios)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(eq(usuarios.id, usuarioId));
        // Sem o usuário, a pessoa vinculada pode deixar de ser relevante como funcionário (MD 3.5.4).
        if (antes.pessoaId) await recalcularRelevancia(tx, [antes.pessoaId]);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }

  /** Desbloqueio antes do fim do prazo (ERP 4.1: "Um Master pode desbloquear em Usuários"). */
  @Permissao('usuarios.editar')
  @Post(':id/desbloquear')
  @HttpCode(204)
  async desbloquear(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const usuarioId = validar(z.uuid(), id);
    if (!sessao.master) throw ErroApi.semPermissao('Só um usuário Master pode desbloquear usuários.');
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(usuarios)
          .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        await tx
          .update(usuarios)
          .set({ bloqueadoAte: null, tentativasFalhas: 0, atualizadoPorId: sessao.usuarioId })
          .where(eq(usuarios.id, usuarioId));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          descricao: 'Usuário desbloqueado',
          antes: { bloqueadoAte: antes.bloqueadoAte, tentativasFalhas: antes.tentativasFalhas },
          depois: { bloqueadoAte: null, tentativasFalhas: 0 },
        });
      },
      { travaVersao: true },
    );
  }

  /**
   * PIN do PDV (ERP 11.2; SYNC 4.1–4.3): o próprio usuário ou quem pode editá-lo. argon2id com os parâmetros da SYNC 4.2;
   * é a única credencial de operador que desce ao PDV. `pin: null` remove. Recusa sequência, repetição e o código.
   */
  @Put(':id/pin')
  @HttpCode(204)
  async definirPin(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const usuarioId = validar(z.uuid(), id);
    const { pin } = validar(definirPinSchema, corpo);
    const proprio = usuarioId === sessao.usuarioId;
    if (!proprio && !sessao.permissoes.has('usuarios.editar')) throw ErroApi.semPermissao();
    const [alvo] = await this.s.tenancy.cx().consulta((db) =>
      db
        .select()
        .from(usuarios)
        .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm))),
    );
    if (!alvo) throw ErroApi.naoEncontrado('Usuário não encontrado.');
    let hash: string | null = null;
    if (pin !== null) {
      const curto = await this.s.tenancy
        .cx()
        .consulta((db) => lerConfiguracao<boolean>(db, 'pdv.permite_pin_curto'));
      const erro = validarPin(pin, { permitirCurto: curto, codigoUsuario: alvo.codigo });
      if (erro)
        throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', { campos: { pin: [erro] } });
      garantirLimiteHash(`${sessao.empresa.empresaId}:${sessao.usuarioId}`);
      hash = await gerarHashPin(pin);
    }
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx.select().from(usuarios).where(eq(usuarios.id, usuarioId)).for('update');
        if (!antes || antes.excluidoEm) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        if (!proprio) {
          if (antes.master && !sessao.master)
            throw ErroApi.semPermissao('Só um usuário Master pode alterar outro Master.');
          await this.garantirAlvoSubordinado(tx, sessao, antes);
        }
        await tx
          .update(usuarios)
          .set({ senhaPdvHash: hash, atualizadoPorId: sessao.usuarioId })
          .where(eq(usuarios.id, usuarioId));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'senha_alterada',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          descricao: hash ? 'PIN do PDV definido' : 'PIN do PDV removido',
          antes: { senhaPdvHash: antes.senhaPdvHash },
          depois: { senhaPdvHash: hash },
        });
      },
      { travaVersao: true },
    );
  }

  /** Redefinir senha (ERP 11.2): senha provisória exibida uma vez; encerra as sessões e zera o bloqueio. */
  @Permissao('usuarios.redefinir_senha')
  @Post(':id/redefinir-senha')
  @HttpCode(200)
  async redefinirSenha(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RespostaSenhaRedefinida> {
    const usuarioId = validar(z.uuid(), id);
    if (usuarioId === sessao.usuarioId) {
      throw new ErroApi('REGRA_NEGOCIO', 'Para a própria senha use Minha conta › Trocar senha.');
    }
    const senha = gerarSenhaProvisoria();
    const hash = await gerarHashSenha(senha);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(usuarios)
          .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        if (antes.master && !sessao.master)
          throw ErroApi.semPermissao('Só um usuário Master pode redefinir a senha de outro Master.');
        await this.garantirAlvoSubordinado(tx, sessao, antes);
        await tx
          .update(usuarios)
          .set({
            senhaHash: hash,
            senhaProvisoria: true,
            tentativasFalhas: 0,
            bloqueadoAte: null,
            atualizadoPorId: sessao.usuarioId,
          })
          .where(eq(usuarios.id, usuarioId));
        await tx
          .update(sessoesUsuario)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'encerrada_admin' })
          .where(and(eq(sessoesUsuario.usuarioId, usuarioId), isNull(sessoesUsuario.encerradaEm)));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'senha_redefinida',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          descricao: 'Senha provisória gerada pelo administrador',
        });
      },
      { travaVersao: true },
    );
    return { senhaProvisoria: senha };
  }

  /** Abas Menus do sistema e Permissões Gerais (ERP 11.2): do perfil, ajustes individuais e efetivas. */
  @Permissao('usuarios.ver')
  @Get(':id/permissoes')
  async permissoes(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<PermissoesUsuario> {
    const usuarioId = validar(z.uuid(), id);
    return this.s.tenancy.cx().consulta(async (db) => {
      const [u] = await db
        .select()
        .from(usuarios)
        .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm), usuarioVisivel(sessao)));
      if (!u) throw ErroApi.naoEncontrado('Usuário não encontrado.');
      return this.permissoesDe(db, u);
    });
  }

  @Permissao('usuarios.permissoes')
  @Put(':id/permissoes')
  async alterarPermissoes(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PermissoesUsuario> {
    const usuarioId = validar(z.uuid(), id);
    const { versao, ajustes } = validar(ajustesPermissoesSchema, corpo);
    if (usuarioId === sessao.usuarioId)
      throw ErroApi.semPermissao('Você não pode alterar as próprias permissões.');
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(usuarios)
          .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Usuário não encontrado.');
        if (antes.versao !== versao) await this.conflito(tx, antes);
        if (antes.master) throw new ErroApi('REGRA_NEGOCIO', 'Usuário Master tem todas as permissões.');
        await this.garantirAlvoSubordinado(tx, sessao, antes);
        const atuais = await tx
          .select({
            id: usuariosPermissoes.id,
            permissao: usuariosPermissoes.permissao,
            efeito: usuariosPermissoes.efeito,
          })
          .from(usuariosPermissoes)
          .where(and(eq(usuariosPermissoes.usuarioId, usuarioId), isNull(usuariosPermissoes.excluidoEm)));
        if (!sessao.master) {
          // Regra do resultado efetivo (decisão 86): toda permissão que o alvo passa a ter — por `conceder` novo ou
          // pela retirada de um `negar` sobre permissão do perfil — precisa estar nas do editor.
          const doPerfil = antes.perfilId
            ? (
                await tx
                  .select({ p: perfisPermissoes.permissao })
                  .from(perfisPermissoes)
                  .where(
                    and(eq(perfisPermissoes.perfilId, antes.perfilId), isNull(perfisPermissoes.excluidoEm)),
                  )
              ).map((r) => r.p)
            : [];
          const efetivasDe = (lista: readonly { permissao: string; efeito: string }[]) =>
            calcularPermissoesEfetivas({
              master: false,
              doPerfil,
              concedidas: lista.filter((a) => a.efeito === 'conceder').map((a) => a.permissao),
              negadas: lista.filter((a) => a.efeito === 'negar').map((a) => a.permissao),
            });
          const atuaisEfetivas = efetivasDe(atuais);
          const faltando = [...efetivasDe(ajustes)]
            .filter((p) => !atuaisEfetivas.has(p) && !sessao.permissoes.has(p))
            .sort();
          if (faltando.length) {
            throw new ErroApi('SEM_PERMISSAO', 'Você não pode conceder permissões que você não tem.', {
              detalhes: { permissoes: faltando },
            });
          }
        }
        const agora = new Date();
        for (const a of atuais) {
          const novo = ajustes.find((x) => x.permissao === a.permissao);
          if (novo && novo.efeito === a.efeito) continue;
          await tx
            .update(usuariosPermissoes)
            .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
            .where(eq(usuariosPermissoes.id, a.id));
        }
        const incluir = ajustes.filter(
          (a) => !atuais.some((x) => x.permissao === a.permissao && x.efeito === a.efeito),
        );
        if (incluir.length) {
          await tx.insert(usuariosPermissoes).values(
            incluir.map((a) => ({
              usuarioId,
              ...a,
              criadoPorId: sessao.usuarioId,
              atualizadoPorId: sessao.usuarioId,
            })),
          );
        }
        const [depois] = await tx
          .update(usuarios)
          .set({ permissoesVersao: sql`${usuarios.permissoesVersao} + 1`, atualizadoPorId: sessao.usuarioId })
          .where(eq(usuarios.id, usuarioId))
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'permissoes_alteradas',
          entidade: 'usuarios',
          registroId: usuarioId,
          localizacao: LOCALIZACAO,
          antes: { ajustes: atuais.map(({ permissao, efeito }) => ({ permissao, efeito })) },
          depois: { ajustes },
        });
        return this.permissoesDe(tx, depois!);
      },
      { travaVersao: true },
    );
  }

  private async permissoesDe(db: DbEmpresa, u: LinhaUsuario): Promise<PermissoesUsuario> {
    const doPerfil = u.perfilId
      ? (
          await db
            .select({ p: perfisPermissoes.permissao })
            .from(perfisPermissoes)
            .where(and(eq(perfisPermissoes.perfilId, u.perfilId), isNull(perfisPermissoes.excluidoEm)))
        ).map((r) => r.p)
      : [];
    const ajustes = (
      await db
        .select({ permissao: usuariosPermissoes.permissao, efeito: usuariosPermissoes.efeito })
        .from(usuariosPermissoes)
        .where(and(eq(usuariosPermissoes.usuarioId, u.id), isNull(usuariosPermissoes.excluidoEm)))
    ).map((a) => ({ permissao: a.permissao, efeito: a.efeito as 'conceder' | 'negar' }));
    const efetivas = calcularPermissoesEfetivas({
      master: u.master,
      doPerfil,
      concedidas: ajustes.filter((a) => a.efeito === 'conceder').map((a) => a.permissao),
      negadas: ajustes.filter((a) => a.efeito === 'negar').map((a) => a.permissao),
    });
    return {
      master: u.master,
      doPerfil: doPerfil.sort(),
      ajustes,
      efetivas: [...efetivas].sort(),
      versao: u.versao,
    };
  }

  /**
   * Estoques permitidos vivos do usuário. O vínculo com estoque excluído fica de fora, como na lista da sessão
   * (`PermissoesEfetivas`): senão ele contaria como estoque que o editor não vê (`garantirAlvoSubordinado` → 403) e
   * voltaria no detalhe, travando a gravação com "Estoque inexistente ou excluído". A exclusão do estoque já encerra
   * os vínculos (estoques.controller); o filtro cobre os antigos.
   */
  private async estoquesDoUsuario(db: DbEmpresa, usuarioId: string): Promise<string[]> {
    const linhas = await db
      .select({ id: usuariosEstoques.estoqueId })
      .from(usuariosEstoques)
      .innerJoin(estoques, eq(estoques.id, usuariosEstoques.estoqueId))
      .where(
        and(
          eq(usuariosEstoques.usuarioId, usuarioId),
          isNull(usuariosEstoques.excluidoEm),
          isNull(estoques.excluidoEm),
        ),
      );
    return linhas.map((l) => l.id);
  }

  /**
   * Estoques permitidos (ERP 11.2; decisão 149): substitui a lista; estoque inexistente → 422 no campo. É a lista
   * inteira do que o usuário vê e movimenta (inclusive o estoque das lojas dele e o CD), não um adicional às lojas.
   */
  private async gravarEstoques(
    tx: DbEmpresa,
    sessao: SessaoErp,
    usuarioId: string,
    informados: readonly string[],
  ): Promise<string[]> {
    const informadosUnicos = [...new Set(informados)];
    if (informadosUnicos.length) {
      const existentes = await tx
        .select({ id: estoques.id })
        .from(estoques)
        .where(and(inArray(estoques.id, informadosUnicos), isNull(estoques.excluidoEm)));
      if (existentes.length !== informadosUnicos.length) {
        throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
          campos: { estoques: ['Estoque inexistente ou excluído'] },
        });
      }
    }
    const antes = await this.estoquesDoUsuario(tx, usuarioId);
    // Mesma regra das lojas (resolverLojas): só concede/retira estoques permitidos ao editor (ERP 2.1); os que ele
    // não vê e o usuário já tinha são preservados.
    const invisiveis = await this.estoquesInvisiveis(tx, sessao, [...informadosUnicos, ...antes]);
    if (informadosUnicos.some((e) => invisiveis.has(e))) {
      throw ErroApi.semPermissao(
        'Você só pode conceder estoques que estão entre os seus estoques permitidos.',
      );
    }
    const pedidos = [...new Set([...antes.filter((e) => invisiveis.has(e)), ...informadosUnicos])];
    const remover = antes.filter((e) => !pedidos.includes(e));
    const incluir = pedidos.filter((e) => !antes.includes(e));
    if (remover.length) {
      await tx
        .update(usuariosEstoques)
        .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
        .where(
          and(
            eq(usuariosEstoques.usuarioId, usuarioId),
            inArray(usuariosEstoques.estoqueId, remover),
            isNull(usuariosEstoques.excluidoEm),
          ),
        );
    }
    if (incluir.length) {
      await tx.insert(usuariosEstoques).values(
        incluir.map((estoqueId) => ({
          usuarioId,
          estoqueId,
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })),
      );
    }
    return pedidos;
  }

  /** Estoques da lista que o editor não enxerga (fora dos estoques permitidos dele, `estoqueVisivel`). */
  private async estoquesInvisiveis(
    db: DbEmpresa,
    sessao: SessaoErp,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const filtro = estoqueVisivel(sessao, sql`${estoques.id}`);
    if (!filtro || ids.length === 0) return new Set();
    const visiveis = await db
      .select({ id: estoques.id })
      .from(estoques)
      .where(and(inArray(estoques.id, [...new Set(ids)]), filtro));
    const ok = new Set(visiveis.map((v) => v.id));
    return new Set(ids.filter((id) => !ok.has(id)));
  }

  /**
   * Escalada (ERP 11.2): quem não é Master só altera, exclui ou mexe no login/e-mail de quem tem acesso contido no
   * dele — permissões efetivas e lojas. Sem isso, trocar o e-mail de um usuário mais poderoso e pedir "esqueci minha
   * senha" tomaria a conta dele.
   */
  private async garantirAlvoSubordinado(tx: DbEmpresa, sessao: SessaoErp, alvo: LinhaUsuario): Promise<void> {
    if (sessao.master || alvo.id === sessao.usuarioId) return;
    const acesso = await this.s.permissoes.obter(tx, sessao.empresa.empresaId, alvo);
    const faltando = [...acesso.permissoes].filter((p) => !sessao.permissoes.has(p));
    const lojasFora = acesso.lojas === null || acesso.lojas.some((l) => !sessao.lojas?.includes(l));
    const estoquesFora =
      (await this.estoquesInvisiveis(tx, sessao, await this.estoquesDoUsuario(tx, alvo.id))).size > 0;
    if (faltando.length || lojasFora || estoquesFora) {
      throw new ErroApi('SEM_PERMISSAO', 'Você não pode alterar um usuário com mais acesso que o seu.', {
        detalhes: {
          permissoes: faltando.sort(),
          lojasForaDoSeuAcesso: lojasFora,
          estoquesForaDoSeuAcesso: estoquesFora,
        },
      });
    }
  }

  private async detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<UsuarioDetalhe | null> {
    const autor = alias(usuarios, 'autor');
    const [l] = await db
      .select({ u: usuarios, perfilNome: perfis.nome, autorNome: autor.nome, municipioNome: municipios.nome })
      .from(usuarios)
      .leftJoin(perfis, eq(perfis.id, usuarios.perfilId))
      .leftJoin(autor, eq(autor.id, usuarios.atualizadoPorId))
      .leftJoin(municipios, eq(municipios.codigoIbge, usuarios.municipioIbge))
      .where(and(eq(usuarios.id, id), isNull(usuarios.excluidoEm), usuarioVisivel(sessao)));
    if (!l) return null;
    const u = l.u;
    return {
      id: u.id,
      codigo: u.codigo,
      nome: u.nome,
      login: u.login,
      email: u.email,
      ativo: u.ativo,
      master: u.master,
      perfilId: u.perfilId,
      perfilNome: l.perfilNome,
      limiteDescontoPct: u.limiteDescontoPct,
      comissaoPct: u.comissaoPct,
      telefone: u.telefone,
      cpf: u.cpf,
      rg: u.rg,
      salario: sessao.permissoes.has(PERMISSAO_RH) ? u.salario : null,
      cep: u.cep,
      logradouro: u.logradouro,
      numero: u.numero,
      complemento: u.complemento,
      bairro: u.bairro,
      uf: u.uf,
      municipioIbge: u.municipioIbge,
      municipioNome: l.municipioNome,
      totem: u.totem,
      pinDefinido: u.senhaPdvHash !== null,
      estoques: await this.estoquesDoUsuario(db, id),
      admissao: u.admissao,
      demissao: u.demissao,
      vendedor: u.vendedor,
      entregador: u.entregador,
      tecnico: u.tecnico,
      pdvUtilitario: u.pdvUtilitario,
      comandaEletronica: u.comandaEletronica,
      observacoes: u.observacoes,
      lojas: await this.lojasDoUsuario(db, id),
      senhaProvisoria: u.senhaProvisoria,
      bloqueadoAte: u.bloqueadoAte && u.bloqueadoAte > new Date() ? u.bloqueadoAte.toISOString() : null,
      ultimoLoginEm: u.ultimoLoginEm?.toISOString() ?? null,
      criadoEm: u.criadoEm.toISOString(),
      atualizadoEm: u.atualizadoEm.toISOString(),
      atualizadoPorNome: l.autorNome,
      versao: u.versao,
    };
  }

  private async lojasDoUsuario(db: DbEmpresa, usuarioId: string): Promise<string[]> {
    const linhas = await db
      .select({ id: usuariosLojas.lojaId })
      .from(usuariosLojas)
      .where(and(eq(usuariosLojas.usuarioId, usuarioId), isNull(usuariosLojas.excluidoEm)));
    return linhas.map((l) => l.id);
  }

  /**
   * Lojas permitidas finais. Quem não é Master só concede/retira lojas a que ele mesmo tem acesso (ERP 11.2,
   * "Escalada"); as que ele não enxerga e o usuário já tinha são preservadas. Exige ao menos uma loja quando a
   * empresa já tem lojas ativas (antes do assistente da Fase 1 não existe nenhuma).
   */
  private async resolverLojas(
    tx: DbEmpresa,
    sessao: SessaoErp,
    informadas: readonly string[],
    atuais: readonly string[],
  ): Promise<string[]> {
    const pedidas = [...new Set(informadas)];
    const existentes = pedidas.length
      ? await tx
          .select({ id: lojas.id })
          .from(lojas)
          .where(and(inArray(lojas.id, pedidas), isNull(lojas.excluidoEm)))
      : [];
    if (existentes.length !== pedidas.length) {
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
        campos: { lojas: ['Loja inexistente ou excluída'] },
      });
    }
    const visiveis = sessao.lojas;
    if (visiveis !== null && pedidas.some((l) => !visiveis.includes(l))) {
      throw ErroApi.semPermissao('Você só pode conceder lojas às quais tem acesso.');
    }
    const preservadas = visiveis === null ? [] : atuais.filter((l) => !visiveis.includes(l));
    const finais = [...new Set([...preservadas, ...pedidas])];
    if (finais.length === 0) {
      const [ativas] = await tx
        .select({ n: count() })
        .from(lojas)
        .where(and(isNull(lojas.excluidoEm), eq(lojas.ativa, true)));
      if ((ativas?.n ?? 0) > 0) {
        throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
          campos: { lojas: ['Escolha ao menos uma loja'] },
        });
      }
    }
    return finais;
  }

  private async gravarLojas(
    tx: DbEmpresa,
    sessao: SessaoErp,
    usuarioId: string,
    antes: readonly string[],
    depois: readonly string[],
  ): Promise<void> {
    const remover = antes.filter((l) => !depois.includes(l));
    const incluir = depois.filter((l) => !antes.includes(l));
    if (remover.length) {
      await tx
        .update(usuariosLojas)
        .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
        .where(
          and(
            eq(usuariosLojas.usuarioId, usuarioId),
            inArray(usuariosLojas.lojaId, remover),
            isNull(usuariosLojas.excluidoEm),
          ),
        );
    }
    if (incluir.length) {
      await tx.insert(usuariosLojas).values(
        incluir.map((lojaId) => ({
          usuarioId,
          lojaId,
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })),
      );
    }
  }

  /** Quem não é Master só atribui um perfil cujas permissões ele mesmo tem (ERP 11.2, "Escalada"). */
  private async garantirPerfil(tx: DbEmpresa, sessao: SessaoErp, perfilId: string): Promise<void> {
    const [perfil] = await tx
      .select({ id: perfis.id })
      .from(perfis)
      .where(and(eq(perfis.id, perfilId), isNull(perfis.excluidoEm)));
    if (!perfil) {
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
        campos: { perfilId: ['Perfil inexistente ou excluído'] },
      });
    }
    if (sessao.master) return;
    const doPerfil = await tx
      .select({ p: perfisPermissoes.permissao })
      .from(perfisPermissoes)
      .where(and(eq(perfisPermissoes.perfilId, perfilId), isNull(perfisPermissoes.excluidoEm)));
    const faltando = doPerfil.map((r) => r.p).filter((p) => !sessao.permissoes.has(p));
    if (faltando.length) {
      throw new ErroApi(
        'SEM_PERMISSAO',
        'Você não pode atribuir um perfil com permissões que você não tem.',
        {
          detalhes: { permissoes: faltando },
        },
      );
    }
  }

  /** Deve existir ao menos um Master ativo por empresa (ERP 2.1). */
  private async garantirOutroMaster(tx: DbEmpresa, exceto: string): Promise<void> {
    const [outros] = await tx
      .select({ n: count() })
      .from(usuarios)
      .where(
        and(
          eq(usuarios.master, true),
          eq(usuarios.ativo, true),
          isNull(usuarios.excluidoEm),
          ne(usuarios.id, exceto),
          or(isNull(usuarios.demissao), sql`${usuarios.demissao} > ${hoje()}`),
        ),
      );
    if ((outros?.n ?? 0) === 0) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        'A empresa precisa de pelo menos um usuário Master ativo. Marque outro usuário como Master antes.',
      );
    }
  }

  private async garantirUnicos(
    tx: DbEmpresa,
    dados: { login: string; codigo?: number | undefined; cpf: string | null },
    exceto?: string,
  ): Promise<void> {
    const outro = exceto ? ne(usuarios.id, exceto) : undefined;
    const vivos = and(isNull(usuarios.excluidoEm), outro);
    const campos: Record<string, string[]> = {};
    const [login] = await tx
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(and(vivos, sql`lower(${usuarios.login}) = ${dados.login}`));
    if (login) campos.login = ['Já existe um usuário com este login'];
    if (dados.codigo !== undefined) {
      const [cod] = await tx
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(and(vivos, eq(usuarios.codigo, dados.codigo)));
      if (cod) campos.codigo = ['Já existe um usuário com este código'];
    }
    if (dados.cpf) {
      const [cpf] = await tx
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(and(vivos, eq(usuarios.cpf, dados.cpf)));
      if (cpf) campos.cpf = ['Já existe um usuário com este CPF'];
    }
    if (Object.keys(campos).length) {
      throw new ErroApi('CONFLITO', 'Já existe um usuário com estes dados.', { campos });
    }
  }

  private async conflito(tx: DbEmpresa, atual: LinhaUsuario): Promise<never> {
    const [autor] = atual.atualizadoPorId
      ? await tx.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, atual.atualizadoPorId))
      : [];
    throw new ErroApi('CONFLITO_VERSAO', 'Registro alterado por outro usuário. Recarregue e tente de novo.', {
      detalhes: {
        versaoAtual: atual.versao,
        alteradoPorId: atual.atualizadoPorId,
        alteradoPorNome: autor?.nome ?? null,
        alteradoEm: atual.atualizadoEm,
      },
    });
  }
}
