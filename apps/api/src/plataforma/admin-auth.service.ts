import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  MENSAGEM_CREDENCIAIS_PLATAFORMA_INVALIDAS,
  type LoginPlataforma,
  type PapelAdmin,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { ErroApi } from '../comum/erros.js';
import type { Configuracao } from '../config/configuracao.js';
import type { BancoControle, DbControle } from '../database/controle/conexao.js';
import { adminsPlataforma, sessoesAdmin } from '../database/controle/schema.js';
import type { Cifra } from '../seguranca/cifra.js';
import type { AssinadorJwt } from '../seguranca/jwt.js';
import { gerarHashSenha, gerarSenhaProvisoria, verificarSenha } from '../seguranca/senhas.js';
import { gerarSegredo, sha256Hex } from '../seguranca/tokens.js';
import { gerarSegredoTotp, uriTotp, verificarTotp } from '../seguranca/totp.js';
import { registrarAuditoriaPlataforma } from './auditoria-plataforma.js';

export const AAD_TOTP = 'admins_plataforma.totp_segredo_cifrado';

/** Atualizar `ultimo_uso_em` no máximo uma vez por minuto por sessão (atividade real, não o refresh). */
const INTERVALO_ATIVIDADE_MS = 60_000;

export interface ClaimsPlataforma {
  sub: string;
  papel: PapelAdmin;
  sid: string;
}

export interface SessaoPlataforma {
  adminId: string;
  nome: string;
  email: string;
  papel: PapelAdmin;
  sessaoId: string;
}

export interface ResultadoLoginPlataforma {
  tokenAcesso: string;
  expiraEm: string;
  admin: { id: string; nome: string; email: string; papel: PapelAdmin };
  refreshToken: string;
  refreshExpiraEm: Date;
}

type LinhaAdmin = typeof adminsPlataforma.$inferSelect;
type Meta = { ip: string | null; userAgent: string | null };

/** Negação decidida dentro da transação: o commit grava contador/auditoria e só depois o erro sobe. */
class Negado {
  constructor(readonly erro: ErroApi) {}
}

/** Login da equipe Genesis com 2FA TOTP obrigatório (ERP 19.1), sessão própria e auditoria na plataforma. */
export class AdminAuthService {
  constructor(
    private readonly config: Configuracao,
    private readonly controle: BancoControle,
    private readonly cifra: Cifra,
    private readonly jwt: AssinadorJwt,
  ) {}

  /** Usado pelo CLI `admin:criar`: devolve senha (se gerada) e segredo TOTP para cadastrar no autenticador. */
  async criarAdmin(entrada: { nome: string; email: string; papel: PapelAdmin; senha?: string }): Promise<{
    id: string;
    senha: string;
    totpSegredo: string;
    totpUri: string;
  }> {
    const senha = entrada.senha ?? gerarSenhaProvisoria(16);
    const totpSegredo = gerarSegredoTotp();
    const email = entrada.email.trim().toLowerCase();
    const [admin] = await this.controle.db
      .insert(adminsPlataforma)
      .values({
        nome: entrada.nome,
        email,
        senhaHash: await gerarHashSenha(senha),
        papel: entrada.papel,
        totpSegredoCifrado: this.cifra.cifrar(totpSegredo, AAD_TOTP),
        totpAtivo: true,
      })
      .returning({ id: adminsPlataforma.id });
    await registrarAuditoriaPlataforma(this.controle.db, {
      acao: 'admin_criado',
      entidade: 'admins_plataforma',
      registroId: admin!.id,
      depois: { nome: entrada.nome, email, papel: entrada.papel },
    });
    return { id: admin!.id, senha, totpSegredo, totpUri: uriTotp(email, totpSegredo) };
  }

