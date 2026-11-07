import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as carregarDotenv } from 'dotenv';
import { configurarZodPtBr } from '@genesis/shared';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

configurarZodPtBr();

const AMBIENTES = ['desenvolvimento', 'teste', 'homologacao', 'producao'] as const;

/** Segredos padrão só para desenvolvimento/teste; fora deles a variável é obrigatória (refine abaixo). */
const SEGREDO_DEV = 'dev-apenas-local-nao-use-em-producao-0123456789';
const SEGREDO_PLATAFORMA_DEV = `${SEGREDO_DEV}-plataforma`;
const CHAVE_MESTRA_DEV = Buffer.alloc(32, 7).toString('base64');
const VALORES_DEV = new Set([SEGREDO_DEV, SEGREDO_PLATAFORMA_DEV, CHAVE_MESTRA_DEV]);

const ehLocal = (ambiente: string) => ambiente === 'desenvolvimento' || ambiente === 'teste';

/** `TRUST_PROXY`: número de proxies confiáveis à frente da API, `false`, ou lista de IPs/CIDRs (Express). */
function lerTrustProxy(valor: string): number | string[] | false | null {
  const v = valor.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'nao') return false;
  if (/^\d+$/.test(v)) return Number(v);
  const lista = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const ipOuCidr = /^([0-9a-f:.]+)(\/\d{1,3})?$|^(loopback|linklocal|uniquelocal)$/;
  return lista.length > 0 && lista.every((x) => ipOuCidr.test(x)) ? lista : null;
}

/**
 * Erro do cron (UTC) pela mesma regra do `schedule` do pg-boss (`CronExpressionParser.parse`, `strict: false`), ou
 * `null` se vale. Sem isso, um cron digitado errado só aparecia no `schedule` do `FilaTrabalhos.iniciar()` e
 * derrubava a fila inteira da instância (e-mails, tarefas), não só o agendamento.
 */
function erroCron(valor: string): string | null {
  try {
    CronExpressionParser.parse(valor, { tz: 'UTC', strict: false });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const booleano = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase())));

