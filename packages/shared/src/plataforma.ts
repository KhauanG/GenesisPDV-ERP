import { z } from 'zod';
import { REGIMES_FISCAIS, STATUS_EMPRESA, PAPEIS_ADMIN } from './enums.js';
import { normalizarCnpj, validarCnpj } from './validadores.js';

export const cnpjSchema = z.string().transform(normalizarCnpj).refine(validarCnpj, 'CNPJ inválido');

const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** Criação de empresa pelo painel da plataforma (ERP 19.3, MD 7.1). */
export const criarEmpresaSchema = z.object({
  codigo: z.number().int().min(100001).max(999999).optional(),
  razaoSocial: z.string().trim().min(2).max(150),
  nomeFantasia: textoOpcional(150),
  cnpj: cnpjSchema,
  planoCodigo: z.string().trim().min(1).max(30),
  regime: z.enum(REGIMES_FISCAIS).default('simples_nacional'),
  nomeResponsavel: textoOpcional(100),
  emailResponsavel: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
  telefoneResponsavel: textoOpcional(20),
  observacoes: z.string().max(5000).optional(),
  canario: z.boolean().default(false),
  admin: z
    .object({
      nome: z.string().trim().min(1).max(100).default('ADMINISTRADOR'),
      login: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^\S+$/, 'O login não pode ter espaços')
        .max(60)
        .default('admin'),
      email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    })
    .default({ nome: 'ADMINISTRADOR', login: 'admin' }),
});
export type CriarEmpresaEntrada = z.input<typeof criarEmpresaSchema>;
export type CriarEmpresa = z.output<typeof criarEmpresaSchema>;

export const resultadoProvisionamentoSchema = z.object({
  empresaId: z.uuid(),
  codigo: z.number().int(),
  nomeBanco: z.string(),
  status: z.enum(STATUS_EMPRESA),
  adminLogin: z.string(),
  /** Exibida uma única vez; nunca é gravada em claro. Ausente quando o administrador já tinha senha definitiva. */
  senhaProvisoria: z.string().optional(),
});
export type ResultadoProvisionamento = z.infer<typeof resultadoProvisionamentoSchema>;

export const motivoStatusSchema = z.object({
  motivo: z.string().trim().min(3, 'Informe o motivo').max(255),
});

export const empresaResumoSchema = z.object({
  id: z.uuid(),
  codigo: z.number().int(),
  razaoSocial: z.string(),
  nomeFantasia: z.string().nullable(),
  cnpj: z.string(),
  status: z.enum(STATUS_EMPRESA),
  motivoStatus: z.string().nullable(),
  plano: z.string(),
  versaoSchema: z.string().nullable(),
  canario: z.boolean(),
  criadoEm: z.string(),
  ativadaEm: z.string().nullable(),
});
export type EmpresaResumo = z.infer<typeof empresaResumoSchema>;

export const filtroEmpresasSchema = z.object({
  status: z.enum(STATUS_EMPRESA).optional(),
  busca: z.string().trim().max(150).optional(),
});

export const papelAdminSchema = z.enum(PAPEIS_ADMIN);

/** Situação de uma empresa frente às migrações do código (ERP 19.7). */
export const SITUACOES_MIGRACAO_EMPRESA = [
  'em_dia',
  'atrasada',
  'com_erro',
  'aplicando',
  'desconhecida',
] as const;
export type SituacaoMigracaoEmpresa = (typeof SITUACOES_MIGRACAO_EMPRESA)[number];

export const filtroSituacaoMigracoesSchema = z.object({
  filtro: z.enum(['todas', 'atrasadas', 'com_erro']).default('todas'),
});

export interface MigracaoDoCodigo {
  ordem: number;
  tag: string;
  hash: string;
}

export interface EmpresaSituacaoMigracao {
  id: string;
  codigo: number;
  razaoSocial: string;
  nomeFantasia: string | null;
  status: (typeof STATUS_EMPRESA)[number];
  canario: boolean;
  /** Última migração aplicada (`empresas.versao_schema`). */
  versaoSchema: string | null;
  /** Migrações do journal posteriores à `versaoSchema`. */
  pendentes: string[];
  situacao: SituacaoMigracaoEmpresa;
  /** Migração que falhou por último e a mensagem (`migracoes_empresas`). */
  migracaoComErro: string | null;
  erro: string | null;
  ultimaExecucaoEm: string | null;
}

export interface ExecucaoMigracoes {
  id: string;
  ocorridoEm: string;
  adminNome: string | null;
  executadoPor: string | null;
  falhas: number;
  interrompida: boolean;
  empresas: Array<{ codigo: number; status: string; aplicadas: string[]; erro?: string; avisos?: string[] }>;
}

export interface SituacaoMigracoes {
  /** Migração mais recente do código (journal do drizzle-kit). */
  versaoAtual: string | null;
  migracoes: MigracaoDoCodigo[];
  resumo: { empresas: number; emDia: number; atrasadas: number; comErro: number };
  empresas: EmpresaSituacaoMigracao[];
  /** Log das últimas execuções do "Aplicar" (painel ou `db:migrate:empresas`), de `auditoria_plataforma`. */
  execucoes: ExecucaoMigracoes[];
}

export interface SimulacaoMigracoes {
  /** `banco`: lido de `drizzle.__drizzle_migrations` da empresa; `versao_schema`: estimado pelo controle. */
  fonte: 'banco' | 'versao_schema';
  empresas: Array<{ codigo: number; razaoSocial: string; pendentes: string[]; alteradas: string[] }>;
  migracoes: Array<{ ordem: number; tag: string; sql: string }>;
}

export type StatusMigracaoExecutada = 'ok' | 'falhou' | 'ignorada' | 'nao_executada';

export interface ResultadoMigracaoEmpresa {
  empresaId: string;
  codigo: number;
  status: StatusMigracaoExecutada;
  aplicadas: string[];
  versaoSchema: string | null;
  erro?: string;
  /** Avisos das preparações de dados (ex.: linhas do razão com a cadeia quebrada, F2-B2); não são falha. */
  avisos?: string[];
}

export interface ResultadoMigracaoEmMassa {
  canarios: ResultadoMigracaoEmpresa[];
  demais: ResultadoMigracaoEmpresa[];
  falhas: number;
  interrompida: boolean;
}

export interface PlanoResumo {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  limiteLojas: number;
  limiteTerminais: number;
  limiteUsuarios: number | null;
  recursos: unknown;
  precoMensal: string;
  ativo: boolean;
}
