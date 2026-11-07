/**
 * Carga do relatório Estoque Atual (Fase 2, F2-B31; README da API › decisão 178). Fora do CI:
 * `pnpm --filter api carga:estoque-atual`. Gera a massa do F2-B28 (`gerarMassa`, 4 milhões de movimentos em 12 meses
 * por padrão: 3 lojas, o CD e a Treino, 2.000 produtos) num ambiente descartável e mede, pela rota de verdade
 * (`GET /relatorios/estoque-atual`, com a API no mesmo processo), a primeira página e o total do relatório em cada
 * caso: "Todas" e uma loja, o saldo de agora e a data-base (ontem e uma data entre o meio da história e o fim da
 * massa, pela projeção menos o razão depois da data; uma data no primeiro terço da história, pela soma até a data), e a
 * exportação na hora do "Todas" em CSV. O meio da história depende do relógio (a regra da metade é entre o primeiro
 * movimento e agora, e as datas da massa são fixas): as datas-base saem do meio real, e cada caso de data-base confere,
 * antes de medir, que a consulta vai mesmo pelo caminho do rótulo (a coluna `recente` de `sqlEstoqueAtual`, como no
 * teste de integração) — senão a carga falha. Cada caso roda `REPETICOES` vezes; vale o pior. Critério de pronto:
 * **menos de 3 s** em todos. Apaga os bancos no fim.
 *
 * Opções: `--movimentos=4000000`, `--produtos=2000`, `--semente=28`, `--saida=resultado.json`.
 */
import { writeFileSync } from 'node:fs';
import { filtrosEstoqueAtualSchema } from '@genesis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sqlEstoqueAtual } from '../../src/relatorios/estoque-atual.js';
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
const LIMITE_MS = 3000;
const REPETICOES = 3;

const FUSO = 'America/Sao_Paulo';
/** `AAAA-MM-DD` do instante `ms`, no fuso de Brasília (o da empresa de carga). */
const diaDe = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date(ms));
const DIA_MS = 86_400_000;

async function principal(): Promise<void> {
  const t0 = Date.now();
  const amb = await criarAmbiente();
  const resultado: Record<string, unknown> = { movimentos: MOVIMENTOS, produtos: PRODUTOS, semente: SEMENTE };
  /** A conexão direta da massa e da conferência do caminho (fechada antes de medir, ou no fim se algo falhar). */
  let c: Awaited<ReturnType<typeof conectar>> | null = null;
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
    const loja1 = massa.cadastro.estoques.find((e) => e.nome === 'Loja 1')!.id;
    // O meio da história é o da regra da metade (entre o primeiro movimento e agora), que anda com o relógio; as
    // datas-base saem dele: uma entre o meio e o fim da massa (ou logo depois do meio, se a massa já ficou toda na
    // metade antiga) e uma no primeiro terço da história.
    const { rows: limites } = await c.query<{ inicio: Date; fim: Date }>(
      'select min(data_movimento) as inicio, max(data_movimento) as fim from movimentos_estoque',
    );
    const inicio = limites[0]!.inicio.getTime();
    const fimMassa = Math.min(limites[0]!.fim.getTime(), Date.now() - DIA_MS);
    const meio = inicio + (Date.now() - inicio) / 2;
    const dataRecente = diaDe(
      fimMassa > meio + 4 * DIA_MS ? meio + (fimMassa - meio) / 2 : meio + 2 * DIA_MS,
    );
    const dataAntiga = diaDe(inicio + ((meio - inicio) * 2) / 3);
    const ontem = diaDe(Date.now() - DIA_MS);
    console.log(`Meio da história: ${diaDe(meio)}; data-base recente ${dataRecente}, antiga ${dataAntiga}`);
    const casos: Array<{
      nome: string;
      query: Record<string, string>;
      exportar?: boolean;
      /** O caminho da data-base que o rótulo promete (`recente`: a projeção). */
      projecao?: boolean;
    }> = [
      { nome: 'Todas, agora', query: {} },
      { nome: 'Loja 1, agora', query: { estoqueId: loja1 } },
      { nome: 'Todas, data-base ontem (projeção)', query: { dataBase: ontem }, projecao: true },
      {
        nome: `Todas, data-base ${dataRecente}, metade recente (projeção)`,
        query: { dataBase: dataRecente },
        projecao: true,
      },
      {
        nome: `Todas, data-base ${dataAntiga}, primeiro terço (soma)`,
        query: { dataBase: dataAntiga },
        projecao: false,
      },
      {
        nome: `Loja 1, data-base ${dataAntiga}, primeiro terço (soma)`,
        query: { estoqueId: loja1, dataBase: dataAntiga },
        projecao: false,
      },
      {
        nome: 'Todas, abaixo do mínimo, ordenado por venda total',
        query: { situacaoSaldo: 'abaixo_minimo', ordenar: 'venda_total:desc' },
      },
      {
        nome: 'Exportação na hora (CSV), Todas, data-base ontem',
        query: { dataBase: ontem },
        exportar: true,
        projecao: true,
      },
    ];
    // Confere o caminho de cada data-base pela própria consulta (a regra automática), com o Master da carga.
    for (const caso of casos) {
      if (caso.projecao === undefined) continue;
      const q = new PgDialect().sqlToQuery(
        sqlEstoqueAtual(
          { estoques: null, permissoes: new Set(['produtos.ver_custo']) },
          { ...filtrosEstoqueAtualSchema.parse(caso.query), fuso: FUSO },
          { limite: 1 },
        ),
      );
      const { rows } = await c.query<{ recente: boolean }>(q.sql, q.params as unknown[]);
      if (rows[0]?.recente !== caso.projecao)
        throw new Error(
          `${caso.nome}: a consulta vai pela ${rows[0]?.recente ? 'projeção' : 'soma'}, não pelo caminho do rótulo`,
        );
    }
    await c.end();
    c = null;
    const medidas = [];
    for (const caso of casos) {
      const tempos: number[] = [];
      let linhas = 0;
      for (let i = 0; i < REPETICOES; i++) {
        const inicio = performance.now();
        const r = await amb
          .http()
          .get(`/api/relatorios/estoque-atual${caso.exportar ? '/exportar' : ''}`)
          .query(caso.exportar ? { ...caso.query, formato: 'csv' } : { ...caso.query, tamanho: '50' })
          .set({ Authorization: `Bearer ${token}` })
          .buffer(true);
        if (r.status !== 200) throw new Error(`${caso.nome}: ${r.status} ${JSON.stringify(r.body)}`);
        tempos.push(performance.now() - inicio);
        // A exportação na hora (até 50 mil linhas) devolve o CSV: as linhas menos o cabeçalho.
        linhas = caso.exportar ? r.text.trim().split('\r\n').length - 1 : r.body.total;
      }
      const medida = {
        caso: caso.nome,
        filtros: caso.query,
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