const esquema = z
  .object({
    AMBIENTE: z.enum(AMBIENTES).default('desenvolvimento'),
    NODE_ENV: z.string().optional(),
    PORTA: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_NIVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_LEGIVEL: booleano.default(false),
    /** Banco de controle `genesis_control`. */
    DATABASE_URL: z.url().default('postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control'),
    /** Servidor PostgreSQL padrão para bancos de empresa; vazio = mesmo servidor/credenciais do DATABASE_URL. */
    EMPRESAS_SERVIDOR_URL: z.url().optional(),
    /** Colação ICU dos bancos de empresa (MD 7.1); vazio desliga (servidor sem ICU). */
    EMPRESAS_ICU_LOCALE: z.string().default('pt-BR'),
    JWT_SEGREDO: z.string().min(32).optional(),
    JWT_SEGREDO_PLATAFORMA: z.string().min(32).optional(),
    /** Chave mestra AES-256-GCM (MD 1.10), base64 de 32 bytes, e a versão dela (1 byte no início de cada cifra). */
    CHAVE_MESTRA: z.string().optional(),
    CHAVE_MESTRA_VERSAO: z.coerce.number().int().min(1).max(255).default(1),
    /** Chaves anteriores para decifrar durante a rotação: `versao:base64,versao:base64`. */
    CHAVES_MESTRAS_ANTERIORES: z.string().default(''),
    CORS_ORIGENS: z.string().default('http://localhost:5173'),
    COOKIE_SEGURO: booleano.optional(),
    /** Proxies confiáveis (X-Forwarded-For): número de saltos ou lista de IPs/CIDRs. Obrigatória fora de dev/teste. */
    TRUST_PROXY: z.string().optional(),
    ACESSO_TOKEN_MINUTOS: z.coerce.number().int().min(1).default(15),
    REFRESH_DIAS: z.coerce.number().int().min(1).default(7),
    SESSAO_INATIVIDADE_MINUTOS: z.coerce.number().int().min(1).default(60),
    SESSAO_ADMIN_INATIVIDADE_MINUTOS: z.coerce.number().int().min(1).default(30),
    /** Janela em que um refresh já rotacionado reaparece sem derrubar a família (requisições simultâneas). */
    REFRESH_TOLERANCIA_SEGUNDOS: z.coerce.number().int().min(0).max(120).default(20),
    LOGIN_MAX_TENTATIVAS: z.coerce.number().int().min(1).default(5),
    LOGIN_BLOQUEIO_MINUTOS: z.coerce.number().int().min(1).default(15),
    LOGIN_LIMITE_POR_MINUTO: z.coerce.number().int().min(1).default(20),
    /** Limite por conta (código da empresa + login, ou e-mail do admin), somado ao limite por IP (ERP 4.1). */
    LOGIN_LIMITE_POR_CONTA_MINUTO: z.coerce.number().int().min(1).default(10),
    POOL_CACHE_MAXIMO: z.coerce.number().int().min(1).default(50),
    POOL_OCIOSO_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(5 * 60_000),
    POOL_CONEXOES_POR_EMPRESA: z.coerce.number().int().min(1).default(5),
    TENANCY_CACHE_MS: z.coerce.number().int().min(0).default(5_000),
    DASHBOARD_CACHE_MS: z.coerce.number().int().min(0).default(60_000),
    MIGRACAO_LOTE: z.coerce.number().int().min(1).default(4),
    MIGRACAO_LOCK_TIMEOUT: z.string().default('10s'),
    /**
     * Espera máxima (ms) pela trava de ordenação 7300001 numa gravação do ERP antes do `SISTEMA_OCUPADO` (Fase 1C, C13);
     * 0 = sem limite. As tarefas em segundo plano esperam sem limite.
     */
    ERP_ESPERA_TRAVA_MS: z.coerce.number().int().min(0).default(5_000),
    /** Endereço do ERP web: base dos links enviados por e-mail (redefinição de senha). */
    ERP_URL: z.url().default('http://localhost:5173'),
    /**
     * Consulta de CEP (ERP 7.2, opcional): modelo com `{cep}` (padrão ViaCEP). `desligada` desativa — a tela continua
     * aceitando o endereço digitado. A consulta tem limite de 3 s e falha sem quebrar o cadastro.
     */
    CEP_CONSULTA_URL: z.string().default('https://viacep.com.br/ws/{cep}/json/'),
    /** E-mail transacional (ERP 18.14): em desenvolvimento, o Mailpit do docker-compose. */
    SMTP_URL: z.url().default('smtp://127.0.0.1:1025'),
    EMAIL_REMETENTE: z.string().min(3).default('GenesisPDV <nao-responda@genesis.local>'),
    /** Armazenamento de objetos S3-compatível (MD 3.1.6); em desenvolvimento, o MinIO do docker-compose. */
    ARMAZENAMENTO_ENDPOINT: z.url().optional(),
    ARMAZENAMENTO_REGIAO: z.string().default('us-east-1'),
    ARMAZENAMENTO_BUCKET: z.string().min(3).default('genesis-dev'),
    ARMAZENAMENTO_CHAVE_ACESSO: z.string().optional(),
    ARMAZENAMENTO_CHAVE_SECRETA: z.string().optional(),
    ARMAZENAMENTO_CAMINHO: booleano.default(true),
    /**
     * Inatividade máxima (ms) da conexão de um pedido ao armazenamento: passou sem nenhum byte indo ou vindo, o pedido
     * falha (e o SDK repete). Sem isso uma parte do envio pendurada na rede esperaria para sempre (decisão 177).
     */
    ARMAZENAMENTO_INATIVIDADE_MS: z.coerce.number().int().min(100).default(120_000),
    /** Esta instância também executa a fila (tarefas em segundo plano e e-mails); `false` = só enfileira. */
    FILA_TRABALHADOR: booleano.default(true),
    /**
     * Verificação periódica do razão de estoque (F2-B3, decisão 147): cron em UTC do `schedule` do pg-boss; vazia =
     * desligada (o padrão; a instância com trabalhador remove o agendamento gravado antes). Só verifica e abre o
     * alerta `RAZAO_SALDO_DIVERGENTE`; corrigir é o `db:recalcular-saldos`. Cron inválido recusa a subida.
     */
    VERIFICACAO_RAZAO_CRON: z.string().trim().default(''),
    /** Versão publicada (commit de 12 caracteres): a imagem de produção define (apps/api/Dockerfile). */
    GENESIS_VERSAO: z.string().max(64).default('desenvolvimento'),
    /**
     * SHA-256 (hex) do token de monitoramento do `GET /api/saude/detalhada` (Implantação do piloto, I1b). Só o hash
     * fica no ambiente; sem ele a rota responde 401 a qualquer token (infra/producao/README.md › Monitoramento).
     */
    MONITOR_TOKEN_SHA256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'use os 64 caracteres hexadecimais do SHA-256 do token')
      .optional(),
    /** Chave do estado do último backup lógico no bucket (gravada pelo genesis-backup, infra/producao/backup). */
    BACKUP_ESTADO_CHAVE: z.string().min(1).default('backups/estado.json'),
  })
  .superRefine((v, ctx) => {
    const erroVerificacao = v.VERIFICACAO_RAZAO_CRON ? erroCron(v.VERIFICACAO_RAZAO_CRON) : null;
    if (erroVerificacao) {
      ctx.addIssue({
        code: 'custom',
        path: ['VERIFICACAO_RAZAO_CRON'],
        message: `cron inválido (5 campos em UTC, ex.: "41 6 * * *"): ${erroVerificacao}`,
      });
    }
    if (v.JWT_SEGREDO && v.JWT_SEGREDO_PLATAFORMA && v.JWT_SEGREDO === v.JWT_SEGREDO_PLATAFORMA) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SEGREDO_PLATAFORMA'],
        message: 'deve ser diferente de JWT_SEGREDO',
      });
    }
    if (v.TRUST_PROXY !== undefined && lerTrustProxy(v.TRUST_PROXY) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'use um número de proxies, false, ou uma lista de IPs/CIDRs separados por vírgula',
      });
    }
    if (ehLocal(v.AMBIENTE)) {
      // Deploy que esqueceu AMBIENTE não pode subir com os segredos públicos de desenvolvimento.
      if (v.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['AMBIENTE'],
          message: `"${v.AMBIENTE}" com NODE_ENV=production: defina AMBIENTE=homologacao ou producao`,
        });
      }
      return;
    }
    for (const chave of ['JWT_SEGREDO', 'JWT_SEGREDO_PLATAFORMA', 'CHAVE_MESTRA'] as const) {
      const valor = v[chave];
      if (!valor) ctx.addIssue({ code: 'custom', path: [chave], message: `obrigatória em ${v.AMBIENTE}` });
      else if (VALORES_DEV.has(valor))
        ctx.addIssue({
          code: 'custom',
          path: [chave],
          message: `valor de desenvolvimento proibido em ${v.AMBIENTE}`,
        });
    }
    if (v.TRUST_PROXY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: `obrigatória em ${v.AMBIENTE} (número de proxies à frente da API, ou false)`,
      });
    }
  });

