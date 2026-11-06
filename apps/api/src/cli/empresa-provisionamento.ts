import { argumentos, executarCli } from './comum.js';

const args = argumentos({
  codigo: { type: 'string' },
  'tentar-novamente': { type: 'boolean', default: false },
  descartar: { type: 'boolean', default: false },
  'admin-login': { type: 'string', default: 'admin' },
  'admin-nome': { type: 'string', default: 'ADMINISTRADOR' },
});

await executarCli(async (s) => {
  const codigo = Number(args.codigo);
  if (!Number.isInteger(codigo) || args['tentar-novamente'] === args.descartar) {
    console.error('Uso: empresa:provisionamento --codigo 100001 (--tentar-novamente | --descartar)');
    return 2;
  }
  if (args.descartar) {
    await s.provisionamento.descartar(codigo);
    console.log(`Provisionamento da empresa ${codigo} descartado (banco removido).`);
    return;
  }
  const r = await s.provisionamento.tentarNovamente(codigo, {
    login: args['admin-login'],
    nome: args['admin-nome'],
  });
  console.log(`Empresa ${r.codigo} ativa.`);
  if (r.senhaProvisoria)
    console.log(`Senha provisória de ${r.adminLogin} (exibida só agora): ${r.senhaProvisoria}`);
});
