import { writeFileSync } from 'node:fs';
import { and, inArray, isNull } from 'drizzle-orm';
import { empresas } from '../database/controle/schema.js';
import { garantirNomeBancoEmpresa } from '../database/nomes-bancos.js';
import {
  corrigirDivergencias,
  prontoParaRecalcular,
  projecaoIdentica,
  resolverAlertaSaldoDivergente,
  resolverAlertasCadeia,
  verificarSaldos,
  type RelatorioRecalculo,
} from '../estoques/recalcular.js';
import { argumentos, executarCli } from './comum.js';

const args = argumentos({
  empresa: { type: 'string' },
  todas: { type: 'boolean', default: false },
  estoque: { type: 'string' },
  produto: { type: 'string' },
  corrigir: { type: 'boolean', default: false },
  saida: { type: 'string' },
});

/** Linhas de divergência mostradas no terminal por empresa (a lista inteira vai para o `--saida`). */
const NO_TERMINAL = 30;

const CABECALHO = [
  'empresa',
  'situacao',
  'estoque_id',
  'produto_id',
  'variacao_id',
  'tipo_estoque_id',
  'campo',
  'gravado',
  'recalculado',
  'diferenca',
  'movimentos',
  'primeiro_movimento_divergente',
  'posicao_movimento_divergente',
  'quebras_cadeia',
  'primeira_quebra_movimento',
  'primeira_quebra_posicao',
  'lote_id',
].join(';');

/** Uma linha do CSV por campo divergente (e uma por linha só com o razão inconsistente, ou por custo de produto). */
function linhasCsv(codigo: number, r: RelatorioRecalculo): string[] {
  const linhas: string[] = [];
  const csv = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  for (const d of r.divergencias) {
    for (const c of d.campos) {
      linhas.push(
        [
          codigo,
          d.situacao,
          d.estoqueId,
          d.produtoId,
          d.variacaoId,
          d.tipoEstoqueId,
          c.campo,
          c.gravado,
          c.recalculado,
          c.diferenca,
          d.recalculado.movimentos,
          d.razao?.primeiroMovimentoDivergente?.movimentoId,
          d.razao?.primeiroMovimentoDivergente?.posicao,
          d.razao?.quebras ?? 0,
          d.razao?.primeiraQuebra?.movimentoId,
          d.razao?.primeiraQuebra?.posicao,
          c.loteId,
        ]
          .map(csv)
          .join(';'),
      );
    }
  }
  for (const i of r.razaoInconsistente) {
    linhas.push(
      [
        codigo,
        'razao_inconsistente',
        i.estoqueId,
        i.produtoId,
        i.variacaoId,
        i.tipoEstoqueId,
        '',
        '',
        '',
        '',
        i.movimentos,
        i.primeiroMovimentoDivergente?.movimentoId,
        i.primeiroMovimentoDivergente?.posicao,
        i.quebras,
        i.primeiraQuebra?.movimentoId,
        i.primeiraQuebra?.posicao,
        '',
      ]
        .map(csv)
        .join(';'),
    );
  }
  for (const p of r.custoProdutos) {
    linhas.push(
      [
        codigo,
        'custo_medio_produto',
        '',
        p.produtoId,
        '',
        '',
        'produtos.custo_medio',
        p.gravado,
        p.recalculado,
        p.diferenca,
      ]
        .map(csv)
        .join(';'),
    );
  }
  return linhas;
}

function imprimir(codigo: number, r: RelatorioRecalculo): void {
  const base = `${r.linhas} linha(s) de saldo, ${r.movimentos} movimento(s)`;
  if (projecaoIdentica(r)) console.log(`${codigo}: idêntico (${base})`);
  else {
    console.log(
      `${codigo}: ${r.divergencias.length} linha(s) de saldo e ${r.custoProdutos.length} custo(s) médio(s) de produto divergentes (${base})`,
    );
  }
  for (const d of r.divergencias.slice(0, NO_TERMINAL)) {
    const campos = d.campos
      .map(
        (c) =>
          `${c.campo}${c.loteId ? ` ${c.loteId}` : ''} ${c.gravado ?? '—'} → ${c.recalculado ?? '—'}${c.diferenca ? ` (${c.diferenca})` : ''}`,
      )
      .join('; ');
    const desvio = d.razao?.primeiroMovimentoDivergente
      ? `; primeiro movimento divergente: ${d.razao.primeiroMovimentoDivergente.posicao}º (${d.razao.primeiroMovimentoDivergente.movimentoId})`
      : '';
    console.log(
      `  [${d.situacao}] estoque ${d.estoqueId} produto ${d.produtoId}${d.variacaoId ? ` variação ${d.variacaoId}` : ''}: ${campos}${desvio}`,
    );
  }
  if (r.divergencias.length > NO_TERMINAL) {
    console.log(`  … e mais ${r.divergencias.length - NO_TERMINAL} (lista inteira com --saida)`);
  }
  for (const p of r.custoProdutos.slice(0, NO_TERMINAL)) {
    console.log(`  [custo do produto] ${p.produtoId}: ${p.gravado} → ${p.recalculado} (${p.diferenca})`);
  }
  if (r.razaoInconsistente.length) {
    console.log(
      `  aviso: ${r.razaoInconsistente.length} linha(s) com a projeção certa e o razão inconsistente em si (cadeia quebrada ou movimento que o replay não repete; histórico, o razão não é alterado)`,
    );
  }
}

