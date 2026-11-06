import { text } from 'node:stream/consumers';
import { papelAdminSchema } from '@genesis/shared';
import { z } from 'zod';
import { validar } from '../comum/zod.js';
import { argumentos, executarCli } from './comum.js';

// Senha nunca como argumento (fica no histórico do shell e no `ps`): gerada, lida da entrada padrão
// (`--senha-stdin`) ou da variável GENESIS_ADMIN_SENHA.
const args = argumentos({
  email: { type: 'string' },
  nome: { type: 'string' },
  papel: { type: 'string', default: 'superadmin' },
  'senha-stdin': { type: 'boolean', default: false },
});

async function senhaInformada(): Promise<string | undefined> {
  if (args['senha-stdin']) return (await text(process.stdin)).split(/\r?\n/)[0];
  return process.env.GENESIS_ADMIN_SENHA || undefined;
}

await executarCli(async (s) => {
  const entrada = validar(
    z.object({
      email: z.string().trim().toLowerCase().pipe(z.email('Informe --email válido')),
      nome: z.string().trim().min(1, 'Informe --nome').max(100),
      papel: papelAdminSchema,
      senha: z.string().min(12, 'A senha do admin deve ter ao menos 12 caracteres').optional(),
    }),
    { email: args.email, nome: args.nome, papel: args.papel, senha: await senhaInformada() },
  );
  const r = await s.adminAuth.criarAdmin(entrada);
  console.log(`Admin da plataforma criado (${entrada.papel}): ${entrada.email}`);
  if (!entrada.senha) console.log(`Senha gerada (exibida só agora): ${r.senha}`);
  console.log(`Segredo TOTP: ${r.totpSegredo}`);
  console.log(`Cadastre no autenticador (2FA obrigatório): ${r.totpUri}`);
});
