/**
 * Catálogo de chaves de `configuracoes` (MD 3.1.2): tipo (`zod`), padrão, se aceita sobreposição por loja, se desce ao
 * PDV e se é segredo. Só existem linhas no banco para valores diferentes do padrão; valor efetivo =
 * loja ?? empresa ?? (chaves "UF": `parametros_fiscais_uf` vigente da UF da loja) ?? padrão daqui.
 *
 * Fase 1A: grupos `geral`, `estoque`, `pdv`, `fiscal`, `tributacao`, `financeiro`, `vendas` e `erp`; Fase 2: `produtos` e
 * `notas_entrada`.
 * As integrações (`integracoes.*`) e a ordem de serviço (`os.*`) entram com as fases que as usam.
 */
import { z } from 'zod';
import {
  CHAVE_TOLERANCIA_CONFERENCIA_ITEM,
  CHAVE_TOLERANCIA_CONFERENCIA_TOTAL,
  TOLERANCIA_CONFERENCIA_ITEM_PADRAO,
  TOLERANCIA_CONFERENCIA_TOTAL_PADRAO,
} from './conferencia.js';
import { REGIMES_FISCAIS } from './enums.js';
import { CHAVE_ASSINATURA_INVALIDA, MODOS_ASSINATURA_INVALIDA } from './notas-entrada.js';
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  CHAVE_LOTE_BAIXA_SEM_INFORMAR,
  MODOS_COMPRA_ATUALIZA_PRECO_CUSTO,
  MODOS_LOTE_BAIXA_SEM_INFORMAR,
} from './estoque.js';
import { BASES_CUSTO_MARGEM, CHAVE_CUSTO_BASE_MARGEM } from './precos.js';
import { CHAVE_TRANSFERENCIA_ALERTA_DIAS, TRANSFERENCIA_ALERTA_DIAS_PADRAO } from './transferencias.js';

export interface DefinicaoConfiguracao {
  chave: string;
  tipo: z.ZodType;
  /** Padrão do catálogo (`null` = sem valor). */
  padrao: unknown;
  /** Aceita sobreposição por loja. */
  loja: boolean;
  /** Desce ao PDV no fluxo `configuracao` (escopo empresa ou a loja do terminal). */
  pdv: boolean;
  /** Valor em `valor_cifrado` (nunca volta ao navegador nem desce em claro). */
  segredo?: boolean;
  /** Padrão vem da coluna de `parametros_fiscais_uf` da UF da loja (o `padrao` acima é só fallback). */
  padraoUf?: string;
}

const bool = z.boolean();
const inteiro = (min = 0, max = 1_000_000) => z.number().int().min(min).max(max);
const dinheiro = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
const percentual = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);
const uuid = z.uuid();
const texto = (max: number) => z.string().max(max);
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const umDe = <T extends readonly [string, ...string[]]>(valores: T) => z.enum(valores);

type Linha = [
  chave: string,
  tipo: z.ZodType,
  padrao: unknown,
  opcoes?: { loja?: boolean; pdv?: boolean; segredo?: boolean; padraoUf?: string },
];

const LP = { loja: true, pdv: true } as const;
const SO_PDV = { pdv: true } as const;

