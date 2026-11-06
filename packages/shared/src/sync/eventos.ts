/**
 * Payloads dos eventos de caixa, venda, vasilhame e alerta de cadastro (SYNC 9.3–9.9, 9.24, 9.26), `versao_schema` 1.
 * Ficam aqui, ao lado do envelope (`contratos.ts`), para a API validar com eles e para a suíte de contrato rodar as
 * mesmas fixtures (`packages/shared/testes/sync/*.payload.json`) no Vitest e no xUnit do PDV (`ContratosEventosTests`,
 * que confere a fixture contra o payload gerado pela `FabricaEventos`).
 *
 * Regras de forma (decisão técnica T17 da 1C, SYNC 9.1):
 * - chaves = nomes de tabela, campos = nomes de coluna; ficam de fora as colunas padrão (`criado_em`, `atualizado_em`,
 *   `excluido_em`, `versao`, autoria), as que só a nuvem preenche (custo, comissão, conta financeira, quantidade
 *   devolvida, fechamento forçado) e as geradas (`diferenca`). `COLUNAS_FORA_DO_PAYLOAD` lista o que fica de fora por
 *   tabela; o teste da API confere que o resto bate com as colunas do Drizzle;
 * - coluna `not null` sem padrão na nuvem é obrigatória; com padrão é opcional (a nuvem aplica o padrão); anulável é
 *   `nullable().optional()`. Decimais em texto com a escala da coluna (`"12.000"`, `"3.1900"`, `"38.28"`);
 * - os objetos aceitam chave desconhecida (como as requisições do sync, `contratos.ts`): o PDV mais novo que manda uma
 *   coluna a mais não trava o outbox. O que pega a chave com nome errado é a suíte de contrato: a fixture tem **todas**
 *   as chaves de cada linha e nenhuma pode ser descartada pelo schema;
 * - enums repetem os CHECKs da migração 0012 (o teste da API confere cada `z.enum`/`z.literal` das linhas contra a
 *   lista do CHECK da coluna, e uma coluna com enum sem lista conhecida quebra o teste): o valor fora da lista vira
 *   `PAYLOAD_INVALIDO` aqui, em vez de 23514 no meio do handler. As regras de soma (fechamento das contas, P6) não
 *   rejeitam: são do handler, que grava e alerta (`VENDA_INCONSISTENTE`).
 */
import { z } from 'zod';
import { TIPOS_FORMA_PAGAMENTO } from '../formas-pagamento.js';

const uuid = z.uuid();
const anulavel = <T extends z.ZodType>(s: T) => s.nullable().optional();
const instante = z.iso.datetime({ offset: true });
const data = z.iso.date();
const texto = (max: number) => z.string().max(max);
const textoPreenchido = (max: number) => z.string().trim().min(1).max(max);
const inteiroNaoNegativo = z.number().int().min(0);

/** Decimal em texto com exatamente `casas` casas (a escala da coluna); `sinal` aceita o `-`. */
function decimalTexto(inteiros: number, casas: number, sinal = false) {
  const re = new RegExp(`^${sinal ? '-?' : ''}\\d{1,${inteiros}}\\.\\d{${casas}}$`);
  return z.string().regex(re, `decimal com ${casas} casas${sinal ? '' : ', sem sinal'}`);
}
const maiorQueZero = (s: z.ZodString) => s.refine((v) => Number(v) > 0, 'deve ser maior que zero');

/** `numeric(15,2)`. */
const dinheiro = decimalTexto(13, 2);
/** `numeric(15,2)` que pode ficar negativo (calculado, estimado, diferença). */
const dinheiroComSinal = decimalTexto(13, 2, true);
/** `numeric(15,4)`. */
const preco = decimalTexto(11, 4);
/** `numeric(15,3)`. */
const quantidade = decimalTexto(12, 3);
/** `numeric(7,4)`. */
const percentual = decimalTexto(3, 4);

// ---------------------------------------------------------------------------------------------------------------
// Enums (CHECKs da 0012; `apps/api/src/database/empresa/schema/{vendas,caixa}.ts` têm as mesmas listas)
// ---------------------------------------------------------------------------------------------------------------

export const TIPOS_VENDA = ['pdv', 'venda'] as const;
export const CANAIS_VENDA = [
  'pdv',
  'erp',
  'ifood',
  '99food',
  'woocommerce',
  'nuvemshop',
  'menu_digital',
  'totem',
] as const;
export const MODOS_VENDA = ['balcao', 'comanda', 'pedido', 'delivery'] as const;
export const STATUS_FISCAL_VENDA = [
  'nao_aplicavel',
  'pendente',
  'transmitindo',
  'autorizada',
  'contingencia',
  'rejeitada',
  'denegada',
  'cancelamento_pendente',
  'cancelada',
  'inutilizada',
  'nfe_solicitada',
] as const;
export const ORIGENS_PRECO_ITEM = [
  'varejo',
  'loja',
  'promocional',
  'atacado',
  'quantidade',
  'grupo_mix',
  'parcelado',
  'manual',
  'balanca',
  'orcamento',
  'kit_rateio',
  'embalagem',
] as const;
export const ORIGENS_ENTRADA_ITEM = [
  'leitor',
  'teclado',
  'balanca',
  'etiqueta',
  'busca',
  'cardapio',
] as const;
export const STATUS_PAGAMENTO_VENDA = ['pendente', 'aprovado', 'cancelado', 'estornado'] as const;
export const TIPOS_PRECO_VENDA = ['varejo', 'atacado', 'parcelado'] as const;
export const ORIGENS_CANCELAMENTO_VENDA = ['pdv', 'erp'] as const;
export const ORIGENS_DESCONTO_TOTAL_VENDA = ['operador', 'cliente', 'orcamento'] as const;
export const OPERACOES_TRANSACAO_TEF = ['venda', 'cancelamento', 'administrativa'] as const;
export const STATUS_TRANSACAO_TEF = [
  'iniciada',
  'negada',
  'aprovada_pendente_confirmacao',
  'confirmada',
  'desfeita',
  'cancelada',
] as const;
export const TIPOS_COBRANCA_PIX = ['dinamico', 'estatico'] as const;
export const STATUS_COBRANCA_PIX = [
  'ativa',
  'paga',
  'expirada',
  'cancelada',
  'devolvida',
  'paga_sem_venda',
] as const;
export const TIPOS_FECHAMENTO_CAIXA = ['fechamento', 'troca_turno'] as const;
export const TIPOS_MOVIMENTO_CAIXA = [
  'abertura',
  'reforco',
  'sangria',
  'sangria_fechamento',
  'devolucao_troca',
  'estorno_venda',
] as const;
/**
 * Só sangria e reforço se cancelam pelo caixa (`caixa.movimento_cancelado`, PDV 20.3); o estorno da venda sai com o
 * `venda.cancelada`. A nuvem recusa os outros com `TRANSICAO_INVALIDA` (permanente) e o PDV repete a lista
 * (`TipoMovimentoCaixa.Cancelaveis`, conferida contra `testes/sync/eventos.conferencias.json`).
 */
