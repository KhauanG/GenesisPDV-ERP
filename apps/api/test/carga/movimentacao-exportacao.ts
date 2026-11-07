/**
 * Carga da Movimentação de Estoque, visão sintética e exportação (Fase 2, F2-B33; README da API › decisão 180). Fora
 * do CI: `pnpm --filter api carga:movimentacao-exportacao`. Gera a massa do F2-B28 (`gerarMassa`, 4 milhões de
 * movimentos em 12 meses por padrão: 3 lojas, o CD e a Treino, 2.000 produtos) num ambiente descartável, com a API, a
 * fila pg-boss e o S3 em memória no mesmo processo, e mede pela rota de verdade:
 *
 * - a **sintética** (`GET /relatorios/movimentacao-estoque/sintetica`, páginas de 50): 12 meses da Loja 1 (a primeira
 *   e a última página), um mês recente (o saldo inicial lê 11 meses de história), só as compras e o CD; cada caso
 *   `REPETICOES` vezes, vale o pior; critério: **menos de 5 s** (o gatilho da decisão 176). Com o `EXPLAIN (ANALYZE,
 *   BUFFERS)` dos 12 meses e do mês recente;
 * - a **contagem própria** da exportação (`sqlContagemMovimentacao`) das duas visões, nos 12 meses;
 * - a **exportação de 12 meses da Loja 1 em tarefa** (`.xlsx` da analítica, ~1,6 milhão de linhas: `202` → tarefa →
 *   link), com o tempo e o **pico de heap do processo inteiro** (amostrado a cada 20 ms, com `--expose-gc` para partir
 *   só do que está vivo) e a memória fora do heap sem o arquivo do S3 em memória (como a `carga:exportacao`), e o
 *   arquivo conferido (lido em streaming: as linhas de todas as abas); critério: heap abaixo de 300 MB;
 * - a exportação da sintética dos 12 meses (na hora: poucos milhares de linhas).
 *
 * Apaga os bancos no fim. Opções: `--movimentos=4000000`, `--produtos=2000`, `--semente=28`, `--saida=resultado.json`.
 */
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as esperar } from 'node:timers/promises';
import { consultaMovimentacaoSinteticaSchema, filtrosMovimentacaoEstoqueSchema } from '@genesis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { sqlContagemMovimentacao, sqlMovimentacaoSintetica } from '../../src/relatorios/movimentacao.js';
import { criarAmbiente, conectar } from '../integracao/ambiente.js';
import { iniciarS3Falso } from '../integracao/s3-falso.js';
import { gerarMassa } from './massa-razao.js';

const argumentos = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.length ? v.join('=') : 'true'] as const;
  }),
);
const numero = (nome: string, padrao: number) => Number(argumentos.get(nome) ?? padrao);
const MOVIMENTOS = numero('movimentos', 4_000_000);
const PRODUTOS = numero('produtos', 2000);
const SEMENTE = numero('semente', 28);
const SAIDA = argumentos.get('saida');
const LIMITE_MS = 5000;
const LIMITE_HEAP_MB = 300;
const LIMITE_EXTERNO_MB = 100;
const REPETICOES = 3;
const FUSO = 'America/Sao_Paulo';
/** Os 12 meses da massa (01/11/2025 a 31/10/2026, no fuso de Brasília). */
const PERIODO = { dataInicial: '2025-11-01', dataFinal: '2026-10-31' };
const SESSAO = { estoques: null, permissoes: new Set(['produtos.ver_custo']) };

const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;

interface NoPlano {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  Plans?: NoPlano[];
}

/** Os nós do plano que leem o razão, de cima para baixo, com as linhas reais. */
function caminhos(no: NoPlano): string[] {
  const proprio = (no['Index Name'] ?? no['Relation Name'] ?? '').includes('movimentos_estoque')
    ? [
        `${no['Node Type']} ${no['Index Name'] ?? no['Relation Name']} ${(
          (no['Actual Rows'] ?? 0) * (no['Actual Loops'] ?? 1)
        ).toFixed(0)}`,
      ]
    : [];
  return [...proprio, ...(no.Plans ?? []).flatMap(caminhos)];
}

