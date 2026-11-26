import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dec, decTexto } from './decimal.js';
import {
  cancelarVendaSchema,
  CANAIS_POR_TIPO_VENDA,
  conferirSessaoSchema,
  FORMAS_DEVOLUCAO_CANCELAMENTO,
  FORMAS_DEVOLUCAO_DISPONIVEIS,
  diaOperacionalEm,
  diferencaConferencia,
  filtroReforcosSchema,
  filtroSessoesCaixaSchema,
  filtroSangriasSchema,
  filtroVendasSchema,
  mesOperacionalEm,
  OBSERVACAO_CONFERENCIA_MAX,
  situacaoConferencia,
  SITUACOES_SESSAO_CAIXA,
  tipoExibidoVenda,
} from './vendas.js';
import { CANAIS_VENDA } from './sync/eventos.js';

describe('consultas de vendas e caixa (C12)', () => {
  it('filtro de vendas: padrões (todas exceto rascunho, sem a loja de treino) e campos vazios da URL', () => {
    expect(filtroVendasSchema.parse({ lojaId: '', codigo: '', numeroCaixa: '' })).toMatchObject({
      situacao: 'todas',
      devolucao: 'todas',
      treino: 'excluir',
      pagina: 1,
    });
    expect(filtroVendasSchema.parse({ numeroCaixa: '2', tipo: 'pdv' })).toMatchObject({
      numeroCaixa: 2,
      tipo: 'pdv',
    });
    expect(filtroVendasSchema.safeParse({ situacao: 'rascunho' }).success).toBe(false);
    expect(filtroVendasSchema.safeParse({ dataInicial: '29/10/2026' }).success).toBe(false);
  });

  it('data impossível é recusada no zod (422), não no `::date` do PostgreSQL (500)', () => {
    for (const dataInicial of ['2026-02-31', '2026-13-01', '2026-04-31', '2025-02-29']) {
      expect(filtroVendasSchema.safeParse({ dataInicial }).success, dataInicial).toBe(false);
      expect(filtroReforcosSchema.safeParse({ dataFinal: dataInicial }).success, dataInicial).toBe(false);
      expect(filtroSessoesCaixaSchema.safeParse({ dataInicial }).success, dataInicial).toBe(false);
    }
    expect(filtroVendasSchema.parse({ dataInicial: '2024-02-29', dataFinal: '2026-12-31' })).toMatchObject({
      dataInicial: '2024-02-29',
      dataFinal: '2026-12-31',
    });
  });

  it('dia e mês operacionais (D7): antes do corte ainda é o dia (e o mês) anterior', () => {
    // 01/11/2026 às 02:00 de Brasília (05:00 UTC).
    const madrugada = new Date('2026-11-01T05:00:00Z');
    expect(diaOperacionalEm(madrugada, '05:00')).toBe('2026-10-31');
    expect(mesOperacionalEm(madrugada, '05:00')).toBe('2026-10');
    expect(diaOperacionalEm(madrugada, '00:00')).toBe('2026-11-01');
    expect(diaOperacionalEm(madrugada, '02:00')).toBe('2026-11-01');
    expect(diaOperacionalEm(madrugada, '02:01')).toBe('2026-10-31');
    expect(diaOperacionalEm(new Date('2026-11-01T08:00:00Z'), '05:00')).toBe('2026-11-01');
    // A virada do ano e outro fuso.
    expect(mesOperacionalEm(new Date('2027-01-01T07:59:59Z'), '05:00')).toBe('2026-12');
    expect(diaOperacionalEm(new Date('2026-11-01T05:00:00Z'), '05:00', 'America/Manaus')).toBe('2026-10-31');
  });

  it('o tipo exibido cobre todos os canais (ERP 15.4.1)', () => {
    expect(tipoExibidoVenda('erp')).toBe('venda');
    expect(tipoExibidoVenda('totem')).toBe('pdv');
    expect(tipoExibidoVenda('ifood')).toBe('integracao');
    expect(Object.values(CANAIS_POR_TIPO_VENDA).flat().sort()).toEqual([...CANAIS_VENDA].sort());
  });

  it('sangria aceita a sangria do fechamento; sessões: "somente com diferença" da URL', () => {
    expect(filtroSangriasSchema.parse({ tipo: 'sangria_fechamento' }).tipo).toBe('sangria_fechamento');
    expect(filtroSangriasSchema.safeParse({ tipo: 'reforco' }).success).toBe(false);
    expect(filtroSessoesCaixaSchema.parse({ somenteComDiferenca: 'true' }).somenteComDiferenca).toBe(true);
    expect(filtroSessoesCaixaSchema.parse({}).somenteComDiferenca).toBe(false);
  });
});

