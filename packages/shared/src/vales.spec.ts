import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NUMERO_VENDA_MAXIMO, VALE_NUMERO_MAXIMO } from './sync/contratos.js';
import {
  conferirCodigoConferenciaVale,
  conferirCodigoVale,
  conferirCupomTroca,
  digitoLuhn,
  gerarCodigoConferenciaVale,
  montarCodigoVale,
  montarCupomTroca,
  PADRAO_RESUMO_CONFERENCIA_VALE_REGEX,
  resumirCodigoConferenciaVale,
  resumoConferenciaValeValido,
  VALE_CONFERENCIA_DIGITOS,
  VALE_CONFERENCIA_ITERACOES,
  VALE_CONFERENCIA_ITERACOES_MAXIMO,
  VALE_CONFERENCIA_ITERACOES_MINIMO,
} from './vales.js';

interface Montar {
  descricao: string;
  loja: number;
  caixa: number;
  sequencial?: number;
  numero?: number;
  codigo?: string;
}
interface Conferir {
  descricao: string;
  lido: string;
  valido: boolean;
  motivo?: string;
  codigo?: string;
  loja?: number;
  caixa?: number;
  sequencial?: number;
  numero?: number;
}
interface Vetores {
  vale: { montar: Montar[]; montar_recusado: Montar[]; conferir: Conferir[] };
  cupom_troca: { montar: Montar[]; montar_recusado: Montar[]; conferir: Conferir[] };
  conferencia: {
    digitos: number;
    iteracoes_padrao: number;
    iteracoes_minimo: number;
    iteracoes_maximo: number;
    resumir: {
      descricao: string;
      codigo_vale: string;
      conferencia: string;
      sal_hex: string;
      iteracoes: number;
      resumo: string;
    }[];
    resumir_recusado: { descricao: string; codigo_vale: string; conferencia: string }[];
    conferir: {
      descricao: string;
      codigo_vale: string;
      conferencia: string;
      resumo: string;
      valido: boolean;
    }[];
  };
}

/** O mesmo arquivo do `CodigoValeVetoresTests` do PDV (GenesisPDV.Core.Tests). */
const V = JSON.parse(
  readFileSync(new URL('../testes/sync/vale.codigo.vetores.json', import.meta.url), 'utf8'),
) as Vetores;

const hex = (h: string) => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

describe('digitoLuhn', () => {
  it('o exemplo clássico (79927398713) e o da SYNC 13.4', () => {
    expect(digitoLuhn('7992739871')).toBe(3);
    expect(digitoLuhn('01020000008')).toBe(0);
  });

  it('só aceita dígitos', () => {
    expect(() => digitoLuhn('12a')).toThrow(RangeError);
    expect(() => digitoLuhn('')).toThrow(RangeError);
  });
});

describe('vale.codigo.vetores.json: código do vale (VC…)', () => {
  it.each(V.vale.montar)('monta: $descricao', (c) => {
    expect(montarCodigoVale(c.loja, c.caixa, c.sequencial!)).toBe(c.codigo);
  });

  it.each(V.vale.montar_recusado)('recusa montar: $descricao', (c) => {
    expect(() => montarCodigoVale(c.loja, c.caixa, c.sequencial!)).toThrow(RangeError);
  });

  it.each(V.vale.conferir)('confere: $descricao', (c) => {
    expect(conferirCodigoVale(c.lido)).toEqual(
      c.valido
        ? {
            valido: true,
            codigo: c.codigo,
            lojaCodigo: c.loja,
            numeroCaixa: c.caixa,
            sequencial: c.sequencial,
          }
        : { valido: false, motivo: c.motivo },
    );
  });

  it('o maior sequencial é o VALE_NUMERO_MAXIMO e o código cabe no ck_vales_codigo', () => {
    expect(montarCodigoVale(99, 99, VALE_NUMERO_MAXIMO)).toMatch(/^VC[0-9]{12}$/);
    expect(() => montarCodigoVale(1, 2, 1.5)).toThrow(RangeError);
  });

  it('todo código montado se confere de volta, e qualquer dígito trocado é recusado', () => {
    for (const [l, c, q] of [
      [1, 2, 8],
      [45, 0, 7_654_321],
      [99, 99, VALE_NUMERO_MAXIMO],
    ] as const) {
      const codigo = montarCodigoVale(l, c, q);
      expect(conferirCodigoVale(codigo)).toMatchObject({
        valido: true,
        lojaCodigo: l,
        numeroCaixa: c,
        sequencial: q,
      });
      for (let i = 2; i < codigo.length; i++) {
        const d = Number(codigo[i]);
        const trocado = `${codigo.slice(0, i)}${(d + 1) % 10}${codigo.slice(i + 1)}`;
        expect(conferirCodigoVale(trocado)).toEqual({ valido: false, motivo: 'DIGITO_VERIFICADOR' });
      }
    }
  });
});