const LINHAS: Linha[] = [
  // Geral
  ['geral.ativa', bool, true, SO_PDV],
  ['geral.logotipo_arquivo_id', uuid, null, SO_PDV],
  ['geral.banner_arquivo_id', uuid, null, SO_PDV],
  ['geral.altera_preco_produto_erp', bool, true],
  ['geral.produto_usa_fornecedores', bool, false],
  ['geral.utiliza_servico_avulso', bool, false, LP],
  ['geral.margem_lucro_pct', percentual, '0'],
  ['geral.tipo_balanca', umDe(['peso', 'valor']), 'valor', LP],
  ['geral.balanca_prefixo', z.string().regex(/^[0-9]$/), '2', LP],
  ['geral.balanca_tamanho_codigo', inteiro(4, 6), 5, LP],
  ['geral.balanca_tamanho_valor', inteiro(5, 6), 6, LP],
  ['geral.ean_duplicado', umDe(['bloquear', 'avisar']), 'bloquear'],
  ['geral.sessao_inatividade_min', inteiro(15, 480), 60],
  ['geral.permite_acesso_suporte', bool, true],
  // D7 (dono, 31/10/2026): corte às 05:00 na empresa, ajustável por loja.
  ['geral.dia_operacional_hora_corte', hora, '05:00', LP],
  // Produtos. F2-B1 (D43, decidida pelo dono: complementos sim, variações não): criar "Com variações"/"Com
  // complementos" exige a chave (`CHAVES_TIPO_PRODUTO`); a de complementos é ligada pelo bloco que entrega o modal
  // (F2-B51) e a de variações fica desligada (a grade, F2-B49, saiu do escopo).
  ['produtos.variacoes_habilitadas', bool, false],
  ['produtos.complementos_habilitados', bool, false],
  // F2-B16 (F2-Q8 = D49, decidida pelo dono: "bem maleável"): o custo base do markup ⇄ preço da compra.
  [CHAVE_CUSTO_BASE_MARGEM, umDe(BASES_CUSTO_MARGEM), 'preco_custo'],
  // Estoque
  ['estoque.permite_negativo_erp', bool, false],
  ['estoque.transferencia_recebimento_automatico', bool, false],
  // F2-B25 (F2-Q11 = D52, padrão até a confirmação do dono): a sugestão de reposição da transferência sobe ao fardo ou
  // à caixa fechada (a embalagem de compra de maior fator), sem passar do saldo da origem; desligada, sai em unidades.
  ['estoque.reposicao_arredonda_embalagem', bool, true],
  // F2-B26 (padrão aplicado sem pergunta, plano da Fase 2): a transferência em trânsito ou com divergência sem tratar há
  // mais destes dias gera o alerta `TRANSFERENCIA_PARADA`.
  [CHAVE_TRANSFERENCIA_ALERTA_DIAS, inteiro(1, 365), TRANSFERENCIA_ALERTA_DIAS_PADRAO],
  ['estoque.custo_inclui_st', bool, true],
  ['estoque.custo_inclui_ipi', bool, true],
  ['estoque.custo_inclui_frete', bool, true],
  ['estoque.custo_abate_creditos', bool, false],
  // F2-B15 (F2-Q8 = D49, decidida pelo dono): a compra não sobrescreve o preço de custo manual sem confirmação.
  [CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO, umDe(MODOS_COMPRA_ATUALIZA_PRECO_CUSTO), 'perguntar'],
  // F2-B6 (F2-Q7 = D48, decidida pelo dono em 05/11/2026): a saída sem lote (venda do PDV, acerto) de produto com
  // saldo de lote no estoque é dividida por lote em FEFO; 'nao_baixar' deixa o saldo por lote só com o que informa
  // o lote. Os modos são os de `MODOS_LOTE_BAIXA_SEM_INFORMAR`, a mesma lista do tipo que o motor lê.
  [CHAVE_LOTE_BAIXA_SEM_INFORMAR, umDe(MODOS_LOTE_BAIXA_SEM_INFORMAR), 'fefo'],
  // F2-B11 (F2-Q6 = D47, decidida pelo dono em 05/11/2026, ajustável): tolerância do relatório de conferência do "Definir", em %
  // do valor contado a custo (total) e do saldo do sistema do próprio item (item). Por loja: o CD e cada loja podem
  // ter o seu limite (o estoque sem loja usa o da empresa).
  [CHAVE_TOLERANCIA_CONFERENCIA_TOTAL, percentual, TOLERANCIA_CONFERENCIA_TOTAL_PADRAO, { loja: true }],
  [CHAVE_TOLERANCIA_CONFERENCIA_ITEM, percentual, TOLERANCIA_CONFERENCIA_ITEM_PADRAO, { loja: true }],
  // NF-e de entrada. F2-B18 (F2-Q9 = D50, decidida pelo dono em 05/11/2026): a assinatura do XML que não confere só
  // avisa, e quem importa confirma; 'recusar' recusa a nota e 'nao_conferir' nem confere.
  [CHAVE_ASSINATURA_INVALIDA, umDe(MODOS_ASSINATURA_INVALIDA), 'avisar'],
  // PDV
  ['pdv.exibe_cardapio_interno', bool, false, LP],
  ['pdv.exibe_estoque_busca', bool, true, LP],
  ['pdv.dias_validade_cupom_troca', inteiro(0, 3650), 30, LP],
  ['pdv.fonte_lista', inteiro(8, 72), 14, LP],
  ['pdv.fonte_total', inteiro(8, 120), 36, LP],
  ['pdv.fonte_codigo', inteiro(8, 72), 20, LP],
  ['pdv.usa_pinpad_virtual', bool, false, LP],
  ['pdv.desmembra_produto_kit', bool, false, LP],
  ['pdv.solicita_abertura_caixa', bool, true, LP],
  ['pdv.resumo_diario_modo', umDe(['intervalo_dias', 'horario']), 'intervalo_dias', LP],
  ['pdv.comandas_numeracao_automatica', bool, false, LP],
  ['pdv.usa_preco_volume', bool, false, LP],
  ['pdv.vale_compra_validade_dias', inteiro(1, 3650), 90, SO_PDV],
  ['pdv.imprime_cupom_troca', bool, false, LP],
  ['pdv.bloqueia_venda_sem_estoque', bool, false, LP],
  ['pdv.limite_valor_venda', dinheiro, null, LP],
  ['pdv.aviso_vencimento', bool, false, LP],
  ['pdv.aviso_vencimento_dias', inteiro(1, 3650), 30, LP],
  ['pdv.limite_venda_em_aberto', inteiro(0, 1000), null, LP],
  ['pdv.imprime_sangria_automaticamente', bool, true, LP],
  ['pdv.valor_limite_sangria', dinheiro, null, LP],
  ['pdv.exibe_foto_produto', bool, false, LP],
  ['pdv.usa_pdv', bool, true, LP],
  ['pdv.orcamento_pdv', bool, false, LP],
  ['pdv.altera_preco_pdv', bool, false, LP],
  ['pdv.pedido_pdv', bool, false, LP],
  ['pdv.agrupa_produtos', bool, false, LP],
  ['pdv.solicita_vendedor_comanda', bool, false, LP],
  ['pdv.forca_escolha_vendedor', bool, false, LP],
  ['pdv.solicita_vendedor_finalizacao', bool, false, LP],
  ['pdv.atendente_ao_inves_vendedor', bool, false, LP],
  ['pdv.taxa_servico_pct', percentual, '0', LP],
  ['pdv.taxa_servico_no_balcao', bool, false, LP],
  ['pdv.taxa_servico_no_documento_fiscal', bool, false, LP],
  // O20 (dono, 31/10/2026): o caixa não pede confirmação de maioridade (`vendas.idade_confirmada_por_id` fica nulo).
  ['pdv.confirmacao_idade', umDe(['por_venda', 'por_item', 'desligado']), 'desligado', LP],
  ['pdv.vasilhame_comodato', bool, false, LP],
  // Decisão do dono (D29, 31/10/2026): o cancelamento da venda devolve ao cliente os vazios que ele trouxe.
  ['pdv.cancelamento_devolve_vazios', bool, true, LP],
  ['pdv.pix_manual_exige_supervisor', bool, true, LP],
  // C11c (D38, decidida pelo dono): o desconto pelo valor do casco (F11 › V) acima deste crédito por
  // venda pede o supervisor; 0 = sem teto (só a permissão `pdv.venda.desconto_total`).
  ['pdv.desconto_cascos_max_sem_supervisor', dinheiro, '50.00', LP],
  ['pdv.fechamento_cego', bool, true, LP],
  ['pdv.tolerancia_diferenca_caixa', dinheiro, '0.00', LP],
  // O3 (dono, 31/10/2026): o operador conta às cegas, não reconta e ninguém vê Calculado × Contado no PDV (só o
  // gerente, no ERP). `pdv.fechamento_mostra_conferencia` ligada volta ao fluxo da PDV 21.2 (conferência e recontagem).
  ['pdv.permite_recontagem', bool, false, LP],
  ['pdv.fechamento_mostra_conferencia', bool, false, LP],
  ['pdv.fechamento_eletronico_automatico', bool, true, LP],
  ['pdv.imprime_calculado_no_fechamento', bool, false, LP],
  ['pdv.sangria_limitada_ao_saldo', bool, true, LP],
  ['pdv.sangria_exige_senha_quem_retira', bool, false, LP],
  // O18 (dono, 31/10/2026): sem limite — o caixa nunca trava por falta de internet (o ERP alerta o terminal sem contato).
  ['pdv.dias_max_offline', inteiro(1, 60), null, LP],
  ['pdv.bloqueio_estoque_offline', bool, false, LP],
  ['pdv.crediario_exige_online', bool, false, LP],
  ['pdv.crediario_exige_senha_cliente', bool, false, LP],
  ['pdv.vale_exige_online', bool, false, LP],
  ['pdv.vale_exige_cliente_acima', dinheiro, '0.00', LP],
  ['pdv.troca_kit_parcial', bool, false, LP],
  ['pdv.devolucao_emite_nfe_entrada', bool, false, LP],
  ['pdv.delivery_emite_nota_na_saida', bool, true, LP],
  ['pdv.pix_validade_s', inteiro(60, 86_400), 300, LP],
  ['pdv.primeiro_vencimento_dias', inteiro(1, 365), 30, LP],
  // O8 (dono, 31/10/2026): o fluxo padrão não pergunta nada; CPF na nota e cliente só pelo F5, quando o cliente pedir.
  ['pdv.pergunta_cpf_na_finalizacao', bool, false, LP],
  ['pdv.horas_alerta_sessao', inteiro(1, 720), 24, LP],
  ['pdv.bloqueia_sessao_dia_anterior', bool, false, LP],
  ['pdv.cancelar_item_exige_supervisor', bool, false, LP],
  ['pdv.limite_preco_digitado', dinheiro, '9999.99', LP],
  ['pdv.troco_maximo', dinheiro, '500.00', LP],
  ['pdv.exige_impressao_danfe', bool, true, LP],
  ['pdv.imprime_qr_pix', bool, false, LP],
  ['pdv.limite_padrao_cliente_pdv', dinheiro, '0.00', LP],
  ['pdv.imprime_itens_cancelados', bool, false, LP],
  ['pdv.permite_pin_curto', bool, false, LP],
  ['pdv.login_aceita_senha_erp', bool, false, LP],
  ['pdv.pessoas_meses_relevancia', inteiro(1, 120), 12, LP],
  ['pdv.mobile.usa_comanda', bool, false, LP],
  ['pdv.mobile.usa_pedido', bool, false, LP],
  ['pdv.mobile.imprime_pelo_mobile', bool, false, LP],
  ['pdv.mobile.abertura', bool, false, LP],
  ['pdv.mobile.reforco', bool, false, LP],
  ['pdv.mobile.sangria', bool, false, LP],
  ['pdv.pesquisa_satisfacao_url_imagem', z.url().max(500), null, LP],
  // ERP
  ['erp.email_produtos_vencendo', bool, false, { loja: true }],
  ['erp.dias_produtos_vencendo', inteiro(1, 3650), 30, { loja: true }],
  ['erp.email_destino_vencendo', z.email().max(254), null, { loja: true }],
  // Fiscal (as colunas próprias de `lojas` — regime, série, ambiente — sobrepõem por loja)
  ['fiscal.regime', umDe(REGIMES_FISCAIS), 'simples_nacional', SO_PDV],
  ['fiscal.nfe_serie', inteiro(1, 889), 1],
  ['fiscal.inf_adic_contribuinte', texto(2000), null, LP],
  ['fiscal.inf_adic_fisco', texto(2000), null, LP],
  ['fiscal.ambiente', umDe(['producao', 'homologacao']), 'homologacao', SO_PDV],
  [
    'fiscal.prazo_transmissao_contingencia_h',
    inteiro(1, 720),
    24,
    { ...LP, padraoUf: 'prazo_transmissao_contingencia_h' },
  ],
  ['fiscal.inutilizacao_prazo_dia', inteiro(1, 28), 10, { ...LP, padraoUf: 'inutilizacao_prazo_dia' }],
  ['fiscal.exige_st_retido_nfce', bool, false, { ...LP, padraoUf: 'exige_st_retido_nfce' }],
  [
    'fiscal.st_retido_criterio',
    umDe(['ultima_entrada', 'media_ponderada']),
    'ultima_entrada',
    { loja: true },
  ],
  ['fiscal.taxa_entrega_como', umDe(['vfrete', 'outro']), 'vfrete', LP],
  ['fiscal.danfe_modo', umDe(['completo', 'resumido', 'eletronico_se_solicitado']), 'completo', LP],
  ['fiscal.intervalo_status_sefaz_s', inteiro(60, 3600), 300, LP],
  ['fiscal.atacado_como', umDe(['preco_unitario', 'desconto_item']), 'preco_unitario', LP],
  ['fiscal.servico_no_pdv', umDe(['bloquear', 'documento_separado']), 'bloquear', LP],
  ['fiscal.exige_vinculacao_pagamento', bool, false, { ...LP, padraoUf: 'exige_vinculacao_pagamento' }],
  // Tributação (padrões do cadastro do produto; o NCM padrão só pré-preenche, nunca vai para a nota)
  ['tributacao.ncm_padrao', z.string().regex(/^[0-9]{8}$/), null],
  ['tributacao.lei_transparencia_pct', percentual, null, SO_PDV],
  ['tributacao.icms_situacao', z.string().regex(/^[0-9]{2,3}$/), '102', SO_PDV],
  ['tributacao.icms_origem', z.string().regex(/^[0-8]$/), '0', SO_PDV],
  ['tributacao.icms_modalidade_bc', z.string().regex(/^[0-3]$/), '3', SO_PDV],
  ['tributacao.icms_modalidade_bcst', z.string().regex(/^[0-6]$/), null, SO_PDV],
  ['tributacao.icms_aliquota', percentual, '0', SO_PDV],
  ['tributacao.icms_credito_pct', percentual, '0', SO_PDV],
  ['tributacao.pis_situacao', z.string().regex(/^[0-9]{2}$/), '49', SO_PDV],
  ['tributacao.pis_aliquota', percentual, '0', SO_PDV],
  ['tributacao.cofins_situacao', z.string().regex(/^[0-9]{2}$/), '49', SO_PDV],
  ['tributacao.cofins_aliquota', percentual, '0', SO_PDV],
  // Financeiro
  ['financeiro.gera_boleto_automaticamente', bool, false, SO_PDV],
  ['financeiro.consolidar_vendas_quitadas', umDe(['por_sessao', 'por_venda']), 'por_sessao'],
  ['financeiro.lanca_quebra_automatica', bool, false],
  ['financeiro.juros_mes_pct', percentual, '0', SO_PDV],
  ['financeiro.multa_pct', z.string().regex(/^(0|1|2)(\.\d{1,4})?$/), '0', SO_PDV],
  ['financeiro.conta_destino_sangria', uuid, null, { loja: true }],
  ['financeiro.limite_credito_padrao', dinheiro, '0.00', SO_PDV],
  ['financeiro.dias_bloqueio_atraso', inteiro(0, 3650), 30, SO_PDV],
  // Vendas
  ['vendas.gera_datas_parcelamento', bool, true, SO_PDV],
  ['vendas.usa_remessa', bool, false],
  ['vendas.usa_recibo', bool, true, SO_PDV],
  ['vendas.titulo_recibo', texto(60), 'COMPROVANTE DE VENDA', LP],
  ['vendas.quatro_casas_decimais', bool, false, SO_PDV],
  ['vendas.exige_tipo_frete', bool, false],
  ['vendas.valida_estoque', bool, false, SO_PDV],
  ['vendas.solicita_id_orcamento', bool, false, SO_PDV],
  ['vendas.numeracao_propria', bool, false],
  ['vendas.permite_produtos_iguais', bool, true],
  ['vendas.bloqueia_pf_fora_estado', bool, false],
  ['vendas.valida_volumes_nfe', bool, false],
  ['vendas.vale_frase_bloqueio', texto(500), null, SO_PDV],
  ['vendas.vale_rodape', texto(500), null, SO_PDV],
];

