/**
 * Ensaio do piloto com a carga REAL (implantação I5), local e fora do CI: a API do e2e do PDV com o catálogo da
 * planilha do Nuvem3 importado pelo importador de verdade (ERP 8.6, prévia + confirmação em segundo plano), a loja de
 * ensaio (a "Treino" do O10, não fiscal) e o caixa 01 criados pelas rotas do ERP como o dono faria, as formas do seed
 * com a chave PIX de mentira (aleatória) na loja, o operador e o gerente com PIN e o Master com PIN (lacuna). Grava em
 * `E2E_ESTADO` o estado que o `EnsaioPilotoTests` (C#) lê: as credenciais, os ids, os tempos e as contagens da
 * importação e uma amostra de produtos vendáveis do catálogo real (unidade, fardo, fracionado e combo, quando houver),
 * sorteada com semente fixa. A planilha (`GENESIS_PLANILHA_REAL`) NUNCA vai para o repositório: o estado fica na pasta
 * temporária do `ensaio-piloto.sh` e o relatório final só tem tempos e contagens, sem nome de produto nem código.
 *
 * Uso: pelo `ensaio-piloto.sh` (sobe este servidor, roda o PDV e derruba tudo no fim). Sem `E2E_ESTADO` sai com 2:
 * não há arquivo padrão no diretório atual, que fica dentro do repositório. Ao receber SIGINT/SIGTERM, ou se o preparo
 * falhar no meio, apaga os bancos que criou (`recursos.ts`) e o estado.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as esperar } from 'node:timers/promises';
import { completarCnpj, criarEmpresaSchema, type PreviaImportacao } from '@genesis/shared';
import { criarAplicacao } from '../../src/app.js';
import { carregarConfiguracao } from '../../src/config/configuracao.js';
import { garantirBanco, migrarControle, seedControle } from '../../src/database/migracoes/controle.js';
import { criarServicos } from '../../src/servicos.js';
import { consultar, urlDoBanco } from '../integracao/ambiente.js';
import { iniciarS3Falso, type S3Falso } from '../integracao/s3-falso.js';
import { RecursosE2ePdv } from './recursos.js';

const SENHA_ERP = 'SenhaEnsaio123';
const OPERADOR = { login: 'caixa.ensaio', nome: 'OPERADOR ENSAIO', pin: '258036' } as const;
const GERENTE = { login: 'gerente.ensaio', nome: 'GERENTE ENSAIO', pin: '369147' } as const;
const PIN_MASTER = '471582';
/** Quantos produtos de cada tipo a amostra leva (o PDV vende itens sorteados dela). */
const AMOSTRA = { unidade: 40, fardo: 8, fracionado: 6, combo: 6 } as const;
const OPCOES_IMPORTACAO = {
  atualizarEstoque: true,
  atualizarEstoqueMinimo: true,
  atualizarPrecos: true,
  criarMarcasCategorias: true,
} as const;

const planilha = process.env.GENESIS_PLANILHA_REAL;
if (!planilha) {
  console.error(
    'ensaio: defina GENESIS_PLANILHA_REAL com o caminho da planilha de produtos do Nuvem3 (.xlsx).',
  );
  process.exit(2);
}
// O estado leva a amostra do catálogo REAL (ids, códigos, preços) e as credenciais do ensaio: sem padrão no diretório
// atual (dentro do repositório), só no caminho que o `ensaio-piloto.sh` passa na pasta temporária dele.
const estadoArquivo = process.env.E2E_ESTADO ?? '';
if (!estadoArquivo) {
  console.error(
    'ensaio: defina E2E_ESTADO com um arquivo fora do repositório (o ensaio-piloto.sh usa a pasta temporária dele).',
  );
  process.exit(2);
}
const porta = Number(process.env.E2E_PORTA_API ?? 3398);
const recursos = new RecursosE2ePdv();
let s3: S3Falso | null = null;
rmSync(estadoArquivo, { force: true });

async function limpar(): Promise<void> {
  await recursos.limpar();
  await s3?.fechar().catch(() => undefined);
  rmSync(estadoArquivo, { force: true });
}

