import { writeFileSync } from 'node:fs';
import { and, inArray, isNull } from 'drizzle-orm';
import { empresas } from '../database/controle/schema.js';
import { garantirNomeBancoEmpresa } from '../database/nomes-bancos.js';
import { linhasComCadeiaQuebrada } from '../estoques/cadeia.js';
import type { ChaveSaldo } from '../estoques/movimentos.js';
import { preencherSeqLancamento, temSeqLancamento } from '../estoques/seq-lancamento.js';
import { argumentos, executarCli } from './comum.js';

const args = argumentos({
  empresas: { type: 'string' },
  saida: { type: 'string' },
});

interface QuebraRelatada extends ChaveSaldo {
  empresa: number;
  movimentos: number;
  posicao: number;
  movimentoId: string;
  saldoEsperado: string;
  saldoAnterior: string;
}

/**
 * `db:preencher-seq-lancamento` (Fase 2, F2-B2; decisão 146 do README): dá a ordem de lançamento aos movimentos que
 * ainda não têm e garante o índice da linha, empresa por empresa, com a role dona. O `db:migrate:empresas` já faz isso
 * sozinho antes da `0017_movimentos_seq_b`; à mão, serve para repetir depois de uma falha dela ou para tirar o
 * relatório das quebras (`--saida=quebras.csv`). O relatório é o **estado do razão** (`linhasComCadeiaQuebrada`, a
 * primeira quebra de cada linha na ordem gravada), não só o que esta passada preencheu: depois da migração, sem nada a
 * preencher, ele ainda lista as linhas quebradas. Quebra não é falha (sai com 0); empresa sem a 0016 é pulada.
 */
await executarCli(async (s) => {
  const codigos = args.empresas
    ?.split(',')
    .map((c) => Number(c.trim()))
    .filter(Number.isInteger);
  const condicoes = [inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)];
  if (codigos?.length) condicoes.push(inArray(empresas.codigo, codigos));
  const lista = await s.controle.db
    .select()
    .from(empresas)
    .where(and(...condicoes));
  const quebras: QuebraRelatada[] = [];
  let falhas = 0;
  for (const e of lista) {
    try {
      garantirNomeBancoEmpresa(e.nomeBanco, e.codigo);
      const c = await s.servidores.conectar(e.servidorBancoId, e.nomeBanco, 'genesis_seq_lancamento');
      try {
        if (!(await temSeqLancamento(c))) {
          console.log(`${e.codigo}: sem a migração 0016_movimentos_seq_a (rode db:migrate:empresas)`);
          continue;
        }
        const r = await preencherSeqLancamento(c);
        const doBanco = await linhasComCadeiaQuebrada(c);
        console.log(
          `${e.codigo}: ${r.preenchidos} movimento(s) preenchido(s) em ${r.linhas} linha(s) (${r.quebras.length} quebra(s) nesta passada); índice ${r.indice}; ${doBanco.length} linha(s) com a cadeia quebrada`,
        );
        for (const q of doBanco) {
          quebras.push({ ...q, empresa: e.codigo });
          console.log(
            `  estoque ${q.estoqueId} produto ${q.produtoId}${q.variacaoId ? ` variação ${q.variacaoId}` : ''}: movimento ${q.posicao} de ${q.movimentos} (${q.movimentoId}) começa em ${q.saldoAnterior}, esperado ${q.saldoEsperado}`,
          );
        }
      } finally {
        await c.end();
      }
    } catch (erro) {
      falhas++;
      console.error(`${e.codigo}: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }
  if (args.saida) {
    const cabecalho =
      'empresa;estoque_id;produto_id;variacao_id;tipo_estoque_id;movimentos;posicao;movimento_id;saldo_esperado;saldo_anterior';
    const linhas = quebras.map((q) =>
      [
        q.empresa,
        q.estoqueId,
        q.produtoId,
        q.variacaoId ?? '',
        q.tipoEstoqueId,
        q.movimentos,
        q.posicao,
        q.movimentoId,
        q.saldoEsperado,
        q.saldoAnterior,
      ].join(';'),
    );
    writeFileSync(args.saida, `${[cabecalho, ...linhas].join('\n')}\n`, 'utf8');
    console.log(`Relatório: ${args.saida} (${quebras.length} linha(s) com a cadeia quebrada)`);
  }
  return falhas ? 1 : 0;
});
