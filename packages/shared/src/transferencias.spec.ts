import { describe, expect, it } from 'vitest';
import {
  alterarTransferenciaSchema,
  cancelarTransferenciaSchema,
  criarTransferenciaSchema,
  diferencaItemTransferenciaTexto,
  enviarTransferenciaSchema,
  excluirTransferenciaSchema,
  filtroTransferenciasSchema,
  LIMITE_ITENS_TRANSFERENCIA,
  nfeExternaTransferenciaSchema,
  podeTransitarTransferencia,
  receberTransferenciaSchema,
  situacaoAposRecebimento,
  STATUS_TRANSFERENCIA,
  sugestaoReposicaoSchema,
  TRANSICOES_TRANSFERENCIA,
  tratarDivergenciaTransferenciaSchema,
} from './transferencias.js';

const CD = '01890000-0000-7000-8000-000000000001';
const LOJA = '01890000-0000-7000-8000-000000000002';
const PRODUTO = '01890000-0000-7000-8000-000000000003';
const LOTE = '01890000-0000-7000-8000-000000000004';
const ITEM = '01890000-0000-7000-8000-000000000005';
const ITEM2 = '01890000-0000-7000-8000-000000000006';
/** Chave inventada com o DV certo (UF 35, CNPJ de teste, modelo 55). */
const CHAVE = '35261111222333000181550010000000011000000014';

const base = { estoqueOrigemId: CD, estoqueDestinoId: LOJA, motivo: 'Reposição semanal' };
const item = (extra: Record<string, unknown> = {}) => ({ produtoId: PRODUTO, quantidade: '60', ...extra });

