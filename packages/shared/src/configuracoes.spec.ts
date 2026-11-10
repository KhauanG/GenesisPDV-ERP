import { describe, expect, it } from 'vitest';
import {
  CHAVES_CONFIGURACAO_PDV,
  CONFIGURACOES,
  CONFIGURACOES_POR_CHAVE,
  GRUPOS_CONFIGURACAO,
  grupoDaChave,
  REGEX_CHAVE_CONFIGURACAO,
} from './configuracoes.js';
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  CHAVE_LOTE_BAIXA_SEM_INFORMAR,
  MODOS_COMPRA_ATUALIZA_PRECO_CUSTO,
  MODOS_LOTE_BAIXA_SEM_INFORMAR,
} from './estoque.js';
import { CHAVE_ASSINATURA_INVALIDA, MODOS_ASSINATURA_INVALIDA } from './notas-entrada.js';
import { BASES_CUSTO_MARGEM, CHAVE_CUSTO_BASE_MARGEM } from './precos.js';
import { CHAVE_RECUSA_PRODUTO_COM_VARIACOES } from './produtos.js';
import { CHAVE_CONSULTA_OUTRAS_LOJAS } from './sync/contratos.js';
import { CHAVE_TRANSFERENCIA_ALERTA_DIAS, TRANSFERENCIA_ALERTA_DIAS_PADRAO } from './transferencias.js';

