import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dec, decTexto } from './decimal.js';
import {
  CANAIS_POR_TIPO_VENDA,
  diaOperacionalEm,
  filtroReforcosSchema,
  filtroSessoesCaixaSchema,
  filtroSangriasSchema,
  filtroVendasSchema,
  mesOperacionalEm,
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
