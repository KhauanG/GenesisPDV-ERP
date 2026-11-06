import { criarEmpresaSchema } from '@genesis/shared';
import { validar } from '../comum/zod.js';
import { argumentos, executarCli } from './comum.js';

const args = argumentos({
  'razao-social': { type: 'string' },
  'nome-fantasia': { type: 'string' },
  cnpj: { type: 'string' },
  plano: { type: 'string', default: 'padrao' },
  regime: { type: 'string', default: 'simples_nacional' },
  codigo: { type: 'string' },
  'admin-login': { type: 'string', default: 'admin' },
  'admin-nome': { type: 'string', default: 'ADMINISTRADOR' },
  'admin-email': { type: 'string' },
  'email-responsavel': { type: 'string' },
  canario: { type: 'boolean', default: false },
});

await executarCli(async (s) => {
  const entrada = validar(criarEmpresaSchema, {
    razaoSocial: args['razao-social'],
    nomeFantasia: args['nome-fantasia'],
    cnpj: args.cnpj,
    planoCodigo: args.plano,
    regime: args.regime,
    codigo: args.codigo ? Number(args.codigo) : undefined,
    emailResponsavel: args['email-responsavel'],
    canario: args.canario,
    admin: { login: args['admin-login'], nome: args['admin-nome'], email: args['admin-email'] },
  });
  const r = await s.provisionamento.criar(entrada);
  console.log(`Empresa criada: código ${r.codigo} (banco ${r.nomeBanco})`);
  console.log(`Administrador: ${r.adminLogin}`);
  if (r.senhaProvisoria) {
    console.log(`Senha provisória (exibida só agora; troca obrigatória no 1º login): ${r.senhaProvisoria}`);
  }
});