/**
 * `db:recalcular-saldos` (Fase 2, F2-B3; README da API › decisões 147 e 151): refaz `saldos_estoque` (desde o F2-B6
 * também `saldos_lote` e a última compra) e confere `produtos.custo_medio` pelo razão, empresa por empresa, com a role
 * dona, como o `db:migrate:empresas`. Sem `--corrigir`, só relata (código de saída 2 se algo diverge); com
 * `--corrigir`, regrava as linhas divergentes sob a trava 7300001, em blocos, sem alterar movimento, e a versão das
 * linhas sobe (o saldo certo desce ao PDV); depois resolve os alertas `RAZAO_CADEIA_QUEBRADA` das linhas
 * conferidas. Rodar de novo sem `--corrigir` confere que ficou idêntico; a conferência idêntica da empresa inteira
 * (sem `--estoque`/`--produto`) também resolve o `RAZAO_SALDO_DIVERGENTE` aberto pela verificação periódica. Falha de
 * uma empresa não impede as outras (código 1 no fim).
 */
await executarCli(async (s) => {
  if (Boolean(args.empresa) === args.todas) {
    throw new Error('Informe --empresa=<código>[,<código>…] ou --todas (um dos dois)');
  }
  const codigos = args.empresa
    ?.split(',')
    .map((c) => Number(c.trim()))
    .filter(Number.isInteger);
  if (args.empresa && !codigos?.length) throw new Error(`--empresa inválido: ${args.empresa}`);
  const filtro = { estoqueId: args.estoque ?? null, produtoId: args.produto ?? null };
  const condicoes = [inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)];
  if (codigos?.length) condicoes.push(inArray(empresas.codigo, codigos));
  const lista = await s.controle.db
    .select()
    .from(empresas)
    .where(and(...condicoes));
  if (codigos?.length) {
    const achados = new Set(lista.map((e) => e.codigo));
    for (const c of codigos) if (!achados.has(c)) console.error(`${c}: empresa não encontrada (ou inativa)`);
  }
  const csv: string[] = [];
  let falhas = codigos?.length ? codigos.length - lista.length : 0;
  let divergentes = 0;
  for (const e of lista) {
    try {
      garantirNomeBancoEmpresa(e.nomeBanco, e.codigo);
      const c = await s.servidores.conectar(e.servidorBancoId, e.nomeBanco, 'genesis_recalcular_saldos');
      try {
        const impedimento = await prontoParaRecalcular(c);
        if (impedimento) throw new Error(impedimento);
        const relatorio = await verificarSaldos(c, filtro);
        imprimir(e.codigo, relatorio);
        csv.push(...linhasCsv(e.codigo, relatorio));
        // A empresa inteira conferida e idêntica: o `RAZAO_SALDO_DIVERGENTE` aberto (da verificação periódica,
        // talvez já desligada) não vale mais. Com filtro, a conferência é parcial e não o resolve.
        if (!filtro.estoqueId && !filtro.produtoId && projecaoIdentica(relatorio)) {
          const resolvidos = await resolverAlertaSaldoDivergente(
            c,
            'Conferência do db:recalcular-saldos idêntica',
          );
          if (resolvidos) console.log(`${e.codigo}: alerta de saldo divergente do razão resolvido`);
        }
        if (!args.corrigir) {
          if (!projecaoIdentica(relatorio)) divergentes++;
          continue;
        }
        if (!projecaoIdentica(relatorio)) {
          const r = await corrigirDivergencias(c, relatorio, {
            executadoPor: `cli:${process.env.USER ?? 'desconhecido'}`,
          });
          console.log(
            `${e.codigo}: corrigidas ${r.corrigidas} linha(s) de saldo e ${r.custoProdutos} custo(s) médio(s) de produto (${r.jaCertas} já estavam certas sob a trava; ${r.transacoes} transação(ões)); rode de novo sem --corrigir para conferir`,
          );
        }
        const resolvidos = await resolverAlertasCadeia(c, filtro);
        if (resolvidos) console.log(`${e.codigo}: ${resolvidos} alerta(s) de cadeia quebrada resolvido(s)`);
      } finally {
        await c.end();
      }
    } catch (erro) {
      falhas++;
      console.error(`${e.codigo}: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }
  if (args.saida) {
    writeFileSync(args.saida, `${[CABECALHO, ...csv].join('\n')}\n`, 'utf8');
    console.log(`Relatório: ${args.saida} (${csv.length} linha(s))`);
  }
  return falhas ? 1 : divergentes ? 2 : 0;
});