export const MOVIMENTOS_CAIXA_CANCELAVEIS = [
  'reforco',
  'sangria',
] as const satisfies readonly (typeof TIPOS_MOVIMENTO_CAIXA)[number][];
export const DESTINOS_MOVIMENTO_VASILHAME = ['entrada', 'baixa_comodato', 'vale'] as const;

/** Origem de cada linha de `componentes_estoque` (SYNC 9.7): `kit` só de versões antigas do app. */
export const ORIGENS_COMPONENTE_ESTOQUE = ['ficha_tecnica', 'kit'] as const;

/**
 * Como cada pagamento da venda finalizada cancelada (forma A) volta ao cliente (SYNC 9.9, 10.4; PDV 13.3). Com a O22
 * (dono) o operador escolhe, no cartão e no PIX, entre o estorno no meio original (`pos_cancelado_na_maquininha`,
 * `pix_devolucao_manual`: a linha `estorno_venda` vai na forma original, nada sai da gaveta e a conta a receber da
 * forma é cancelada) e a devolução em dinheiro (`devolvido_em_dinheiro`: a linha vai na forma Dinheiro, sai da gaveta
 * e entra no esperado do fechamento, mas a transação do cartão/PIX **não** foi desfeita, então a conta a receber da
 * credenciadora/PSP e a conciliação ficam como estão). `dinheiro_devolvido` é só do pagamento cuja forma é dinheiro;
 * o PDV escolhe o valor pela forma do pagamento e o handler (C7) confere com o `tipo_forma` gravado.
 */
export const ESTORNOS_PAGAMENTO = [
  'dinheiro_devolvido',
  'devolvido_em_dinheiro',
  'dinheiro_nao_devolvido',
  'tef_cancelado',
  'tef_estorno_pendente',
  'pos_cancelado_na_maquininha',
  'pix_devolvido_api',
  'pix_devolucao_manual',
  'pix_devolucao_pendente',
  'credito_cancelado',
  'vale_restituido',
  'transferido',
] as const;
export type EstornoPagamento = (typeof ESTORNOS_PAGAMENTO)[number];

/**
 * Estornos efetivados no caixa (PDV 13.3): cada um vira uma linha `estorno_venda` por forma, na sessão do
 * cancelamento. Os pendentes, o dinheiro não devolvido, o crédito, o vale e o transferido não geram movimento.
 */
export const ESTORNOS_COM_MOVIMENTO_CAIXA = [
  'dinheiro_devolvido',
  'devolvido_em_dinheiro',
  'tef_cancelado',
  'pos_cancelado_na_maquininha',
  'pix_devolvido_api',
  'pix_devolucao_manual',
] as const satisfies readonly EstornoPagamento[];

/** `tipo_alerta` do `alerta.cadastro` (SYNC 9.24). */
export const TIPOS_ALERTA_CADASTRO = [
  'ncm_rejeitado',
  'gtin_rejeitado',
  'tributacao_rejeitada',
  'unidade_nao_fracionavel_balanca',
  'produto_sem_preco',
  'ean_duplicado_no_caixa',
] as const;

/**
 * Ações de `liberacoes` que o PDV já gera (decisão técnica T18 da 1C; `AcaoLiberacao` no PDV, conferidas pelos dois
 * lados contra `testes/sync/eventos.conferencias.json`): os descontos acima do limite e, desde o C11a, `pix_manual`
 * (confirmação manual do PIX liberada pelo supervisor, O9b), `forma_pagamento` (forma com "exige supervisor" ou senha
 * de liberação, C8b) e, desde o C11c, `desconto_cascos` (desconto pelo valor do casco liberado: operador sem
 * `pdv.venda.desconto_total` ou crédito acima de `pdv.desconto_cascos_max_sem_supervisor`). O campo é texto livre no
 * contrato: uma ação nova num PDV mais novo não pode recusar a venda inteira (é só registro, não muda estoque nem valor).
 */
export const ACOES_LIBERACAO_VENDA = [
  'desconto_item',
  'desconto_total',
  'pix_manual',
  'forma_pagamento',
  'desconto_cascos',
] as const;

/**
 * `vendas.motivo_cancelamento` no cancelamento da venda (O6, dono): texto livre de 15 a 255 caracteres, contados e
 * gravados sem os espaços das pontas, nas duas formas do `venda.cancelada`. O PDV (`Venda.MotivoCancelamento*`) e
 * este schema rodam as mesmas bordas (`testes/sync/eventos.conferencias.json`).
 */
export const MOTIVO_CANCELAMENTO_VENDA_MIN = 15;
export const MOTIVO_CANCELAMENTO_VENDA_MAX = 255;
const MENSAGEM_MOTIVO_CANCELAMENTO = `motivo de ${MOTIVO_CANCELAMENTO_VENDA_MIN} a ${MOTIVO_CANCELAMENTO_VENDA_MAX} caracteres`;
const motivoCancelamentoVenda = z
  .string()
  .trim()
  .min(MOTIVO_CANCELAMENTO_VENDA_MIN, MENSAGEM_MOTIVO_CANCELAMENTO)
  .max(MOTIVO_CANCELAMENTO_VENDA_MAX, MENSAGEM_MOTIVO_CANCELAMENTO);

// ---------------------------------------------------------------------------------------------------------------
// Linhas de caixa (MD 3.12)
// ---------------------------------------------------------------------------------------------------------------

/** Linha de `movimentos_caixa` (MD 3.12.2), comum a abertura, reforço, sangria, fechamento e estorno. */
const movimentoCaixaBase = z.object({
  id: uuid,
  sessao_caixa_id: uuid,
  loja_id: uuid,
  caixa_id: uuid,
  numero_caixa: z.number().int().min(1),
  terminal_id: uuid,
  tipo: z.enum(TIPOS_MOVIMENTO_CAIXA),
  forma_pagamento_id: anulavel(uuid),
  valor: maiorQueZero(dinheiro),
  operador_id: uuid,
  quem_retira_usuario_id: anulavel(uuid),
  quem_retira_nome: anulavel(texto(60)),
  observacao: anulavel(texto(255)),
  inf_adicionais: anulavel(texto(255)),
  ocorrido_em: instante,
  autorizado_por_id: anulavel(uuid),
  troca_id: anulavel(uuid),
  cancelado: z.literal(false).optional(),
});
export type MovimentoCaixa = z.infer<typeof movimentoCaixaBase>;

