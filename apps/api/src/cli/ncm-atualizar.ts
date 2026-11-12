import { createReadStream } from 'node:fs';
import {
  AtualizacaoNcm,
  baixarTabelaNcm,
  ErroTabelaNcm,
  interpretarTabelaNcm,
  lerAteLimite,
} from '../plataforma/ncm-atualizacao.js';
import { argumentos, codigosEmpresas, executarCli } from './comum.js';

const args = argumentos({
  arquivo: { type: 'string' },
  url: { type: 'string' },
  empresas: { type: 'string' },
  simular: { type: 'boolean', default: false },
  'permitir-encerramento-em-massa': { type: 'boolean', default: false },
});

/**
 * `ncm-atualizar` (F2-B46, decisão 193): baixa a tabela NCM vigente do Siscomex (`SISCOMEX_NCM_URL`, ou `--url`), ou
 * lê `--arquivo <caminho>` (`--arquivo -` = entrada padrão: o JSON baixado no navegador), confere o formato e aplica
 * em cada empresa com o relatório. `--simular` mostra o mesmo relatório sem gravar nada.
 */
await executarCli(async (s) => {
  // Antes do download: o `--empresas` com um código inválido recusa o comando (nunca vira "todas as empresas").
  const codigos = codigosEmpresas(args.empresas);
  const origem = args.arquivo ? 'arquivo' : (args.url ?? s.config.siscomexNcmUrl);
  let tabela;
  try {
    const bytes = args.arquivo
      ? await lerAteLimite(args.arquivo === '-' ? process.stdin : createReadStream(args.arquivo))
      : await baixarTabelaNcm(origem);
    tabela = interpretarTabelaNcm(bytes);
  } catch (e) {
    if (!(e instanceof ErroTabelaNcm)) throw e;
    console.error(`Tabela NCM recusada, nada foi aplicado: ${e.message}`);
    return 1;
  }
  console.log(
    `Tabela NCM de ${tabela.vigenteEm}${tabela.ato ? ` (${tabela.ato})` : ''}: ${tabela.ncms.length} NCMs, sha256 ${tabela.sha256.slice(0, 16)}…`,
  );
  let r;
  try {
    r = await new AtualizacaoNcm(s.controle, s.servidores, s.migrador.executadoPor).executar(tabela, {
      codigos,
      simular: args.simular,
      permitirEncerramentoEmMassa: args['permitir-encerramento-em-massa'],
      origem,
    });
  } catch (e) {
    if (!(e instanceof ErroTabelaNcm)) throw e;
    console.error(`Tabela NCM recusada, nada foi aplicado: ${e.message}`);
    return 1;
  }
  if (r.simulacao) console.log('SIMULAÇÃO: nada foi gravado.');
  if (!r.empresas.length) console.log('Nenhuma empresa ativa ou suspensa para atualizar.');
  for (const e of r.empresas) {
    if (e.status !== 'ok') {
      console.log(`${e.codigo}: ${e.status} – ${e.erro}`);
      continue;
    }
    console.log(
      `${e.codigo}: ok – ${e.incluidos} incluído(s), ${e.alterados} alterado(s), ${e.encerrados} encerrado(s); ` +
        `CEST: ${e.cests} linha(s); ${e.terminais} terminal(is) vão baixar a tabela de novo`,
    );
    const d = e.diferenca!;
    if (d.incluidos.length)
      console.log(
        `  incluídos: ${d.incluidos.slice(0, 50).join(', ')}${d.incluidos.length > 50 ? ', …' : ''}`,
      );
    if (d.encerrados.length)
      console.log(
        `  encerrados: ${d.encerrados.slice(0, 50).join(', ')}${d.encerrados.length > 50 ? ', …' : ''}`,
      );
    if (e.produtosInvalidados) {
      console.log(
        `  ${e.produtosInvalidados} produto(s) ficam com NCM inválido (Relatórios › NCMs inválidos):`,
      );
      for (const p of e.produtos ?? []) console.log(`    ${p.codigo} ${p.nome} (NCM ${p.ncm})`);
      if (e.produtosInvalidados > (e.produtos?.length ?? 0)) console.log('    …');
    }
  }
  console.log(
    `Falhas: ${r.falhas}. Empresa com falha ficou como estava (rode de novo depois de ver o erro).`,
  );
  return r.falhas > 0 ? 1 : 0;
});
