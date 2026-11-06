import { z } from 'zod';
import {
  cpfOpcional,
  dataOpcional,
  dinheiroOpcional,
  emailOpcional,
  enderecoOpcional,
  percentualCampo,
  textoOpcional,
  vazioParaNulo,
} from './campos.js';
import { paginacaoQuerySchema } from './paginacao.js';
import { CHAVES_PERMISSOES } from './permissoes.js';

/** Filtro "Situação" da listagem de usuários (ERP 11.1). */
export const SITUACOES_USUARIO = ['ativos', 'inativos', 'todos'] as const;
export type SituacaoUsuario = (typeof SITUACOES_USUARIO)[number];

/** Colunas ordenáveis da listagem (nome da coluna no banco, como no `ordenar=campo:asc` do ERP 1.8). */
export const ORDENACOES_USUARIOS = ['codigo', 'nome', 'login', 'perfil', 'ultimo_login_em', 'ativo'] as const;

export const filtroUsuariosSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(100).optional(),
  situacao: z.enum(SITUACOES_USUARIO).default('ativos'),
  perfilId: z.uuid().optional(),
  lojaId: z.uuid().optional(),
});
export type FiltroUsuarios = z.infer<typeof filtroUsuariosSchema>;

/** Campos editáveis do usuário (aba Dados Gerais, ERP 11.2). O PIN do PDV tem rota própria (`PUT /usuarios/:id/pin`). */
const camposUsuario = z.object({
  codigo: z.number().int().min(1).max(999_999).optional(),
  nome: z.string().trim().min(1, 'Informe o nome').max(100),
  login: z
    .string()
    .trim()
    .min(1, 'Informe o login')
    .max(60)
    .regex(/^\S+$/, 'O login não pode ter espaços')
    .transform((v) => v.toLowerCase()),
  email: emailOpcional,
  ativo: z.boolean().default(true),
  master: z.boolean().default(false),
  perfilId: z.preprocess(vazioParaNulo, z.uuid().nullable().default(null)),
  limiteDescontoPct: percentualCampo.default('0.0000'),
  comissaoPct: percentualCampo.default('0.0000'),
  telefone: textoOpcional(20),
  cpf: cpfOpcional,
  rg: textoOpcional(20),
  admissao: dataOpcional,
  demissao: dataOpcional,
  /** Só gravado por quem tem `usuarios.ver_dados_rh` (ERP 11.2); sem a permissão o valor atual é mantido. */
  salario: dinheiroOpcional,
  ...enderecoOpcional,
  vendedor: z.boolean().default(false),
  entregador: z.boolean().default(false),
  tecnico: z.boolean().default(false),
  pdvUtilitario: z.boolean().default(false),
  comandaEletronica: z.boolean().default(false),
  totem: z.boolean().default(false),
  observacoes: textoOpcional(5000),
  /** Lojas permitidas (`usuarios_lojas`); ignorado para Master, que tem todas. */
  lojas: z.array(z.uuid()).max(500).default([]),
  /**
   * Estoques permitidos (`usuarios_estoques`): a lista inteira do que o usuário vê e movimenta, inclusive o estoque das
   * lojas dele e os sem loja (o CD). Não soma com as lojas permitidas (README da API › decisão 149); sem efeito para
   * Master e para quem tem `estoques.todos`, que veem todos.
   */
  estoques: z.array(z.uuid()).max(500).default([]),
});

type Campos = z.output<typeof camposUsuario>;

function regrasUsuario(v: Campos, ctx: z.RefinementCtx): void {
  if (!v.master && !v.perfilId && !v.totem) {
    ctx.addIssue({ code: 'custom', path: ['perfilId'], message: 'Escolha o perfil de acesso' });
  }
  if (v.admissao && v.demissao && v.demissao < v.admissao) {
    ctx.addIssue({
      code: 'custom',
      path: ['demissao'],
      message: 'A demissão deve ser igual ou após a admissão',
    });
  }
}

