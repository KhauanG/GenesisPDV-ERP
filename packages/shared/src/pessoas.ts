/** Pessoas (ERP 7.1, 7.2; MD 3.5): dados gerais, endereços, telefones, e-mails e categorias. */
import { z } from 'zod';
import {
  cepOpcional,
  dataOpcional,
  dinheiroOpcional,
  municipioOpcional,
  percentualCampo,
  textoOpcional,
  ufOpcional,
  vazioParaNulo,
  validarPin,
  type MetadadosRegistro,
} from './campos.js';
import { paginacaoQuerySchema } from './paginacao.js';
import { normalizarCnpj, somenteDigitos, validarCnpj, validarCpf } from './validadores.js';

export const CATEGORIAS_PESSOA = [
  'cliente',
  'fornecedor',
  'funcionario',
  'transportadora',
  'representante',
  'consumidor',
] as const;
export type CategoriaPessoa = (typeof CATEGORIAS_PESSOA)[number];

export const ROTULOS_CATEGORIA_PESSOA: Record<CategoriaPessoa, string> = {
  cliente: 'Cliente',
  fornecedor: 'Fornecedor',
  funcionario: 'Funcionário',
  transportadora: 'Transportadora',
  representante: 'Representante',
  consumidor: 'Consumidor',
};

export const TIPOS_ENDERECO = ['principal', 'entrega', 'cobranca', 'outro'] as const;
export const ROTULOS_TIPO_ENDERECO: Record<(typeof TIPOS_ENDERECO)[number], string> = {
  principal: 'Principal',
  entrega: 'Entrega',
  cobranca: 'Cobrança',
  outro: 'Outro',
};
export const TIPOS_TELEFONE = ['celular', 'comercial', 'residencial', 'whatsapp', 'outro'] as const;
export const ROTULOS_TIPO_TELEFONE: Record<(typeof TIPOS_TELEFONE)[number], string> = {
  celular: 'Celular',
  comercial: 'Comercial',
  residencial: 'Residencial',
  whatsapp: 'WhatsApp',
  outro: 'Outro',
};
export const INDICADORES_IE = ['contribuinte', 'isento', 'nao_contribuinte'] as const;
export const SEXOS = ['M', 'F', 'O', 'N'] as const;

export const ORDENACOES_PESSOAS = ['codigo', 'nome', 'cpf_cnpj', 'cidade'] as const;

const lista = (v: unknown) =>
  typeof v === 'string'
    ? v.split(',').filter(Boolean)
    : Array.isArray(v)
      ? v
      : v === undefined
        ? undefined
        : v;

export const filtroPessoasSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(150).optional(),
  cpfCnpj: z.string().trim().max(18).optional(),
  cep: z.string().trim().max(9).optional(),
  cidade: z.string().trim().max(80).optional(),
  categorias: z.preprocess(lista, z.array(z.enum(CATEGORIAS_PESSOA)).optional()),
  uf: z.string().trim().toUpperCase().length(2).optional(),
  situacao: z.enum(['ativas', 'inativas', 'todas']).default('ativas'),
  codigo: z.coerce.number().int().min(1).optional(),
});
export type FiltroPessoas = z.infer<typeof filtroPessoasSchema>;

const idFilha = z.preprocess(vazioParaNulo, z.uuid().nullable().default(null));

