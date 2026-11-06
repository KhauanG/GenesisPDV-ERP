/**
 * "Esqueci minha senha" (ERP 4.3; MD 3.3.6 `redefinicoes_senha`, 3.1.10 `mensagens_enviadas`). A requisição só grava
 * a mensagem pendente e enfileira o envio (resposta sempre igual, exista ou não o usuário). O trabalhador gera o
 * token de uso único (1 h) — o segredo nunca é gravado em claro, nem na fila — e manda o e-mail com o link.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { MENSAGEM_ESQUECI_SENHA, type EsqueciSenha, type RedefinirSenha } from '@genesis/shared';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import { ErroApi } from '../comum/erros.js';
import type { Configuracao } from '../config/configuracao.js';
import {
  mensagensEnviadas,
  redefinicoesSenha,
  sessoesUsuario,
  usuarios,
} from '../database/empresa/schema/index.js';
import type { EnviadorEmail } from '../infra/email.js';
import { FILAS, type FilaTrabalhos } from '../infra/fila.js';
import { gerarHashSenha, verificarSenha } from '../seguranca/senhas.js';
import { gerarSegredo, sha256Hex } from '../seguranca/tokens.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { MetaRequisicao } from './auth.service.js';

export const TIPO_MENSAGEM_REDEFINICAO = 'redefinicao_senha';
const VALIDADE_MS = 60 * 60_000;
/** Pedido repetido para o mesmo usuário dentro desta janela não gera outro e-mail (anti-spam). */
const INTERVALO_MINIMO_MS = 2 * 60_000;

export class RedefinicaoSenha {
  constructor(
    private readonly config: Configuracao,
    private readonly tenancy: Tenancy,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaTrabalhos,
    private readonly email: EnviadorEmail,
  ) {}

  async solicitar(entrada: EsqueciSenha, _meta: MetaRequisicao): Promise<{ mensagem: string }> {
    const resposta = { mensagem: MENSAGEM_ESQUECI_SENHA };
    const empresa = await this.resolvedor.porCodigo(entrada.codigoEmpresa);
    if (!empresa || empresa.excluida || empresa.status !== 'ativa' || empresa.emManutencao) return resposta;
    const contexto = this.resolvedor.contexto(empresa);
    const mensagemId = await this.tenancy.executarNaEmpresa(contexto, () =>
      this.tenancy.cx().transacao(async (tx) => {
        const [u] = await tx
          .select()
          .from(usuarios)
          .where(and(sql`lower(${usuarios.login}) = ${entrada.login}`, isNull(usuarios.excluidoEm)));
        if (!u || !u.ativo || u.totem || !u.email) return null;
        if (u.demissao && u.demissao <= new Date().toISOString().slice(0, 10)) return null;
        const [recente] = await tx
          .select({ id: mensagensEnviadas.id })
          .from(mensagensEnviadas)
          .where(
            and(
              eq(mensagensEnviadas.templateTipo, TIPO_MENSAGEM_REDEFINICAO),
              eq(mensagensEnviadas.registroId, u.id),
              gt(mensagensEnviadas.criadoEm, new Date(Date.now() - INTERVALO_MINIMO_MS)),
            ),
          );
        if (recente) return null;
        const [m] = await tx
          .insert(mensagensEnviadas)
          .values({
            canal: 'email',
            destino: u.email,
            templateTipo: TIPO_MENSAGEM_REDEFINICAO,
            entidade: 'usuarios',
            registroId: u.id,
          })
          .returning({ id: mensagensEnviadas.id });
        return m!.id;
      }),
    );
    // Depois do commit: a fila nunca recebe trabalho de uma transação desfeita.
    if (mensagemId) await this.fila.enviar(FILAS.mensagem, { empresaId: empresa.id, mensagemId });
    return resposta;
  }