/** Vetor da apuração do caixa (PDV 20.4; ERP 14.9) que o PDV e a API conferem; aqui, só a coerência interna. */
interface VetorApuracao {
  casos: Array<{
    nome: string;
    fundo_troco: string;
    sangria_fechamento: string;
    esperado: Record<string, string> & { formas: Record<string, { calculado: string }> };
  }>;
}

describe('caixa.apuracao.vetores.json', () => {
  const vetor = JSON.parse(
    readFileSync(new URL('../testes/sync/caixa.apuracao.vetores.json', import.meta.url), 'utf8'),
  ) as VetorApuracao;

  it.each(vetor.casos.map((c) => [c.nome, c] as const))(
    '%s: as parcelas fecham o dinheiro esperado',
    (_, c) => {
      const e = c.esperado;
      const dinheiro = dec(c.fundo_troco)
        .plus(dec(e.vendas_dinheiro))
        .minus(dec(e.troco_outras_formas))
        .plus(dec(e.reforcos))
        .minus(dec(e.sangrias))
        .minus(dec(e.estornos_dinheiro))
        .minus(dec(e.devolucoes));
      expect(decTexto(dinheiro, 2)).toBe(e.dinheiro);
      expect(e.formas.dinheiro!.calculado).toBe(e.dinheiro);
      expect(decTexto(dinheiro.minus(dec(c.sangria_fechamento)), 2)).toBe(e.gaveta_apos_sangria_fechamento);
    },
  );
});