export const enderecoPessoaSchema = z
  .object({
    id: idFilha,
    tipo: z.enum(TIPOS_ENDERECO).default('principal'),
    cep: cepOpcional,
    logradouro: textoOpcional(150),
    numero: textoOpcional(20),
    complemento: textoOpcional(80),
    bairro: textoOpcional(80),
    uf: ufOpcional,
    municipioIbge: municipioOpcional,
    exterior: z.boolean().default(false),
    paisCodigo: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .regex(/^\d{4}$/, 'País inválido')
        .nullable()
        .default(null),
    ),
    cidadeExterior: textoOpcional(80),
    referencia: textoOpcional(150),
  })
  .superRefine((e, ctx) => {
    if (e.exterior) {
      if (!e.paisCodigo) ctx.addIssue({ code: 'custom', path: ['paisCodigo'], message: 'Escolha o país' });
      return;
    }
    const obrigatorios: Array<[keyof typeof e, string]> = [
      ['cep', 'Informe o CEP'],
      ['logradouro', 'Informe o endereço'],
      ['numero', 'Informe o número (ou S/N)'],
      ['bairro', 'Informe o bairro'],
      ['uf', 'Escolha a UF'],
      ['municipioIbge', 'Escolha a cidade'],
    ];
    for (const [campo, message] of obrigatorios) {
      if (e[campo] === null || e[campo] === '') ctx.addIssue({ code: 'custom', path: [campo], message });
    }
  });

export const telefonePessoaSchema = z
  .object({
    id: idFilha,
    tipo: z.enum(TIPOS_TELEFONE).default('celular'),
    /** Aceita "(41) 99999-0000" num campo só: o DDD sai dos 2 primeiros dígitos quando `ddd` vier vazio. */
    ddd: z.preprocess((v) => (typeof v === 'string' ? somenteDigitos(v) : v), z.string().default('')),
    numero: z.preprocess((v) => (typeof v === 'string' ? somenteDigitos(v) : v), z.string()),
    contato: textoOpcional(80),
    principal: z.boolean().default(false),
  })
  .transform((t) =>
    !t.ddd && t.numero.length >= 10 ? { ...t, ddd: t.numero.slice(0, 2), numero: t.numero.slice(2) } : t,
  )
  .superRefine((t, ctx) => {
    if (!/^[1-9]\d$/.test(t.ddd)) ctx.addIssue({ code: 'custom', path: ['ddd'], message: 'DDD inválido' });
    if (!/^\d{8,9}$/.test(t.numero))
      ctx.addIssue({ code: 'custom', path: ['numero'], message: 'Telefone com 8 ou 9 dígitos' });
  });

export const emailPessoaSchema = z.object({
  id: idFilha,
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('E-mail inválido')),
  principal: z.boolean().default(false),
  recebeDocumentos: z.boolean().default(true),
});

const camposPessoa = z.object({
  tipo: z.enum(['PF', 'PJ']).default('PF'),
  nome: z.string().trim().min(2, 'Informe ao menos 2 caracteres').max(150),
  apelido: textoOpcional(150),
  ativa: z.boolean().default(true),
  cpfCnpj: z.preprocess(
    (v) => (typeof v === 'string' ? normalizarCnpj(v) || null : v),
    z.string().nullable().default(null),
  ),
  rgIe: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() || null : v),
    z.string().max(20).nullable().default(null),
  ),
  indicadorIe: z.enum(INDICADORES_IE).default('nao_contribuinte'),
  inscricaoMunicipal: textoOpcional(20),
  nascimento: dataOpcional,
  sexo: z.enum(SEXOS).default('N'),
  limiteCompras: dinheiroOpcional,
  descontoPct: percentualCampo.default('0.0000'),
  bloqueadaCredito: z.boolean().default(false),
  observacoes: textoOpcional(5000),
  observacaoPdv: textoOpcional(200),
  /**
   * Relevância `manual` (MD 3.5.4, D19): a pessoa desce para o espelho de todos os PDVs da empresa, mesmo sem ser
   * funcionário nem ter crediário (busca offline no caixa).
   */
  manterNoPdv: z.boolean().default(false),
  categorias: z.array(z.enum(CATEGORIAS_PESSOA)).default(['cliente']),
  enderecos: z.array(enderecoPessoaSchema).max(50).default([]),
  telefones: z.array(telefonePessoaSchema).max(50).default([]),
  emails: z.array(emailPessoaSchema).max(50).default([]),
  /** Senha do cliente para compra a prazo (6–8 dígitos, ERP 7.2); vazio = mantém. */
  senha: z.preprocess(vazioParaNulo, z.string().nullable().default(null)),
  removerSenha: z.boolean().default(false),
});

type CamposPessoa = z.output<typeof camposPessoa>;