async function explicarSintetica(c: pg.Client, query: Record<string, string>) {
  const f = consultaMovimentacaoSinteticaSchema.parse(query);
  const q = new PgDialect().sqlToQuery(
    sqlMovimentacaoSintetica(
      SESSAO,
      { ...f, fuso: FUSO },
      { limite: f.tamanho, deslocamento: 0, janela: true },
    ),
  );
  await c.query('set jit = off');
  let melhor: { Plan: NoPlano; 'Execution Time': number } | null = null;
  for (let i = 0; i < REPETICOES; i++) {
    const { rows } = await c.query<{ 'QUERY PLAN': [{ Plan: NoPlano; 'Execution Time': number }] }>(
      `explain (analyze, buffers, format json) ${q.sql}`,
      q.params as unknown[],
    );
    const r = rows[0]!['QUERY PLAN'][0];
    if (!melhor || r['Execution Time'] < melhor['Execution Time']) melhor = r;
  }
  return {
    ms: Math.round(melhor!['Execution Time'] * 10) / 10,
    paginas: (melhor!.Plan['Shared Hit Blocks'] ?? 0) + (melhor!.Plan['Shared Read Blocks'] ?? 0),
    temporarias: melhor!.Plan['Temp Read Blocks'] ?? 0,
    caminho: [...new Set(caminhos(melhor!.Plan))],
  };
}

/** Linhas de dados do `.xlsx`, lido em streaming (sem carregar o livro): todas as abas, menos os cabeçalhos. */
async function contarXlsx(conteudo: Buffer): Promise<{ linhas: number; abas: number }> {
  const leitor = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([conteudo]), {
    worksheets: 'emit',
    sharedStrings: 'ignore',
    styles: 'ignore',
    hyperlinks: 'ignore',
  });
  let linhas = 0;
  let abas = 0;
  for await (const aba of leitor) {
    abas++;
    for await (const _linha of aba) linhas++;
    linhas--; // o cabeçalho
  }
  return { linhas, abas };
}

