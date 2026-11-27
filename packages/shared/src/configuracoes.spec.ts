import { describe, expect, it } from 'vitest';
import {
  alterarNumeracaoVendaErpSchema,
  CHAVE_NUMERACAO_PROPRIA,
  CHAVES_CONFIGURACAO_PDV,
  chaveLigada,
  CONFIGURACOES,
  CONFIGURACOES_POR_CHAVE,
  consultaTerminaisDesatualizadosSchema,
  faixaConfiguracao,
  GRUPOS_CONFIGURACAO,
  grupoDaChave,
  REGEX_CHAVE_CONFIGURACAO,
  temVersaoPdv,
  valorGravadoValido,
  VERSAO_PDV_DA_CHAVE,
  VERSAO_PDV_R3,
  VERSAO_PDV_R4,
  VERSAO_PDV_R5,
} from './configuracoes.js';
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  CHAVE_LOTE_BAIXA_SEM_INFORMAR,
  MODOS_COMPRA_ATUALIZA_PRECO_CUSTO,
  MODOS_LOTE_BAIXA_SEM_INFORMAR,
} from './estoque.js';
import { CHAVE_ASSINATURA_INVALIDA, MODOS_ASSINATURA_INVALIDA } from './notas-entrada.js';
import { BASES_CUSTO_MARGEM, CHAVE_CUSTO_BASE_MARGEM } from './precos.js';
import { CHAVE_RECUSA_PRODUTO_COM_VARIACOES, VERSAO_PDV_GUARDA_VARIACOES } from './produtos.js';
import { CHAVE_CONSULTA_OUTRAS_LOJAS, NUMERO_VENDA_MAXIMO } from './sync/contratos.js';
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

  it('Fase 3 (F3-B3): o limite de comodato por cliente (D84) e a conferência do vale (D96), por loja e no PDV', () => {
    const comodato = CONFIGURACOES_POR_CHAVE.get('pdv.vasilhame_comodato_max_por_cliente')!;
    expect(comodato.padrao).toBe(6);
    expect([comodato.loja, comodato.pdv]).toEqual([true, true]);
    for (const v of [0, 6, 9999]) expect(comodato.tipo.safeParse(v).success, String(v)).toBe(true);
    for (const v of [-1, 10_000, 2.5, '6']) expect(comodato.tipo.safeParse(v).success, String(v)).toBe(false);
    // O recurso continua desligado até o dono ligar (D84).
    expect(CONFIGURACOES_POR_CHAVE.get('pdv.vasilhame_comodato')!.padrao).toBe(false);
    const conferencia = CONFIGURACOES_POR_CHAVE.get('pdv.vale_exige_conferencia')!;
    expect(conferencia.padrao).toBe(true);
    expect([conferencia.loja, conferencia.pdv]).toEqual([true, true]);
    // O limite padrão do cliente no caixa já existia desde a Fase 1: o F3-B3 não a recria.
    expect(CONFIGURACOES_POR_CHAVE.get('pdv.limite_padrao_cliente_pdv')).toBeDefined();
  });

  it('F3-B12: as faixas das seis chaves da ERP 9.3.1', () => {
    expect(faixaConfiguracao('pdv.dias_validade_cupom_troca')).toEqual({ min: 0, max: 365 });
    expect(faixaConfiguracao('pdv.fonte_lista')).toEqual({ min: 10, max: 32 });
    expect(faixaConfiguracao('pdv.fonte_total')).toEqual({ min: 20, max: 72 });
    expect(faixaConfiguracao('pdv.fonte_codigo')).toEqual({ min: 10, max: 40 });
    expect(faixaConfiguracao('pdv.vale_compra_validade_dias')).toEqual({ min: 1, max: 730 });
    expect(faixaConfiguracao('pdv.aviso_vencimento_dias')).toEqual({ min: 1, max: 365 });
    expect(faixaConfiguracao('pdv.troco_maximo')).toBeNull();
    expect(faixaConfiguracao('nao.existe')).toBeNull();
  });

  it('F3-B12: o valor gravado fora da faixa deixa de valer, sem recusar a leitura', () => {
    expect(valorGravadoValido('pdv.fonte_total', 120)).toBe(false);
    expect(valorGravadoValido('pdv.fonte_total', 72)).toBe(true);
    expect(valorGravadoValido('pdv.dias_validade_cupom_troca', 3650)).toBe(false);
    expect(valorGravadoValido('pdv.dias_validade_cupom_troca', 0)).toBe(true);
    expect(valorGravadoValido('pdv.limite_valor_venda', null)).toBe(true);
    expect(valorGravadoValido('pdv.troco_maximo', 500)).toBe(false);
    expect(valorGravadoValido('nao.existe', true)).toBe(false);
  });

  it('F3-B12: VERSAO_PDV_DA_CHAVE só com chaves do catálogo, versões válidas e trava só em booleanas', () => {
    const versoes = new Set(['0.11.0', VERSAO_PDV_R3, VERSAO_PDV_R4, VERSAO_PDV_R5]);
    for (const [chave, v] of Object.entries(VERSAO_PDV_DA_CHAVE)) {
      const def = CONFIGURACOES_POR_CHAVE.get(chave);
      expect(def, chave).toBeDefined();
      expect(versoes.has(v.versao), chave).toBe(true);
      // A chave do cadastro de produtos não desce, mas decide o que o caixa recebe (variações, F2-B34).
      if (chave !== 'produtos.variacoes_habilitadas') expect(def!.pdv, chave).toBe(true);
      if (v.trava) {
        expect(def!.tipo.safeParse(true).success, chave).toBe(true);
        expect(def!.tipo.safeParse(1).success, chave).toBe(false);
        // Nasce desligada: o padrão nunca liga a trava sozinho.
        expect(chaveLigada(def!.padrao), chave).toBe(false);
      }
    }
    expect(VERSAO_PDV_DA_CHAVE['produtos.variacoes_habilitadas']).toEqual({
      versao: VERSAO_PDV_GUARDA_VARIACOES,
      trava: false,
    });
    // Padrões da Fase 3: o comodato muda o que o cliente leva e paga, e só liga com todos os caixas na R4.
    expect(VERSAO_PDV_DA_CHAVE['pdv.vasilhame_comodato']).toEqual({ versao: VERSAO_PDV_R4, trava: true });
    expect(Object.values(VERSAO_PDV_DA_CHAVE).filter((v) => v.trava)).toHaveLength(1);
  });

  it('F3-B12: a consulta de terminais desatualizados aceita só chaves com versão', () => {
    const ok = consultaTerminaisDesatualizadosSchema.safeParse({
      chave: 'pdv.vasilhame_comodato,pdv.orcamento_pdv,pdv.vasilhame_comodato',
    });
    expect(ok.success && ok.data.chave).toEqual(['pdv.vasilhame_comodato', 'pdv.orcamento_pdv']);
    expect(consultaTerminaisDesatualizadosSchema.safeParse({ chave: 'pdv.troco_maximo' }).success).toBe(
      false,
    );
    expect(consultaTerminaisDesatualizadosSchema.safeParse({ chave: '' }).success).toBe(false);
    // O que vem do protótipo do objeto não é chave com versão (o `in` deixaria passar e a comparação daria 500).
    for (const c of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(temVersaoPdv(c), c).toBe(false);
      expect(consultaTerminaisDesatualizadosSchema.safeParse({ chave: c }).success, c).toBe(false);
      expect(
        consultaTerminaisDesatualizadosSchema.safeParse({ chave: `pdv.vasilhame_comodato,${c}` }).success,
        c,
      ).toBe(false);
    }
    expect(temVersaoPdv('pdv.vasilhame_comodato')).toBe(true);
  });

  it('F3-B12: Nº da próxima venda do ERP de 1 ao maior número de venda', () => {
    expect(CONFIGURACOES_POR_CHAVE.get(CHAVE_NUMERACAO_PROPRIA)!.padrao).toBe(false);
    for (const v of [1, NUMERO_VENDA_MAXIMO])
      expect(alterarNumeracaoVendaErpSchema.safeParse({ proximoNumero: v }).success).toBe(true);
    for (const v of [0, NUMERO_VENDA_MAXIMO + 1, 2.5, '10'])
      expect(alterarNumeracaoVendaErpSchema.safeParse({ proximoNumero: v }).success, String(v)).toBe(false);
  });
});