const segundos = (inicio: number) => Math.round((performance.now() - inicio) / 100) / 10;

async function preparar(): Promise<void> {
  const inicio = await recursos.reservarBloco();
  s3 = await iniciarS3Falso();
  const url = urlDoBanco(recursos.bancoControle);
  recursos.marcarControle();
  await garantirBanco(url);
  await migrarControle(url);
  const config = carregarConfiguracao({
    AMBIENTE: 'teste',
    DATABASE_URL: url,
    PORTA: String(porta),
    LOG_NIVEL: process.env.E2E_LOG_NIVEL ?? 'warn',
    LOG_LEGIVEL: 'false',
    // A confirmação da importação roda no trabalhador do pg-boss, como em produção.
    FILA_TRABALHADOR: 'true',
    ARMAZENAMENTO_ENDPOINT: s3.url,
    ARMAZENAMENTO_BUCKET: `ensaio-${Date.now()}`,
    TENANCY_CACHE_MS: '0',
    CEP_CONSULTA_URL: 'desligada',
    LOGIN_LIMITE_POR_MINUTO: '1000',
    LOGIN_LIMITE_POR_CONTA_MINUTO: '1000',
  });
  process.env.IMPORTACAO_PREVIAS_POR_MINUTO = '1000';
  const servicos = criarServicos(config, { executadoPor: 'ensaio-piloto' });
  await seedControle(servicos.controle, servicos.servidores);
  await servicos.controle.pool.query(`alter sequence seq_codigo_empresa restart with ${inicio + 1}`);
  await servicos.armazenamento.garantirBucket();

  const empresa = await servicos.provisionamento.criar(
    criarEmpresaSchema.parse({
      razaoSocial: 'Empresa Ensaio do Piloto Ltda',
      cnpj: completarCnpj(`${randomInt(10 ** 11, 10 ** 12 - 1)}`.slice(0, 12)),
      planoCodigo: 'padrao',
    }),
  );
  const { app } = await criarAplicacao(config, servicos);
  recursos.app = app;
  await app.listen(porta, '127.0.0.1');
  await servicos.fila.iniciar();
  const base = `http://127.0.0.1:${porta}`;

  async function chamar<T>(metodo: string, rota: string, corpo?: unknown, token?: string): Promise<T> {
    const r = await fetch(`${base}${rota}`, {
      method: metodo,
      headers: {
        ...(corpo instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: corpo === undefined ? undefined : corpo instanceof FormData ? corpo : JSON.stringify(corpo),
    });
    const texto = await r.text();
    if (!r.ok) throw new Error(`${metodo} ${rota}: ${r.status} ${texto.slice(0, 2000)}`);
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  const primeiro = await chamar<{ tokenAcesso: string }>('POST', '/api/auth/login', {
    codigoEmpresa: empresa.codigo,
    login: 'admin',
    senha: empresa.senhaProvisoria!,
  });
  const admin = (
    await chamar<{ tokenAcesso: string }>(
      'POST',
      '/api/auth/trocar-senha',
      { senhaAtual: empresa.senhaProvisoria!, novaSenha: SENHA_ERP },
      primeiro.tokenAcesso,
    )
  ).tokenAcesso;

  // Loja de ensaio pelo assistente do ERP (caixa 0, conta e numerações nascem juntos) e o caixa 01. A chave PIX é uma
  // aleatória de mentira (o QR sai, nenhum banco a conhece).
  const loja = await chamar<{ id: string; estoqueId: string }>(
    'POST',
    '/api/lojas',
    {
      nome: 'Loja Ensaio',
      razaoSocial: 'Empresa Ensaio do Piloto Ltda',
      nomeFantasia: 'Ensaio',
      cnpj: completarCnpj(`${randomInt(10 ** 11, 10 ** 12 - 1)}`.slice(0, 12)),
      cep: '80010000',
      logradouro: 'Rua do Ensaio',
      numero: '1',
      bairro: 'Centro',
      municipioIbge: 4106902,
      uf: 'PR',
      treino: true,
      tipoEmissao: 'nao_fiscal',
      chavePix: randomUUID(),
      pixNomeRecebedor: 'LOJA ENSAIO',
      pixCidadeRecebedor: 'CURITIBA',
      estoqueId: null,
      nomeEstoque: 'Estoque Ensaio',
    },
    admin,
  );
  const caixa = await chamar<{ id: string }>(
    'POST',
    `/api/lojas/${loja.id}/caixas`,
    { numero: 1, descricao: 'Caixa 01' },
    admin,
  );

  // Importação da planilha real pela prévia e pela confirmação (tarefa no pg-boss), com o tempo de cada uma.
  const arquivo = readFileSync(planilha!);
  const formulario = () => {
    const f = new FormData();
    f.set('lojaId', loja.id);
    for (const [k, v] of Object.entries(OPCOES_IMPORTACAO)) f.set(k, String(v));
    // A hora da contagem do "Atualizar estoque" (F2-B11): a carga do ensaio conta agora.
    f.set('dataContagem', new Date().toISOString());
    f.set('arquivo', new Blob([arquivo]), basename(planilha!));
    return f;
  };
  const t0 = performance.now();
  const previa = await chamar<PreviaImportacao>(
    'POST',
    '/api/importacoes/produtos/previa',
    formulario(),
    admin,
  );
  const segundosPrevia = segundos(t0);
  const t1 = performance.now();
  const { tarefaId } = await chamar<{ tarefaId: string }>(
    'POST',
    '/api/importacoes/produtos/confirmar',
    {
      arquivoId: previa.arquivoId,
      lojaId: loja.id,
      ...OPCOES_IMPORTACAO,
      dataContagem: new Date().toISOString(),
    },
    admin,
  );
  let tarefa: { status: string; resultado?: unknown; erro?: string | null } = { status: 'na_fila' };
  for (let i = 0; i < 1200 && !['concluida', 'falhou', 'cancelada'].includes(tarefa.status); i++) {
    await esperar(500);
    tarefa = await chamar('GET', `/api/tarefas/${tarefaId}`, undefined, admin);
  }
  if (tarefa.status !== 'concluida')
    throw new Error(`importação: tarefa ${tarefa.status} ${tarefa.erro ?? ''}`);
  const segundosConfirmacao = segundos(t1);

  // Usuários do caixa com PIN pela rota do ERP (argon2id da SYNC 4.2): operador (perfil padrão) e gerente.
  const criarUsuario = async (u: { login: string; nome: string; pin: string }, perfil: string) => {
    const [linha] = await consultar<{ id: string }>(
      empresa.nomeBanco,
      `insert into usuarios (nome, login, perfil_id)
       values ($1, $2, (select id from perfis where chave_sistema = $3)) returning id`,
      [u.nome, u.login, perfil],
    );
    await consultar(empresa.nomeBanco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [
      linha!.id,
      loja.id,
    ]);
    await chamar('PUT', `/api/usuarios/${linha!.id}/pin`, { pin: u.pin }, admin);
  };
  await criarUsuario(OPERADOR, 'operador_caixa');
  await criarUsuario(GERENTE, 'gerente');
  const [master] = await consultar<{ id: string }>(
    empresa.nomeBanco,
    "select id from usuarios where login = 'admin'",
  );
  await chamar('PUT', `/api/usuarios/${master!.id}/pin`, { pin: PIN_MASTER }, admin);

  // Amostra vendável do catálogo real: ativo, com preço, sem balança nem "solicita preço", com um código de venda
  // que só ele tem (o caixa entra o primeiro de um código repetido) e, no combo, todos os componentes ativos.
  const amostra = await consultar<{ id: string; codigo: string; tipo: string; preco: string }>(
    empresa.nomeBanco,
    `with v as (
       select p.id, p.tipo, p.permite_fracao, u.sigla, p.preco_venda,
              (select min(c.codigo) from produtos_codigos_barras c
                where c.produto_id = p.id and c.excluido_em is null and c.usa_venda and c.fator = 1
                  and not exists (select 1 from produtos_codigos_barras o
                                   where o.codigo = c.codigo and o.produto_id <> p.id and o.excluido_em is null)) as codigo
         from produtos p join unidades_medida u on u.id = p.unidade_id
        where p.excluido_em is null and p.ativo and p.preco_venda > 0 and not p.solicita_preco_pdv
          and p.balanca_tipo = 'nao_usa' and p.tipo in ('simples', 'kit', 'produzido')
          and (p.tipo <> 'kit' or (
            exists (select 1 from produtos_componentes pc where pc.produto_id = p.id and pc.excluido_em is null)
            and not exists (select 1 from produtos_componentes pc join produtos c on c.id = pc.componente_id
                             where pc.produto_id = p.id and pc.excluido_em is null and (not c.ativo or c.excluido_em is not null))))
     ), classificada as (
       select id, codigo, preco_venda::text as preco,
              case when tipo = 'kit' then 'combo'
                   when permite_fracao then 'fracionado'
                   when sigla in ('FD', 'CX', 'PCT', 'FDO') then 'fardo'
                   else 'unidade' end as tipo
         from v where codigo is not null
     )
     select id, codigo, tipo, preco from (
       select *, row_number() over (partition by tipo order by md5(id::text || 'ensaio')) as n from classificada
     ) x
     where (tipo = 'unidade' and n <= $1) or (tipo = 'fardo' and n <= $2)
        or (tipo = 'fracionado' and n <= $3) or (tipo = 'combo' and n <= $4)
     order by tipo, n`,
    [AMOSTRA.unidade, AMOSTRA.fardo, AMOSTRA.fracionado, AMOSTRA.combo],
  );
  const [catalogo] = await consultar<{
    produtos: number;
    ativos: number;
    codigos: number;
    com_preco: number;
  }>(
    empresa.nomeBanco,
    `select count(*)::int as produtos, count(*) filter (where ativo)::int as ativos,
            count(*) filter (where ativo and preco_venda > 0)::int as com_preco,
            (select count(*)::int from produtos_codigos_barras where excluido_em is null) as codigos
       from produtos where excluido_em is null`,
  );

  const resumo = previa.resumo;
  const estado = {
    api: `${base}/`,
    codigoEmpresa: empresa.codigo,
    erp: { login: 'admin', senha: SENHA_ERP },
    operador: { login: OPERADOR.login, pin: OPERADOR.pin, nome: OPERADOR.nome },
    gerente: { login: GERENTE.login, pin: GERENTE.pin, nome: GERENTE.nome },
    lojaId: loja.id,
    estoqueId: loja.estoqueId,
    caixaId: caixa.id,
    importacao: {
      segundosPrevia,
      segundosConfirmacao,
      linhas: resumo.linhas,
      criar: resumo.criar,
      atualizar: resumo.atualizar,
      ignorar: resumo.ignorar,
      comAviso: resumo.comAviso,
      porAviso: resumo.porAviso,
      linhasComErro: previa.linhas.filter((l) => l.erros.length > 0).length,
      resultado: tarefa.resultado ?? null,
    },
    catalogo,
    amostra: amostra.map((a) => ({ id: a.id, codigo: a.codigo, tipo: a.tipo, preco: a.preco })),
  };
  writeFileSync(estadoArquivo, JSON.stringify(estado, null, 2));
  console.log(
    `ensaio: API em ${base}, empresa ${empresa.codigo}; ${catalogo!.ativos} produtos ativos importados em ` +
      `${segundosPrevia + segundosConfirmacao} s; amostra de ${amostra.length}; estado em ${estadoArquivo}`,
  );
}

let encerrando = false;
async function encerrar(codigo: number): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  try {
    await limpar();
  } catch (e) {
    console.error('ensaio: falha ao apagar os bancos (use pnpm --filter api test:limpar):', e);
    codigo = codigo || 1;
  }
  process.exit(codigo);
}
process.on('SIGINT', () => void encerrar(0));
process.on('SIGTERM', () => void encerrar(0));

try {
  await preparar();
} catch (e) {
  console.error('ensaio: o preparo falhou; apagando o que foi criado.', e);
  await encerrar(1);
}