describe('vale.codigo.vetores.json: cupom de troca (CT…)', () => {
  it.each(V.cupom_troca.montar)('monta: $descricao', (c) => {
    expect(montarCupomTroca(c.loja, c.caixa, c.numero!)).toBe(c.codigo);
  });

  it.each(V.cupom_troca.montar_recusado)('recusa montar: $descricao', (c) => {
    expect(() => montarCupomTroca(c.loja, c.caixa, c.numero!)).toThrow(RangeError);
  });

  it.each(V.cupom_troca.conferir)('confere: $descricao', (c) => {
    expect(conferirCupomTroca(c.lido)).toEqual(
      c.valido
        ? { valido: true, codigo: c.codigo, lojaCodigo: c.loja, numeroCaixa: c.caixa, numeroVenda: c.numero }
        : { valido: false, motivo: c.motivo },
    );
  });

  it('o maior número é o NUMERO_VENDA_MAXIMO, e qualquer dígito trocado é recusado', () => {
    const codigo = montarCupomTroca(12, 3, NUMERO_VENDA_MAXIMO);
    expect(codigo).toMatch(/^CT[0-9]{17}$/);
    for (let i = 2; i < codigo.length; i++) {
      const d = Number(codigo[i]);
      const trocado = `${codigo.slice(0, i)}${(d + 3) % 10}${codigo.slice(i + 1)}`;
      expect(conferirCupomTroca(trocado)).toEqual({ valido: false, motivo: 'DIGITO_VERIFICADOR' });
    }
  });
});

describe('vale.codigo.vetores.json: código de conferência do vale (D96)', () => {
  it('as constantes são as do vetor (o PDV confere as mesmas)', () => {
    expect([
      VALE_CONFERENCIA_DIGITOS,
      VALE_CONFERENCIA_ITERACOES,
      VALE_CONFERENCIA_ITERACOES_MINIMO,
      VALE_CONFERENCIA_ITERACOES_MAXIMO,
    ]).toEqual([
      V.conferencia.digitos,
      V.conferencia.iteracoes_padrao,
      V.conferencia.iteracoes_minimo,
      V.conferencia.iteracoes_maximo,
    ]);
  });

  it.each(V.conferencia.resumir)('resume: $descricao', async (c) => {
    const resumo = await resumirCodigoConferenciaVale(c.codigo_vale, c.conferencia, {
      sal: hex(c.sal_hex),
      iteracoes: c.iteracoes,
    });
    expect(resumo).toBe(c.resumo);
    expect(resumo.length).toBeLessThanOrEqual(100);
    expect(resumoConferenciaValeValido(resumo)).toBe(true);
  });

  it.each(V.conferencia.resumir_recusado)('recusa resumir: $descricao', async (c) => {
    await expect(
      resumirCodigoConferenciaVale(c.codigo_vale, c.conferencia, {
        sal: new Uint8Array(16),
        iteracoes: 10_000,
      }),
    ).rejects.toThrow(RangeError);
  });

  it.each(V.conferencia.conferir)('confere: $descricao', async (c) => {
    expect(await conferirCodigoConferenciaVale(c.codigo_vale, c.conferencia, c.resumo)).toBe(c.valido);
  });

  it('o resumo com quebra de linha no fim está fora do formato (o PDV recusa igual, com \\z)', () => {
    const r = V.conferencia.resumir[0]!.resumo;
    expect(resumoConferenciaValeValido(r)).toBe(true);
    expect(resumoConferenciaValeValido(`${r}\n`)).toBe(false);
  });

  it('o sorteio dá sempre 4 dígitos, com zeros à esquerda, e espalha', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = gerarCodigoConferenciaVale();
      expect(c).toMatch(/^[0-9]{4}$/);
      vistos.add(c);
    }
    // 2000 sorteios em 10.000 valores: menos de 1.700 distintos só com um gerador muito ruim.
    expect(vistos.size).toBeGreaterThan(1700);
  });

  it('o resumo novo sai com as iterações padrão e um sal diferente a cada vez, e confere', async () => {
    const codigo = montarCodigoVale(1, 2, 8);
    const conferencia = gerarCodigoConferenciaVale();
    const [a, b] = await Promise.all([
      resumirCodigoConferenciaVale(codigo, conferencia),
      resumirCodigoConferenciaVale(codigo, conferencia),
    ]);
    expect(a).not.toBe(b);
    expect(PADRAO_RESUMO_CONFERENCIA_VALE_REGEX.exec(a)?.[1]).toBe(String(VALE_CONFERENCIA_ITERACOES));
    expect(a).toHaveLength(87);
    expect(await conferirCodigoConferenciaVale(codigo, conferencia, a)).toBe(true);
    expect(await conferirCodigoConferenciaVale(codigo, conferencia, b)).toBe(true);
  });

  it('resumir recusa entrada inválida (erro de programação), conferir só responde false', async () => {
    await expect(resumirCodigoConferenciaVale('VC010200000080', '427')).rejects.toThrow(RangeError);
    await expect(resumirCodigoConferenciaVale('VC0102', '0427')).rejects.toThrow(RangeError);
    await expect(
      resumirCodigoConferenciaVale('VC010200000080', '0427', {
        iteracoes: VALE_CONFERENCIA_ITERACOES_MAXIMO + 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      resumirCodigoConferenciaVale('VC010200000080', '0427', { sal: new Uint8Array(8) }),
    ).rejects.toThrow(RangeError);
    const r = V.conferencia.resumir[0]!.resumo;
    expect(await conferirCodigoConferenciaVale('VC0102', '0427', r)).toBe(false);
  });
});