export const CONFIGURACOES: readonly DefinicaoConfiguracao[] = LINHAS.map(([chave, tipo, padrao, o]) => ({
  chave,
  tipo,
  padrao,
  loja: o?.loja ?? false,
  pdv: o?.pdv ?? false,
  ...(o?.segredo ? { segredo: true } : {}),
  ...(o?.padraoUf ? { padraoUf: o.padraoUf } : {}),
}));

export const CONFIGURACOES_POR_CHAVE: ReadonlyMap<string, DefinicaoConfiguracao> = new Map(
  CONFIGURACOES.map((c) => [c.chave, c]),
);

/** Chaves que descem ao PDV (fluxo `configuracao`, MD 3.1.1). */
export const CHAVES_CONFIGURACAO_PDV: readonly string[] = CONFIGURACOES.filter((c) => c.pdv).map(
  (c) => c.chave,
);

/** Formato `<grupo>.<nome>` (até 100 caracteres, `configuracoes.chave`); o grupo aceita `_` (`notas_entrada`, F2-B18). */
export const REGEX_CHAVE_CONFIGURACAO = /^[a-z0-9]+(_[a-z0-9]+)*(\.[a-z0-9_]+)+$/;

// ---------------------------------------------------------------------------------------------------------------
// API de Configurações (ERP 9.0): leitura do valor efetivo e gravação só do que difere do padrão.

