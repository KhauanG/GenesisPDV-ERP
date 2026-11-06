/**
 * API para o teste de ponta a ponta: banco de controle próprio (nome em `E2E_BANCO`), faixa de códigos de empresa
 * livre no servidor, admin da plataforma com senha e segredo TOTP conhecidos (gravados em `E2E_ESTADO` para o
 * teste) e a API escutando em `E2E_PORTA_API`. Roda com o tsx da API (`pnpm --filter api exec tsx …`), porque importa
 * o código dela.
 */
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { criarAplicacao } from '../../api/src/app.js';
import { carregarConfiguracao } from '../../api/src/config/configuracao.js';
import { garantirBanco, migrarControle, seedControle } from '../../api/src/database/migracoes/controle.js';
import { criarServicos } from '../../api/src/servicos.js';
import { iniciarS3Falso } from '../../api/test/integracao/s3-falso.js';

const obrigatoria = (nome: string): string => {
  const v = process.env[nome];
  if (!v) throw new Error(`Defina ${nome} (o playwright.config.ts define ao rodar test:e2e)`);
  return v;
};

const base = new URL(
  process.env.DATABASE_URL ?? 'postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control',
);
base.pathname = `/${obrigatoria('E2E_BANCO')}`;
const url = base.toString();
const porta = Number(obrigatoria('E2E_PORTA_API'));

await garantirBanco(url);
await migrarControle(url);
// Armazenamento de objetos em memória (planilhas da importação e relatórios), sem MinIO/Docker.
const s3 = await iniciarS3Falso();
const config = carregarConfiguracao({
  AMBIENTE: 'teste',
  DATABASE_URL: url,
  PORTA: String(porta),
  LOG_NIVEL: 'warn',
  LOG_LEGIVEL: 'false',
  CORS_ORIGENS: obrigatoria('E2E_ORIGEM_WEB'),
  // Fila ligada: a importação roda em tarefa de segundo plano (ERP 3.6).
  FILA_TRABALHADOR: 'true',
  ARMAZENAMENTO_ENDPOINT: s3.url,
  ARMAZENAMENTO_BUCKET: 'genesis-e2e',
  DASHBOARD_CACHE_MS: '0',
  CEP_CONSULTA_URL: 'desligada',
  LOGIN_LIMITE_POR_MINUTO: '1000',
  LOGIN_LIMITE_POR_CONTA_MINUTO: '1000',
  TENANCY_CACHE_MS: '0',
});
const servicos = criarServicos(config, { executadoPor: 'e2e' });
await servicos.armazenamento.garantirBucket();
await seedControle(servicos.controle, servicos.servidores);

// Faixa de 1.000 códigos sem banco de empresa no servidor (os testes de integração usam 800000+).
let inicio: number | null = null;
for (let i = 0; i < 50 && inicio === null; i++) {
  const candidato = randomInt(700, 800) * 1000;
  const { rows } = await servicos.controle.pool.query<{ n: number }>(
    `select count(*)::int as n from pg_database
     where datname ~ '^genesis_emp_[0-9]+$' and substring(datname from 13)::int between $1 and $2`,
    [candidato, candidato + 999],
  );
  if (rows[0]?.n === 0) inicio = candidato;
}
if (inicio === null) throw new Error('Sem faixa de códigos livre para o e2e');
await servicos.controle.pool.query(`alter sequence seq_codigo_empresa restart with ${inicio + 1}`);

const admin = { nome: 'Admin E2E', email: 'e2e@genesis.dev', senha: 'senha-do-e2e-123456' };
const criado = await servicos.adminAuth.criarAdmin({ ...admin, papel: 'superadmin' });
writeFileSync(
  obrigatoria('E2E_ESTADO'),
  JSON.stringify({ ...admin, totp: criado.totpSegredo, bancoControle: base.pathname.slice(1) }),
);

const { app } = await criarAplicacao(config, servicos);
await app.listen(porta, '127.0.0.1');
