/**
 * Carga da exportação de relatório em tarefa, em streaming (Fase 2, F2-B29; README da API › decisão 177). Fora do CI:
 * `pnpm --filter api carga:exportacao`. Gera a massa do F2-B28 (`gerarMassa`, 1 milhão de movimentos por padrão) num
 * ambiente descartável, com a API, a fila pg-boss e o S3 em memória no mesmo processo, e exporta o razão inteiro pelo
 * provedor de exemplo (`provedor-movimentos.ts`) em `.xlsx` e em `.csv`, pela rota de verdade (`202` → tarefa →
 * link). Mede o tempo e o **pico de heap do processo inteiro** (amostrado a cada 20 ms, com `--expose-gc` para partir
 * só do que está vivo), confere que o arquivo abre e tem o total de linhas (o `.xlsx` lido pelo leitor em streaming do
 * exceljs) e apaga os bancos no fim. Critério de pronto: pico de heap abaixo de 300 MB. Reprova também pela memória
 * fora do heap (`external`) acima de `LIMITE_EXTERNO_MB`, sem contar o arquivo que o S3 em memória guarda (até duas
 * cópias: as partes e o objeto montado no fim): é lá que a entrada do zip do exceljs acumulava a planilha sem
 * comprimir (~340 MB com 1 milhão de linhas, decisão 177), e o heap não acusa.
 *
 * Opções: `--movimentos=1000000`, `--produtos=2000`, `--semente=28`, `--saida=resultado.json`.
 */
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as esperar } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { criarAmbiente, conectar } from '../integracao/ambiente.js';
import { CHAVE_MOVIMENTOS_TESTE, provedorMovimentosTeste } from '../integracao/provedor-movimentos.js';
import { iniciarS3Falso } from '../integracao/s3-falso.js';
import { gerarMassa } from './massa-razao.js';

const argumentos = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.length ? v.join('=') : 'true'] as const;
  }),
);
const numero = (nome: string, padrao: number) => Number(argumentos.get(nome) ?? padrao);
const MOVIMENTOS = numero('movimentos', 1_000_000);
const PRODUTOS = numero('produtos', 2000);
const SEMENTE = numero('semente', 28);
const SAIDA = argumentos.get('saida');
const LIMITE_HEAP_MB = 300;
const LIMITE_EXTERNO_MB = 100;

const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;

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
      ARMAZENAMENTO_BUCKET: `genesis-carga-exp-${Date.now()}`,
    },
  });
  const resultado: Record<string, unknown> = { movimentos: MOVIMENTOS, produtos: PRODUTOS, semente: SEMENTE };
  try {
    await amb.servicos.armazenamento.garantirBucket();
    await amb.servicos.fila.iniciar();
    amb.servicos.exportacoes.registrar(provedorMovimentosTeste());
    const empresa = await amb.criarEmpresa();
    console.log(`Empresa de carga: ${empresa.nomeBanco}`);
    const c = await conectar(empresa.nomeBanco);
    const tMassa = Date.now();
    let massa;
    try {
      massa = await gerarMassa(empresa.nomeBanco, c, {
        movimentos: MOVIMENTOS,
        produtos: PRODUTOS,
        semente: SEMENTE,
        aoProgredir: (n) => console.log(`  ${n.toLocaleString('pt-BR')} movimentos`),
      });
    } finally {
      await c.end();
    }
    resultado.massa = { movimentos: massa.movimentos, geracao_s: Math.round((Date.now() - tMassa) / 1000) };
    console.log(`Massa: ${massa.movimentos.toLocaleString('pt-BR')} movimentos`);
    const token = await amb.entrar(empresa.codigo, 'admin', empresa.senha);

    const medidas = [];
    for (const formato of ['xlsx', 'csv'] as const) {
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
        .get(`/api/relatorios/${CHAVE_MOVIMENTOS_TESTE}/exportar`)
        .query({ formato })
        .set({ Authorization: `Bearer ${token}` });
      if (pedido.status !== 202)
        throw new Error(`esperava 202: ${pedido.status} ${JSON.stringify(pedido.body)}`);
      const pedidoMs = Date.now() - inicio;
      let tarefa;
      for (;;) {
        const r = await amb
          .http()
          .get(`/api/tarefas/${pedido.body.tarefaId}`)
          .set({ Authorization: `Bearer ${token}` });
        tarefa = r.body;
        if (tarefa.status === 'concluida' || tarefa.status === 'falhou') break;
        await esperar(250);
      }
      clearInterval(amostra);
      const segundos = (Date.now() - inicio) / 1000;
      if (tarefa.status !== 'concluida') throw new Error(`a tarefa falhou: ${tarefa.erro}`);
      const partes = s3.pedidos.filter((p) => p.metodo === 'PUT' && p.consulta.has('partNumber')).length;
      const resposta = await fetch(tarefa.download);
      const conteudo = Buffer.from(await resposta.arrayBuffer());
      const conferido =
        formato === 'xlsx'
          ? await contarXlsx(conteudo)
          : { linhas: conteudo.toString('utf8').split('\r\n').filter(Boolean).length - 1, abas: 1 };
      // O que o gerador e o envio seguraram fora do heap: o pico menos o de partida e as duas cópias do S3 em memória.
      const externoGerador = Math.max(0, picoExterno - externoInicial - 2 * conteudo.length);
      const medida = {
        formato,
        linhas_pedido: pedido.body.linhas,
        linhas_tarefa: tarefa.resultado.linhas,
        linhas_arquivo: conferido.linhas,
        abas: conferido.abas,
        tamanho: `${mb(conteudo.length)} MB`,
        partes_multipart_acumuladas: partes,
        pedido_ms: pedidoMs,
        segundos: Math.round(segundos * 10) / 10,
        linhas_por_s: Math.round(conferido.linhas / segundos),
        heap_inicial: `${mb(heapInicial)} MB`,
        heap_pico: `${mb(picoHeap)} MB`,
        // Buffers fora do heap: as partes do envio e o arquivo guardado no S3 em memória (mesmo processo).
        externo_pico: `${mb(picoExterno)} MB`,
        externo_sem_s3: `${mb(externoGerador)} MB`,
        // O RSS de partida já traz a geração da massa (o processo não devolve a memória ao sistema).
        rss_inicial: `${mb(rssInicial)} MB`,
        rss_pico: `${mb(picoRss)} MB`,
      };
      console.log(JSON.stringify(medida));
      medidas.push(medida);
      if (conferido.linhas !== massa.movimentos || tarefa.resultado.linhas !== massa.movimentos) {
        throw new Error(`o arquivo não tem o total de linhas (${conferido.linhas} de ${massa.movimentos})`);
      }
      if (mb(picoHeap) >= LIMITE_HEAP_MB) {
        throw new Error(`pico de heap ${mb(picoHeap)} MB passou de ${LIMITE_HEAP_MB} MB`);
      }
      if (mb(externoGerador) >= LIMITE_EXTERNO_MB) {
        throw new Error(
          `fora do heap ${mb(externoGerador)} MB (sem o S3 em memória) passou de ${LIMITE_EXTERNO_MB} MB`,
        );
      }
      s3.objetos.clear();
    }
    Object.assign(resultado, { medidas, total_s: Math.round((Date.now() - t0) / 1000) });
    if (SAIDA) writeFileSync(SAIDA, JSON.stringify(resultado, null, 2));
  } finally {
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