/** `senha` vazia = a API gera uma senha provisória e a devolve uma única vez. Toda senha definida aqui é provisória. */
export const criarUsuarioSchema = camposUsuario
  .extend({
    senha: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .min(8, 'A senha deve ter pelo menos 8 caracteres')
        .max(200)
        .regex(/[A-Za-zÀ-ÿ]/, 'A senha deve ter ao menos uma letra')
        .regex(/\d/, 'A senha deve ter ao menos um número')
        .nullable()
        .default(null),
    ),
  })
  .superRefine(regrasUsuario);
export type CriarUsuarioEntrada = z.input<typeof criarUsuarioSchema>;
export type CriarUsuario = z.output<typeof criarUsuarioSchema>;

export const alterarUsuarioSchema = camposUsuario
  .extend({ versao: z.number().int() })
  .superRefine(regrasUsuario);
export type AlterarUsuarioEntrada = z.input<typeof alterarUsuarioSchema>;
export type AlterarUsuario = z.output<typeof alterarUsuarioSchema>;

export interface UsuarioResumo {
  id: string;
  codigo: number;
  nome: string;
  login: string;
  perfilId: string | null;
  perfilNome: string | null;
  master: boolean;
  ativo: boolean;
  ultimoLoginEm: string | null;
  versao: number;
}

export interface UsuarioDetalhe extends Omit<Campos, 'codigo'> {
  id: string;
  codigo: number;
  perfilNome: string | null;
  municipioNome: string | null;
  /** `usuarios.senha_pdv_hash` definido (o hash nunca sai da API). */
  pinDefinido: boolean;
  senhaProvisoria: boolean;
  bloqueadoAte: string | null;
  ultimoLoginEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
  atualizadoPorNome: string | null;
  versao: number;
}

export interface RespostaUsuarioGravado {
  usuario: UsuarioDetalhe;
  /** Exibida uma única vez (criação sem senha informada). */
  senhaProvisoria?: string;
}

/** PIN do PDV (SYNC 4.3): `null` remove. As regras de formato estão em `validarPin` (a API confere de novo). */
export const definirPinSchema = z.object({
  pin: z.preprocess(vazioParaNulo, z.string().trim().nullable()),
});
export type DefinirPin = z.output<typeof definirPinSchema>;

export interface RespostaSenhaRedefinida {
  senhaProvisoria: string;
}

const chavePermissao = z.string().refine((c) => CHAVES_PERMISSOES.has(c), 'Permissão inexistente');

/** Ajustes individuais do usuário (`usuarios_permissoes`, ERP 11.2 abas Menus/Permissões Gerais). */
export const ajustesPermissoesSchema = z.object({
  versao: z.number().int(),
  ajustes: z
    .array(z.object({ permissao: chavePermissao, efeito: z.enum(['conceder', 'negar']) }))
    .max(1000)
    .refine((a) => new Set(a.map((x) => x.permissao)).size === a.length, 'Permissão repetida'),
});
export type AjustesPermissoes = z.output<typeof ajustesPermissoesSchema>;

export interface PermissoesUsuario {
  master: boolean;
  doPerfil: string[];
  ajustes: Array<{ permissao: string; efeito: 'conceder' | 'negar' }>;
  efetivas: string[];
  versao: number;
}

export interface PerfilResumo {
  id: string;
  nome: string;
  descricao: string | null;
  chaveSistema: string | null;
  usuarios: number;
}

// Perfis de acesso (ERP 11.3)

export const filtroPerfisSchema = paginacaoQuerySchema.extend({ nome: z.string().trim().max(40).optional() });
export const ORDENACOES_PERFIS = ['nome', 'usuarios'] as const;

const camposPerfil = z.object({
  nome: z.string().trim().min(1, 'Informe o nome').max(40),
  descricao: textoOpcional(255),
  permissoes: z
    .array(chavePermissao)
    .max(1000)
    .transform((l) => [...new Set(l)].sort()),
});

export const criarPerfilSchema = camposPerfil;
export type CriarPerfilEntrada = z.input<typeof criarPerfilSchema>;
export const alterarPerfilSchema = camposPerfil.extend({ versao: z.number().int() });
export type AlterarPerfilEntrada = z.input<typeof alterarPerfilSchema>;

export interface PerfilDetalhe extends PerfilResumo {
  permissoes: string[];
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
  atualizadoPorNome: string | null;
}
