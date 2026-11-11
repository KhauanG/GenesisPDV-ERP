/**
 * Contratos da estrutura da empresa (ERP 10.1, 10.3, 13.2; MD 3.2): empresa, lojas, caixas e locais de estoque.
 */
import { z } from 'zod';
import { idArquivoAnexo } from './arquivos.js';
import {
  cnpjCampo,
  emailOpcional,
  enderecoObrigatorio,
  textoObrigatorio,
  textoOpcional,
  uuidOpcional,
  vazioParaNulo,
  type MetadadosRegistro,
} from './campos.js';
import { REGIMES_FISCAIS, TIPOS_EMISSAO, TIPOS_ESTOQUE_LOCAL, TIPOS_LOJA } from './enums.js';
import { normalizarChavePix, PIX_CIDADE_MAXIMO, PIX_NOME_MAXIMO, tipoChavePix } from './implantacao.js';
import { paginacaoQuerySchema } from './paginacao.js';

/** Fuso IANA aceito pelo `Intl` (ADR-05). */
export function fusoValido(fuso: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(fuso) || fuso === 'UTC';
  } catch {
    return false;
  }
}

const fusoCampo = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .refine(fusoValido, 'Fuso horário inválido (use o formato IANA, ex.: America/Sao_Paulo)')
  .default('America/Sao_Paulo');

const telefoneOpcional = textoOpcional(20);

/** Lista de e-mails separados por vírgula ou ponto e vírgula (ERP 10.1 `email_contador`), gravada como "a, b". */
export const listaEmailsOpcional = z.preprocess(
  vazioParaNulo,
  z
    .string()
    .trim()
    .transform((v) =>
      v
        .split(/[;,\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    )
    .superRefine((lista, ctx) => {
      for (const e of lista) {
        if (!z.email().safeParse(e).success)
          ctx.addIssue({ code: 'custom', message: `E-mail inválido: ${e}` });
      }
    })
    .transform((lista) => lista.join(', '))
    .refine((v) => v.length <= 254, 'Até 254 caracteres')
    .nullable()
    .default(null),
);

// ---------------------------------------------------------------------------------------------------------------
// Empresa (ERP 10.1)

export const alterarEmpresaSchema = z.object({
  versao: z.number().int(),
  razaoSocial: textoObrigatorio(150, 'Informe a razão social'),
  nomeFantasia: textoObrigatorio(150, 'Informe o nome fantasia'),
  cnpj: cnpjCampo,
  ie: textoOpcional(20),
  inscricaoMunicipal: textoOpcional(20),
  ...enderecoObrigatorio,
  telefone: telefoneOpcional,
  email: emailOpcional,
  emailContador: listaEmailsOpcional,
  fusoHorario: fusoCampo,
});
export type AlterarEmpresaEntrada = z.input<typeof alterarEmpresaSchema>;
export type AlterarEmpresa = z.output<typeof alterarEmpresaSchema>;

export interface EmpresaDetalhe extends MetadadosRegistro {
  codigo: number;
  razaoSocial: string;
  nomeFantasia: string | null;
  cnpj: string;
  ie: string | null;
  inscricaoMunicipal: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  uf: string | null;
  municipioIbge: number | null;
  municipioNome: string | null;
  telefone: string | null;
  email: string | null;
  emailContador: string | null;
  fusoHorario: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Lojas (ERP 10.3; MD 3.2.2, 7.13)

export const SITUACOES_ATIVO = ['ativos', 'inativos', 'todos'] as const;
export type SituacaoAtivo = (typeof SITUACOES_ATIVO)[number];

export const ORDENACOES_LOJAS = ['codigo', 'nome', 'cnpj', 'tipo', 'ordem', 'ativa'] as const;

export const filtroLojasSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(60).optional(),
  situacao: z.enum(SITUACOES_ATIVO).default('todos'),
});
export type FiltroLojas = z.infer<typeof filtroLojasSchema>;

const chavePublica = z.preprocess(
  vazioParaNulo,
  z
    .string()
    .trim()
    .toLowerCase()
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use letras minúsculas, números e hífen')
    .nullable()
    .default(null),
);

const camposLoja = z.object({
  nome: textoObrigatorio(60, 'Informe o nome'),
  tipo: z.enum(TIPOS_LOJA).default('ponto_venda'),
  razaoSocial: textoObrigatorio(150, 'Informe a razão social'),
  nomeFantasia: textoObrigatorio(150, 'Informe o nome fantasia'),
  cnpj: cnpjCampo,
  ie: textoOpcional(20),
  inscricaoMunicipal: textoOpcional(20),
  telefone: telefoneOpcional,
  celular: telefoneOpcional,
  email: emailOpcional,
  ...enderecoObrigatorio,
  fusoHorario: fusoCampo,
  fraseRodapeCupom: textoOpcional(300),
  ordem: z.coerce.number().int().min(0).max(9999).default(0),
  ativa: z.boolean().default(true),
  usaPdv: z.boolean().default(true),
  usaMenuDigital: z.boolean().default(false),
  /**
   * Loja de treino (dono, O10): a loja "Treino" dentro da empresa real, com estoque próprio e não fiscal. As vendas
   * dela são gravadas como as das outras, mas as consultas e o dashboard do ERP a deixam de fora por padrão (C12). Só
   * vale com `tipoEmissao = 'nao_fiscal'` (`regrasLoja` e `ck_lojas_treino_nao_fiscal`): sem isso o faturamento fiscal
   * de uma loja real marcada por engano sumiria dos totais.
   */
  treino: z.boolean().default(false),
  chavePublica,
  /**
   * Recebedor do PIX estático com valor (PDV 16.7; implantação I5): a chave, o nome (até 25) e a cidade (até 15) que o
   * caixa põe no BR Code. Sem chave, o PIX continua pela confirmação manual, sem QR. A chave é conferida pelo formato
   * (`tipoChavePix`) e gravada como vai para o QR (CPF/CNPJ só com os dígitos).
   */
  chavePix: z.preprocess(
    vazioParaNulo,
    z
      .string()
      .trim()
      .max(77)
      .refine(
        (v) => tipoChavePix(v) !== null,
        'Chave PIX inválida (CPF, CNPJ, e-mail, +55 com DDD ou aleatória)',
      )
      .transform(normalizarChavePix)
      .nullable()
      .default(null),
  ),
  pixNomeRecebedor: textoOpcional(PIX_NOME_MAXIMO),
  pixCidadeRecebedor: textoOpcional(PIX_CIDADE_MAXIMO),
  // Aba Fiscal (colunas de `lojas`; certificado, CSC e TEF entram com a fase fiscal).
  regime: z.preprocess(vazioParaNulo, z.enum(REGIMES_FISCAIS).nullable().default(null)),
  tipoEmissao: z.enum(TIPOS_EMISSAO).default('nao_fiscal'),
  nfceAmbiente: z.union([z.literal(1), z.literal(2)]).default(2),
  nfeSerie: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1).max(889).nullable().default(null),
  ),
  nfcePrazoCancelamentoMin: z.coerce.number().int().min(1).max(10_080).default(30),
  nfceValorExigeIdentificacao: z
    .union([z.number(), z.string().trim()])
    .transform((v, ctx) => {
      const n = typeof v === 'number' ? v : Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: 'Valor inválido' });
        return z.NEVER;
      }
      return n.toFixed(2);
    })
    .default('10000.00'),
});

