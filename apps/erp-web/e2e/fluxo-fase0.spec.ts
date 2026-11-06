import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

interface Estado {
  email: string;
  senha: string;
  totp: string;
}

const estado = (): Estado => JSON.parse(readFileSync(process.env.E2E_ESTADO!, 'utf8')) as Estado;

/** TOTP (RFC 6238: SHA-1, 6 dígitos, 30 s), o mesmo que o autenticador do celular gera. */
function codigoTotp(segredoBase32: string, agora = Date.now()): string {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of segredoBase32.replace(/=+$/, '').toUpperCase()) {
    bits += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  }
  const chave = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(agora / 30_000)));
  const h = createHmac('sha1', chave).update(contador).digest();
  const deslocamento = h[h.length - 1]! & 0xf;
  const n = (h.readUInt32BE(deslocamento) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

async function escolher(page: Page, rotulo: string, opcao: string) {
  await page.getByRole('combobox', { name: new RegExp(`^${rotulo}`) }).click();
  await page.getByRole('option', { name: opcao }).click();
}

const NOVA_SENHA_ADMIN = 'SenhaNova123';

async function entrarNoErp(p: Page, codigo: string, senha: string) {
  await p.goto('/login');
  await p.getByRole('textbox', { name: 'Código da empresa' }).fill(codigo);
  await p.getByRole('textbox', { name: 'Usuário' }).fill('admin');
  await p.getByLabel(/^Senha/).fill(senha);
  await p.getByRole('button', { name: 'Entrar' }).click();
}

test('Fase 0 de ponta a ponta: painel, empresa, login no ERP, usuários e suspensão', async ({
  page,
  browser,
}) => {
  const admin = estado();
  let codigo = '';
  let senhaProvisoria = '';

  await test.step('painel: login com senha e código do autenticador (2FA)', async () => {
    await page.goto('/plataforma/login');
    await page.getByLabel('E-mail').fill(admin.email);
    await page.getByLabel('Senha').fill(admin.senha);
    await page.getByRole('group', { name: 'Código do autenticador' }).getByRole('textbox').first().click();
    await page.keyboard.type(codigoTotp(admin.totp));
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Empresas' })).toBeVisible();
  });

  await test.step('painel: cria a empresa e mostra a senha provisória do admin uma vez', async () => {
    await page.getByRole('link', { name: 'Nova empresa' }).click();
    await page.getByLabel('Razão social').fill('Ice Beer Comércio de Bebidas Ltda');
    await page.getByLabel('Nome fantasia').fill('Ice Beer');
    await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const titulo = page.getByRole('heading', { name: /^Empresa \d+ criada$/ });
    await expect(titulo).toBeVisible();
    codigo = (await titulo.textContent())!.match(/\d+/)![0];
    senhaProvisoria = (await page.getByTestId('senha-provisoria-admin').textContent())!.trim();
    expect(senhaProvisoria).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  await test.step('painel: migrações em dia e planos', async () => {
    await page.getByRole('navigation', { name: 'Menu da plataforma' }).getByText('Migrações').click();
    const linha = page.getByRole('table', { name: 'Situação das empresas' }).getByRole('row', {
      name: new RegExp(codigo),
    });
    await expect(linha).toContainText('Em dia');
    await page.getByRole('navigation', { name: 'Menu da plataforma' }).getByText('Planos').click();
    await expect(page.getByRole('table', { name: 'Planos' })).toContainText('padrao');
  });

  const erp = await browser.newPage();
  await test.step('ERP: login com a senha provisória obriga a troca e abre o Início', async () => {
    await entrarNoErp(erp, codigo, senhaProvisoria);
    await erp.getByLabel(/^Senha provisória/).fill(senhaProvisoria);
    await erp.getByLabel(/^Nova senha/).fill(NOVA_SENHA_ADMIN);
    await erp.getByLabel(/^Confirmar nova senha/).fill(NOVA_SENHA_ADMIN);
    await erp.getByRole('button', { name: 'Trocar senha' }).click();
    await expect(erp.getByText(/Olá, Administrador/)).toBeVisible();
  });

  await test.step('ERP: cadastra um usuário (senha provisória gerada) e exporta a listagem', async () => {
    await erp.goto('/cadastros/usuarios');
    await erp.getByRole('link', { name: 'Novo usuário' }).click();
    // A listagem também tem um campo "Nome" (filtro): espera o formulário abrir.
    await expect(erp.getByRole('heading', { name: 'Novo usuário' })).toBeVisible();
    await erp.getByRole('textbox', { name: /^Nome/ }).fill('JOAO CAIXA');
    await erp.getByRole('textbox', { name: /^Login/ }).fill('joao');
    await escolher(erp, 'Perfil de acesso', 'Vendedor');
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp.getByTestId('senha-provisoria')).toHaveText(/^[A-Za-z0-9]{12}$/);
    await erp.keyboard.press('Escape');
    await erp.goto('/cadastros/usuarios');
    await expect(erp.getByRole('link', { name: 'JOAO CAIXA' }).first()).toBeVisible();

    await erp.getByRole('button', { name: 'Exportar' }).click();
    const download = erp.waitForEvent('download');
    await erp.getByRole('menuitem', { name: 'CSV' }).click();
    const arquivo = await download;
    expect(arquivo.suggestedFilename()).toMatch(/^Usuarios_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.csv$/);
    const conteudo = readFileSync((await arquivo.path())!, 'utf8');
    expect(conteudo).toContain('JOAO CAIXA;joao;Vendedor');
  });

  await test.step('painel: suspende com motivo; o login no ERP é recusado com o motivo', async () => {
    await page.goto(`/plataforma/empresas/${codigo}`);
    await page.getByRole('button', { name: 'Suspender' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Suspender empresa' });
    await dialogo.getByRole('button', { name: 'Suspender' }).click();
    await expect(page.getByText('Suspensa', { exact: true })).toBeVisible();

    const outra = await browser.newPage();
    await entrarNoErp(outra, codigo, NOVA_SENHA_ADMIN);
    await expect(outra.getByText(/Acesso suspenso.*Motivo: Inadimplência/)).toBeVisible();
    await outra.close();
  });

  await test.step('painel: reativa; o ERP volta a aceitar o login', async () => {
    await page.getByRole('button', { name: 'Reativar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reativar' }).click();
    await expect(page.getByText('Ativa', { exact: true })).toBeVisible();

    const outra = await browser.newPage();
    await entrarNoErp(outra, codigo, NOVA_SENHA_ADMIN);
    await expect(outra.getByText(/Olá, Administrador/)).toBeVisible();
    await outra.close();
  });
  await erp.close();
});