const movimentoDoTipo = <T extends (typeof TIPOS_MOVIMENTO_CAIXA)[number]>(tipo: T) =>
  movimentoCaixaBase.extend({ tipo: z.literal(tipo) });

/** "F2 Contar cédulas" (PDV 8.2): valor da cédula/moeda em texto → quantidade (só payload, vai para a auditoria). */
const contagemCedulas = anulavel(z.record(dinheiro, inteiroNaoNegativo));

const sessaoCaixaAberta = z.object({
  id: uuid,
  loja_id: uuid,
  caixa_id: uuid,
  numero_caixa: z.number().int().min(1),
  terminal_id: uuid,
  operador_id: uuid,
  status: z.literal('aberta'),
  dia_operacional: data,
  aberta_em: instante,
  abertura_automatica: z.boolean().optional(),
  fundo_troco: dinheiro.optional(),
  sessao_anterior_id: anulavel(uuid),
  valor_recebido_anterior: anulavel(dinheiro),
  diferenca_recebimento: anulavel(dinheiroComSinal),
  fechada_em: z.null().optional(),
});

/** Movimentos ligados à sessão do payload: o `sessao_caixa_id` de cada um é a sessão. */
function mesmaSessao(
  sessaoId: string,
  movimentos: ReadonlyArray<{ sessao_caixa_id: string }>,
  ctx: z.RefinementCtx,
  caminho: string,
) {
  movimentos.forEach((m, i) => {
    if (m.sessao_caixa_id !== sessaoId) {
      ctx.addIssue({ code: 'custom', path: [caminho, i, 'sessao_caixa_id'], message: 'outra sessão' });
    }
  });
}

/** `caixa.aberto` v1 (SYNC 9.3): agregado `sessao_caixa`. Fundo 0,00 → `movimentos_caixa` vazio. */
export const payloadCaixaAbertoSchema = z
  .object({
    sessoes_caixa: sessaoCaixaAberta,
    movimentos_caixa: z.array(movimentoDoTipo('abertura')).max(1).default([]),
    contagem_cedulas: contagemCedulas,
  })
  .superRefine((p, ctx) => {
    mesmaSessao(p.sessoes_caixa.id, p.movimentos_caixa, ctx, 'movimentos_caixa');
    const abertura = p.movimentos_caixa[0];
    if (abertura && abertura.valor !== (p.sessoes_caixa.fundo_troco ?? '0.00')) {
      ctx.addIssue({
        code: 'custom',
        path: ['movimentos_caixa', 0, 'valor'],
        message: 'o movimento de abertura é o fundo de troco',
      });
    }
  });
export type PayloadCaixaAberto = z.infer<typeof payloadCaixaAbertoSchema>;

const comQuemRetira = (m: MovimentoCaixa, ctx: z.RefinementCtx) => {
  // ck_movimentos_caixa_sangria
  if (m.tipo === 'sangria' && !m.quem_retira_usuario_id && !m.quem_retira_nome) {
    ctx.addIssue({ code: 'custom', path: ['movimentos_caixa', 'quem_retira_nome'], message: 'quem retira' });
  }
};

/** `caixa.reforco` v1 (SYNC 9.4): agregado `movimento_caixa`, depende da sessão. */
export const payloadCaixaReforcoSchema = z.object({
  movimentos_caixa: movimentoDoTipo('reforco'),
  dinheiro_estimado_antes: anulavel(dinheiroComSinal),
  contagem_cedulas: contagemCedulas,
});
export type PayloadCaixaReforco = z.infer<typeof payloadCaixaReforcoSchema>;

/** `caixa.sangria` v1 (SYNC 9.4): exige quem retira (usuário ou nome). */
export const payloadCaixaSangriaSchema = z
  .object({
    movimentos_caixa: movimentoDoTipo('sangria'),
    dinheiro_estimado_antes: anulavel(dinheiroComSinal),
    contagem_cedulas: contagemCedulas,
  })
  .superRefine((p, ctx) => comQuemRetira(p.movimentos_caixa, ctx));
export type PayloadCaixaSangria = z.infer<typeof payloadCaixaSangriaSchema>;

/** `caixa.movimento_cancelado` v1 (SYNC 9.5): só as colunas de cancelamento liberadas pela imutabilidade. */
export const payloadCaixaMovimentoCanceladoSchema = z.object({
  movimentos_caixa: z.object({
    id: uuid,
    cancelado: z.literal(true),
    cancelado_em: instante,
    cancelado_por_id: uuid,
    autorizado_cancelamento_por_id: anulavel(uuid),
    motivo_cancelamento: textoPreenchido(255),
  }),
});
export type PayloadCaixaMovimentoCancelado = z.infer<typeof payloadCaixaMovimentoCanceladoSchema>;

/**
 * `fechamentos_caixa.resumo` (SYNC 9.6): guardado inteiro no `jsonb` (`loose`, as chaves desconhecidas ficam).
 * `ultima_sequencia_evento` é a única que a nuvem lê (alerta de eventos do turno em erro ou retidos, SYNC 9.6).
 */
const resumoFechamento = z.looseObject({
  qtd_vendas: inteiroNaoNegativo.optional(),
  total_vendas: dinheiro.optional(),
  ticket_medio: dinheiro.optional(),
  qtd_canceladas: inteiroNaoNegativo.optional(),
  total_canceladas: dinheiro.optional(),
  qtd_itens_cancelados: inteiroNaoNegativo.optional(),
  total_itens_cancelados: dinheiro.optional(),
  total_descontos: dinheiro.optional(),
  qtd_liberacoes: inteiroNaoNegativo.optional(),
  qtd_trocas: inteiroNaoNegativo.optional(),
  total_vales_emitidos: dinheiro.optional(),
  nfce_emitidas: inteiroNaoNegativo.optional(),
  nfce_contingencia: inteiroNaoNegativo.optional(),
  nfce_pendentes: inteiroNaoNegativo.optional(),
  ultima_sequencia_evento: z.number().int().min(1),
});