  async login(entrada: LoginPlataforma, meta: Meta): Promise<ResultadoLoginPlataforma> {
    const invalido = ErroApi.naoAutenticado(MENSAGEM_CREDENCIAIS_PLATAFORMA_INVALIDAS);
    const bloqueado = ErroApi.naoAutenticado('Acesso bloqueado temporariamente. Tente novamente mais tarde.');
    const [lido] = await this.controle.db
      .select()
      .from(adminsPlataforma)
      .where(
        and(sql`lower(${adminsPlataforma.email}) = ${entrada.email}`, isNull(adminsPlataforma.excluidoEm)),
      );
    const auditarNegacao = (db: DbControle, motivo: string, adminId: string | null) =>
      registrarAuditoriaPlataforma(db, {
        adminId,
        acao: 'login_negado',
        entidade: 'admins_plataforma',
        registroId: adminId,
        depois: { email: entrada.email, motivo },
        ip: meta.ip,
      });
    if (!lido) {
      await verificarSenha(null, entrada.senha);
      await auditarNegacao(this.controle.db, 'email_desconhecido', null);
      throw invalido;
    }
    // Pré-filtro barato; a decisão vale pela linha travada abaixo.
    if (lido.bloqueadoAte && lido.bloqueadoAte > new Date()) {
      await auditarNegacao(this.controle.db, 'bloqueado', lido.id);
      throw bloqueado;
    }
    // argon2 (CPU) fora da transação; o TOTP (HMAC, barato) é conferido com a linha travada.
    const senhaOk = await verificarSenha(lido.senhaHash, entrada.senha);

    const r = await this.controle.transacao(async (tx) => {
      const negar = async (motivo: string, erro = invalido) => {
        await auditarNegacao(tx, motivo, lido.id);
        return new Negado(erro);
      };
      const [admin] = await tx
        .select()
        .from(adminsPlataforma)
        .where(eq(adminsPlataforma.id, lido.id))
        .for('update');
      if (!admin || admin.excluidoEm) return negar('email_desconhecido');
      // Requisições em paralelo: quem chega depois do bloqueio é recusado mesmo com a senha certa.
      if (admin.bloqueadoAte && admin.bloqueadoAte > new Date()) return negar('bloqueado', bloqueado);
      const passoTotp =
        senhaOk && admin.senhaHash === lido.senhaHash && admin.totpAtivo && admin.totpSegredoCifrado
          ? await verificarTotp(
              this.cifra.decifrarTexto(admin.totpSegredoCifrado, AAD_TOTP),
              entrada.codigoTotp,
              admin.totpUltimoPasso,
            )
          : null;
      if (passoTotp === null) {
        const [{ tentativas }] = (await tx
          .update(adminsPlataforma)
          .set({ tentativasFalhas: sql`${adminsPlataforma.tentativasFalhas} + 1` })
          .where(eq(adminsPlataforma.id, admin.id))
          .returning({ tentativas: adminsPlataforma.tentativasFalhas })) as [{ tentativas: number }];
        if (tentativas >= this.config.login.maxTentativas) {
          await tx
            .update(adminsPlataforma)
            .set({
              tentativasFalhas: 0,
              bloqueadoAte: new Date(Date.now() + this.config.login.bloqueioMinutos * 60_000),
            })
            .where(eq(adminsPlataforma.id, admin.id));
          await registrarAuditoriaPlataforma(tx, {
            adminId: admin.id,
            acao: 'admin_bloqueado',
            entidade: 'admins_plataforma',
            registroId: admin.id,
            depois: { tentativas, minutos: this.config.login.bloqueioMinutos },
            ip: meta.ip,
          });
        }
        return negar(senhaOk ? 'totp_invalido' : 'senha_invalida');
      }
      if (!admin.ativo) return negar('inativo');

      await tx
        .update(adminsPlataforma)
        .set({
          tentativasFalhas: 0,
          bloqueadoAte: null,
          ultimoLoginEm: new Date(),
          totpUltimoPasso: passoTotp,
        })
        .where(eq(adminsPlataforma.id, admin.id));
      const sessao = await this.criarSessao(tx, admin.id, uuidv7(), meta);
      await registrarAuditoriaPlataforma(tx, {
        adminId: admin.id,
        acao: 'login',
        entidade: 'admins_plataforma',
        registroId: admin.id,
        ip: meta.ip,
      });
      return { admin, sessao };
    });
    if (r instanceof Negado) throw r.erro;
    return this.montar(r.admin, r.sessao.id, r.sessao.segredo, r.sessao.expiraEm);
  }

