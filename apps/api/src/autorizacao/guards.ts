import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PapelAdmin } from '@genesis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { sessaoAbertaDaFamilia, type SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { sessoesUsuario, usuarios } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import { SQL_GERACAO_PERMISSOES } from './permissoes-efetivas.js';
import { META_PERMISSOES, META_PLATAFORMA, META_PUBLICO, META_SENHA_PROVISORIA } from './decorators.js';

/** `ultimo_uso_em` é gravado no máximo uma vez por minuto por sessão. */
const INTERVALO_ATIVIDADE_MS = 60_000;

function tokenBearer(req: RequisicaoGenesis): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

/**
 * Autentica toda rota não pública. ERP: token de audiência `erp` → empresa pelo `eid` (o `emp` precisa bater) →
 * `ContextoEmpresa` da requisição. Não existe parâmetro de rota/cabeçalho que escolha a empresa: ela sai só do
 * token assinado, então um token da empresa A nunca alcança o banco da empresa B.
 */
@Injectable()
export class AutenticacaoGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SERVICOS) private readonly s: Servicos,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const alvos = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(META_PUBLICO, alvos)) return true;
    const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
    const token = tokenBearer(req);
    if (!token) throw ErroApi.naoAutenticado();

    const papeis = this.reflector.getAllAndOverride<PapelAdmin[] | undefined>(META_PLATAFORMA, alvos);
    if (papeis !== undefined) {
      const sessao = await this.s.adminAuth.autenticar(token);
      if (!sessao) throw ErroApi.naoAutenticado();
      if (papeis.length > 0 && sessao.papel !== 'superadmin' && !papeis.includes(sessao.papel)) {
        throw ErroApi.semPermissao('Seu papel na plataforma não permite esta ação.');
      }
      req.sessaoPlataforma = sessao;
      return true;
    }

    const claims = await this.s.auth.verificarToken(token);
    if (!claims) throw ErroApi.naoAutenticado();
    const empresa = await this.s.resolvedor.porId(claims.eid);
    if (!empresa || empresa.codigo !== claims.emp) throw ErroApi.naoAutenticado();
    this.s.resolvedor.verificarAcessoErp(empresa, 'antes_credenciais');
    this.s.resolvedor.verificarAcessoErp(empresa, 'depois_credenciais');
    const contexto = this.s.resolvedor.contexto(empresa);

    const inatividadeMs = this.s.config.sessao.inatividadeMinutos * 60_000;
    const sessao = await this.s.tenancy.executarNaEmpresa(contexto, () =>
      this.s.tenancy.cx().consulta(async (db): Promise<SessaoErp | null> => {
        const [linha] = await db
          .select({ u: usuarios, s: sessoesUsuario, geracao: SQL_GERACAO_PERMISSOES })
          .from(usuarios)
          .innerJoin(
            sessoesUsuario,
            and(eq(sessoesUsuario.id, claims.sid), eq(sessoesUsuario.usuarioId, usuarios.id)),
          )
          .where(eq(usuarios.id, claims.sub));
        if (!linha || !this.s.auth.usuarioPodeEntrar(linha.u)) return null;
        // Token emitido antes de uma rotação continua valendo até expirar, mas só enquanto a família tiver sessão
        // aberta: logout, troca de senha, reuso, inatividade e encerramento pelo admin derrubam a família inteira.
        if (linha.s.encerradaEm && linha.s.motivoEncerramento !== 'rotacionada') return null;
        const aberta = linha.s.encerradaEm ? await sessaoAbertaDaFamilia(db, linha.s.familiaId) : linha.s;
        if (!aberta || aberta.expiraEm <= new Date()) return null;
        // Inatividade (ERP 4.1) medida pela última requisição real; o refresh agendado do navegador não conta.
        const ociosoMs = Date.now() - (aberta.ultimoUsoEm ?? aberta.criadoEm).getTime();
        if (ociosoMs > inatividadeMs) {
          await db
            .update(sessoesUsuario)
            .set({ encerradaEm: new Date(), motivoEncerramento: 'expirada' })
            .where(and(eq(sessoesUsuario.id, aberta.id), isNull(sessoesUsuario.encerradaEm)));
          return null;
        }
        if (ociosoMs > INTERVALO_ATIVIDADE_MS) {
          await db
            .update(sessoesUsuario)
            .set({ ultimoUsoEm: sql`now()` })
            .where(and(eq(sessoesUsuario.id, aberta.id), isNull(sessoesUsuario.encerradaEm)));
        }
        const acesso = await this.s.permissoes.obter(db, empresa.id, linha.u, linha.geracao);
        return {
          usuarioId: linha.u.id,
          usuarioNome: linha.u.nome,
          login: linha.u.login,
          codigo: linha.u.codigo,
          master: linha.u.master,
          senhaProvisoria: linha.u.senhaProvisoria,
          sessaoId: claims.sid,
          permissoes: acesso.permissoes,
          lojas: acesso.lojas,
          estoques: acesso.estoques,
          limiteDescontoPct: linha.u.limiteDescontoPct,
          empresa: contexto,
        };
      }),
    );
    if (!sessao) throw ErroApi.naoAutenticado();
    if (sessao.senhaProvisoria && !this.reflector.getAllAndOverride<boolean>(META_SENHA_PROVISORIA, alvos)) {
      throw new ErroApi('TROCA_SENHA_OBRIGATORIA', 'Troque a senha provisória para continuar.');
    }
    req.sessao = sessao;
    req.contextoEmpresa = contexto;
    return true;
  }
}

/** `@Permissao(...)`: exige todas as permissões listadas (a API é a fonte da verdade, ERP 2.2). */
@Injectable()
export class PermissaoGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const exigidas = this.reflector.getAllAndOverride<string[] | undefined>(META_PERMISSOES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!exigidas?.length) return true;
    const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
    if (!req.sessao) throw ErroApi.semPermissao();
    const faltando = exigidas.filter((p) => !req.sessao!.permissoes.has(p));
    if (faltando.length) {
      throw new ErroApi('SEM_PERMISSAO', 'Você não tem permissão para esta ação.', {
        detalhes: { permissoes: faltando },
      });
    }
    return true;
  }
}