describe('conferência do fechamento (F3-B9; D114)', () => {
  const formas = (...pares: Array<[string, string]>) =>
    pares.map(([valorCalculado, valorConferido]) => ({ valorCalculado, valorConferido }));

  it('com a tolerância padrão (R$ 0,00), qualquer centavo de diferença numa forma é "Divergente"', () => {
    expect(situacaoConferencia(formas(['225.00', '225.00'], ['35.00', '35.00']), '0.00')).toBe('conferida');
    expect(situacaoConferencia(formas(['225.00', '224.99'], ['35.00', '35.00']), '0.00')).toBe('divergente');
    expect(situacaoConferencia(formas(['225.00', '225.00'], ['35.00', '35.01']), '0')).toBe('divergente');
  });

  it('dentro da tolerância, para mais ou para menos, em cada forma; fora dela em qualquer forma, diverge', () => {
    expect(situacaoConferencia(formas(['225.00', '224.95'], ['35.00', '35.05']), '0.05')).toBe('conferida');
    expect(situacaoConferencia(formas(['225.00', '224.94'], ['35.00', '35.00']), '0.05')).toBe('divergente');
    // As diferenças não se compensam entre as formas: −5 no dinheiro e +5 no PIX continuam divergentes.
    expect(situacaoConferencia(formas(['225.00', '220.00'], ['35.00', '40.00']), '0.05')).toBe('divergente');
    expect(situacaoConferencia(formas(['10.00', '15.00']), '5.00')).toBe('conferida');
  });

  it('forma sem venda: calculado 0 conferido 0 não diverge; conferido acima de 0 diverge; sem formas, conferida', () => {
    expect(situacaoConferencia(formas(['0.00', '0.00'], ['35.00', '35.00']), '0.00')).toBe('conferida');
    expect(situacaoConferencia(formas(['0.00', '2.00']), '0.00')).toBe('divergente');
    expect(situacaoConferencia([], '0.00')).toBe('conferida');
  });

  it('a diferença é conferido − calculado em decimal, sem ponto flutuante', () => {
    expect(diferencaConferencia('223.50', '225.00')).toBe('-1.50');
    expect(diferencaConferencia('0.30', '0.10')).toBe('0.20');
    expect(diferencaConferencia('9999999999999.99', '0.01')).toBe('9999999999999.98');
  });

  it('o corpo: valor em texto com vírgula ou ponto, normalizado; recusa número, sinal, 3 casas e forma repetida', () => {
    const forma = '01a18752-3782-7bda-ad3e-2d6d1a3d1fa7';
    const outra = '01a18752-c8a9-7970-9641-9f828b9d2434';
    expect(
      conferirSessaoSchema.parse({
        formas: [
          { formaPagamentoId: forma, valorConferido: '223,5' },
          { formaPagamentoId: outra, valorConferido: ' 35 ' },
        ],
        observacao: '  ',
      }),
    ).toEqual({
      versao: null,
      formas: [
        { formaPagamentoId: forma, valorConferido: '223.50' },
        { formaPagamentoId: outra, valorConferido: '35.00' },
      ],
      observacao: null,
    });
    for (const valorConferido of [223.5, '-1.00', '1.005', '', '1.234,56', 'abc'])
      expect(
        conferirSessaoSchema.safeParse({ formas: [{ formaPagamentoId: forma, valorConferido }] }).success,
        String(valorConferido),
      ).toBe(false);
    expect(
      conferirSessaoSchema.safeParse({
        formas: [
          { formaPagamentoId: forma, valorConferido: '1' },
          { formaPagamentoId: forma.toUpperCase(), valorConferido: '2' },
        ],
      }).success,
    ).toBe(false);
    const longa = 'x'.repeat(OBSERVACAO_CONFERENCIA_MAX + 1);
    expect(conferirSessaoSchema.safeParse({ formas: [], observacao: longa }).success).toBe(false);
    expect(conferirSessaoSchema.parse({ formas: [], versao: 3 }).versao).toBe(3);
  });

  it('as quatro situações do filtro da listagem', () => {
    expect(SITUACOES_SESSAO_CAIXA).toEqual(['aberta', 'fechada', 'conferida', 'divergente']);
    expect(filtroSessoesCaixaSchema.parse({ situacao: 'divergente' }).situacao).toBe('divergente');
    expect(filtroSessoesCaixaSchema.safeParse({ situacao: 'fechada_forcado' }).success).toBe(false);
  });
});

describe('cancelar venda pelo ERP (F3-B11; D112, D113)', () => {
  it('motivo de 15 a 255 sem os espaços das pontas, como no caixa (O6); forma e confirmação com padrão', () => {
    expect(cancelarVendaSchema.parse({ motivo: '  Venda registrada com erro  ' })).toEqual({
      motivo: 'Venda registrada com erro',
      formaDevolucao: null,
      confirmarAvisos: false,
    });
    for (const motivo of ['curto demais', `   ${'x'.repeat(14)}   `, 'x'.repeat(256), undefined])
      expect(cancelarVendaSchema.safeParse({ motivo }).success, String(motivo)).toBe(false);
    expect(cancelarVendaSchema.safeParse({ motivo: 'x'.repeat(255) }).success).toBe(true);
    expect(
      cancelarVendaSchema.parse({
        motivo: 'Cliente devolveu tudo no dia seguinte',
        formaDevolucao: 'estorno_pix',
        confirmarAvisos: true,
      }),
    ).toMatchObject({ formaDevolucao: 'estorno_pix', confirmarAvisos: true });
    expect(
      cancelarVendaSchema.safeParse({
        motivo: 'Cliente devolveu tudo no dia seguinte',
        formaDevolucao: 'cheque',
      }).success,
    ).toBe(false);
  });

  it('o vale existe no contrato, mas só passa a valer com os vales (F3-B50)', () => {
    expect(FORMAS_DEVOLUCAO_CANCELAMENTO).toContain('vale');
    expect(FORMAS_DEVOLUCAO_DISPONIVEIS).not.toContain('vale');
    expect(FORMAS_DEVOLUCAO_DISPONIVEIS.every((f) => FORMAS_DEVOLUCAO_CANCELAMENTO.includes(f))).toBe(true);
  });
});
