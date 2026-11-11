/**
 * Handler do `alerta.cadastro` (SYNC 9.24, 10.1; bloco C7 da 1C): o caixa avisa o ERP de um produto com cadastro que
 * impede ou atrapalha a venda (NCM ou GTIN rejeitado, tributação, unidade não fracionável na balança, sem preço, o
 * mesmo código de barras em dois produtos). Vira um `alertas` do tipo `CADASTRO_PRODUTO` (o `tipo_alerta` do caixa vai
 * no título e em `dados`), deduplicado por `chave_deduplicacao = 'cadastro:<tipo_alerta>:<produto_id>'`: com o alerta
 * aberto, o caixa que avisa de novo (o mesmo ou outro) não repete. O cadastro é da empresa e a chave também: o alerta
 * nasce com `loja_id` nulo (todo gerente com acesso a alertas o vê, como o da ativação por força bruta), e as lojas que
 * avisaram ficam em `dados.lojas` (a primeira em `dados.loja_id`; o aviso de outra loja com o alerta aberto entra na
 * lista). Produto ou variação que nunca existiu na empresa → `REFERENCIA_INEXISTENTE` (o excluído existe e é aceito).
 */
import {
  payloadAlertaCadastroSchema,
  type PayloadAlertaCadastro,
  type TIPOS_ALERTA_CADASTRO,
} from '@genesis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alertas } from '../../database/empresa/schema/index.js';
import type { DbEmpresa } from '../../tenancy/tenancy.js';
import type { TerminalDoEvento } from '../aplicacao.js';
import { ErroRegraEvento } from '../erros.js';
import { gravarAlerta, registrarAuditoriaPdv, type CatalogoHandlers, type ContextoHandler } from './comum.js';

/** SYNC 9.24: um tipo de alerta para todos os avisos de cadastro do caixa; o motivo vai em `dados.tipo_alerta`. */
export const ALERTA_CADASTRO_PRODUTO = 'CADASTRO_PRODUTO';

/**
 * Localização da auditoria do aviso (entidade `produtos`, ação `criar`): o aviso não muda o cadastro, e o Histórico de
 * produtos (F2-B42, decisão 188) o deixa de fora por ela.
 */
export const LOCALIZACAO_ALERTA_CADASTRO_PDV = 'PDV › Alerta de cadastro';

const TITULOS: Record<(typeof TIPOS_ALERTA_CADASTRO)[number], string> = {
  ncm_rejeitado: 'NCM rejeitado',
  gtin_rejeitado: 'GTIN rejeitado',
  tributacao_rejeitada: 'Tributação rejeitada',
  unidade_nao_fracionavel_balanca: 'Unidade não fracionável na balança',
  produto_sem_preco: 'Produto sem preço',
  ean_duplicado_no_caixa: 'Código de barras em dois produtos',
};

const minusculo = (v: string) => v.toLowerCase();

interface AlertaPreparado {
  nome: string;
}

/** Só lendo: o produto (e a variação) existem na empresa, mesmo excluídos. */
async function prepararAlerta({ tx }: ContextoHandler, p: PayloadAlertaCadastro): Promise<AlertaPreparado> {
  const produtoId = minusculo(p.produto_id);
  const { rows } = await tx.execute<{ nome: string }>(sql`select nome from produtos where id = ${produtoId}`);
  if (!rows[0]) {
    throw new ErroRegraEvento('REFERENCIA_INEXISTENTE', 'Produto do alerta inexistente na empresa.', {
      produtos: [produtoId],
    });
  }
  if (p.variacao_id) {
    const { rows: variacoes } = await tx.execute<{ id: string }>(sql`
      select id from produtos_variacoes where id = ${minusculo(p.variacao_id)} and produto_id = ${produtoId}`);
    if (!variacoes[0]) {
      throw new ErroRegraEvento('REFERENCIA_INEXISTENTE', 'Variação do alerta inexistente no produto.', {
        variacao_id: minusculo(p.variacao_id),
      });
    }
  }
  return { nome: rows[0].nome };
}

