import { garantirBanco, migrarControle, seedControle } from '../database/migracoes/controle.js';
import { configuracaoCli, executarCli } from './comum.js';

const config = configuracaoCli();
if (await garantirBanco(config.bancoControleUrl)) console.log('Banco de controle criado.');
const aplicadas = await migrarControle(config.bancoControleUrl, config.migracao.lockTimeout);
console.log(
  aplicadas.length
    ? `Migrações aplicadas: ${aplicadas.join(', ')}`
    : 'Banco de controle já estava atualizado.',
);
await executarCli(async (s) => {
  await seedControle(s.controle, s.servidores);
  console.log('Plano padrão e servidor de banco padrão conferidos.');
});
