/**
 * Carga do relatório Movimentação de Estoque, visão analítica (Fase 2, F2-B32; README da API › decisão 179). Fora do
 * CI: `pnpm --filter api carga:movimentacao`. Gera a massa do F2-B28 (`gerarMassa`, 4 milhões de movimentos em 12 meses
 * por padrão: 3 lojas, o CD e a Treino, 2.000 produtos) num ambiente descartável e mede, pela rota de verdade (`GET
 * /relatorios/movimentacao-estoque`, com a API no mesmo processo), a página de 12 meses da loja com mais movimentos em
 * cada caso: a primeira página, a do meio e a última pelo cursor, só as compras, o produto mais vendido (o que tem a
 * história mais longa: o saldo anterior lê mais), um fornecedor e um operador. Cada caso roda `REPETICOES` vezes; vale
 * o pior. Critério de pronto: **menos de 5 s** em todos. Registra também o `EXPLAIN (ANALYZE, BUFFERS)` da consulta da
 * primeira página e da do meio (o plano resumido, o tempo e as páginas de 8 kB tocadas). Apaga os bancos no fim.
 *
 * Opções: `--movimentos=4000000`, `--produtos=2000`, `--semente=28`, `--saida=resultado.json`.
 */
import { writeFileSync } from 'node:fs';
import { consultaMovimentacaoEstoqueSchema } from '@genesis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { codificarCursor, sqlMovimentacaoAnalitica } from '../../src/relatorios/movimentacao.js';
import { criarAmbiente, conectar } from '../integracao/ambiente.js';
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
const REPETICOES = 3;
const FUSO = 'America/Sao_Paulo';
/** Os 12 meses da massa (01/11/2025 a 31/10/2026, no fuso de Brasília). */
const PERIODO = { dataInicial: '2025-11-01', dataFinal: '2026-10-31' };

interface NoPlano {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: NoPlano[];
}

/** Os nós do plano que leem o razão (o caminho de leitura), de cima para baixo, com as linhas reais. */
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

async function explicar(c: pg.Client, query: Record<string, string>, cursor?: { data: string; id: string }) {
  const f = consultaMovimentacaoEstoqueSchema.parse(query);
  const q = new PgDialect().sqlToQuery(
    sqlMovimentacaoAnalitica(
      { estoques: null, permissoes: new Set(['produtos.ver_custo']) },
      { ...f, fuso: FUSO },
      { limite: f.tamanho + 1, cursor },
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
    caminho: [...new Set(caminhos(melhor!.Plan))],
  };
}

async function principal(): Promise<void> {
  const t0 = Date.now();
  const amb = await criarAmbiente();
  const resultado: Record<string, unknown> = { movimentos: MOVIMENTOS, produtos: PRODUTOS, semente: SEMENTE };
  let c: pg.Client | null = null;
  try {
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
    const loja = massa.cadastro.estoques.find((e) => e.nome === 'Loja 1')!.id;
    const base = { estoqueId: loja, ...PERIODO, tamanho: '50' };

    // Os pontos dos casos, pelo banco: o meio e o fim do período (o cursor é o movimento antes deles), o produto e o
    // fornecedor com mais movimentos e um operador.
    const ponto = async (instante: string) => {
      const { rows } = await c!.query<{ data: string; id: string }>(
        `select to_char(data_movimento at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as data, id
           from movimentos_estoque where estoque_id = $1 and data_movimento < $2::timestamptz
          order by data_movimento desc, id desc limit 1`,
        [loja, instante],
      );
      return rows[0]!;
    };
    const meio = await ponto('2026-05-01T03:00:00Z');
    const fim = await ponto('2026-10-31T23:00:00Z');
    const { rows: mais } = await c.query<{ produto_id: string; n: string }>(
      `select produto_id, count(*)::text as n from movimentos_estoque where estoque_id = $1
        group by produto_id order by count(*) desc limit 1`,
      [loja],
    );
    const { rows: forn } = await c.query<{ pessoa_id: string; n: string }>(
      `select pessoa_id, count(*)::text as n from movimentos_estoque
        where estoque_id = $1 and pessoa_id is not null group by pessoa_id order by count(*) desc limit 1`,
      [loja],
    );
    const { rows: oper } = await c.query<{ usuario_id: string; n: string }>(
      `select usuario_id, count(*)::text as n from movimentos_estoque
        where estoque_id = $1 and usuario_id is not null group by usuario_id order by count(*) limit 1`,
      [loja],
    );
    const { rows: total } = await c.query<{ n: string }>(
      'select count(*)::text as n from movimentos_estoque where estoque_id = $1',
      [loja],
    );
    resultado.loja = {
      movimentos: Number(total[0]!.n),
      produto_mais_movimentado: Number(mais[0]!.n),
      fornecedor: Number(forn[0]?.n ?? 0),
      operador: Number(oper[0]?.n ?? 0),
    };
    console.log(JSON.stringify(resultado.loja));

    // O plano da primeira página e da do meio (o EXPLAIN registrado do critério de pronto).
    resultado.explain = {
      primeira_pagina: await explicar(c, base),
      pagina_do_meio: await explicar(c, base, meio),
      produto_mais_movimentado: await explicar(c, { ...base, produtoId: mais[0]!.produto_id }),
    };
    console.log(JSON.stringify(resultado.explain, null, 2));
    await c.end();
    c = null;

    const casos: Array<{ nome: string; query: Record<string, string> }> = [
      { nome: '12 meses, 1ª página', query: base },
      { nome: '12 meses, página do meio (cursor)', query: { ...base, cursor: codificarCursor(meio) } },
      { nome: '12 meses, última página (cursor)', query: { ...base, cursor: codificarCursor(fim) } },
      { nome: '12 meses, só as compras', query: { ...base, tiposMovimento: 'RECEB_MANUAL,RECEB_NFE' } },
      { nome: '12 meses, o produto mais movimentado', query: { ...base, produtoId: mais[0]!.produto_id } },
      ...(forn[0]
        ? [{ nome: '12 meses, um fornecedor', query: { ...base, pessoaId: forn[0].pessoa_id } }]
        : []),
      ...(oper[0]
        ? [
            {
              nome: '12 meses, o operador com menos movimentos',
              query: { ...base, usuarioId: oper[0].usuario_id },
            },
          ]
        : []),
    ];
    const medidas = [];
    for (const caso of casos) {
      const tempos: number[] = [];
      let linhas = 0;
      for (let i = 0; i < REPETICOES; i++) {
        const inicio = performance.now();
        const r = await amb
          .http()
          .get('/api/relatorios/movimentacao-estoque')
          .query(caso.query)
          .set({ Authorization: `Bearer ${token}` });
        if (r.status !== 200)
          throw new Error(`${caso.nome}: ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
        tempos.push(performance.now() - inicio);
        linhas = r.body.itens.length;
      }
      const medida = {
        caso: caso.nome,
        linhas,
        ms: tempos.map((t) => Math.round(t)),
        pior_ms: Math.round(Math.max(...tempos)),
      };
      console.log(JSON.stringify(medida));
      medidas.push(medida);
      if (medida.pior_ms >= LIMITE_MS)
        throw new Error(`${caso.nome}: ${medida.pior_ms} ms passou de ${LIMITE_MS} ms`);
    }
    Object.assign(resultado, { medidas, total_s: Math.round((Date.now() - t0) / 1000) });
    if (SAIDA) writeFileSync(SAIDA, JSON.stringify(resultado, null, 2));
  } finally {
    await c?.end();
    await amb.fechar();
  }
}

try {
  await principal();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