export interface Configuracao {
  ambiente: (typeof AMBIENTES)[number];
  porta: number;
  log: { nivel: string; legivel: boolean };
  bancoControleUrl: string;
  empresas: { servidorUrl: string; icuLocale: string | null };
  jwt: { segredo: string; segredoPlataforma: string; acessoMinutos: number };
  cifra: { versaoAtual: number; chaves: Map<number, Buffer> };
  corsOrigens: string[];
  cookieSeguro: boolean;
  /** Valor do `trust proxy` do Express. */
  trustProxy: number | string[] | false;
  sessao: {
    refreshDias: number;
    inatividadeMinutos: number;
    inatividadeAdminMinutos: number;
    toleranciaRefreshSegundos: number;
  };
  login: {
    maxTentativas: number;
    bloqueioMinutos: number;
    limitePorMinuto: number;
    limitePorContaMinuto: number;
  };
  pools: { cacheMaximo: number; ociosoMs: number; conexoesPorEmpresa: number };
  tenancyCacheMs: number;
  /** Cache do `GET /dashboard` por empresa × loja × mês (ERP 6: 60 s); 0 desliga. */
  dashboardCacheMs: number;
  migracao: { lote: number; lockTimeout: string };
  /** Espera máxima do ERP pela trava 7300001 antes do `SISTEMA_OCUPADO` (C13); `null` = sem limite. */
  esperaTravaVersaoMs: number | null;
  erpUrl: string;
  /** `null` = consulta de CEP desligada. */
  cepConsultaUrl: string | null;
  email: { smtpUrl: string; remetente: string };
  armazenamento: {
    endpoint: string | null;
    regiao: string;
    bucket: string;
    chaveAcesso: string | null;
    chaveSecreta: string | null;
    estiloCaminho: boolean;
    /** Inatividade máxima da conexão de um pedido (`ARMAZENAMENTO_INATIVIDADE_MS`). */
    inatividadeMs: number;
  };
  fila: {
    trabalhador: boolean;
    /** Cron (UTC) da verificação periódica do razão; `null` = desligada. */
    verificacaoRazaoCron: string | null;
  };
  /** Versão publicada (`GENESIS_VERSAO`). */
  versao: string;
  /** `GET /api/saude/detalhada` (I1b): hash do token (32 bytes) ou `null` = rota fechada. */
  monitor: { tokenSha256: Buffer | null };
  backup: { chaveEstado: string };
}

