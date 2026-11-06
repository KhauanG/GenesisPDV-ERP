import { posMigracaoSemAdmin } from '../plataforma/provisionamento.js';
import { argumentos, executarCli } from './comum.js';

const args = argumentos({
  empresas: { type: 'string' },
  lote: { type: 'string' },
  'parar-no-primeiro-erro': { type: 'boolean', default: false },
});

await executarCli(async (s) => {
  const codigos = args.empresas
    ?.split(',')
    .map((c) => Number(c.trim()))
    .filter(Number.isInteger);
  const r = await s.migrador.migrarTodas({
    codigos,
    lote: args.lote ? Number(args.lote) : undefined,
    pararNoPrimeiroErro: args['parar-no-primeiro-erro'],
    posMigracao: posMigracaoSemAdmin(s.controle),
  });
  for (const e of [
    ...r.canarios.map((x) => ({ ...x, canario: true })),
    ...r.demais.map((x) => ({ ...x, canario: false })),
  ]) {
    const aplicadas = e.aplicadas.length ? e.aplicadas.join(', ') : '—';
    console.log(
      `${e.canario ? '[canário] ' : ''}${e.codigo}: ${e.status} (aplicadas: ${aplicadas})${e.erro ? ` – ${e.erro}` : ''}`,
    );
    for (const aviso of e.avisos ?? []) console.log(`  aviso: ${aviso}`);
  }
  if (r.interrompida) console.log('Execução interrompida (falha no canário ou --parar-no-primeiro-erro).');
  console.log(
    `Falhas: ${r.falhas}. Empresas com falha ficam em manutenção (503) até a próxima execução bem-sucedida.`,
  );
  return r.falhas > 0 ? 1 : 0;
});