function regrasLoja(v: z.output<typeof camposLoja>, ctx: z.RefinementCtx): void {
  if (v.tipo === 'deposito' && v.usaPdv) {
    ctx.addIssue({ code: 'custom', path: ['usaPdv'], message: 'Depósito/CD não usa PDV' });
  }
  if (v.usaMenuDigital && !v.chavePublica) {
    ctx.addIssue({ code: 'custom', path: ['chavePublica'], message: 'Informe a chave para o menu digital' });
  }
  if (v.tipoEmissao === 'nfce' && !v.ie) {
    ctx.addIssue({ code: 'custom', path: ['ie'], message: 'A IE é obrigatória para emitir NFC-e' });
  }
  if (v.chavePix && !v.pixNomeRecebedor) {
    ctx.addIssue({
      code: 'custom',
      path: ['pixNomeRecebedor'],
      message: 'Informe o nome do recebedor (como aparece no app do banco)',
    });
  }
  if (v.treino && v.tipoEmissao !== 'nao_fiscal') {
    ctx.addIssue({
      code: 'custom',
      path: ['treino'],
      message: 'A loja de treino é não fiscal: troque o tipo de emissão para "Não fiscal (recibo)"',
    });
  }
}

/**
 * Criar loja = assistente de primeira configuração (MD 7.13): `estoqueId` vazio cria o estoque homônimo (tipo
 * `deposito` para loja depósito/CD); a API cria também o caixa 0, a conta "Caixa – {loja}" e as numerações.
 */
export const criarLojaSchema = camposLoja
  .extend({ estoqueId: uuidOpcional, nomeEstoque: textoOpcional(60) })
  .superRefine(regrasLoja);
export type CriarLojaEntrada = z.input<typeof criarLojaSchema>;
export type CriarLoja = z.output<typeof criarLojaSchema>;

/**
 * Anexos da loja (ERP 10.3.4; F2-B43): o id de um envio de `POST /api/arquivos?destino=loja_logotipo|loja_foto` da
 * própria loja, `null` para tirar ou ausente para manter (o ERP de antes do F2-B43 não manda e não apaga nada).
 */
const anexoLoja = idArquivoAnexo;

export const alterarLojaSchema = camposLoja
  .extend({
    versao: z.number().int(),
    estoqueId: z.uuid('Escolha o estoque vinculado'),
    logotipoArquivoId: anexoLoja,
    fotoArquivoId: anexoLoja,
  })
  .superRefine(regrasLoja);