function lerChave(base64: string, nome: string): Buffer {
  const chave = Buffer.from(base64, 'base64');
  if (chave.length !== 32) throw new Error(`${nome} deve ser base64 de exatamente 32 bytes`);
  return chave;
}

export function carregarConfiguracao(env: Record<string, string | undefined> = process.env): Configuracao {
  // Linha `CHAVE=` vazia no .env vale como variável ausente (o dotenv a carrega como "").
  const semVazias = Object.fromEntries(Object.entries(env).filter(([, valor]) => valor !== ''));
  const r = esquema.safeParse(semVazias);
  if (!r.success) {
    const detalhes = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${detalhes}`);
  }
  const v = r.data;
  const chaves = new Map<number, Buffer>();
  chaves.set(v.CHAVE_MESTRA_VERSAO, lerChave(v.CHAVE_MESTRA ?? CHAVE_MESTRA_DEV, 'CHAVE_MESTRA'));
  for (const par of v.CHAVES_MESTRAS_ANTERIORES.split(',').filter(Boolean)) {
    const [versao, base64] = par.split(':');
    chaves.set(Number(versao), lerChave(base64 ?? '', `CHAVES_MESTRAS_ANTERIORES[${versao}]`));
  }
  return {
    ambiente: v.AMBIENTE,
    porta: v.PORTA,
    log: { nivel: v.LOG_NIVEL, legivel: v.LOG_LEGIVEL },
    bancoControleUrl: v.DATABASE_URL,
    empresas: {
      servidorUrl: v.EMPRESAS_SERVIDOR_URL ?? v.DATABASE_URL,
      icuLocale: v.EMPRESAS_ICU_LOCALE || null,
    },
    jwt: {
      segredo: v.JWT_SEGREDO ?? SEGREDO_DEV,
      segredoPlataforma: v.JWT_SEGREDO_PLATAFORMA ?? SEGREDO_PLATAFORMA_DEV,
      acessoMinutos: v.ACESSO_TOKEN_MINUTOS,
    },
    cifra: { versaoAtual: v.CHAVE_MESTRA_VERSAO, chaves },
    corsOrigens: v.CORS_ORIGENS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    cookieSeguro: v.COOKIE_SEGURO ?? !ehLocal(v.AMBIENTE),
    trustProxy: v.TRUST_PROXY === undefined ? false : (lerTrustProxy(v.TRUST_PROXY) ?? false),
    sessao: {
      refreshDias: v.REFRESH_DIAS,
      inatividadeMinutos: v.SESSAO_INATIVIDADE_MINUTOS,
      inatividadeAdminMinutos: v.SESSAO_ADMIN_INATIVIDADE_MINUTOS,
      toleranciaRefreshSegundos: v.REFRESH_TOLERANCIA_SEGUNDOS,
    },
    login: {
      maxTentativas: v.LOGIN_MAX_TENTATIVAS,
      bloqueioMinutos: v.LOGIN_BLOQUEIO_MINUTOS,
      limitePorMinuto: v.LOGIN_LIMITE_POR_MINUTO,
      limitePorContaMinuto: v.LOGIN_LIMITE_POR_CONTA_MINUTO,
    },
    pools: {
      cacheMaximo: v.POOL_CACHE_MAXIMO,
      ociosoMs: v.POOL_OCIOSO_MS,
      conexoesPorEmpresa: v.POOL_CONEXOES_POR_EMPRESA,
    },
    tenancyCacheMs: v.TENANCY_CACHE_MS,
    dashboardCacheMs: v.DASHBOARD_CACHE_MS,
    migracao: { lote: v.MIGRACAO_LOTE, lockTimeout: v.MIGRACAO_LOCK_TIMEOUT },
    esperaTravaVersaoMs: v.ERP_ESPERA_TRAVA_MS === 0 ? null : v.ERP_ESPERA_TRAVA_MS,
    erpUrl: v.ERP_URL.replace(/\/+$/, ''),
    cepConsultaUrl: v.CEP_CONSULTA_URL === 'desligada' ? null : v.CEP_CONSULTA_URL,
    email: { smtpUrl: v.SMTP_URL, remetente: v.EMAIL_REMETENTE },
    armazenamento: {
      // Em desenvolvimento, o MinIO local (infra/docker-compose.yml) com as credenciais de lá.
      endpoint: v.ARMAZENAMENTO_ENDPOINT ?? (ehLocal(v.AMBIENTE) ? 'http://127.0.0.1:9000' : null),
      regiao: v.ARMAZENAMENTO_REGIAO,
      bucket: v.ARMAZENAMENTO_BUCKET,
      chaveAcesso: v.ARMAZENAMENTO_CHAVE_ACESSO ?? (ehLocal(v.AMBIENTE) ? 'genesis' : null),
      chaveSecreta: v.ARMAZENAMENTO_CHAVE_SECRETA ?? (ehLocal(v.AMBIENTE) ? 'genesis_dev_minio' : null),
      estiloCaminho: v.ARMAZENAMENTO_CAMINHO,
      inatividadeMs: v.ARMAZENAMENTO_INATIVIDADE_MS,
    },
    fila: { trabalhador: v.FILA_TRABALHADOR, verificacaoRazaoCron: v.VERIFICACAO_RAZAO_CRON || null },
    versao: v.GENESIS_VERSAO,
    monitor: {
      tokenSha256: v.MONITOR_TOKEN_SHA256 ? Buffer.from(v.MONITOR_TOKEN_SHA256.toLowerCase(), 'hex') : null,
    },
    backup: { chaveEstado: v.BACKUP_ESTADO_CHAVE },
  };
}

/**
 * Lê `.env.<AMBIENTE>.local`, `.env.<AMBIENTE>`, `.env.local` e `.env` (nessa prioridade) da pasta da API.
 * Variáveis já definidas no processo nunca são sobrescritas.
 */
export function carregarArquivosEnv(pasta = process.cwd()): void {
  const ambiente = process.env.AMBIENTE || 'desenvolvimento';
  for (const nome of [`.env.${ambiente}.local`, `.env.${ambiente}`, '.env.local', '.env']) {
    const caminho = resolve(pasta, nome);
    if (existsSync(caminho)) carregarDotenv({ path: caminho, override: false, quiet: true });
  }
}
