import * as contrato from '@genesis/shared';
import { getTableColumns, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as caixa from '../database/empresa/schema/caixa.js';
import * as financeiro from '../database/empresa/schema/financeiro.js';
import * as vendas from '../database/empresa/schema/vendas.js';

/**
 * Contrato dos payloads (`@genesis/shared`, `sync/eventos.ts`) × tabelas da 0012 (decisão técnica T17 da 1C): cada
 * linha do payload leva as colunas da tabela, menos as padrão e as de `COLUNAS_FORA_DO_PAYLOAD`, e cada `z.enum` ou
 * `z.literal` das linhas repete a lista do CHECK da coluna (`CHECKS`). Coluna nova na migração sem o campo no contrato
 * (ou o contrário), ou um valor a mais num lado só, quebra aqui, antes de virar `PAYLOAD_INVALIDO` ou 23514 no handler.
 */
const PADRAO = ['criado_em', 'atualizado_em', 'excluido_em', 'versao', 'criado_por_id', 'atualizado_por_id'];

/** Tira `optional`/`nullable`/`default` e o array até o objeto da linha. */
function linha(s: z.ZodType): z.ZodObject {
  let atual: z.ZodType = s;
  for (;;) {
    if (atual instanceof z.ZodObject) return atual;
    if (
      atual instanceof z.ZodOptional ||
      atual instanceof z.ZodNullable ||
      atual instanceof z.ZodDefault ||
      atual instanceof z.ZodPrefault
    ) {
      atual = atual.unwrap() as z.ZodType;
    } else if (atual instanceof z.ZodArray) {
      atual = atual.element as z.ZodType;
    } else {
      throw new Error(`sem objeto em ${atual.constructor.name}`);
    }
  }
}

const bloco = (payload: z.ZodType, chave: string) => linha(linha(payload).shape[chave] as z.ZodType);

const TABELAS: Array<[keyof typeof contrato.COLUNAS_FORA_DO_PAYLOAD | string, Table, z.ZodObject, string[]]> =
  [
    ['vendas', vendas.vendas, bloco(contrato.payloadVendaFinalizadaSchema, 'vendas'), []],
    [
      'itens_venda',
      vendas.itensVenda,
      bloco(contrato.payloadVendaFinalizadaSchema, 'itens_venda'),
      ['componentes_estoque'],
    ],
    [
      'itens_venda_complementos',
      vendas.itensVendaComplementos,
      bloco(contrato.payloadVendaFinalizadaSchema, 'itens_venda_complementos'),
      [],
    ],
    [
      'pagamentos_venda',
      vendas.pagamentosVenda,
      bloco(contrato.payloadVendaFinalizadaSchema, 'pagamentos_venda'),
      [],
    ],
    [
      'parcelas_venda',
      vendas.parcelasVenda,
      bloco(contrato.payloadVendaFinalizadaSchema, 'parcelas_venda'),
      [],
    ],
    [
      'transacoes_tef',
      vendas.transacoesTef,
      bloco(contrato.payloadVendaFinalizadaSchema, 'transacoes_tef'),
      [],
    ],
    ['cobrancas_pix', vendas.cobrancasPix, bloco(contrato.payloadVendaFinalizadaSchema, 'cobrancas_pix'), []],
    ['sessoes_caixa', caixa.sessoesCaixa, bloco(contrato.payloadCaixaAbertoSchema, 'sessoes_caixa'), []],
    [
      'movimentos_caixa',
      caixa.movimentosCaixa,
      bloco(contrato.payloadCaixaSangriaSchema, 'movimentos_caixa'),
      [],
    ],
    [
      'fechamentos_caixa',
      caixa.fechamentosCaixa,
      bloco(contrato.payloadCaixaFechadoSchema, 'fechamentos_caixa'),
      [],
    ],
    [
      'fechamentos_caixa_formas',
      caixa.fechamentosCaixaFormas,
      bloco(contrato.payloadCaixaFechadoSchema, 'fechamentos_caixa_formas'),
      [],
    ],
    [
      'movimentos_vasilhame',
      caixa.movimentosVasilhame,
      bloco(contrato.payloadVasilhameMovimentadoSchema, 'movimentos_vasilhame'),
      [],
    ],
  ];

/**
 * Lista do CHECK de cada coluna com enum no contrato (`tabela.coluna`), a mesma constante que o Drizzle usa no
 * `check(...)` da 0012. `tipo_forma` não tem CHECK nas tabelas da venda e do fechamento (é snapshot), mas vem de
 * `formas_pagamento.tipo_forma` (`ck_formas_pagamento_tipo_forma`).
 */
const CHECKS: Record<string, readonly string[]> = {
  'vendas.tipo': vendas.TIPOS_VENDA,
  'vendas.canal': vendas.CANAIS_VENDA,
  'vendas.modo': vendas.MODOS_VENDA,
  'vendas.status': vendas.STATUS_VENDA,
  'vendas.status_fiscal': vendas.STATUS_FISCAL_VENDA,
  'vendas.devolucao': vendas.DEVOLUCOES_VENDA,
  'vendas.tipo_preco': vendas.TIPOS_PRECO_VENDA,
  'vendas.desconto_total_origem': vendas.ORIGENS_DESCONTO_TOTAL_VENDA,
  'vendas.cancelamento_origem': vendas.ORIGENS_CANCELAMENTO_VENDA,
  'itens_venda.origem_preco': vendas.ORIGENS_PRECO_ITEM,
  'itens_venda.origem_entrada': vendas.ORIGENS_ENTRADA_ITEM,
  'pagamentos_venda.status': vendas.STATUS_PAGAMENTO_VENDA,
  'pagamentos_venda.tipo_forma': financeiro.TIPOS_FORMA_PAGAMENTO,
  'transacoes_tef.operacao': vendas.OPERACOES_TRANSACAO_TEF,
  'transacoes_tef.status': vendas.STATUS_TRANSACAO_TEF,
  'cobrancas_pix.tipo': vendas.TIPOS_COBRANCA_PIX,
  'cobrancas_pix.status': vendas.STATUS_COBRANCA_PIX,
  'sessoes_caixa.status': caixa.STATUS_SESSAO_CAIXA,
  'movimentos_caixa.tipo': caixa.TIPOS_MOVIMENTO_CAIXA,
  'fechamentos_caixa.tipo': caixa.TIPOS_FECHAMENTO_CAIXA,
  'fechamentos_caixa_formas.tipo_forma': financeiro.TIPOS_FORMA_PAGAMENTO,
  'movimentos_vasilhame.destino': caixa.DESTINOS_MOVIMENTO_VASILHAME,
};

/**
 * Linhas de cada payload em que o enum aparece, além das de `TABELAS`: a forma A do `venda.cancelada` e os movimentos e
 * a sessão dos outros eventos de caixa (cada um com o seu `z.literal`).
 */
const LINHAS_COM_ENUM: Array<[string, z.ZodObject]> = [
  ...TABELAS.map(([nome, , schema]) => [nome, schema] as [string, z.ZodObject]),
  ['vendas', bloco(contrato.payloadVendaCanceladaEmAndamentoSchema, 'vendas')],
  ['vendas', bloco(contrato.payloadVendaCanceladaFinalizadaSchema, 'vendas')],
  ['pagamentos_venda', bloco(contrato.payloadVendaCanceladaFinalizadaSchema, 'pagamentos_venda')],
  ['movimentos_caixa', bloco(contrato.payloadVendaCanceladaFinalizadaSchema, 'movimentos_caixa')],
  ['transacoes_tef', bloco(contrato.payloadVendaCanceladaFinalizadaSchema, 'transacoes_tef')],
  ['movimentos_caixa', bloco(contrato.payloadCaixaAbertoSchema, 'movimentos_caixa')],
  ['movimentos_caixa', bloco(contrato.payloadCaixaReforcoSchema, 'movimentos_caixa')],
  ['movimentos_caixa', bloco(contrato.payloadCaixaFechadoSchema, 'movimentos_caixa')],
  ['sessoes_caixa', bloco(contrato.payloadCaixaFechadoSchema, 'sessoes_caixa')],
];

/** Enums só de payload (sem coluna, logo sem CHECK): ficam de fora da conferência. */
const ENUMS_SO_PAYLOAD = ['pagamentos_venda.estorno'];

/** Valores de texto de um `z.enum` (todos) ou `z.literal` (subconjunto de propósito), sem `optional`/`nullable`. */
function valoresEnum(s: z.ZodType): { valores: string[]; literal: boolean } | null {
  let atual = s;
  while (atual instanceof z.ZodOptional || atual instanceof z.ZodNullable || atual instanceof z.ZodDefault) {
    atual = atual.unwrap() as z.ZodType;
  }
  if (atual instanceof z.ZodEnum) return { valores: atual.options.map(String), literal: false };
  if (atual instanceof z.ZodLiteral && [...atual.values].every((v) => typeof v === 'string')) {
    return { valores: [...atual.values] as string[], literal: true };
  }
  return null;
}

describe('contrato dos payloads × tabelas da nuvem', () => {
  it.each(TABELAS)(
    '%s: as chaves do contrato são as colunas que o PDV preenche',
    (nome, tabela, schema, soPayload) => {
      const fora = (
        contrato.COLUNAS_FORA_DO_PAYLOAD as Record<
          string,
          { nuvem: readonly string[]; erp: readonly string[] }
        >
      )[nome];
      const colunas = Object.values(getTableColumns(tabela))
        .map((c) => c.name)
        .filter((c) => !PADRAO.includes(c) && !fora?.nuvem.includes(c) && !fora?.erp.includes(c));
      const chaves = Object.keys(schema.shape).filter((c) => !soPayload.includes(c));
      expect(chaves.sort()).toEqual(colunas.sort());
    },
  );

  it.each(TABELAS)('%s: coluna not null sem padrão é obrigatória no contrato', (_nome, tabela, schema) => {
    const obrigatorias = Object.values(getTableColumns(tabela))
      .filter((c) => c.notNull && !c.hasDefault && !c.generated)
      .map((c) => c.name)
      .filter((c) => c in schema.shape);
    const opcionais = obrigatorias.filter((c) => (schema.shape[c] as z.ZodType).safeParse(undefined).success);
    expect(opcionais).toEqual([]);
  });

  it('cada enum das linhas do contrato é a lista do CHECK da coluna (z.literal: subconjunto dela)', () => {
    const divergentes: unknown[] = [];
    for (const [tabela, schema] of LINHAS_COM_ENUM) {
      for (const [coluna, campo] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        const e = valoresEnum(campo);
        if (!e || ENUMS_SO_PAYLOAD.includes(`${tabela}.${coluna}`)) continue;
        const check = CHECKS[`${tabela}.${coluna}`];
        const ok = check
          ? e.literal
            ? e.valores.every((v) => check.includes(v))
            : [...e.valores].sort().join() === [...check].sort().join()
          : false;
        if (!ok)
          divergentes.push({ coluna: `${tabela}.${coluna}`, contrato: e.valores, check: check ?? null });
      }
    }
    expect(divergentes).toEqual([]);
  });

  it('as listas exportadas pelo contrato são as dos CHECKs da 0012', () => {
    expect([...contrato.TIPOS_VENDA]).toEqual([...vendas.TIPOS_VENDA]);
    expect([...contrato.CANAIS_VENDA]).toEqual([...vendas.CANAIS_VENDA]);
    expect([...contrato.MODOS_VENDA]).toEqual([...vendas.MODOS_VENDA]);
    expect([...contrato.STATUS_FISCAL_VENDA]).toEqual([...vendas.STATUS_FISCAL_VENDA]);
    expect([...contrato.ORIGENS_PRECO_ITEM]).toEqual([...vendas.ORIGENS_PRECO_ITEM]);
    expect([...contrato.ORIGENS_ENTRADA_ITEM]).toEqual([...vendas.ORIGENS_ENTRADA_ITEM]);
    expect([...contrato.STATUS_PAGAMENTO_VENDA]).toEqual([...vendas.STATUS_PAGAMENTO_VENDA]);
    expect([...contrato.TIPOS_MOVIMENTO_CAIXA]).toEqual([...caixa.TIPOS_MOVIMENTO_CAIXA]);
    expect([...contrato.DESTINOS_MOVIMENTO_VASILHAME]).toEqual([...caixa.DESTINOS_MOVIMENTO_VASILHAME]);
    expect([...contrato.TIPOS_PRECO_VENDA]).toEqual([...vendas.TIPOS_PRECO_VENDA]);
    expect([...contrato.ORIGENS_CANCELAMENTO_VENDA]).toEqual([...vendas.ORIGENS_CANCELAMENTO_VENDA]);
    expect([...contrato.ORIGENS_DESCONTO_TOTAL_VENDA]).toEqual([...vendas.ORIGENS_DESCONTO_TOTAL_VENDA]);
    expect([...contrato.OPERACOES_TRANSACAO_TEF]).toEqual([...vendas.OPERACOES_TRANSACAO_TEF]);
    expect([...contrato.STATUS_TRANSACAO_TEF]).toEqual([...vendas.STATUS_TRANSACAO_TEF]);
    expect([...contrato.TIPOS_COBRANCA_PIX]).toEqual([...vendas.TIPOS_COBRANCA_PIX]);
    expect([...contrato.STATUS_COBRANCA_PIX]).toEqual([...vendas.STATUS_COBRANCA_PIX]);
    expect([...contrato.TIPOS_FECHAMENTO_CAIXA]).toEqual([...caixa.TIPOS_FECHAMENTO_CAIXA]);
  });

  it('handler de tipo contratado valida com o schema do contrato, não com um próprio', async () => {
    // O PDV gera o payload que a fixture fixa; um schema paralelo na API deixaria os dois divergirem calados. A nuvem
    // só anuncia em `versoes_schema` o tipo que tem handler (T13): na 1C eles entram no C5 (caixa), C6b e C7.
    const { HANDLERS } = await import('./eventos.js');
    for (const [tipo, c] of Object.entries(contrato.CONTRATOS_EVENTOS)) {
      for (const [versao, handler] of Object.entries(HANDLERS[tipo] ?? {})) {
        expect({
          tipo,
          versao,
          mesmo: handler.schema === (c.versoes as Record<string, z.ZodType>)[versao],
        }).toEqual({
          tipo,
          versao,
          mesmo: true,
        });
      }
    }
  });
});