/** Grupos editáveis pelo ERP nesta fase (as abas Fiscal/Tributação/Financeiro/Vendas entram com as fases delas). */
export const GRUPOS_CONFIGURACAO = [
  'geral',
  'produtos',
  'estoque',
  'notas_entrada',
  'pdv',
  'fiscal',
  'tributacao',
  'financeiro',
  'vendas',
  'erp',
] as const;
export type GrupoConfiguracao = (typeof GRUPOS_CONFIGURACAO)[number];

/** Grupos que exigem `configuracoes.editar_fiscal` além de `configuracoes.editar` (ERP 9). */
export const GRUPOS_CONFIGURACAO_FISCAIS: readonly string[] = ['fiscal', 'tributacao'];

export function grupoDaChave(chave: string): string {
  return chave.split('.')[0]!;
}

export interface ValorConfiguracao {
  chave: string;
  /** Valor efetivo no escopo pedido (loja ?? empresa ?? padrão). */
  valor: unknown;
  padrao: unknown;
  /** Valor gravado no escopo empresa (`undefined` = sem linha, vale o padrão). */
  valorEmpresa?: unknown;
  /** Valor gravado na loja pedida (`undefined` = herda da empresa). */
  valorLoja?: unknown;
  loja: boolean;
  pdv: boolean;
  segredo: boolean;
  /** Lojas que sobrepõem esta chave (ícone 🏬 na tela de Configurações, ERP 9.0). */
  lojasSobrepondo: number;
}