function regrasPessoa(v: CamposPessoa, ctx: z.RefinementCtx): void {
  const erro = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (v.cpfCnpj) {
    if (v.tipo === 'PF' && !validarCpf(v.cpfCnpj)) erro(['cpfCnpj'], 'CPF inválido');
    if (v.tipo === 'PJ' && !validarCnpj(v.cpfCnpj)) erro(['cpfCnpj'], 'CNPJ inválido');
  } else if (v.tipo === 'PJ' && v.categorias.includes('fornecedor')) {
    erro(['cpfCnpj'], 'CNPJ obrigatório para fornecedor PJ');
  }
  if (v.categorias.length === 0) erro(['categorias'], 'Escolha ao menos uma categoria');
  if (new Set(v.categorias).size !== v.categorias.length) erro(['categorias'], 'Categoria repetida');
  if (v.nascimento && v.nascimento > new Date().toISOString().slice(0, 10)) {
    erro(['nascimento'], 'A data não pode ser futura');
  }
  if (v.tipo === 'PJ' && v.sexo !== 'N') erro(['sexo'], 'Sexo só para pessoa física');
  if (v.enderecos.length > 0 && v.enderecos.filter((e) => e.tipo === 'principal').length !== 1) {
    erro(['enderecos'], 'Marque exatamente um endereço como principal');
  }
  if (v.telefones.filter((t) => t.principal).length > 1) erro(['telefones'], 'Só um telefone principal');
  if (v.emails.filter((e) => e.principal).length > 1) erro(['emails'], 'Só um e-mail principal');
  const emails = v.emails.map((e) => e.email);
  if (new Set(emails).size !== emails.length) erro(['emails'], 'E-mail repetido');
  if (v.senha) {
    const msg = validarPin(v.senha);
    if (msg) erro(['senha'], msg);
    if (v.removerSenha) erro(['senha'], 'Informe a senha ou remova, não os dois');
  }
}

export const criarPessoaSchema = camposPessoa.superRefine(regrasPessoa);
export type CriarPessoaEntrada = z.input<typeof criarPessoaSchema>;
export type CriarPessoa = z.output<typeof criarPessoaSchema>;
export const alterarPessoaSchema = camposPessoa
  .extend({ versao: z.number().int() })
  .superRefine(regrasPessoa);
export type AlterarPessoaEntrada = z.input<typeof alterarPessoaSchema>;

export interface PessoaResumo {
  id: string;
  codigo: number;
  tipo: 'PF' | 'PJ';
  nome: string;
  apelido: string | null;
  cpfCnpj: string | null;
  telefone: string | null;
  email: string | null;
  categorias: CategoriaPessoa[];
  cidade: string | null;
  uf: string | null;
  ativa: boolean;
  versao: number;
}

type Filha<T extends z.ZodType> = Omit<z.output<T>, 'id'> & { id: string };

export interface PessoaDetalhe
  extends
    MetadadosRegistro,
    Omit<CamposPessoa, 'senha' | 'removerSenha' | 'enderecos' | 'telefones' | 'emails'> {
  codigo: number;
  origem: string;
  senhaDefinida: boolean;
  enderecos: Array<Filha<typeof enderecoPessoaSchema> & { municipioNome: string | null }>;
  telefones: Array<Filha<typeof telefonePessoaSchema>>;
  emails: Array<Filha<typeof emailPessoaSchema>>;
}

/** Resposta de `GET /utilitarios/cep/:cep` (ERP 7.2 "botão buscar"). */
export interface EnderecoCep {
  cep: string;
  logradouro: string | null;
  complemento: string | null;
  bairro: string | null;
  uf: string | null;
  municipioIbge: number | null;
  municipioNome: string | null;
}