  /**
   * Rotação do refresh numa transação com a linha travada: duas requisições com o mesmo cookie nunca geram duas
   * sessões. Cookie já rotacionado fora da janela de tolerância = reuso (roubo provável) → todas as sessões do admin
   * são encerradas e auditadas.
   */
  async refresh(token: string | undefined, meta: Meta): Promise<ResultadoLoginPlataforma> {
    if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) throw ErroApi.naoAutenticado();
    const hash = sha256Hex(token);
    const r = await this.controle.transacao(async (tx) => {
      const [s] = await tx
        .select()
        .from(sessoesAdmin)
        .where(eq(sessoesAdmin.refreshTokenHash, hash))
        .for('update');
      if (!s) return new Negado(ErroApi.naoAutenticado());
      if (s.encerradaEm) {
        if (s.motivoEncerramento !== 'rotacionada') return new Negado(ErroApi.naoAutenticado());
        const tolerancia = this.config.sessao.toleranciaRefreshSegundos * 1000;
        const recente = Date.now() - s.encerradaEm.getTime() <= tolerancia;
        if (recente && (await this.familiaAberta(tx, s.familiaId)))
          return new Negado(ErroApi.refreshConcorrente());
        await tx
          .update(sessoesAdmin)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'reuso_detectado' })
          .where(and(eq(sessoesAdmin.adminId, s.adminId), isNull(sessoesAdmin.encerradaEm)));
        await registrarAuditoriaPlataforma(tx, {
          adminId: s.adminId,
          acao: 'token_anterior_reutilizado',
          entidade: 'sessoes_admin',
          registroId: s.id,
          depois: { motivo: 'reuso de refresh token rotacionado: todas as sessões encerradas' },
          ip: meta.ip,
        });
        return new Negado(ErroApi.naoAutenticado());
      }
      const inatividade = this.config.sessao.inatividadeAdminMinutos * 60_000;
      const ultimaAtividade = (s.ultimoUsoEm ?? s.criadoEm).getTime();
      if (s.expiraEm <= new Date() || Date.now() - ultimaAtividade > inatividade) {
        await tx
          .update(sessoesAdmin)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'expirada' })
          .where(eq(sessoesAdmin.id, s.id));
        return new Negado(ErroApi.naoAutenticado());
      }
      const [admin] = await tx.select().from(adminsPlataforma).where(eq(adminsPlataforma.id, s.adminId));
      if (!admin || !admin.ativo || admin.excluidoEm) {
        await tx
          .update(sessoesAdmin)
          .set({ encerradaEm: new Date(), motivoEncerramento: 'encerrada_admin' })
          .where(eq(sessoesAdmin.id, s.id));
        return new Negado(ErroApi.naoAutenticado());
      }
      await tx
        .update(sessoesAdmin)
        .set({ encerradaEm: new Date(), motivoEncerramento: 'rotacionada' })
        .where(eq(sessoesAdmin.id, s.id));
      // A sucessora herda família, expiração absoluta e a última atividade real (o refresh não conta como uso).
      const nova = await this.criarSessao(
        tx,
        admin.id,
        s.familiaId,
        meta,
        s.expiraEm,
        s.ultimoUsoEm ?? s.criadoEm,
      );
      return { admin, nova };
    });
    if (r instanceof Negado) throw r.erro;
    return this.montar(r.admin, r.nova.id, r.nova.segredo, r.nova.expiraEm);
  }

  async logout(token: string | undefined, ip: string | null): Promise<void> {
    if (!token) return;
    await this.controle.transacao(async (tx) => {
      const [s] = await tx
        .update(sessoesAdmin)
        .set({ encerradaEm: new Date(), motivoEncerramento: 'logout' })
        .where(and(eq(sessoesAdmin.refreshTokenHash, sha256Hex(token)), isNull(sessoesAdmin.encerradaEm)))
        .returning();
      if (!s) return;
      await registrarAuditoriaPlataforma(tx, {
        adminId: s.adminId,
        acao: 'logout',
        entidade: 'admins_plataforma',
        registroId: s.adminId,
        ip,
      });
    });
  }

  /**
   * Valida o token de acesso. A sessão do token precisa estar aberta, ou ter sido só rotacionada com a família
   * ainda viva (logout, reuso, inatividade e expiração encerram a família inteira). Também mede a inatividade pela
   * última requisição real e a registra (no máximo 1×/min).
   */
  async autenticar(token: string): Promise<SessaoPlataforma | null> {
    const c = await this.jwt.verificar<ClaimsPlataforma & { [k: string]: unknown }>(token);
    if (!c || typeof c.sid !== 'string' || typeof c.sub !== 'string') return null;
    const [linha] = await this.controle.db
      .select({ admin: adminsPlataforma, sessao: sessoesAdmin })
      .from(sessoesAdmin)
      .innerJoin(adminsPlataforma, eq(adminsPlataforma.id, sessoesAdmin.adminId))
      .where(eq(sessoesAdmin.id, c.sid));
    if (!linha || linha.admin.id !== c.sub || !linha.admin.ativo || linha.admin.excluidoEm) return null;
    const { sessao } = linha;
    if (sessao.encerradaEm && sessao.motivoEncerramento !== 'rotacionada') return null;
    const aberta = sessao.encerradaEm ? await this.familiaAberta(this.controle.db, sessao.familiaId) : sessao;
    if (!aberta || aberta.expiraEm <= new Date()) return null;
    const ultimaAtividade = (aberta.ultimoUsoEm ?? aberta.criadoEm).getTime();
    if (Date.now() - ultimaAtividade > this.config.sessao.inatividadeAdminMinutos * 60_000) {
      await this.controle.db
        .update(sessoesAdmin)
        .set({ encerradaEm: new Date(), motivoEncerramento: 'expirada' })
        .where(and(eq(sessoesAdmin.id, aberta.id), isNull(sessoesAdmin.encerradaEm)));
      return null;
    }
    if (Date.now() - ultimaAtividade > INTERVALO_ATIVIDADE_MS) {
      await this.controle.db
        .update(sessoesAdmin)
        .set({ ultimoUsoEm: new Date() })
        .where(and(eq(sessoesAdmin.id, aberta.id), isNull(sessoesAdmin.encerradaEm)));
    }
    return {
      adminId: linha.admin.id,
      nome: linha.admin.nome,
      email: linha.admin.email,
      papel: linha.admin.papel as PapelAdmin,
      sessaoId: c.sid,
    };
  }

  private async familiaAberta(db: DbControle, familiaId: string) {
    const [aberta] = await db
      .select()
      .from(sessoesAdmin)
      .where(and(eq(sessoesAdmin.familiaId, familiaId), isNull(sessoesAdmin.encerradaEm)))
      .limit(1);
    return aberta ?? null;
  }

  private async criarSessao(
    db: DbControle,
    adminId: string,
    familiaId: string,
    meta: Meta,
    expiraEm?: Date,
    ultimoUsoEm?: Date,
  ) {
    const segredo = gerarSegredo();
    const expira = expiraEm ?? new Date(Date.now() + this.config.sessao.refreshDias * 86_400_000);
    const [s] = await db
      .insert(sessoesAdmin)
      .values({
        adminId,
        familiaId,
        refreshTokenHash: sha256Hex(segredo),
        expiraEm: expira,
        ultimoUsoEm: ultimoUsoEm ?? new Date(),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
      })
      .returning({ id: sessoesAdmin.id });
    return { id: s!.id, segredo, expiraEm: expira };
  }

  private async montar(
    admin: LinhaAdmin,
    sessaoId: string,
    segredo: string,
    refreshExpiraEm: Date,
  ): Promise<ResultadoLoginPlataforma> {
    const papel = admin.papel as PapelAdmin;
    const { token, expiraEm } = await this.jwt.assinar({ sub: admin.id, papel, sid: sessaoId });
    return {
      tokenAcesso: token,
      expiraEm: expiraEm.toISOString(),
      admin: { id: admin.id, nome: admin.nome, email: admin.email, papel },
      refreshToken: segredo,
      refreshExpiraEm,
    };
  }
}