  async redefinir(entrada: RedefinirSenha, meta: MetaRequisicao): Promise<{ mensagem: string }> {
    const invalido = new ErroApi('VALIDACAO', 'Link de redefinição inválido ou expirado. Peça outro.', {
      campos: { token: ['Link inválido ou expirado'] },
    });
    const [codigo, segredo] = entrada.token.split('.') as [string, string];
    const empresa = await this.resolvedor.porCodigo(Number(codigo));
    if (!empresa || empresa.excluida) throw invalido;
    this.resolvedor.verificarAcessoErp(empresa, 'antes_credenciais');
    this.resolvedor.verificarAcessoErp(empresa, 'depois_credenciais');
    const hash = sha256Hex(segredo);
    const contexto = this.resolvedor.contexto(empresa);
    return this.tenancy.executarNaEmpresa(contexto, async () => {
      const cx = this.tenancy.cx();
      const [pedido] = await cx.consulta((db) =>
        db
          .select({ r: redefinicoesSenha, u: usuarios })
          .from(redefinicoesSenha)
          .innerJoin(usuarios, eq(usuarios.id, redefinicoesSenha.usuarioId))
          .where(eq(redefinicoesSenha.tokenHash, hash)),
      );
      if (!pedido || pedido.r.usadoEm || pedido.r.expiraEm <= new Date()) throw invalido;
      if (await verificarSenha(pedido.u.senhaHash, entrada.novaSenha)) {
        throw new ErroApi('VALIDACAO', 'A nova senha deve ser diferente da atual.', {
          campos: { novaSenha: ['Igual à atual'] },
        });
      }
      const novoHash = await gerarHashSenha(entrada.novaSenha);
      const ok = await cx.transacao(
        async (tx) => {
          // Uso único mesmo com dois cliques simultâneos no link.
          const [usado] = await tx
            .update(redefinicoesSenha)
            .set({ usadoEm: new Date(), ip: meta.ip })
            .where(
              and(
                eq(redefinicoesSenha.id, pedido.r.id),
                isNull(redefinicoesSenha.usadoEm),
                gt(redefinicoesSenha.expiraEm, new Date()),
              ),
            )
            .returning({ id: redefinicoesSenha.id });
          if (!usado) return false;
          await tx
            .update(usuarios)
            .set({
              senhaHash: novoHash,
              senhaProvisoria: false,
              senhaAlteradaEm: new Date(),
              tentativasFalhas: 0,
              bloqueadoAte: null,
            })
            .where(eq(usuarios.id, pedido.u.id));
          await tx
            .update(sessoesUsuario)
            .set({ encerradaEm: new Date(), motivoEncerramento: 'senha_alterada' })
            .where(and(eq(sessoesUsuario.usuarioId, pedido.u.id), isNull(sessoesUsuario.encerradaEm)));
          await this.auditoria.registrar(
            tx,
            {
              origem: 'erp',
              usuarioId: pedido.u.id,
              usuarioNome: pedido.u.nome,
              ip: meta.ip,
              userAgent: meta.userAgent,
              requisicaoId: meta.requisicaoId,
            },
            {
              acao: 'senha_redefinida',
              entidade: 'usuarios',
              registroId: pedido.u.id,
              localizacao: 'Redefinir senha',
              descricao: 'Senha redefinida pelo link enviado por e-mail',
            },
          );
          return true;
        },
        { travaVersao: true },
      );
      if (!ok) throw invalido;
      return { mensagem: 'Senha redefinida. Entre com a nova senha.' };
    });
  }

  /** Trabalhador da fila: gera o token, envia o e-mail e registra o resultado em `mensagens_enviadas`. */
  async enviarRedefinicao(empresaId: string, mensagemId: string): Promise<void> {
    const empresa = await this.resolvedor.porId(empresaId);
    if (!empresa || empresa.excluida) return;
    const contexto = this.resolvedor.contexto(empresa);
    await this.tenancy.executarNaEmpresa(contexto, async () => {
      const cx = this.tenancy.cx();
      const preparo = await cx.transacao(async (tx) => {
        const [m] = await tx
          .select()
          .from(mensagensEnviadas)
          .where(eq(mensagensEnviadas.id, mensagemId))
          .for('update');
        if (!m || m.status !== 'pendente' || !m.registroId) return null;
        const segredo = gerarSegredo();
        await tx.insert(redefinicoesSenha).values({
          usuarioId: m.registroId,
          tokenHash: sha256Hex(segredo),
          expiraEm: new Date(Date.now() + VALIDADE_MS),
        });
        await tx
          .update(mensagensEnviadas)
          .set({ tentativas: sql`${mensagensEnviadas.tentativas} + 1` })
          .where(eq(mensagensEnviadas.id, m.id));
        const [u] = await tx
          .select({ nome: usuarios.nome })
          .from(usuarios)
          .where(eq(usuarios.id, m.registroId));
        return { destino: m.destino, nome: u?.nome ?? '', token: `${empresa.codigo}.${segredo}` };
      });
      if (!preparo) return;
      const link = `${this.config.erpUrl}/redefinir-senha?token=${encodeURIComponent(preparo.token)}`;
      try {
        await this.email.enviar({
          para: preparo.destino,
          assunto: 'Redefinição de senha – GenesisPDV ERP',
          texto: [
            `Olá, ${preparo.nome}.`,
            '',
            `Recebemos um pedido para redefinir a sua senha do ERP (empresa ${empresa.codigo}).`,
            `Use o link abaixo em até 1 hora (ele vale uma única vez):`,
            link,
            '',
            'Se você não pediu, ignore este e-mail: a sua senha continua a mesma.',
          ].join('\n'),
        });
      } catch (e) {
        await cx.consulta((db) =>
          db
            .update(mensagensEnviadas)
            .set({ erro: (e as Error).message.slice(0, 2000) })
            .where(eq(mensagensEnviadas.id, mensagemId)),
        );
        throw e;
      }
      await cx.consulta((db) =>
        db
          .update(mensagensEnviadas)
          .set({ status: 'enviada', enviadaEm: new Date(), erro: null })
          .where(eq(mensagensEnviadas.id, mensagemId)),
      );
    });
  }
}
