import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Recebimento manual de ponta a ponta (Fase 2, F2-B16; ERP 13.3): empresa nova → loja → pela API, o fornecedor e um
 * produto com fardo de 12 (DUN-14 de compra) → no ERP, o recebimento de um fornecedor sem nota: o código do fardo lido
 * no campo Produto preenche a embalagem e o fator, frete de R$ 12,00, um produto novo pelo "Cadastrar novo produto" do
 * próprio formulário, "Salvar e movimentar" com a pergunta do preço de custo, o espelho pela impressão do navegador e o
 * saldo de +120 com o frete rateado entre os itens. (O saldo e o preço descendo ao PDV são conferidos no teste de integração
 * `recebimento-movimentar.test.ts`, com o `/sync/pull` real.) As telas vão para `E2E_TELAS` (padrão
 * `test-results/telas-recebimento`).
 */
interface Estado {
  email: string;
  senha: string;
  totp: string;
}

const estado = (): Estado => JSON.parse(readFileSync(process.env.E2E_ESTADO!, 'utf8')) as Estado;
const API = `http://127.0.0.1:${process.env.E2E_PORTA_API}`;
const TELAS = process.env.E2E_TELAS ?? join(process.cwd(), 'test-results', 'telas-recebimento');
const SENHA = 'SenhaNova123';

function codigoTotp(segredoBase32: string, agora = Date.now()): string {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of segredoBase32.replace(/=+$/, '').toUpperCase())
    bits += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  const chave = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(agora / 30_000)));
  const h = createHmac('sha1', chave).update(contador).digest();
  const d = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(d) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test.use({ actionTimeout: 20_000 });

async function tela(page: Page, nome: string) {
  mkdirSync(TELAS, { recursive: true });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(TELAS, `${nome}.png`), fullPage: true });
}

/** Select do Mantine: abre pelo rótulo e escolhe a opção. */
async function escolher(page: Page, rotulo: RegExp, opcao: string | RegExp) {
  await page.getByRole('combobox', { name: rotulo }).first().click();
  await page
    .getByRole('option', { name: opcao, exact: typeof opcao === 'string' })
    .first()
    .click();
}

async function apiLogin(request: APIRequestContext, codigo: string): Promise<string> {
  const r = await request.post(`${API}/api/auth/login`, {
    data: { codigoEmpresa: codigo, login: 'admin', senha: SENHA },
  });
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { tokenAcesso: string }).tokenAcesso;
}