export type AlterarLojaEntrada = z.input<typeof alterarLojaSchema>;
export type AlterarLoja = z.output<typeof alterarLojaSchema>;

export interface LojaResumo {
  id: string;
  codigo: number;
  nome: string;
  tipo: (typeof TIPOS_LOJA)[number];
  cnpj: string;
  estoqueId: string;
  estoqueNome: string | null;
  caixasAtivos: number;
  ativa: boolean;
  versao: number;
}

export interface LojaDetalhe extends MetadadosRegistro, z.output<typeof camposLoja> {
  codigo: number;
  estoqueId: string;
  estoqueNome: string | null;
  municipioNome: string | null;
  logotipoArquivoId: string | null;
  fotoArquivoId: string | null;
  /** Conta corrente "Caixa – loja" criada pelo assistente. */
  contaCaixaId: string | null;
  nfeProximoNumero: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Caixas (ERP 10.3.10; MD 3.2.7)

const serieNfce = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.coerce.number().int().min(1, 'Série de 1 a 889').max(889, 'Série de 1 a 889').nullable().default(null),
);

const camposCaixa = z.object({
  descricao: textoOpcional(40),
  nfceSerie: serieNfce,
  tefTerminal: textoOpcional(20),
  posIdTerminal: textoOpcional(40),
  ativo: z.boolean().default(true),
  /** Nº inicial da NFC-e: só enquanto o caixa nunca teve terminal (grava `numeracoes.ultimo_numero = n − 1`). */
  nfceNumeroInicial: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1).max(999_999_999).nullable().default(null),
  ),
});

export const criarCaixaSchema = camposCaixa.extend({
  numero: z.coerce.number().int().min(1, 'Caixas de PDV usam 1 a 99').max(99, 'Caixas de PDV usam 1 a 99'),
});
export type CriarCaixaEntrada = z.input<typeof criarCaixaSchema>;

export const alterarCaixaSchema = camposCaixa.extend({ versao: z.number().int() });
export type AlterarCaixaEntrada = z.input<typeof alterarCaixaSchema>;

export interface CaixaDetalhe {
  id: string;
  lojaId: string;
  numero: number;
  descricao: string | null;
  sistema: boolean;
  nfceSerie: number | null;
  tefTerminal: string | null;
  posIdTerminal: string | null;
  ativo: boolean;
  terminalId: string | null;
  /** O caixa já teve terminal: o PDV é o dono da numeração (SYNC 13.2). */
  jaTeveTerminal: boolean;
  nfceUltimoNumero: number | null;
  vendaUltimoNumero: number | null;
  versao: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Locais de estoque (ERP 13.2; MD 3.2.4)

export const ORDENACOES_ESTOQUES = ['codigo', 'nome', 'tipo', 'ativo'] as const;

export const filtroEstoquesSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(60).optional(),
  tipo: z.enum(TIPOS_ESTOQUE_LOCAL).optional(),
  situacao: z.enum(SITUACOES_ATIVO).default('ativos'),
});
export type FiltroEstoques = z.infer<typeof filtroEstoquesSchema>;

const camposEstoque = z.object({
  nome: textoObrigatorio(60, 'Informe o nome'),
  tipo: z.enum(TIPOS_ESTOQUE_LOCAL).default('loja'),
  endereco: textoOpcional(255),
  ativo: z.boolean().default(true),
});

export const criarEstoqueSchema = camposEstoque;
export type CriarEstoqueEntrada = z.input<typeof criarEstoqueSchema>;
export const alterarEstoqueSchema = camposEstoque.extend({ versao: z.number().int() });
export type AlterarEstoqueEntrada = z.input<typeof alterarEstoqueSchema>;

export interface EstoqueResumo {
  id: string;
  codigo: number;
  nome: string;
  tipo: (typeof TIPOS_ESTOQUE_LOCAL)[number];
  lojaId: string | null;
  lojaNome: string | null;
  ativo: boolean;
  versao: number;
}

export interface EstoqueDetalhe extends EstoqueResumo, MetadadosRegistro {
  endereco: string | null;
}

export const ROTULOS_TIPO_LOJA: Record<(typeof TIPOS_LOJA)[number], string> = {
  ponto_venda: 'Ponto de venda',
  deposito: 'Depósito / CD',
};

export const ROTULOS_TIPO_ESTOQUE: Record<(typeof TIPOS_ESTOQUE_LOCAL)[number], string> = {
  loja: 'Loja',
  deposito: 'Depósito (CD)',
  outro: 'Outro',
};

export const ROTULOS_TIPO_EMISSAO: Record<(typeof TIPOS_EMISSAO)[number], string> = {
  nao_fiscal: 'Não fiscal (recibo)',
  sat: 'CF-e SAT',
  mfe: 'CF-e MFE',
  nfce: 'NFC-e',
};