/** Os caminhos com erro (`itens.0.quantidade`, `estoqueDestinoId`…) de um schema. */
function erros(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, corpo: unknown) {
  const r = schema.safeParse(corpo) as
    { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } };
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('contrato da transferência (F2-B22; ERP 13.7; MD 3.7.6)', () => {
  it('normaliza decimais a 3 casas, aplica os padrões e aceita tipo, data, lote e variação vazios', () => {
    const r = criarTransferenciaSchema.parse({
      ...base,
      tipoEstoqueId: '',
      data: '',
      observacoes: '  ',
      motivo: '  Reposição semanal ',
      itens: [item({ quantidade: '1.234,5678', loteId: '', variacaoId: '' })],
    });
    expect(r).toMatchObject({
      tipoEstoqueId: null,
      data: null,
      motivo: 'Reposição semanal',
      observacoes: null,
      nfeExternaChave: null,
      nfeExternaNumero: null,
    });
    // ADR-05: quantidade com 3 casas (arredondada).
    expect(r.itens).toEqual([
      { id: null, produtoId: PRODUTO, variacaoId: null, loteId: null, quantidade: '1234.568' },
    ]);
    expect(criarTransferenciaSchema.parse({ ...base }).itens).toEqual([]);
  });

  it('recusa origem = destino (sem diferenciar maiúsculas), motivo vazio ou longo e data impossível', () => {
    expect(erros(criarTransferenciaSchema, { ...base, estoqueDestinoId: CD.toUpperCase() })).toEqual([
      'estoqueDestinoId',
    ]);
    expect(erros(criarTransferenciaSchema, { ...base, motivo: '   ' })).toEqual(['motivo']);
    expect(erros(criarTransferenciaSchema, { ...base, motivo: 'x'.repeat(121) })).toEqual(['motivo']);
    expect(erros(criarTransferenciaSchema, { ...base, motivo: 'x'.repeat(120) })).toEqual([]);
    expect(erros(criarTransferenciaSchema, { ...base, data: '2026-02-30' })).toEqual(['data']);
    expect(erros(criarTransferenciaSchema, { estoqueDestinoId: LOJA, motivo: 'x' })).toEqual([
      'estoqueOrigemId',
    ]);
  });

  it('itens: quantidade > 0, teto, mesmo id e mesmo produto × lote recusados; lotes diferentes passam', () => {
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item({ quantidade: '0' })] })).toEqual([
      'itens.0.quantidade',
    ]);
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item({ quantidade: '-1' })] })).toEqual([
      'itens.0.quantidade',
    ]);
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item({ quantidade: '1000000000' })] })).toEqual(
      ['itens.0.quantidade'],
    );
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item({ quantidade: '0,001' })] })).toEqual([]);
    // O mesmo produto sem lote duas vezes, e o mesmo produto no mesmo lote.
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item(), item({ quantidade: '1' })] })).toEqual([
      'itens.1.produtoId',
    ]);
    expect(
      erros(criarTransferenciaSchema, {
        ...base,
        itens: [item({ loteId: LOTE }), item({ loteId: LOTE.toUpperCase() })],
      }),
    ).toEqual(['itens.1.produtoId']);
    // Sem lote (FEFO) e com o lote escolhido são linhas diferentes.
    expect(erros(criarTransferenciaSchema, { ...base, itens: [item(), item({ loteId: LOTE })] })).toEqual([]);
    expect(
      erros(criarTransferenciaSchema, {
        ...base,
        itens: [item({ id: ITEM }), item({ id: ITEM, loteId: LOTE })],
      }),
    ).toEqual(['itens.1.id']);
    const muitos = Array.from({ length: LIMITE_ITENS_TRANSFERENCIA + 1 }, () => item());
    expect(erros(criarTransferenciaSchema, { ...base, itens: muitos })).toContain('itens');
  });

  it('NF-e emitida por fora: opcional, chave sem espaços com o DV conferido, número até 20', () => {
    const r = criarTransferenciaSchema.parse({
      ...base,
      nfeExternaChave: ` ${CHAVE.slice(0, 22)} ${CHAVE.slice(22)} `,
      nfeExternaNumero: ' 1234/1 ',
    });
    expect(r).toMatchObject({ nfeExternaChave: CHAVE, nfeExternaNumero: '1234/1' });
    const dvErrado = `${CHAVE.slice(0, 43)}5`;
    expect(erros(criarTransferenciaSchema, { ...base, nfeExternaChave: dvErrado })).toEqual([
      'nfeExternaChave',
    ]);
    expect(erros(criarTransferenciaSchema, { ...base, nfeExternaChave: '123' })).toEqual(['nfeExternaChave']);
    expect(erros(criarTransferenciaSchema, { ...base, nfeExternaNumero: 'x'.repeat(21) })).toEqual([
      'nfeExternaNumero',
    ]);
    expect(nfeExternaTransferenciaSchema.parse({ nfeExternaChave: '', nfeExternaNumero: '' })).toEqual({
      nfeExternaChave: null,
      nfeExternaNumero: null,
    });
    expect(nfeExternaTransferenciaSchema.parse({ versao: 3, nfeExternaChave: CHAVE })).toMatchObject({
      versao: 3,
      nfeExternaChave: CHAVE,
    });
  });

  it('alterar exige a versão; excluir aceita ?versao= opcional', () => {
    expect(erros(alterarTransferenciaSchema, { ...base })).toEqual(['versao']);
    expect(alterarTransferenciaSchema.parse({ ...base, versao: 7 }).versao).toBe(7);
    // As regras do rascunho valem também no PUT.
    expect(erros(alterarTransferenciaSchema, { ...base, versao: 7, estoqueDestinoId: CD })).toEqual([
      'estoqueDestinoId',
    ]);
    expect(excluirTransferenciaSchema.parse({ versao: '12' })).toEqual({ versao: 12 });
    expect(excluirTransferenciaSchema.parse({})).toEqual({});
  });

  it('etapas: enviar com versão opcional; cancelar exige o motivo', () => {
    expect(enviarTransferenciaSchema.parse({})).toEqual({});
    expect(enviarTransferenciaSchema.parse({ versao: 2 })).toEqual({ versao: 2 });
    expect(erros(cancelarTransferenciaSchema, {})).toEqual(['motivo']);
    expect(erros(cancelarTransferenciaSchema, { motivo: '  ' })).toEqual(['motivo']);
    expect(erros(cancelarTransferenciaSchema, { motivo: 'x'.repeat(256) })).toEqual(['motivo']);
    expect(cancelarTransferenciaSchema.parse({ motivo: ' Caminhão quebrou ' })).toEqual({
      motivo: 'Caminhão quebrou',
    });
  });

  it('receber: "receber tudo" sem itens, ou a quantidade de cada item (≥ 0, sem repetir)', () => {
    expect(receberTransferenciaSchema.parse({ receberTudo: true })).toEqual({ receberTudo: true, itens: [] });
    expect(
      receberTransferenciaSchema.parse({
        itens: [
          { itemId: ITEM, quantidadeRecebida: '8' },
          { itemId: ITEM2, quantidadeRecebida: '0' },
        ],
      }).itens,
    ).toEqual([
      { itemId: ITEM, quantidadeRecebida: '8.000' },
      { itemId: ITEM2, quantidadeRecebida: '0.000' },
    ]);
    expect(erros(receberTransferenciaSchema, {})).toEqual(['itens']);
    expect(
      erros(receberTransferenciaSchema, {
        receberTudo: true,
        itens: [{ itemId: ITEM, quantidadeRecebida: '1' }],
      }),
    ).toEqual(['itens']);
    expect(
      erros(receberTransferenciaSchema, { itens: [{ itemId: ITEM, quantidadeRecebida: '-1' }] }),
    ).toEqual(['itens.0.quantidadeRecebida']);
    expect(
      erros(receberTransferenciaSchema, {
        itens: [
          { itemId: ITEM, quantidadeRecebida: '1' },
          { itemId: ITEM.toUpperCase(), quantidadeRecebida: '2' },
        ],
      }),
    ).toEqual(['itens.1.itemId']);
  });

  it('tratar divergência: ao menos um item, tratamento conhecido e sem repetir', () => {
    expect(
      tratarDivergenciaTransferenciaSchema.parse({
        itens: [
          { itemId: ITEM, tratamento: 'retorno_origem' },
          { itemId: ITEM2, tratamento: 'perda' },
        ],
      }).itens,
    ).toHaveLength(2);
    expect(erros(tratarDivergenciaTransferenciaSchema, { itens: [] })).toEqual(['itens']);
    expect(
      erros(tratarDivergenciaTransferenciaSchema, { itens: [{ itemId: ITEM, tratamento: 'sumiu' }] }),
    ).toEqual(['itens.0.tratamento']);
    expect(
      erros(tratarDivergenciaTransferenciaSchema, {
        itens: [
          { itemId: ITEM, tratamento: 'perda' },
          { itemId: ITEM, tratamento: 'retorno_origem' },
        ],
      }),
    ).toEqual(['itens.1.itemId']);
  });

  it('filtros da listagem e a consulta da sugestão de reposição', () => {
    expect(filtroTransferenciasSchema.parse({})).toMatchObject({
      pagina: 1,
      tamanho: 20,
      periodo: 'criacao',
    });
    expect(
      filtroTransferenciasSchema.parse({
        codigo: '3',
        status: 'em_transito',
        periodo: 'envio',
        dataInicial: '2026-11-01',
      }),
    ).toMatchObject({ codigo: 3, status: 'em_transito', periodo: 'envio', dataInicial: '2026-11-01' });
    expect(erros(filtroTransferenciasSchema, { dataFinal: '2026-02-30' })).toEqual(['dataFinal']);
    expect(erros(filtroTransferenciasSchema, { status: 'enviada' })).toEqual(['status']);
    expect(erros(filtroTransferenciasSchema, { periodo: 'recebimento' })).toEqual(['periodo']);
    expect(sugestaoReposicaoSchema.parse({ origem: CD, destino: LOJA })).toEqual({
      origem: CD,
      destino: LOJA,
    });
    expect(erros(sugestaoReposicaoSchema, { origem: CD, destino: CD })).toEqual(['destino']);
    expect(erros(sugestaoReposicaoSchema, { origem: CD })).toEqual(['destino']);
  });
});