/**
 * `PUT /configuracoes`: `valores` com `null` = volta ao herdado (exclui a linha). Sem `lojaId` grava na empresa;
 * com `lojaId` grava a sobreposição da loja (só chaves com `loja = true`).
 */
export const gravarConfiguracoesSchema = z.object({
  lojaId: z.uuid().nullable().default(null),
  valores: z
    .record(z.string().regex(REGEX_CHAVE_CONFIGURACAO), z.unknown())
    .refine((v) => Object.keys(v).length > 0, 'Nada para gravar'),
});
export type GravarConfiguracoes = z.output<typeof gravarConfiguracoesSchema>;

/** Valida um valor contra o catálogo; devolve a mensagem de erro ou `null`. */
export function validarValorConfiguracao(chave: string, valor: unknown): string | null {
  const def = CONFIGURACOES_POR_CHAVE.get(chave);
  if (!def) return 'Chave desconhecida';
  if (valor === null) return null;
  const r = def.tipo.safeParse(valor);
  return r.success ? null : (r.error.issues[0]?.message ?? 'Valor inválido');
}

// Atalhos do PDV (ERP 9.9; PDV 28.3; MD 3.10.2)

/** Teclas fixas do PDV e combinações do sistema operacional: nunca configuráveis (PDV 28.3). */
const TECLAS_PROIBIDAS = new Set(['alt+f4', 'ctrl+alt+del', 'ctrl+alt+delete']);
const MODIFICADORES = ['Ctrl', 'Alt', 'Shift'] as const;