const fechamentoCaixa = z.object({
  id: uuid,
  sessao_caixa_id: uuid,
  loja_id: uuid,
  caixa_id: uuid,
  terminal_id: uuid,
  numero_caixa: z.number().int().min(1),
  tipo: z.enum(TIPOS_FECHAMENTO_CAIXA),
  zera_caixa: z.boolean(),
  usuario_anterior_id: uuid,
  usuario_subsequente_id: anulavel(uuid),
  valor_caixa: dinheiro.optional(),
  total_calculado: dinheiroComSinal,
  total_digitado: dinheiro,
  justificativa: anulavel(texto(255)),
  recontagem: z.boolean().optional(),
  fechamento_cego: z.boolean(),
  ocorrido_em: instante,
  dia_operacional: data,
  resumo: resumoFechamento,
});

const fechamentoCaixaForma = z.object({
  id: uuid,
  fechamento_id: uuid,
  forma_pagamento_id: uuid,
  descricao_forma: textoPreenchido(40),
  tipo_forma: z.enum(TIPOS_FORMA_PAGAMENTO),
  valor_calculado: dinheiroComSinal,
  valor_digitado: dinheiro,
  quantidade_pagamentos: inteiroNaoNegativo.optional(),
  preenchido_automatico: z.boolean().optional(),
  valor_primeira_contagem: anulavel(dinheiro),
});

/** `caixa.fechado` v1 (SYNC 9.6): fechamento (zera, com `sangria_fechamento`) ou troca de turno (não zera, sem). */
export const payloadCaixaFechadoSchema = z
  .object({
    sessoes_caixa: z.object({ id: uuid, status: z.literal('fechada'), fechada_em: instante }),
    fechamentos_caixa: fechamentoCaixa,
    fechamentos_caixa_formas: z.array(fechamentoCaixaForma).default([]),
    movimentos_caixa: z.array(movimentoDoTipo('sangria_fechamento')).max(1).default([]),
  })
  .superRefine((p, ctx) => {
    const sessaoId = p.sessoes_caixa.id;
    const f = p.fechamentos_caixa;
    if (f.sessao_caixa_id !== sessaoId) {
      ctx.addIssue({
        code: 'custom',
        path: ['fechamentos_caixa', 'sessao_caixa_id'],
        message: 'outra sessão',
      });
    }
    // ck_fechamentos_caixa_zera: só o fechamento zera; a troca de turno passa a gaveta adiante.
    if (f.zera_caixa !== (f.tipo === 'fechamento')) {
      ctx.addIssue({
        code: 'custom',
        path: ['fechamentos_caixa', 'zera_caixa'],
        message: 'zera só no fechamento',
      });
    }
    if (f.tipo === 'troca_turno' && p.movimentos_caixa.length) {
      ctx.addIssue({ code: 'custom', path: ['movimentos_caixa'], message: 'troca de turno sem sangria' });
    }
    mesmaSessao(sessaoId, p.movimentos_caixa, ctx, 'movimentos_caixa');
    const formas = new Set<string>();
    p.fechamentos_caixa_formas.forEach((forma, i) => {
      if (forma.fechamento_id !== f.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['fechamentos_caixa_formas', i, 'fechamento_id'],
          message: 'outro fechamento',
        });
      }
      // uq_fechamentos_caixa_formas
      if (formas.has(forma.forma_pagamento_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fechamentos_caixa_formas', i, 'forma_pagamento_id'],
          message: 'forma repetida',
        });
      }
      formas.add(forma.forma_pagamento_id);
    });
  });
export type PayloadCaixaFechado = z.infer<typeof payloadCaixaFechadoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Venda (MD 3.11)
// ---------------------------------------------------------------------------------------------------------------

/** Cabeçalho de `vendas` (MD 3.11.2) com o `status` do evento. */
const cabecalhoVenda = <S extends z.ZodType>(status: S) =>
  z.object({
    id: uuid,
    numero: z.number().int().min(1),
    numero_exibicao: textoPreenchido(20),
    loja_id: uuid,
    caixa_id: uuid,
    numero_caixa: z.number().int().min(1),
    terminal_id: anulavel(uuid),
    sessao_caixa_id: anulavel(uuid),
    tipo: z.enum(TIPOS_VENDA),
    canal: z.enum(CANAIS_VENDA).optional(),
    modo: z.enum(MODOS_VENDA).optional(),
    id_externo: anulavel(texto(60)),
    status,
    status_fiscal: z.enum(STATUS_FISCAL_VENDA).optional(),
    devolucao: z.literal('nenhuma').optional(),
    dia_operacional: anulavel(data),
    operador_id: uuid,
    vendedor_id: anulavel(uuid),
    cliente_id: anulavel(uuid),
    cpf_cnpj_nota: anulavel(
      z.string().regex(/^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$/, 'CPF ou CNPJ só com dígitos'),
    ),
    nome_nota: anulavel(texto(60)),
    tipo_preco: z.enum(TIPOS_PRECO_VENDA).optional(),
    orcamento_id: anulavel(uuid),
    comanda_id: anulavel(uuid),
    pedido_id: anulavel(uuid),
    qtd_itens: inteiroNaoNegativo.optional(),
    subtotal_bruto: dinheiro.optional(),
    desconto_itens: dinheiro.optional(),
    desconto_total: dinheiro.optional(),
    desconto_total_pct: anulavel(percentual),
    desconto_total_origem: anulavel(z.enum(ORIGENS_DESCONTO_TOTAL_VENDA)),
    acrescimo_total: dinheiro.optional(),
    taxa_servico: dinheiro.optional(),
    taxa_entrega: dinheiro.optional(),
    valor_frete: dinheiro.optional(),
    total: dinheiro.optional(),
    troco: dinheiro.optional(),
    endereco_entrega: anulavel(z.record(z.string(), z.unknown())),
    observacao: anulavel(texto(500)),
    iniciada_em: instante,
    finalizada_em: anulavel(instante),
    cancelada_em: anulavel(instante),
    cancelada_por_id: anulavel(uuid),
    cancelamento_autorizado_por_id: anulavel(uuid),
    motivo_cancelamento: anulavel(texto(255)),
    cancelamento_origem: anulavel(z.enum(ORIGENS_CANCELAMENTO_VENDA)),
    idade_confirmada_por_id: anulavel(uuid),
    idade_confirmada_em: anulavel(instante),
    evento_finalizacao_id: anulavel(uuid),
  });

/** Baixa de estoque do item produzido (SYNC 9.7, só payload), já multiplicada pela quantidade e com a perda. */
const componenteEstoque = z.object({
  produto_id: uuid,
  variacao_id: anulavel(uuid),
  quantidade: maiorQueZero(quantidade),
  origem: z.enum(ORIGENS_COMPONENTE_ESTOQUE),
});