async function principal(): Promise<void> {
  const t0 = Date.now();
  const s3 = await iniciarS3Falso();
  const amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3.url,
      ARMAZENAMENTO_BUCKET: `genesis-carga-mov-${Date.now()}`,
    },
  });
  const resultado: Record<string, unknown> = { movimentos: MOVIMENTOS, produtos: PRODUTOS, semente: SEMENTE };
  let c: pg.Client | null = null;
  try {
    await amb.servicos.armazenamento.garantirBucket();
    await amb.servicos.fila.iniciar();
    const empresa = await amb.criarEmpresa();
    console.log(`Empresa de carga: ${empresa.nomeBanco}`);
    c = await conectar(empresa.nomeBanco);
    const tMassa = Date.now();
    const massa = await gerarMassa(empresa.nomeBanco, c, {
      movimentos: MOVIMENTOS,
      produtos: PRODUTOS,
      semente: SEMENTE,
      aoProgredir: (n) => console.log(`  ${n.toLocaleString('pt-BR')} movimentos`),
    });
    resultado.massa = {
      movimentos: massa.movimentos,
      linhas_saldo: massa.linhasSaldo,
      geracao_s: Math.round((Date.now() - tMassa) / 1000),
    };
    console.log(`Massa: ${massa.movimentos.toLocaleString('pt-BR')} movimentos, ${massa.linhasSaldo} linhas`);
    const token = await amb.entrar(empresa.codigo, 'admin', empresa.senha);
    const auth = { Authorization: `Bearer ${token}` };
    const loja = massa.cadastro.estoques.find((e) => e.nome === 'Loja 1')!.id;
    const cd = massa.cadastro.estoques.find((e) => e.nome === 'CD')?.id;
    const base = { estoqueId: loja, ...PERIODO, tamanho: '50' };

    // O plano da sintética dos 12 meses e do mês recente, e a contagem própria das duas visões.
    const mes = { ...base, dataInicial: '2026-10-01' };
    resultado.explain = {
      sintetica_12_meses: await explicarSintetica(c, base),
      sintetica_mes_recente: await explicarSintetica(c, mes),
    };
    console.log(JSON.stringify(resultado.explain, null, 2));
    const contagem: Record<string, { linhas: number; ms: number }> = {};
    for (const visao of ['analitica', 'sintetica'] as const) {
      const q = new PgDialect().sqlToQuery(
        sqlContagemMovimentacao(
          SESSAO,
          { ...filtrosMovimentacaoEstoqueSchema.parse({ estoqueId: loja, ...PERIODO }), fuso: FUSO },
          visao,
        ),
      );
      let melhor = Infinity;
      let linhas = 0;
      for (let i = 0; i < REPETICOES; i++) {
        const inicio = performance.now();
        const { rows } = await c.query<{ n: string }>(q.sql, q.params as unknown[]);
        melhor = Math.min(melhor, performance.now() - inicio);
        linhas = Number(rows[0]!.n);
      }
      contagem[visao] = { linhas, ms: Math.round(melhor) };
    }
    resultado.contagem_12_meses = contagem;
    console.log(JSON.stringify(contagem));
    await c.end();
    c = null;

    // A sintética pela rota.
    const ultima = Math.max(1, Math.ceil(contagem.sintetica!.linhas / 50));
    const casos: Array<{ nome: string; query: Record<string, string> }> = [
      { nome: 'sintética, 12 meses, 1ª página', query: base },
      { nome: 'sintética, 12 meses, última página', query: { ...base, pagina: String(ultima) } },
      { nome: 'sintética, outubro (saldo inicial de 11 meses)', query: mes },
      {
        nome: 'sintética, 12 meses, só as compras',
        query: { ...base, tiposMovimento: 'RECEB_MANUAL,RECEB_NFE' },
      },
      ...(cd ? [{ nome: 'sintética, 12 meses, o CD', query: { ...base, estoqueId: cd } }] : []),
    ];
    const medidas = [];
    for (const caso of casos) {
      const tempos: number[] = [];
      let linhas = 0;
      let total = 0;
      for (let i = 0; i < REPETICOES; i++) {
        const inicio = performance.now();
        const r = await amb
          .http()
          .get('/api/relatorios/movimentacao-estoque/sintetica')
          .query(caso.query)
          .set(auth);
        if (r.status !== 200)
          throw new Error(`${caso.nome}: ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
        tempos.push(performance.now() - inicio);
        linhas = r.body.itens.length;
        total = r.body.total;
      }
      const medida = {
        caso: caso.nome,
        linhas,
        total,
        ms: tempos.map((t) => Math.round(t)),
        pior_ms: Math.round(Math.max(...tempos)),
      };
      console.log(JSON.stringify(medida));
      medidas.push(medida);
      if (medida.pior_ms >= LIMITE_MS)
        throw new Error(`${caso.nome}: ${medida.pior_ms} ms passou de ${LIMITE_MS} ms`);
    }
    resultado.sintetica = medidas;

    // A exportação da sintética dos 12 meses (na hora).
    {
      const inicio = Date.now();
      const r = await amb
        .http()
        .get('/api/relatorios/movimentacao-estoque/exportar')
        .query({ estoqueId: loja, ...PERIODO, visao: 'sintetica', formato: 'xlsx' })
        .set(auth)
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (p: Buffer) => partes.push(p));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
      if (r.status !== 200) throw new Error(`exportação da sintética: ${r.status}`);
      const conferido = await contarXlsx(r.body as Buffer);
      resultado.exportacao_sintetica = {
        linhas: conferido.linhas,
        tamanho: `${mb((r.body as Buffer).length)} MB`,
        ms: Date.now() - inicio,
      };
      console.log(JSON.stringify(resultado.exportacao_sintetica));
      if (conferido.linhas !== contagem.sintetica!.linhas)
        throw new Error(
          `a sintética exportada tem ${conferido.linhas} de ${contagem.sintetica!.linhas} linhas`,
        );
    }

    // A exportação da analítica dos 12 meses em tarefa, com o pico de memória.
    global.gc?.();
    const heapInicial = process.memoryUsage().heapUsed;
    let picoHeap = heapInicial;
    const rssInicial = process.memoryUsage().rss;
    let picoRss = rssInicial;
    const externoInicial = process.memoryUsage().external;
    let picoExterno = externoInicial;
    const amostra = setInterval(() => {
      const m = process.memoryUsage();
      picoHeap = Math.max(picoHeap, m.heapUsed);
      picoRss = Math.max(picoRss, m.rss);
      picoExterno = Math.max(picoExterno, m.external);
    }, 20);
    const inicio = Date.now();
    const pedido = await amb
      .http()
      .get('/api/relatorios/movimentacao-estoque/exportar')
      .query({ estoqueId: loja, ...PERIODO, formato: 'xlsx' })
      .set(auth);
    if (pedido.status !== 202)
      throw new Error(`esperava 202: ${pedido.status} ${JSON.stringify(pedido.body)}`);
    const pedidoMs = Date.now() - inicio;
    let tarefa;
    for (;;) {
      const r = await amb.http().get(`/api/tarefas/${pedido.body.tarefaId}`).set(auth);
      tarefa = r.body;
      if (tarefa.status === 'concluida' || tarefa.status === 'falhou') break;
      await esperar(250);
    }
    clearInterval(amostra);
    const segundos = (Date.now() - inicio) / 1000;
    if (tarefa.status !== 'concluida') throw new Error(`a tarefa falhou: ${tarefa.erro}`);
    const conteudo = Buffer.from(await (await fetch(tarefa.download)).arrayBuffer());
    const conferido = await contarXlsx(conteudo);
    const externoGerador = Math.max(0, picoExterno - externoInicial - 2 * conteudo.length);
    resultado.exportacao_analitica = {
      linhas_pedido: pedido.body.linhas,
      linhas_tarefa: tarefa.resultado.linhas,
      linhas_arquivo: conferido.linhas,
      abas: conferido.abas,
      nome: tarefa.resultado.nomeArquivo,
      tamanho: `${mb(conteudo.length)} MB`,
      pedido_ms: pedidoMs,
      segundos: Math.round(segundos * 10) / 10,
      linhas_por_s: Math.round(conferido.linhas / segundos),
      heap_inicial: `${mb(heapInicial)} MB`,
      heap_pico: `${mb(picoHeap)} MB`,
      externo_pico: `${mb(picoExterno)} MB`,
      externo_sem_s3: `${mb(externoGerador)} MB`,
      rss_inicial: `${mb(rssInicial)} MB`,
      rss_pico: `${mb(picoRss)} MB`,
    };
    console.log(JSON.stringify(resultado.exportacao_analitica));
    if (
      conferido.linhas !== contagem.analitica!.linhas ||
      tarefa.resultado.linhas !== contagem.analitica!.linhas
    )
      throw new Error(
        `o arquivo não tem o total de linhas (${conferido.linhas} de ${contagem.analitica!.linhas})`,
      );
    if (mb(picoHeap) >= LIMITE_HEAP_MB)
      throw new Error(`pico de heap ${mb(picoHeap)} MB passou de ${LIMITE_HEAP_MB} MB`);
    if (mb(externoGerador) >= LIMITE_EXTERNO_MB)
      throw new Error(
        `fora do heap ${mb(externoGerador)} MB (sem o S3 em memória) passou de ${LIMITE_EXTERNO_MB} MB`,
      );

    Object.assign(resultado, { total_s: Math.round((Date.now() - t0) / 1000) });
    console.log(`Total: ${resultado.total_s} s`);
    if (SAIDA) writeFileSync(SAIDA, JSON.stringify(resultado, null, 2));
  } finally {
    await c?.end();
    await amb.fechar();
    await s3.fechar();
  }
}

try {
  await principal();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