/**
 * Normaliza e valida a tecla: `F1`–`F12` com ou sem modificadores; letra, dígito ou `Espaço` só com Ctrl/Alt (Shift
 * sozinho digitaria o caractere). Ordem canônica dos modificadores: Ctrl+Alt+Shift. Devolve `null` se inválida.
 */
export function normalizarTeclaAtalho(tecla: string): string | null {
  const partes = tecla
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes.length === 0) return null;
  const base = partes.pop()!;
  const mods = new Set<string>();
  for (const p of partes) {
    const m = MODIFICADORES.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  let chave: string;
  if (/^f([1-9]|1[0-2])$/i.test(base)) chave = base.toUpperCase();
  else if (/^[a-z0-9]$/i.test(base)) chave = base.toUpperCase();
  else if (/^(espaço|espaco|space)$/i.test(base)) chave = 'Espaço';
  else return null;
  const funcao = chave.startsWith('F') && chave.length > 1;
  if (!funcao && !mods.has('Ctrl') && !mods.has('Alt')) return null;
  const texto = [...MODIFICADORES.filter((m) => mods.has(m)), chave].join('+');
  return TECLAS_PROIBIDAS.has(texto.toLowerCase()) ? null : texto;
}

export const atalhoPdvSchema = z.object({
  acao: z.string().regex(/^[a-z_]{2,40}$/),
  tecla: z
    .string()
    .trim()
    .max(30)
    .transform((v, ctx) => {
      const n = normalizarTeclaAtalho(v);
      if (!n) {
        ctx.addIssue({ code: 'custom', message: 'Tecla inválida (F1–F12, Ctrl/Alt + letra ou número)' });
        return z.NEVER;
      }
      return n;
    }),
  habilitado: z.boolean(),
  ordem: z.coerce.number().int().min(0).max(999),
});

export const gravarAtalhosSchema = z
  .object({ itens: z.array(atalhoPdvSchema).min(1).max(200) })
  .superRefine((v, ctx) => {
    const porTecla = new Map<string, number>();
    v.itens.forEach((a, i) => {
      if (!a.habilitado) return;
      const k = a.tecla.toLowerCase();
      const outro = porTecla.get(k);
      if (outro !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'tecla'],
          message: `Tecla já usada em ${v.itens[outro]!.acao}`,
        });
      } else porTecla.set(k, i);
    });
    const acoes = v.itens.map((a) => a.acao);
    if (new Set(acoes).size !== acoes.length)
      ctx.addIssue({ code: 'custom', path: ['itens'], message: 'Ação repetida' });
  });
export type GravarAtalhos = z.output<typeof gravarAtalhosSchema>;

export interface AtalhoPdv {
  id: string;
  acao: string;
  tecla: string;
  habilitado: boolean;
  ordem: number;
}
