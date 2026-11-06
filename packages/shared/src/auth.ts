import { z } from 'zod';

/** Código da empresa: 6 dígitos (ERP 4.1). Aceita número ou string no JSON. */
export const codigoEmpresaSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{6}$/, 'Código da empresa deve ter 6 dígitos'))
  .transform((v) => Number(v));

export const loginSchema = z.object({
  codigoEmpresa: codigoEmpresaSchema,
  login: z
    .string()
    .trim()
    .min(1, 'Informe o usuário')
    .max(60)
    .transform((v) => v.toLowerCase()),
  senha: z.string().min(1, 'Informe a senha').max(200),
});
export type LoginEntrada = z.input<typeof loginSchema>;
export type Login = z.output<typeof loginSchema>;

export const usuarioSessaoSchema = z.object({
  id: z.uuid(),
  codigo: z.number().int(),
  nome: z.string(),
  login: z.string(),
  master: z.boolean(),
  senhaProvisoria: z.boolean(),
});
export type UsuarioSessao = z.infer<typeof usuarioSessaoSchema>;

export const respostaLoginSchema = z.object({
  tokenAcesso: z.string(),
  expiraEm: z.string(),
  trocarSenha: z.boolean(),
  empresa: z.object({ codigo: z.number().int(), nome: z.string() }),
  usuario: usuarioSessaoSchema,
});
export type RespostaLogin = z.infer<typeof respostaLoginSchema>;

export const respostaEuSchema = z.object({
  usuario: usuarioSessaoSchema,
  empresa: z.object({ codigo: z.number().int(), nome: z.string() }),
  permissoes: z.array(z.string()),
  /** Lojas permitidas não excluídas; `ativa` deixa os seletores esconderem as inativas (ERP 3.4). */
  lojas: z.array(
    z.object({
      id: z.uuid(),
      codigo: z.number().int(),
      nome: z.string(),
      ativa: z.boolean(),
      /** `nfce`/`sat`/`nao_fiscal`... (o ERP avisa o que não é vendável em loja fiscal, ERP 8.2.17). */
      tipoEmissao: z.string().optional(),
      /** `loja` ou `deposito` (CD). */
      tipo: z.string().optional(),
      /** Loja de treino (O10): os seletores a marcam e as consultas oferecem o filtro "loja de treino". */
      treino: z.boolean().optional(),
      /**
       * Estoque vinculado da loja, quando está entre os estoques permitidos do usuário (F2-B5); `null` = fora deles. É
       * o "Loja" do bloco Validade do produto (ERP 8.2.12; F2-B17), que grava o estoque da loja no lote.
       */
      estoqueId: z.uuid().nullable().optional(),
    }),
  ),
  todasLojas: z.boolean(),
});
export type RespostaEu = z.infer<typeof respostaEuSchema>;

/** Política de senha do ERP (ERP 4.2): mínimo 8, ao menos 1 letra e 1 número. */
export const novaSenhaSchema = z
  .string()
  .min(8, 'A senha deve ter pelo menos 8 caracteres')
  .max(200)
  .regex(/[A-Za-zÀ-ÿ]/, 'A senha deve ter ao menos uma letra')
  .regex(/\d/, 'A senha deve ter ao menos um número');

export const trocarSenhaSchema = z
  .object({
    senhaAtual: z.string().min(1, 'Informe a senha atual'),
    novaSenha: novaSenhaSchema,
    confirmacao: z.string().optional(),
  })
  .refine((v) => v.confirmacao === undefined || v.confirmacao === v.novaSenha, {
    message: 'A confirmação não confere com a nova senha',
    path: ['confirmacao'],
  })
  .refine((v) => v.senhaAtual !== v.novaSenha, {
    message: 'A nova senha deve ser diferente da atual',
    path: ['novaSenha'],
  });
export type TrocarSenha = z.infer<typeof trocarSenhaSchema>;

/** Esqueci minha senha (ERP 4.3): a resposta é sempre a mesma, exista ou não o usuário. */
export const esqueciSenhaSchema = z.object({
  codigoEmpresa: codigoEmpresaSchema,
  login: z
    .string()
    .trim()
    .min(1, 'Informe o usuário')
    .max(60)
    .transform((v) => v.toLowerCase()),
});
export type EsqueciSenha = z.output<typeof esqueciSenhaSchema>;

export const MENSAGEM_ESQUECI_SENHA =
  'Se os dados estiverem corretos e o usuário tiver e-mail cadastrado, você receberá um link para redefinir a senha. Sem e-mail cadastrado, peça a um administrador da sua empresa.';

/** Redefinição pelo link do e-mail (uso único, 1 h; MD 3.3.6). Token = `<código da empresa>.<segredo>`. */
export const redefinirSenhaSchema = z
  .object({
    token: z.string().regex(/^\d{6}\.[A-Za-z0-9_-]{43}$/, 'Link inválido'),
    novaSenha: novaSenhaSchema,
    confirmacao: z.string().optional(),
  })
  .refine((v) => v.confirmacao === undefined || v.confirmacao === v.novaSenha, {
    message: 'A confirmação não confere com a nova senha',
    path: ['confirmacao'],
  });
export type RedefinirSenha = z.output<typeof redefinirSenhaSchema>;

export const respostaRefreshSchema = z.object({
  tokenAcesso: z.string(),
  expiraEm: z.string(),
});

/** Login do painel da plataforma: e-mail + senha + TOTP (ERP 19.1, 2FA obrigatório). */
export const loginPlataformaSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('E-mail inválido')),
  senha: z.string().min(1).max(200),
  codigoTotp: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos do autenticador'),
});
export type LoginPlataforma = z.infer<typeof loginPlataformaSchema>;

export const MENSAGEM_CREDENCIAIS_PLATAFORMA_INVALIDAS = 'E-mail, senha ou código do autenticador inválidos.';