/** Linha de `itens_venda` (MD 3.11.3); o combo é uma linha por posição, ligadas por `kit_grupo_id`. */
const itemVenda = z
  .object({
    id: uuid,
    venda_id: uuid,
    sequencia: z.number().int().min(1),
    produto_id: uuid,
    variacao_id: anulavel(uuid),
    codigo_lido: anulavel(texto(30)),
    codigo_barras_id: anulavel(uuid),
    origem_entrada: anulavel(z.enum(ORIGENS_ENTRADA_ITEM)),
    peso_digitado: z.boolean().optional(),
    descricao: textoPreenchido(120),
    unidade: textoPreenchido(6),
    quantidade: maiorQueZero(quantidade),
    preco_tabela: preco,
    preco_unitario: preco,
    origem_preco: z.enum(ORIGENS_PRECO_ITEM).optional(),
    grupo_preco_quantidade_id: anulavel(uuid),
    quantidade_referencia_preco: anulavel(quantidade),
    valor_bruto: dinheiro,
    desconto_item: dinheiro.optional(),
    desconto_promocao: dinheiro.optional(),
    promocao_id: anulavel(uuid),
    desconto_rateado: dinheiro.optional(),
    acrescimo_rateado: dinheiro.optional(),
    frete_rateado: dinheiro.optional(),
    valor_liquido: dinheiro,
    lote_id: anulavel(uuid),
    lote: anulavel(texto(30)),
    validade_lote: anulavel(data),
    kit_grupo_id: anulavel(uuid),
    kit_produto_id: anulavel(uuid),
    kit_descricao: anulavel(texto(120)),
    kit_quantidade: anulavel(quantidade),
    kit_preco_unitario: anulavel(preco),
    kit_componente_id: anulavel(uuid),
    kit_alternativa_id: anulavel(uuid),
    kit_acrescimo: preco.optional(),
    vasilhame_item_origem_id: anulavel(uuid),
    item_comanda_id: anulavel(uuid),
    item_orcamento_id: anulavel(uuid),
    vendedor_id: anulavel(uuid),
    cfop: anulavel(z.string().regex(/^\d{4}$/)),
    ncm: anulavel(z.string().regex(/^\d{8}$/)),
    fiscal_snapshot: anulavel(z.record(z.string(), z.unknown())),
    v_ibs: anulavel(dinheiro),
    v_cbs: anulavel(dinheiro),
    v_is: anulavel(dinheiro),
    v_fcp: anulavel(dinheiro),
    v_icms_st_ret: anulavel(dinheiro),
    v_fcp_st_ret: anulavel(dinheiro),
    cancelado: z.boolean().optional(),
    cancelado_em: anulavel(instante),
    cancelado_por_id: anulavel(uuid),
    autorizado_por_id: anulavel(uuid),
    motivo_cancelamento: anulavel(texto(255)),
    incluido_em: instante,
    componentes_estoque: z.array(componenteEstoque).default([]),
  })
  .superRefine((i, ctx) => {
    // ck_itens_venda_kit: as colunas do combo andam juntas.
    const kit = [i.kit_grupo_id, i.kit_produto_id, i.kit_componente_id].map((v) => v != null);
    if (new Set(kit).size > 1 || (i.kit_alternativa_id != null && !kit[0])) {
      ctx.addIssue({ code: 'custom', path: ['kit_grupo_id'], message: 'colunas do combo incompletas' });
    }
    if (kit[0] && (i.kit_quantidade == null || i.kit_preco_unitario == null || !i.kit_descricao)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kit_quantidade'],
        message: 'combo sem quantidade, preço ou descrição',
      });
    }
  });

const itemVendaComplemento = z.object({
  id: uuid,
  item_venda_id: uuid,
  complemento_id: anulavel(uuid),
  grupo_nome: textoPreenchido(40),
  descricao: textoPreenchido(60),
  quantidade: maiorQueZero(quantidade).optional(),
  preco_adicional: preco.optional(),
});

/** Linha de `pagamentos_venda` (MD 3.11.4), com os snapshots da forma e o grupo `detPag`/`card`. */
const pagamentoVenda = z.object({
  id: uuid,
  venda_id: uuid,
  sequencia: z.number().int().min(1),
  forma_pagamento_id: uuid,
  descricao_forma: textoPreenchido(40),
  meio_pagamento_fiscal: z.string().regex(/^\d{2}$/),
  tipo_forma: z.enum(TIPOS_FORMA_PAGAMENTO),
  valor: maiorQueZero(dinheiro),
  valor_recebido: anulavel(dinheiro),
  troco: dinheiro.optional(),
  valor_taxa_servico: dinheiro.optional(),
  parcelas: z.number().int().min(1).optional(),
  status: z.enum(STATUS_PAGAMENTO_VENDA).optional(),
  lanca_quitada: z.boolean(),
  taxa_pct: percentual.optional(),
  pessoa_id: anulavel(uuid),
  indicador_pagamento: z.union([z.literal(0), z.literal(1)]).optional(),
  data_pagamento: anulavel(data),
  cnpj_pagamento: anulavel(z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/)),
  uf_pagamento: anulavel(z.string().regex(/^[A-Z]{2}$/)),
  tipo_integracao: anulavel(z.union([z.literal(1), z.literal(2)])),
  bandeira: anulavel(texto(2)),
  bandeira_nome: anulavel(texto(30)),
  adquirente: anulavel(texto(40)),
  cnpj_credenciadora: anulavel(z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/)),
  nsu: anulavel(texto(20)),
  autorizacao: anulavel(texto(20)),
  cartao_mascarado: anulavel(texto(20)),
  cnpj_beneficiario: anulavel(z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/)),
  id_terminal_pagamento: anulavel(texto(40)),
  tef_transacao_id: anulavel(uuid),
  pix_cobranca_id: anulavel(uuid),
  vale_id: anulavel(uuid),
  transferido_de_id: anulavel(uuid),
  autorizado_por_id: anulavel(uuid),
});

const parcelaVenda = z.object({
  id: uuid,
  pagamento_venda_id: uuid,
  numero: z.number().int().min(1),
  vencimento: data,
  valor: maiorQueZero(dinheiro),
});