describe('catálogo de configurações (MD 3.1.2)', () => {
  it('chaves únicas, no formato <grupo>.<nome> e cabendo em configuracoes.chave', () => {
    expect(CONFIGURACOES_POR_CHAVE.size).toBe(CONFIGURACOES.length);
    for (const c of CONFIGURACOES) {
      expect(c.chave).toMatch(REGEX_CHAVE_CONFIGURACAO);
      expect(c.chave.length).toBeLessThanOrEqual(100);
    }
  });

  it('o padrão de cada chave é válido para o próprio tipo', () => {
    for (const c of CONFIGURACOES) {
      if (c.padrao === null) continue;
      expect(c.tipo.safeParse(c.padrao).success, c.chave).toBe(true);
    }
  });

  it('todas as pdv.* descem ao PDV; as chaves do ERP e de inatividade da sessão não', () => {
    for (const c of CONFIGURACOES.filter((x) => x.chave.startsWith('pdv.')))
      expect(c.pdv, c.chave).toBe(true);
    expect(CHAVES_CONFIGURACAO_PDV).toContain('pdv.usa_preco_volume');
    expect(CHAVES_CONFIGURACAO_PDV).toContain('pdv.desmembra_produto_kit');
    expect(CHAVES_CONFIGURACAO_PDV).toContain('geral.dia_operacional_hora_corte');
    expect(CHAVES_CONFIGURACAO_PDV).not.toContain('geral.ean_duplicado');
    expect(CHAVES_CONFIGURACAO_PDV).not.toContain('geral.sessao_inatividade_min');
    expect(CHAVES_CONFIGURACAO_PDV).not.toContain('erp.email_produtos_vencendo');
  });

  it('Central do PDV (decisão 66 do README do PDV): nada do que desce ao PDV é segredo e não há chave do cancelamento posterior', () => {
    // A aba Parâmetros mostra as regras da loja em claro; um segredo (`valor_cifrado`) nunca desce, e se um dia descer
    // a tela tem de mascará-lo. D23 mantida: as chaves `pdv.cancelamento_posterior_*` do plano não existem.
    for (const c of CONFIGURACOES.filter((x) => x.pdv)) expect(c.segredo ?? false, c.chave).toBe(false);
    expect(CONFIGURACOES.filter((c) => c.chave.startsWith('pdv.cancelamento_posterior'))).toEqual([]);
  });

  it('valida valores: dinheiro e percentual em string decimal, multa até 2 % (CDC)', () => {
    const tipo = (k: string) => CONFIGURACOES_POR_CHAVE.get(k)!.tipo;
    expect(tipo('pdv.troco_maximo').safeParse('500.00').success).toBe(true);
    expect(tipo('pdv.troco_maximo').safeParse(500).success).toBe(false);
    expect(tipo('financeiro.multa_pct').safeParse('2.0000').success).toBe(true);
    expect(tipo('financeiro.multa_pct').safeParse('3').success).toBe(false);
    expect(tipo('geral.dia_operacional_hora_corte').safeParse('05:00').success).toBe(true);
    expect(tipo('geral.dia_operacional_hora_corte').safeParse('24:00').success).toBe(false);
  });

  it('estoque.lote_baixa_sem_informar aceita exatamente os modos de MODOS_LOTE_BAIXA_SEM_INFORMAR (F2-B6)', () => {
    const tipo = CONFIGURACOES_POR_CHAVE.get(CHAVE_LOTE_BAIXA_SEM_INFORMAR)!.tipo;
    for (const modo of MODOS_LOTE_BAIXA_SEM_INFORMAR) expect(tipo.safeParse(modo).success, modo).toBe(true);
    expect(tipo.safeParse('baixar_tudo').success).toBe(false);
  });

  it('estoque.compra_atualiza_preco_custo: os três modos, padrão "perguntar" (F2-B15; D49)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO)!;
    expect(def.padrao).toBe('perguntar');
    for (const modo of MODOS_COMPRA_ATUALIZA_PRECO_CUSTO)
      expect(def.tipo.safeParse(modo).success, modo).toBe(true);
    expect(def.tipo.safeParse('as_vezes').success).toBe(false);
  });

  it('produtos.custo_base_margem: preço de custo, custo médio ou último custo, padrão "preco_custo" (F2-B16; D49)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_CUSTO_BASE_MARGEM)!;
    expect(def.padrao).toBe('preco_custo');
    expect(def.loja).toBe(false);
    for (const base of BASES_CUSTO_MARGEM) expect(def.tipo.safeParse(base).success, base).toBe(true);
    expect(def.tipo.safeParse('preco_venda').success).toBe(false);
  });

  it('notas_entrada.assinatura_invalida: avisar, recusar ou não conferir, padrão "avisar" (F2-B18; D50)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_ASSINATURA_INVALIDA)!;
    expect(def.padrao).toBe('avisar');
    expect(def.loja).toBe(false);
    expect(def.pdv).toBe(false);
    for (const modo of MODOS_ASSINATURA_INVALIDA) expect(def.tipo.safeParse(modo).success, modo).toBe(true);
    expect(def.tipo.safeParse('ignorar').success).toBe(false);
    expect(GRUPOS_CONFIGURACAO).toContain(grupoDaChave(CHAVE_ASSINATURA_INVALIDA));
  });

  it('estoque.transferencia_alerta_dias: inteiro de 1 a 365, padrão 3, da empresa e fora do PDV (F2-B26)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_TRANSFERENCIA_ALERTA_DIAS)!;
    expect(TRANSFERENCIA_ALERTA_DIAS_PADRAO).toBe(3);
    expect(def.padrao).toBe(3);
    expect(def.loja).toBe(false);
    expect(def.pdv).toBe(false);
    for (const v of [1, 3, 365]) expect(def.tipo.safeParse(v).success, String(v)).toBe(true);
    for (const v of [0, 366, 2.5, '3']) expect(def.tipo.safeParse(v).success, String(v)).toBe(false);
  });

  it('pdv.recusa_produto_com_variacoes: booleana, padrão Sim, por loja e desce ao PDV (F2-B34; D44)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_RECUSA_PRODUTO_COM_VARIACOES)!;
    expect(def.padrao).toBe(true);
    expect(def.loja).toBe(true);
    expect(def.pdv).toBe(true);
    expect(CHAVES_CONFIGURACAO_PDV).toContain(CHAVE_RECUSA_PRODUTO_COM_VARIACOES);
  });

  it('pdv.consulta_outras_lojas: booleana, padrão Sim, por loja e desce ao PDV (F2-B35; D53)', () => {
    const def = CONFIGURACOES_POR_CHAVE.get(CHAVE_CONSULTA_OUTRAS_LOJAS)!;
    expect(def.padrao).toBe(true);
    expect(def.loja).toBe(true);
    expect(def.pdv).toBe(true);
    expect(CHAVES_CONFIGURACAO_PDV).toContain(CHAVE_CONSULTA_OUTRAS_LOJAS);
  });
});