/** Formata CPF (11) ou CNPJ (14) para exibição. */
export function formatarCpfCnpj(v: string | null | undefined): string {
  if (!v) return '';
  if (v.length === 11) return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}`;
  if (v.length === 14)
    return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
  return v;
}

// ---------------------------------------------------------------- Fornecedor (F2-B13)

/** Pessoa resumida para seletores e para as filhas que apontam para ela (fornecedor do produto, F2-B13). */
export interface PessoaOpcao {
  id: string;
  codigo: number;
  tipo: 'PF' | 'PJ';
  nome: string;
  apelido: string | null;
  /** `null` no vínculo do detalhe do produto: o documento só sai pela API de pessoas (`pessoas.ver`; LGPD). */
  cpfCnpj: string | null;
  ativa: boolean;
  /** Pessoa excluída (o vínculo antigo continua legível e gravável; o seletor nunca a oferece). */
  excluida: boolean;
}

/**
 * Tipo da pessoa pelo documento já normalizado (`normalizarCnpj`): 11 caracteres = CPF (PF), 14 = CNPJ (PJ, inclusive
 * o alfanumérico). `null` = nem um nem outro.
 */
export function tipoPessoaDoDocumento(doc: string): 'PF' | 'PJ' | null {
  return doc.length === 11 ? 'PF' : doc.length === 14 ? 'PJ' : null;
}

/**
 * Cadastro rápido de fornecedor (ERP 3.4 `<SeletorPessoa>` "+", 8.2.14, 13.3; F2-B13): CNPJ ou CPF (com ou sem
 * máscara: a busca é pelo documento normalizado), nome, fantasia, IE, telefone num campo só e o endereço opcional
 * (a UF só é gravada com o endereço completo, `ck_pessoas_enderecos_completo`). Documento já cadastrado reaproveita a
 * pessoa: só ganha a categoria Fornecedor, sem mudar o resto (`POST /pessoas/fornecedor-rapido`).
 */
export const cadastroRapidoFornecedorSchema = z
  .object({
    cpfCnpj: z.preprocess(
      (v) => (typeof v === 'string' ? normalizarCnpj(v) : v),
      z.string().min(1, 'Informe o CNPJ ou o CPF'),
    ),
    nome: z.string().trim().min(2, 'Informe ao menos 2 caracteres').max(150),
    apelido: textoOpcional(150),
    rgIe: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().toUpperCase() || null : v),
      z.string().max(20).nullable().default(null),
    ),
    /** "(41) 3333-0000" ou só os dígitos, com o DDD. */
    telefone: z.preprocess(
      (v) => (typeof v === 'string' ? somenteDigitos(v) || null : v),
      z.string().nullable().default(null),
    ),
    endereco: enderecoPessoaSchema.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    // Vazio: "Informe o CNPJ ou o CPF" já saiu.
    if (v.cpfCnpj) {
      const tipo = tipoPessoaDoDocumento(v.cpfCnpj);
      if (!tipo) ctx.addIssue({ code: 'custom', path: ['cpfCnpj'], message: 'CNPJ (14) ou CPF (11)' });
      else if (tipo === 'PF' && !validarCpf(v.cpfCnpj))
        ctx.addIssue({ code: 'custom', path: ['cpfCnpj'], message: 'CPF inválido' });
      else if (tipo === 'PJ' && !validarCnpj(v.cpfCnpj))
        ctx.addIssue({ code: 'custom', path: ['cpfCnpj'], message: 'CNPJ inválido' });
    }
    if (v.telefone !== null && !/^[1-9]\d\d{8,9}$/.test(v.telefone))
      ctx.addIssue({ code: 'custom', path: ['telefone'], message: 'Telefone com DDD e 8 ou 9 dígitos' });
  });
export type CadastroRapidoFornecedorEntrada = z.input<typeof cadastroRapidoFornecedorSchema>;
export type CadastroRapidoFornecedor = z.output<typeof cadastroRapidoFornecedorSchema>;

/** Resposta do cadastro rápido: a pessoa e o que foi feito com ela. */
export interface ResultadoFornecedorRapido {
  pessoa: PessoaOpcao;
  /** A pessoa não existia (documento novo). */
  criada: boolean;
  /** A pessoa existia sem a categoria Fornecedor e a ganhou. */
  categoriaAdicionada: boolean;
}
