/** Formas de pagamento (ERP 10.2; MD 3.10.1). As regras abaixo repetem os CHECKs da tabela com mensagem por campo. */
import { z } from 'zod';
import {
  dinheiroOpcional,
  percentualCampo,
  textoObrigatorio,
  textoOpcional,
  uuidOpcional,
  vazioParaNulo,
  type MetadadosRegistro,
} from './campos.js';
import { SITUACOES_ATIVO } from './estrutura.js';
import { paginacaoQuerySchema } from './paginacao.js';

export const TIPOS_FORMA_PAGAMENTO = [
  'dinheiro',
  'cartao_credito',
  'cartao_debito',
  'pix',
  'crediario',
  'credito_funcionario',
  'vale',
  'vale_alimentacao',
  'vale_refeicao',
  'boleto',
  'cheque',
  'consumo_interno',
  'outros',
] as const;
export type TipoFormaPagamento = (typeof TIPOS_FORMA_PAGAMENTO)[number];

export const ROTULOS_TIPO_FORMA: Record<TipoFormaPagamento, string> = {
  dinheiro: 'Dinheiro',
  cartao_credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  pix: 'PIX',
  crediario: 'Crediário / caderneta',
  credito_funcionario: 'Crédito funcionário',
  vale: 'Vale compra',
  vale_alimentacao: 'Vale alimentação',
  vale_refeicao: 'Vale refeição',
  boleto: 'Boleto',
  cheque: 'Cheque',
  consumo_interno: 'Consumo interno / avaria',
  outros: 'Outros',
};

export const INTEGRACOES_FORMA = ['nenhuma', 'tef', 'pos_externo', 'pix_dinamico', 'pix_estatico'] as const;
export const ROTULOS_INTEGRACAO_FORMA: Record<(typeof INTEGRACOES_FORMA)[number], string> = {
  nenhuma: 'Nenhuma',
  tef: 'TEF',
  pos_externo: 'Maquininha (POS)',
  pix_dinamico: 'PIX dinâmico (PSP)',
  pix_estatico: 'PIX estático (chave da loja)',
};

export const USOS_FORMA = ['pdv', 'totem', 'menu_digital'] as const;

export const ORDENACOES_FORMAS_PAGAMENTO = ['descricao', 'ordem', 'tipo_forma', 'ativa'] as const;

export const filtroFormasPagamentoSchema = paginacaoQuerySchema.extend({
  descricao: z.string().trim().max(40).optional(),
  uso: z.enum(USOS_FORMA).optional(),
  situacao: z.enum(SITUACOES_ATIVO).default('ativos'),
  lojaId: z.uuid().optional(),
});
export type FiltroFormasPagamento = z.infer<typeof filtroFormasPagamentoSchema>;

const camposForma = z.object({
  descricao: textoObrigatorio(40, 'Informe a descrição'),
  ordem: z.coerce.number().int().min(0).max(9999).default(0),
  tipoForma: z.enum(TIPOS_FORMA_PAGAMENTO).default('outros'),
  meioPagamentoFiscal: z.string().regex(/^\d{2}$/, 'Escolha o meio de pagamento fiscal'),
  descricaoFiscal: textoOpcional(60),
  integracao: z.enum(INTEGRACOES_FORMA).default('nenhuma'),
  tipoPinpad: z.preprocess(vazioParaNulo, z.enum(['virtual', 'fisico']).nullable().default(null)),
  /**
   * Lojas em que a forma vale (C8b, O9a/D25; MD 3.10.1 `formas_pagamento_lojas`). Vazio = todas as lojas, inclusive
   * as que forem criadas depois. Desce só ao caixa dessas lojas; tirar uma loja tira a forma do caixa dela.
   */
  lojaIds: z
    .array(z.uuid())
    .max(500)
    .default([])
    .transform((l) => [...new Set(l)]),
  taxaPct: percentualCampo.default('0.0000'),
  diasRecebimento: z.coerce.number().int().min(0).max(3650).default(0),
  contaCorrenteId: uuidOpcional,
  planoContasId: uuidOpcional,
  /** Nova senha de liberação (texto, vira hash argon2id); vazio = mantém a atual. */
  senhaLiberacao: z.preprocess(
    vazioParaNulo,
    z.string().min(4, 'Use ao menos 4 caracteres').max(60).nullable().default(null),
  ),
  removerSenhaLiberacao: z.boolean().default(false),
  sempreZeradoPdv: z.boolean().default(false),
  lancaQuitada: z.boolean().default(true),
  permiteTroco: z.boolean().default(false),
  eBoleto: z.boolean().default(false),
  exigePessoa: z.boolean().default(false),
  ativa: z.boolean().default(true),
  abrirGaveta: z.boolean().default(false),
  usaPdv: z.boolean().default(true),
  usaTotem: z.boolean().default(false),
  usaMenuDigital: z.boolean().default(false),
  creditoFuncionario: z.boolean().default(false),
  permiteParcelar: z.boolean().default(false),
  parcelasMaximo: z.coerce.number().int().min(1, 'De 1 a 48').max(48, 'De 1 a 48').default(1),
  parcelaValorMinimo: dinheiroOpcional,
  geraQrcodePix: z.boolean().default(false),
  aPrazo: z.boolean().default(false),
  valeCompra: z.boolean().default(false),
  exigeDadosPos: z.boolean().default(false),
  restringeIdadeMinima: z.boolean().default(false),
  /** O caixa pede a liberação de um supervisor (PIN) para lançar a forma (C8b, O9a; PDV 16 e 31.3). */
  exigeSupervisor: z.boolean().default(false),
});