describe('regras puras da situação da transferência (ERP 13.7)', () => {
  it('transições do diagrama, iguais às do trigger de etapa; recebida e cancelada são o fim', () => {
    const permitidas = STATUS_TRANSFERENCIA.flatMap((de) =>
      STATUS_TRANSFERENCIA.filter((para) => podeTransitarTransferencia(de, para)).map(
        (para) => `${de}→${para}`,
      ),
    );
    expect(permitidas).toEqual([
      'rascunho→em_transito',
      'rascunho→cancelada',
      'em_transito→recebida',
      'em_transito→recebida_divergencia',
      'em_transito→cancelada',
      'recebida_divergencia→recebida',
    ]);
    expect(TRANSICOES_TRANSFERENCIA.recebida).toEqual([]);
    expect(TRANSICOES_TRANSFERENCIA.cancelada).toEqual([]);
    // Não se pula a 1ª etapa, e a recebida não se cancela (faz-se uma transferência inversa).
    expect(podeTransitarTransferencia('rascunho', 'recebida')).toBe(false);
    expect(podeTransitarTransferencia('recebida', 'cancelada')).toBe(false);
  });

  it('diferença do item como a coluna gerada, e a situação depois do recebimento', () => {
    expect(diferencaItemTransferenciaTexto('10', null)).toBe('0.000');
    expect(diferencaItemTransferenciaTexto('10', '8')).toBe('2.000');
    expect(diferencaItemTransferenciaTexto('0.3', '0.1')).toBe('0.200');
    expect(diferencaItemTransferenciaTexto('10', '10')).toBe('0.000');
    expect(
      situacaoAposRecebimento([
        { quantidadeEnviada: '60', quantidadeRecebida: '60' },
        { quantidadeEnviada: '0.3', quantidadeRecebida: '0.300' },
      ]),
    ).toBe('recebida');
    expect(
      situacaoAposRecebimento([
        { quantidadeEnviada: '60', quantidadeRecebida: '60' },
        { quantidadeEnviada: '10', quantidadeRecebida: '9.999' },
      ]),
    ).toBe('recebida_divergencia');
    expect(situacaoAposRecebimento([{ quantidadeEnviada: '5', quantidadeRecebida: '0' }])).toBe(
      'recebida_divergencia',
    );
  });
});