/** O alerta de cadastro de um produto (o do caixa, SYNC 9.24, ou o que a nuvem abre ao receber a venda, F2-B34). */
export interface AlertaCadastro {
  /** Vai em `dados.tipo_alerta` e na chave `cadastro:<tipo_alerta>:<produto_id>`. */
  tipoAlerta: string;
  titulo: string;
  mensagem: string;
  produtoId: string;
  variacaoId: string | null;
  detalhes: Record<string, unknown>;
}

/**
 * Abre o `CADASTRO_PRODUTO` da empresa (`loja_id` nulo) deduplicado por `cadastro:<tipo_alerta>:<produto_id>`; com o
 * alerta já aberto, a loja do terminal entra em `dados.lojas` (uma vez). Devolve se o alerta é novo.
 */
export async function abrirAlertaCadastro(
  tx: DbEmpresa,
  terminal: TerminalDoEvento,
  a: AlertaCadastro,
): Promise<boolean> {
  const chave = `cadastro:${a.tipoAlerta}:${a.produtoId}`;
  const novo = await gravarAlerta(tx, {
    tipo: ALERTA_CADASTRO_PRODUTO,
    severidade: 'aviso',
    titulo: a.titulo.slice(0, 150),
    mensagem: a.mensagem,
    lojaId: null,
    entidade: 'produtos',
    registroId: a.produtoId,
    dados: {
      tipo_alerta: a.tipoAlerta,
      produto_id: a.produtoId,
      variacao_id: a.variacaoId,
      loja_id: terminal.lojaId,
      lojas: [terminal.lojaId],
      terminal_id: terminal.terminalId,
      detalhes: a.detalhes,
    },
    chaveDeduplicacao: chave,
  });
  if (!novo) {
    // O alerta aberto é o mesmo para a empresa: a loja que avisa agora entra na lista (uma vez).
    await tx
      .update(alertas)
      .set({
        dados: sql`jsonb_set(coalesce(${alertas.dados}, '{}'::jsonb), '{lojas}',
          coalesce(${alertas.dados} -> 'lojas', '[]'::jsonb) || to_jsonb(${terminal.lojaId}::text))`,
      })
      .where(
        and(
          eq(alertas.chaveDeduplicacao, chave),
          isNull(alertas.resolvidoEm),
          isNull(alertas.excluidoEm),
          sql`not (coalesce(${alertas.dados} -> 'lojas', '[]'::jsonb) ? ${terminal.lojaId})`,
        ),
      );
  }
  return novo;
}

async function aplicarAlerta(ctx: ContextoHandler, p: PayloadAlertaCadastro, prep: AlertaPreparado) {
  const { tx, terminal } = ctx;
  const produtoId = minusculo(p.produto_id);
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const titulo = TITULOS[p.tipo_alerta];
  const novo = await abrirAlertaCadastro(tx, terminal, {
    tipoAlerta: p.tipo_alerta,
    titulo: `${titulo}: ${prep.nome}`,
    mensagem: `${p.descricao} (avisado pelo caixa ${caixa}). Corrija o cadastro do produto no ERP.`,
    produtoId,
    variacaoId: p.variacao_id ? minusculo(p.variacao_id) : null,
    detalhes: p.detalhes,
  });
  await registrarAuditoriaPdv(ctx, {
    entidade: 'produtos',
    registroId: produtoId,
    acao: 'criar',
    localizacao: LOCALIZACAO_ALERTA_CADASTRO_PDV,
    descricao: `${titulo} avisado pelo caixa ${caixa}: ${p.descricao}`,
    depois: { tipo_alerta: p.tipo_alerta, alerta_novo: novo, detalhes: p.detalhes },
  });
  return { alerta: novo ? 'criado' : 'ja_aberto', tipo_alerta: p.tipo_alerta };
}

export const HANDLERS_ALERTA: CatalogoHandlers = {
  'alerta.cadastro': {
    1: {
      schema: payloadAlertaCadastroSchema,
      preparar: prepararAlerta,
      aplicar: aplicarAlerta,
    },
  },
};
