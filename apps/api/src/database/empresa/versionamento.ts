import { TABELAS_DOS_FLUXOS } from '../../sync/fluxos.js';

/**
 * Qual trigger de `versao` cada tabela do banco da empresa usa (MD 1.5, "regra explícita"): toda tabela lida por
 * algum fluxo do /sync/pull usa `fn_versao` (com trava de ordenação) — a lista sai do registro de fluxos
 * (`src/sync/fluxos.ts`) —; as demais, `fn_versao_local`.
 * O teste de integração `versionamento` confere estas listas contra o banco migrado.
 */
export const TABELAS_FN_VERSAO: readonly string[] = TABELAS_DOS_FLUXOS;

/**
 * Colunas isentas de versão (argumentos do trigger `tg_<tabela>_versao`, migrações 0011, 0012 e 0016; MD 1.5; T3/T10
 * da 1C): se só elas mudam, a linha fica com a mesma `versao` e não desce. Só projeção mantida pelo banco e que nunca vai
 * ao PDV: toda coluna daqui fica no `omitir` do fluxo da tabela. Coluna editada no ERP **nunca** entra (o 409 do ERP
 * 1.4 lê a versão). Toda coluna gerada (`generated ... stored`) também entra: no trigger BEFORE o NEW dela chega nulo
 * e o UPDATE sem mudança real geraria versão nova; ela só muda junto das colunas de que deriva, então pode descer.
 * O teste `versionamento` confere os argumentos dos triggers, as colunas geradas e o `omitir` contra esta lista.
 */
export const COLUNAS_ISENTAS_VERSAO: Readonly<Record<string, readonly string[]>> = {
  // Projeção do razão (0006) mudada a cada venda; `preco_custo`/`markup_pct` do combo versionam (crítica da 1C, 12).
  produtos: ['custo_medio'],
  // Colunas geradas (0012): `total_digitado - total_calculado` e `valor_digitado - valor_calculado`.
  fechamentos_caixa: ['diferenca'],
  fechamentos_caixa_formas: ['diferenca'],
  // Ordem de lançamento do razão (0016, F2-B2; `fn_versao_local`): o preenchimento dos movimentos antigos não é
  // mudança do fato. A tabela não desce ao PDV.
  movimentos_estoque: ['seq_lancamento'],
  // Coluna gerada (0025, F2-B22): enviada − recebida do item da transferência.
  itens_transferencia: ['diferenca'],
};

export const TABELAS_FN_VERSAO_LOCAL = [
  'numeracoes',
  'arquivos',
  'alertas',
  'usuarios_estoques',
  'tipos_movimento_estoque',
  'planos_contas',
  'contas_correntes',
  'bancos',
  // MD 3.15 (—)
  'terminais',
  'comandos_terminal',
  // Fase 1A (—)
  'planos_contas_lojas',
  'cests',
  'pessoas_emails',
  'produtos_fornecedores',
  'produtos_imagens',
  'movimentos_estoque',
  'acertos_estoque',
  'itens_acerto_estoque',
  // Fase 1C: vendas e caixa (MD 3.11.2–3.11.6, 3.12.1–3.12.3, 3.12.6), sobem por evento e não descem (↑)
  'vendas',
  'itens_venda',
  'itens_venda_complementos',
  'pagamentos_venda',
  'parcelas_venda',
  'transacoes_tef',
  'cobrancas_pix',
  'sessoes_caixa',
  'movimentos_caixa',
  'fechamentos_caixa',
  'fechamentos_caixa_formas',
  'movimentos_vasilhame',
  // Fase 2: recebimento manual (MD 3.8.1, F2-B14), documento do ERP que não desce (—)
  'recebimentos',
  'itens_recebimento',
  // Fase 2: NF-e de fornecedor por XML (MD 3.8.2, F2-B18), documento do ERP que não desce (—)
  'notas_entrada',
  'itens_nota_entrada',
  'notas_entrada_duplicatas',
  // Fase 2: transferência entre estoques (MD 3.7.6, F2-B22), documento do ERP que não desce (—); os saldos descem
  // pelo fluxo `estoque`
  'transferencias_estoque',
  'itens_transferencia',
] as const;

/** Tabelas com bloco AU (`criado_por_id`, `atualizado_por_id` → usuarios). */
export const TABELAS_COM_AUTORIA = [
  'empresa',
  'lojas',
  'estoques',
  'tipos_estoque',
  'caixas',
  'perfis',
  'usuarios',
  'perfis_permissoes',
  'usuarios_permissoes',
  'usuarios_lojas',
  'usuarios_estoques',
  'configuracoes',
  'templates_documentos',
  'arquivos',
  'unidades_medida',
  'cfops_grupos',
  'planos_contas',
  'contas_correntes',
  'formas_pagamento',
  'atalhos_pdv',
  'terminais',
  'comandos_terminal',
  // Fase 1A
  'lojas_banners',
  'certificados_digitais',
  'impressoras_destino',
  'taxas_entrega',
  'planos_contas_lojas',
  'pessoas',
  'pessoas_categorias',
  'pessoas_enderecos',
  'pessoas_telefones',
  'pessoas_emails',
  'pessoas_aliases',
  'marcas',
  'categorias',
  'grupos_preco_quantidade',
  'grupos_preco_quantidade_faixas',
  'produtos',
  'produtos_categorias',
  'atributos_variacao',
  'atributos_variacao_valores',
  'produtos_variacoes',
  'produtos_variacoes_valores',
  'produtos_codigos_barras',
  'produtos_componentes',
  'produtos_componentes_alternativas',
  'produtos_relacionados',
  'produtos_precos_quantidade',
  'produtos_lojas',
  'produtos_tributacao_uf',
  'produtos_lotes',
  'produtos_fornecedores',
  'produtos_imagens',
  'restricoes_horario_venda',
  'acertos_estoque',
  // Fase 1C
  'vendas',
  'formas_pagamento_lojas',
  // Fase 2
  'recebimentos',
  'notas_entrada',
  'transferencias_estoque',
] as const;