type CamposForma = z.output<typeof camposForma>;

/** Tipos que nunca dão troco (O23; `ck_formas_pagamento_troco`). */
export const TIPOS_SEM_TROCO = ['cartao_credito', 'cartao_debito', 'pix'] as const;

export function regrasFormaPagamento(v: CamposForma, ctx: z.RefinementCtx): void {
  const erro = (campo: keyof CamposForma, message: string) =>
    ctx.addIssue({ code: 'custom', path: [campo], message });
  if (v.meioPagamentoFiscal === '99' && !v.descricaoFiscal) {
    erro('descricaoFiscal', 'Obrigatória com o meio 99 (Outros)');
  }
  if (v.integracao === 'tef' && !v.tipoPinpad) erro('tipoPinpad', 'Escolha o tipo de pinpad do TEF');
  if (v.integracao !== 'tef' && v.tipoPinpad) erro('tipoPinpad', 'Só para formas com TEF');
  if (v.exigeDadosPos && v.integracao !== 'pos_externo')
    erro('exigeDadosPos', 'Só com integração Maquininha (POS)');
  if (!v.permiteParcelar && v.parcelasMaximo !== 1) erro('parcelasMaximo', 'Sem parcelamento, use 1');
  if (v.aPrazo && (!v.exigePessoa || v.lancaQuitada)) {
    erro('aPrazo', 'Venda a prazo exige pessoa e não pode lançar quitada');
  }
  if (v.creditoFuncionario && (!v.exigePessoa || v.lancaQuitada)) {
    erro('creditoFuncionario', 'Crédito funcionário exige pessoa e não pode lançar quitada');
  }
  if (v.eBoleto && !v.exigePessoa) erro('eBoleto', 'Boleto exige pessoa');
  if (v.tipoForma === 'consumo_interno') {
    if (v.meioPagamentoFiscal !== '90')
      erro('meioPagamentoFiscal', 'Consumo interno usa o meio 90 (Sem pagamento)');
    if (!v.lancaQuitada) erro('lancaQuitada', 'Consumo interno lança quitada');
    if (!v.planoContasId) erro('planoContasId', 'Escolha a conta de despesa');
    if (v.permiteTroco) erro('permiteTroco', 'Consumo interno não dá troco');
    if (v.abrirGaveta) erro('abrirGaveta', 'Consumo interno não abre a gaveta');
    if (v.exigePessoa) erro('exigePessoa', 'Consumo interno não exige pessoa');
  }
  // O23 (dono, 1C): troco só no dinheiro; cartão e PIX, e o que passa pela maquininha, TEF ou PIX, não passam do total
  // (`ck_formas_pagamento_troco`). Forma personalizada sem integração segue a flag (padrão desligada).
  if (
    v.permiteTroco &&
    (v.integracao !== 'nenhuma' || TIPOS_SEM_TROCO.includes(v.tipoForma as (typeof TIPOS_SEM_TROCO)[number]))
  ) {
    erro('permiteTroco', 'Cartão, PIX e formas pela maquininha não dão troco');
  }
  if (v.senhaLiberacao && v.removerSenhaLiberacao)
    erro('senhaLiberacao', 'Informe a senha ou remova, não os dois');
}

export const criarFormaPagamentoSchema = camposForma.superRefine(regrasFormaPagamento);
export type CriarFormaPagamentoEntrada = z.input<typeof criarFormaPagamentoSchema>;
export const alterarFormaPagamentoSchema = camposForma
  .extend({ versao: z.number().int() })
  .superRefine(regrasFormaPagamento);
export type AlterarFormaPagamentoEntrada = z.input<typeof alterarFormaPagamentoSchema>;

export interface FormaPagamentoResumo {
  id: string;
  descricao: string;
  ordem: number;
  tipoForma: TipoFormaPagamento;
  usaPdv: boolean;
  usaTotem: boolean;
  usaMenuDigital: boolean;
  /** Lojas em que a forma vale (C8b); vazio = todas. */
  lojas: Array<{ id: string; codigo: number; nome: string }>;
  ativa: boolean;
  versao: number;
}

export interface FormaPagamentoDetalhe
  extends MetadadosRegistro, Omit<CamposForma, 'senhaLiberacao' | 'removerSenhaLiberacao'> {
  senhaLiberacaoDefinida: boolean;
}

/** Opções dos seletores do formulário (`GET /formas-pagamento/opcoes`). */
export interface OpcoesFormaPagamento {
  meiosFiscais: Array<{ codigo: string; descricao: string; ativo: boolean }>;
  contasCorrentes: Array<{ id: string; descricao: string; lojaId: string | null }>;
  planosContas: Array<{ id: string; codigo: string; nome: string; tipo: string }>;
}