/** Linha de `transacoes_tef` (MD 3.11.5): a venda (Fase 6) e o cancelamento da forma A. */
const transacaoTef = z.object({
  id: uuid,
  loja_id: uuid,
  terminal_id: uuid,
  venda_id: anulavel(uuid),
  pagamento_venda_id: anulavel(uuid),
  provedor: textoPreenchido(10),
  operacao: z.enum(OPERACOES_TRANSACAO_TEF).optional(),
  status: z.enum(STATUS_TRANSACAO_TEF).optional(),
  valor: dinheiro,
  parcelas: z.number().int().min(1).optional(),
  tipo_cartao: anulavel(texto(8)),
  bandeira: anulavel(texto(2)),
  bandeira_nome: anulavel(texto(30)),
  adquirente: anulavel(texto(40)),
  cnpj_credenciadora: anulavel(texto(14)),
  nsu: anulavel(texto(20)),
  nsu_host: anulavel(texto(20)),
  autorizacao: anulavel(texto(20)),
  codigo_resposta: anulavel(texto(10)),
  mensagem: anulavel(texto(255)),
  cartao_mascarado: anulavel(texto(20)),
  data_hora_transacao: anulavel(instante),
  comprovante_cliente: anulavel(z.string()),
  comprovante_loja: anulavel(z.string()),
  transacao_original_id: anulavel(uuid),
  iniciada_em: instante,
  confirmada_em: anulavel(instante),
  desfeita_em: anulavel(instante),
  cancelada_em: anulavel(instante),
});

/** Linha de `cobrancas_pix` (MD 3.11.6): no PDV-1 só a estática (QR da chave da loja ou confirmação manual). */
const cobrancaPix = z.object({
  id: uuid,
  txid: textoPreenchido(35),
  tipo: z.enum(TIPOS_COBRANCA_PIX),
  loja_id: uuid,
  terminal_id: uuid,
  venda_id: anulavel(uuid),
  pagamento_venda_id: anulavel(uuid),
  psp: anulavel(texto(30)),
  valor: dinheiro,
  status: z.enum(STATUS_COBRANCA_PIX).optional(),
  qrcode_payload: z.string(),
  expira_em: anulavel(instante),
  paga_em: anulavel(instante),
  e2e_id: anulavel(texto(32)),
  pagador_nome: anulavel(texto(60)),
  pagador_documento: anulavel(texto(14)),
  valor_devolvido: dinheiro.optional(),
  devolvida_em: anulavel(instante),
});

/**
 * Liberação de supervisor ligada à venda (SYNC 9.7, só payload; PDV 31.3): desconto, preço, limite. Também sobe em
 * `auditoria.registros`; aqui fica ligada ao item (ou à venda, `item_venda_id` nulo) e conta no `qtd_liberacoes`.
 */
const liberacaoVenda = z.object({
  acao: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(60),
  item_venda_id: anulavel(uuid),
  valor_pct: anulavel(percentual),
  autorizado_por_id: uuid,
  motivo: textoPreenchido(255),
  ocorrido_em: instante,
});

/** Cascos envolvidos na venda (SYNC 9.7, só payload; PDV 10.12). `emprestados` (comodato) exige o cliente. */
const vasilhameVenda = z
  .object({
    produto_vasilhame_id: uuid,
    devolvidos: inteiroNaoNegativo,
    vendidos: inteiroNaoNegativo,
    emprestados: inteiroNaoNegativo,
    pessoa_id: anulavel(uuid),
  })
  .superRefine((v, ctx) => {
    if (v.emprestados > 0 && !v.pessoa_id) {
      ctx.addIssue({ code: 'custom', path: ['pessoa_id'], message: 'comodato exige o cliente' });
    }
  });

/** O documento inteiro da venda: o `venda.finalizada` e a forma B do `venda.cancelada` (SYNC 9.7, 9.9 B). */
const documentoVenda = <S extends z.ZodType>(status: S) =>
  z.object({
    vendas: cabecalhoVenda(status),
    itens_venda: z.array(itemVenda),
    itens_venda_complementos: z.array(itemVendaComplemento).default([]),
    pagamentos_venda: z.array(pagamentoVenda).default([]),
    parcelas_venda: z.array(parcelaVenda).default([]),
    transacoes_tef: z.array(transacaoTef).default([]),
    cobrancas_pix: z.array(cobrancaPix).default([]),
    liberacoes: z.array(liberacaoVenda).default([]),
    vasilhames: z.array(vasilhameVenda).default([]),
    nfe_solicitada: z.boolean().default(false),
    nfe_pendente_erp: z.boolean().default(false),
  });
type DocumentoVenda = z.infer<ReturnType<typeof documentoVenda>>;

/**
 * Coerência interna do documento: as linhas são desta venda, as sequências não repetem e o que aponta para outra
 * linha (casco cobrado, parcela, complemento, liberação) aponta para uma linha do próprio payload.
 */
function documentoCoerente(p: DocumentoVenda, ctx: z.RefinementCtx) {
  const vendaId = p.vendas.id;
  const erro = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const itens = new Set(p.itens_venda.map((i) => i.id));
  const pagamentos = new Set(p.pagamentos_venda.map((pg) => pg.id));
  const sequencias = new Set<number>();
  p.itens_venda.forEach((i, n) => {
    if (i.venda_id !== vendaId) erro(['itens_venda', n, 'venda_id'], 'outra venda');
    if (sequencias.has(i.sequencia)) erro(['itens_venda', n, 'sequencia'], 'sequência repetida');
    sequencias.add(i.sequencia);
    if (i.vasilhame_item_origem_id && !itens.has(i.vasilhame_item_origem_id)) {
      erro(['itens_venda', n, 'vasilhame_item_origem_id'], 'item de origem fora da venda');
    }
  });
  const seqPagamentos = new Set<number>();
  p.pagamentos_venda.forEach((pg, n) => {
    if (pg.venda_id !== vendaId) erro(['pagamentos_venda', n, 'venda_id'], 'outra venda');
    if (seqPagamentos.has(pg.sequencia)) erro(['pagamentos_venda', n, 'sequencia'], 'sequência repetida');
    seqPagamentos.add(pg.sequencia);
  });
  p.parcelas_venda.forEach((pa, n) => {
    if (!pagamentos.has(pa.pagamento_venda_id)) {
      erro(['parcelas_venda', n, 'pagamento_venda_id'], 'pagamento fora da venda');
    }
  });
  p.itens_venda_complementos.forEach((c, n) => {
    if (!itens.has(c.item_venda_id))
      erro(['itens_venda_complementos', n, 'item_venda_id'], 'item fora da venda');
  });
  p.liberacoes.forEach((l, n) => {
    if (l.item_venda_id && !itens.has(l.item_venda_id)) {
      erro(['liberacoes', n, 'item_venda_id'], 'item fora da venda');
    }
  });
  if (p.nfe_solicitada && p.nfe_pendente_erp) erro(['nfe_pendente_erp'], 'nunca junto com nfe_solicitada');
}