test('recebimento de fardo: fornecedor sem nota, produto novo no formulário, movimentar e o espelho', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const admin = estado();
  let codigo = '';
  let senhaProvisoria = '';

  await test.step('painel: cria a empresa', async () => {
    await page.goto('/plataforma/login');
    await page.getByLabel('E-mail').fill(admin.email);
    await page.getByLabel('Senha').fill(admin.senha);
    // O painel recusa o código já usado (sem reuso de TOTP): se outro e2e entrou nesta janela de 30 s, espera a
    // próxima.
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    await page.getByRole('group', { name: 'Código do autenticador' }).getByRole('textbox').first().click();
    await page.keyboard.type(codigoTotp(admin.totp));
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Empresas' })).toBeVisible();
    await page.getByRole('link', { name: 'Nova empresa' }).click();
    await page.getByLabel('Razão social').fill('Ice Beer Comércio de Bebidas Ltda');
    await page.getByLabel('Nome fantasia').fill('Ice Beer');
    await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const titulo = page.getByRole('heading', { name: /^Empresa \d+ criada$/ });
    await expect(titulo).toBeVisible();
    codigo = (await titulo.textContent())!.match(/\d+/)![0];
    senhaProvisoria = (await page.getByTestId('senha-provisoria-admin').textContent())!.trim();
  });

  const erp = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // A impressão do navegador não abre a caixa de diálogo no teste (o espelho a chama sozinho).
  await erp.context().addInitScript(() => {
    window.print = () => undefined;
  });
  await test.step('ERP: primeiro acesso e a loja', async () => {
    await erp.goto('/login');
    await erp.getByRole('textbox', { name: 'Código da empresa' }).fill(codigo);
    await erp.getByRole('textbox', { name: 'Usuário' }).fill('admin');
    await erp.getByLabel(/^Senha/).fill(senhaProvisoria);
    await erp.getByRole('button', { name: 'Entrar' }).click();
    await erp.getByLabel(/^Senha provisória/).fill(senhaProvisoria);
    await erp.getByLabel(/^Nova senha/).fill(SENHA);
    await erp.getByLabel(/^Confirmar nova senha/).fill(SENHA);
    await erp.getByRole('button', { name: 'Trocar senha' }).click();
    await expect(erp.getByText(/Olá, Administrador/)).toBeVisible();
    await erp.goto('/cadastros/lojas/novo');
    await erp.getByRole('textbox', { name: /^Nome( \*)?$/ }).fill('Loja 1 - Ice Beer Hermes');
    await erp.getByLabel(/^CNPJ/).fill('11.222.333/0001-81');
    await erp.getByLabel(/^Razão social/).fill('Ice Beer Comércio de Bebidas Ltda');
    await erp.getByLabel(/^Fantasia/).fill('Ice Beer Hermes');
    await erp.getByLabel(/^CEP/).fill('86020-000');
    await erp.getByLabel(/^Endereço/).fill('Av. Higienópolis');
    await erp.getByLabel(/^Número/).fill('500');
    await erp.getByLabel(/^Bairro/).fill('Centro');
    await escolher(erp, /^UF/, 'PR');
    await erp.getByRole('combobox', { name: /^Cidade/ }).fill('Londrina');
    await erp.getByRole('option', { name: 'Londrina', exact: true }).click();
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp).toHaveURL(/\/cadastros\/lojas\/[0-9a-f-]{36}/);
  });

  let pilsen = '';
  let h: Record<string, string> = {};
  await test.step('API: o fornecedor e a cerveja com o fardo de 12 de compra', async () => {
    h = { Authorization: `Bearer ${await apiLogin(request, codigo)}` };
    const unidades = (await (
      await request.get(`${API}/api/referencias/unidades`, { headers: h })
    ).json()) as Array<{
      id: string;
      sigla: string;
    }>;
    const un = unidades.find((u) => u.sigla === 'UN')!.id;
    const fd = unidades.find((u) => u.sigla === 'FD')!.id;
    const f = await request.post(`${API}/api/pessoas/fornecedor-rapido`, {
      headers: h,
      data: { cpfCnpj: '44.555.666/0001-81', nome: 'Distribuidora Norte Ltda' },
    });
    expect(f.status(), await f.text()).toBe(200);
    const p = await request.post(`${API}/api/produtos`, {
      headers: h,
      data: {
        nome: 'CERV PILSEN LATA 350ML',
        unidadeId: un,
        precoCusto: '4',
        precoVenda: '7,99',
        codigosBarras: [
          { codigo: '7894900011517', principal: true },
          { codigo: '17891149101006', descricao: 'FARDO 12', unidadeId: fd, fator: '12', usaVenda: false },
        ],
      },
    });
    expect(p.status(), await p.text()).toBe(201);
    pilsen = ((await p.json()) as { id: string }).id;
  });

  await test.step('recebimento sem nota: o fardo pelo código, frete e um produto novo no formulário', async () => {
    await erp.goto('/estoque/recebimentos/novo');
    await expect(erp.getByRole('heading', { name: 'Novo recebimento manual' })).toBeVisible();
    await expect(erp.getByRole('combobox', { name: /^Estoque de destino/ })).toHaveValue(
      'Loja 1 - Ice Beer Hermes',
    );
    const fornecedor = erp.getByRole('combobox', { name: /^Fornecedor/ });
    await fornecedor.fill('norte');
    await erp.getByRole('option', { name: /Distribuidora Norte Ltda/ }).click();
    await erp.getByRole('textbox', { name: /^Cód. remessa/ }).fill('PEDIDO 4471');
    await erp.getByRole('textbox', { name: /^Frete/ }).fill('12,00');
    // O código do fardo lido no campo Produto: a embalagem e o fator vêm dele.
    const produto = erp.getByRole('combobox', {
      name: 'Produto ou código de barras da linha 1',
      exact: true,
    });
    await produto.click();
    await produto.fill('17891149101006');
    await erp.getByRole('option', { name: /\d+ - CERV PILSEN LATA 350ML$/ }).click();
    await expect(erp.getByRole('combobox', { name: 'Embalagem da linha 1' })).toHaveValue(/.+/);
    await expect(erp.getByLabel('Embalagem da linha 1')).toContainText('FD × 12');
    await erp.getByRole('textbox', { name: 'Quant. da linha 1', exact: true }).fill('10');
    await erp.getByRole('textbox', { name: 'Preço compra da linha 1', exact: true }).fill('60,00');
    const grade = erp.getByRole('table', { name: 'Itens do recebimento' });
    await expect(grade).toContainText('120 UN');
    await expect(grade).toContainText('R$ 5,1');
    // O produto que ainda não existe: cadastrado no próprio formulário.
    await erp.getByRole('button', { name: 'Cadastrar novo produto' }).click();
    const modal = erp.getByRole('dialog', { name: 'Cadastrar novo produto' });
    await modal.getByRole('textbox', { name: /^Nome/ }).fill('GELO EM CUBOS 5KG');
    await modal.getByRole('textbox', { name: /^Preço de venda/ }).fill('12,90');
    await modal.getByRole('button', { name: 'Gravar' }).click();
    await expect(erp.getByText(/Produto \d+ - GELO EM CUBOS 5KG cadastrado/)).toBeVisible();
    await expect(
      erp.getByRole('combobox', { name: 'Produto ou código de barras da linha 2', exact: true }),
    ).toHaveValue(/GELO EM CUBOS 5KG/);
    await erp.getByRole('textbox', { name: 'Quant. da linha 2', exact: true }).fill('10');
    await erp.getByRole('textbox', { name: 'Preço compra da linha 2', exact: true }).fill('6,00');
    await expect(erp.getByTestId('totais-recebimento')).toContainText('Total geral: R$ 672,00');
    await tela(erp, '01-recebimento-rascunho');
  });

  await test.step('"Salvar e movimentar" com a pergunta do preço de custo', async () => {
    await erp.getByRole('button', { name: 'Salvar e movimentar' }).click();
    await erp
      .getByRole('dialog', { name: 'Salvar e movimentar' })
      .getByRole('button', { name: 'Movimentar' })
      .click();
    const pergunta = erp.getByRole('dialog', { name: 'Atualizar o preço de custo?' });
    await expect(pergunta).toContainText('CERV PILSEN LATA 350ML');
    await tela(erp, '02-pergunta-preco-custo');
    await pergunta.getByRole('button', { name: 'Sim, atualizar' }).click();
    await expect(erp.getByText('Recebimento movimentado: estoque atualizado')).toBeVisible();
    await expect(erp).toHaveURL(/\/estoque\/recebimentos\/[0-9a-f-]{36}$/);
    await expect(erp.getByText(/o documento não muda mais \(use Estornar\)/)).toBeVisible();
    await tela(erp, '03-recebimento-movimentado');
  });

  await test.step('espelho pela impressão do navegador', async () => {
    const [espelho] = await Promise.all([
      erp.waitForEvent('popup'),
      erp.getByRole('button', { name: 'Imprimir' }).click(),
    ]);
    await expect(espelho.getByRole('heading', { name: /Espelho do recebimento Nº \d+ – Sim/ })).toBeVisible();
    await expect(espelho.getByTestId('totais-espelho')).toContainText('Total geral: R$ 672,00');
    await expect(espelho.getByText('FD × 12 (17891149101006)')).toBeVisible();
    await tela(espelho, '04-espelho');
    await espelho.close();
  });

  // O frete de R$ 12,00 foi rateado entre os dois itens pelo valor: R$ 10,91 no fardo (600 de 660) e R$ 1,09 no gelo,
  // então o fardo entra a (600,00 + 10,91) / 120 = R$ 5,0909 (o R$ 5,10 da tela era com o fardo sozinho).
  await test.step('o saldo entrou: +120 com o frete rateado e o preço de custo atualizado', async () => {
    const estoques = (await (
      await request.get(`${API}/api/estoques?situacao=ativos&tamanho=todos`, { headers: h })
    ).json()) as { itens: Array<{ id: string; nome: string }> };
    const loja1 = estoques.itens.find((e) => e.nome === 'Loja 1 - Ice Beer Hermes')!.id;
    const saldo = (await (
      await request.get(`${API}/api/saldos-estoque/itens?estoqueId=${loja1}&produtoIds=${pilsen}`, {
        headers: h,
      })
    ).json()) as Array<{ quantidade: string; custoMedio: string }>;
    expect(Number(saldo[0]!.quantidade)).toBe(120);
    expect(Number(saldo[0]!.custoMedio)).toBe(5.0909);
    const p = (await (await request.get(`${API}/api/produtos/${pilsen}`, { headers: h })).json()) as {
      precoCusto: string;
    };
    expect(Number(p.precoCusto)).toBe(5.0909);
    await erp.goto('/estoque/recebimentos');
    await expect(erp.getByRole('link', { name: 'Distribuidora Norte Ltda' })).toBeVisible();
    await tela(erp, '05-recebimentos-listagem');
  });

  await erp.close();
});