/** `venda.finalizada` v1 (SYNC 9.7): agregado `venda`, depende da sessão. */
export const payloadVendaFinalizadaSchema = documentoVenda(z.literal('finalizada')).superRefine((p, ctx) => {
  documentoCoerente(p, ctx);
  if (!p.vendas.finalizada_em) {
    ctx.addIssue({
      code: 'custom',
      path: ['vendas', 'finalizada_em'],
      message: 'venda finalizada sem a hora',
    });
  }
  if (!p.itens_venda.length)
    ctx.addIssue({ code: 'custom', path: ['itens_venda'], message: 'venda sem itens' });
});
export type PayloadVendaFinalizada = z.infer<typeof payloadVendaFinalizadaSchema>;

/**
 * `venda.cancelada` v1 forma B (SYNC 9.9 B): a venda em andamento cancelada, documento completo, sem estoque nem
 * financeiro. É por ela que os números reservados e não finalizados aparecem no ERP. O motivo é o mesmo campo da forma
 * A (obrigatório, aparado antes de contar e de gravar), no lugar do `texto(255)` anulável do cabeçalho.
 */
const documentoVendaCancelada = documentoVenda(z.literal('cancelada'));
export const payloadVendaCanceladaEmAndamentoSchema = documentoVendaCancelada
  .extend({
    vendas: documentoVendaCancelada.shape.vendas.extend({ motivo_cancelamento: motivoCancelamentoVenda }),
  })
  .superRefine((p, ctx) => {
    documentoCoerente(p, ctx);
    const v = p.vendas;
    const erro = (campo: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: ['vendas', campo], message });
    if (v.finalizada_em != null) erro('finalizada_em', 'venda em andamento não tem finalização');
    if (!v.cancelada_em) erro('cancelada_em', 'cancelamento sem a hora');
  });
export type PayloadVendaCanceladaEmAndamento = z.infer<typeof payloadVendaCanceladaEmAndamentoSchema>;

/**
 * `venda.cancelada` v1 forma A (SYNC 9.9 A): venda finalizada cancelada na sessão aberta (PDV 13.3). Só as colunas
 * de cancelamento, o estorno de cada pagamento e os movimentos `estorno_venda` (uma linha por forma; só a da forma
 * Dinheiro sai da gaveta). Quem pode e até quando é regra do PDV (O6: só gerente, só na sessão ainda aberta).
 */
export const payloadVendaCanceladaFinalizadaSchema = z
  .object({
    vendas: z.object({
      id: uuid,
      status: z.literal('cancelada'),
      status_fiscal: z.enum(STATUS_FISCAL_VENDA).optional(),
      cancelada_em: instante,
      cancelada_por_id: uuid,
      cancelamento_autorizado_por_id: anulavel(uuid),
      motivo_cancelamento: motivoCancelamentoVenda,
      cancelamento_origem: z.literal('pdv'),
    }),
    sessao_caixa_cancelamento_id: uuid,
    pagamentos_venda: z
      .array(z.object({ id: uuid, status: z.literal('estornado'), estorno: z.enum(ESTORNOS_PAGAMENTO) }))
      .default([]),
    movimentos_caixa: z.array(movimentoDoTipo('estorno_venda')).default([]),
    transacoes_tef: z.array(transacaoTef).default([]),
  })
  .superRefine((p, ctx) => {
    mesmaSessao(p.sessao_caixa_cancelamento_id, p.movimentos_caixa, ctx, 'movimentos_caixa');
    // ck_movimentos_caixa_estorno_forma: o estorno diz de que forma o dinheiro saiu.
    p.movimentos_caixa.forEach((m, i) => {
      if (!m.forma_pagamento_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['movimentos_caixa', i, 'forma_pagamento_id'],
          message: 'estorno sem a forma',
        });
      }
    });
    const efetivados = p.pagamentos_venda.some((pg) =>
      (ESTORNOS_COM_MOVIMENTO_CAIXA as readonly string[]).includes(pg.estorno),
    );
    if (efetivados !== p.movimentos_caixa.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['movimentos_caixa'],
        message: 'estorno_venda só (e sempre) com estorno efetivado',
      });
    }
  });
export type PayloadVendaCanceladaFinalizada = z.infer<typeof payloadVendaCanceladaFinalizadaSchema>;

export type PayloadVendaCancelada = PayloadVendaCanceladaEmAndamento | PayloadVendaCanceladaFinalizada;

/** A forma do `venda.cancelada`: a B traz o documento (`itens_venda`), a A não. */
export function formaVendaCancelada(payload: unknown): 'em_andamento' | 'finalizada' {
  return typeof payload === 'object' && payload !== null && 'itens_venda' in payload
    ? 'em_andamento'
    : 'finalizada';
}

/**
 * `venda.cancelada` v1 nas duas formas. A forma vem da chave, não de um campo à parte, e cada uma é validada só pelo
 * seu schema: num `z.union` o erro da forma B sairia misturado com o "faltou `sessao_caixa_cancelamento_id`" da A.
 */
export const payloadVendaCanceladaSchema = z.unknown().transform((v, ctx): PayloadVendaCancelada => {
  const schema =
    formaVendaCancelada(v) === 'em_andamento'
      ? payloadVendaCanceladaEmAndamentoSchema
      : payloadVendaCanceladaFinalizadaSchema;
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const issue of r.error.issues)
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  return z.NEVER;
});

// ---------------------------------------------------------------------------------------------------------------
// Vasilhame e alerta
// ---------------------------------------------------------------------------------------------------------------

/**
 * `vasilhame.movimentado` v1 (SYNC 9.26): devolução avulsa de cascos vazios (F11 › V), agregado
 * `movimento_vasilhame`, depende da sessão. O contrato aceita os três destinos; na 1C o handler recusa
 * `baixa_comodato` e `vale` (Fase 3). `vales`/`movimentos_vale` chegam com o vale (Fase 3) e ficam livres até lá.
 */
export const payloadVasilhameMovimentadoSchema = z
  .object({
    movimentos_vasilhame: z.object({
      id: uuid,
      sessao_caixa_id: uuid,
      loja_id: uuid,
      caixa_id: uuid,
      terminal_id: uuid,
      operador_id: uuid,
      pessoa_id: anulavel(uuid),
      produto_vasilhame_id: uuid,
      quantidade: maiorQueZero(quantidade),
      destino: z.enum(DESTINOS_MOVIMENTO_VASILHAME),
      vale_id: anulavel(uuid),
      ocorrido_em: instante,
    }),
    vales: z.array(z.record(z.string(), z.unknown())).default([]),
    movimentos_vale: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .superRefine((p, ctx) => {
    const m = p.movimentos_vasilhame;
    // ck_movimentos_vasilhame_comodato e ck_movimentos_vasilhame_vale
    if (m.destino === 'baixa_comodato' && !m.pessoa_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['movimentos_vasilhame', 'pessoa_id'],
        message: 'comodato exige o cliente',
      });
    }
    if ((m.destino === 'vale') !== (m.vale_id != null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['movimentos_vasilhame', 'vale_id'],
        message: 'vale só no destino vale',
      });
    }
  });
export type PayloadVasilhameMovimentado = z.infer<typeof payloadVasilhameMovimentadoSchema>;

/** `alerta.cadastro` v1 (SYNC 9.24): agregado `produto`; vira `alertas` com `chave_deduplicacao`. */
export const payloadAlertaCadastroSchema = z.object({
  tipo_alerta: z.enum(TIPOS_ALERTA_CADASTRO),
  produto_id: uuid,
  variacao_id: anulavel(uuid),
  descricao: textoPreenchido(500),
  detalhes: z.record(z.string(), z.unknown()).default({}),
});
export type PayloadAlertaCadastro = z.infer<typeof payloadAlertaCadastroSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------------------------

export interface ContratoEvento {
  /** `agregado_tipo` do envelope (SYNC 7.3). */
  agregadoTipo: string;
  /** Schema por `versao_schema`. */
  versoes: Readonly<Record<number, z.ZodType>>;
  /** O `agregado_id` que o envelope deve trazer, lido do payload já validado. */
  agregadoId(payload: never): string;
}

/**
 * Tipos de evento de caixa, venda, vasilhame e alerta com contrato fixado (Fase 1C). Contrato aqui não é handler: a
 * nuvem só anuncia o tipo em `versoes_schema` (`/sync/estado`) quando o handler existe (`HANDLERS` da API), e o PDV
 * só grava o tipo anunciado (T13).
 */
export const CONTRATOS_EVENTOS = {
  'caixa.aberto': {
    agregadoTipo: 'sessao_caixa',
    versoes: { 1: payloadCaixaAbertoSchema },
    agregadoId: (p: PayloadCaixaAberto) => p.sessoes_caixa.id,
  },
  'caixa.reforco': {
    agregadoTipo: 'movimento_caixa',
    versoes: { 1: payloadCaixaReforcoSchema },
    agregadoId: (p: PayloadCaixaReforco) => p.movimentos_caixa.id,
  },
  'caixa.sangria': {
    agregadoTipo: 'movimento_caixa',
    versoes: { 1: payloadCaixaSangriaSchema },
    agregadoId: (p: PayloadCaixaSangria) => p.movimentos_caixa.id,
  },
  'caixa.movimento_cancelado': {
    agregadoTipo: 'movimento_caixa',
    versoes: { 1: payloadCaixaMovimentoCanceladoSchema },
    agregadoId: (p: PayloadCaixaMovimentoCancelado) => p.movimentos_caixa.id,
  },
  'caixa.fechado': {
    agregadoTipo: 'sessao_caixa',
    versoes: { 1: payloadCaixaFechadoSchema },
    agregadoId: (p: PayloadCaixaFechado) => p.sessoes_caixa.id,
  },
  'venda.finalizada': {
    agregadoTipo: 'venda',
    versoes: { 1: payloadVendaFinalizadaSchema },
    agregadoId: (p: PayloadVendaFinalizada) => p.vendas.id,
  },
  'venda.cancelada': {
    agregadoTipo: 'venda',
    versoes: { 1: payloadVendaCanceladaSchema },
    agregadoId: (p: PayloadVendaCancelada) => p.vendas.id,
  },
  'vasilhame.movimentado': {
    agregadoTipo: 'movimento_vasilhame',
    versoes: { 1: payloadVasilhameMovimentadoSchema },
    agregadoId: (p: PayloadVasilhameMovimentado) => p.movimentos_vasilhame.id,
  },
  'alerta.cadastro': {
    agregadoTipo: 'produto',
    versoes: { 1: payloadAlertaCadastroSchema },
    agregadoId: (p: PayloadAlertaCadastro) => p.produto_id,
  },
} as const satisfies Record<string, ContratoEvento>;
export type TipoEventoContratado = keyof typeof CONTRATOS_EVENTOS;

/**
 * Colunas de cada tabela que o payload não leva (SYNC 9.1; T17): as padrão ficam implícitas. O teste da API
 * (`contratos-eventos.spec.ts`) confere que colunas do Drizzle − estas = chaves do contrato.
 */
export const COLUNAS_FORA_DO_PAYLOAD = {
  vendas: {
    /** Só a nuvem preenche (MD 4.3); `relogio_confiavel` vem do envelope (T5). */
    nuvem: ['custo_total', 'relogio_confiavel'],
    /** Venda do ERP (Fase 3): nunca vem do caixa. */
    erp: [
      'endereco_entrega_id',
      'endereco_faturamento_id',
      'data_entrega',
      'observacao_nfe',
      'frete_modalidade',
      'frete_tipo',
      'transportadora_id',
      'volumes',
      'qtd_parcelas',
    ],
  },
  itens_venda: {
    nuvem: ['comissao_pct', 'valor_comissao', 'custo_unitario', 'quantidade_devolvida'],
    erp: [],
  },
  pagamentos_venda: { nuvem: ['conta_financeira_id'], erp: [] },
  movimentos_caixa: {
    /** As de cancelamento vêm no `caixa.movimento_cancelado`; a conta corrente é da Fase 4. */
    nuvem: [
      'cancelado_em',
      'cancelado_por_id',
      'autorizado_cancelamento_por_id',
      'motivo_cancelamento',
      'movimento_conta_corrente_id',
    ],
    erp: [],
  },
  sessoes_caixa: { nuvem: ['fechamento_forcado', 'fechamento_forcado_motivo'], erp: [] },
  fechamentos_caixa: { nuvem: ['diferenca'], erp: [] },
  fechamentos_caixa_formas: { nuvem: ['diferenca'], erp: [] },
  movimentos_vasilhame: {
    /** O cancelamento da devolução avulsa não tem evento na 1C. */
    nuvem: ['cancelado', 'cancelado_em', 'cancelado_por_id', 'motivo_cancelamento'],
    erp: [],
  },
} as const;
