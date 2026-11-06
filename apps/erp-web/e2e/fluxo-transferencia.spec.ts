import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Transferência CD → loja com divergência, de ponta a ponta (Fase 2, F2-B27; ERP 13.7): empresa nova → pela API, a
 * Loja 2, o CD (estoque sem loja), a cerveja com o fardo de 12 de compra e 100 unidades no CD → no ERP, a transferência
 * nova do CD para a Loja 2 com 5 fardos (60 un), "Salvar e enviar", o romaneio pela impressão do navegador (empresa,
 * origem, destino, "5 FD" e as assinaturas), o recebimento na loja com 58 (2 a menor: "Recebida com divergência") e o
 * tratamento da diferença como perda → "Recebida". Os saldos no fim: 40 no CD (o retorno e a baixa da perda se anulam) e
 * 58 na Loja 2, sem nada em trânsito nem a tratar. Tudo pelo ERP, sem tocar na API depois da preparação. As telas vão para
 * `E2E_TELAS` (padrão `test-results/telas-transferencia`).
 */
interface Estado {
  email: string;
  senha: string;
  totp: string;
}

const estado = (): Estado => JSON.parse(readFileSync(process.env.E2E_ESTADO!, 'utf8')) as Estado;
const API = `http://127.0.0.1:${process.env.E2E_PORTA_API}`;
const TELAS = process.env.E2E_TELAS ?? join(process.cwd(), 'test-results', 'telas-transferencia');
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

test('transferência CD → loja com divergência: enviar, romaneio, receber a menor e tratar como perda', async ({
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
  // A impressão do navegador não abre a caixa de diálogo no teste (o romaneio a chama sozinho).
  await erp.context().addInitScript(() => {
    window.print = () => undefined;
  });
  await test.step('ERP: primeiro acesso', async () => {
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
  });

  let h: Record<string, string> = {};
  let cd = '';
  let estoqueLoja2 = '';
  let pilsen = '';
  await test.step('API: a Loja 2, o CD, a cerveja com o fardo de 12 e 100 unidades no CD', async () => {
    h = { Authorization: `Bearer ${await apiLogin(request, codigo)}` };
    const loja = await request.post(`${API}/api/lojas`, {
      headers: h,
      data: {
        nome: 'Loja 2 - Bairro',
        razaoSocial: 'Ice Beer Comércio de Bebidas Ltda',
        nomeFantasia: 'Ice Beer Bairro',
        cnpj: '11.222.333/0002-62',
        cep: '86020-000',
        logradouro: 'Rua das Flores',
        numero: '10',
        bairro: 'Centro',
        municipioIbge: 4113700,
        uf: 'PR',
        nomeEstoque: 'Estoque Loja 2',
      },
    });
    expect(loja.status(), await loja.text()).toBe(201);
    estoqueLoja2 = ((await loja.json()) as { estoqueId: string }).estoqueId;
    const e = await request.post(`${API}/api/estoques`, {
      headers: h,
      data: { nome: 'CD - Estoque Ice Beer', tipo: 'deposito', endereco: 'Galpão 3, Rod. PR-445 km 2' },
    });
    expect(e.status(), await e.text()).toBe(201);
    cd = ((await e.json()) as { id: string }).id;
    const unidades = (await (
      await request.get(`${API}/api/referencias/unidades`, { headers: h })
    ).json()) as Array<{ id: string; sigla: string }>;
    const un = unidades.find((u) => u.sigla === 'UN')!.id;
    const fd = unidades.find((u) => u.sigla === 'FD')!.id;
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
    const a = await request.post(`${API}/api/acertos`, {
      headers: h,
      data: {
        estoqueId: cd,
        motivo: 'Saldo inicial do CD',
        dataContagem: new Date().toISOString(),
        tipoAjuste: 'entrada',
        itens: [{ produtoId: pilsen, quantidade: '100', custoUnitario: '4' }],
      },
    });
    expect(a.status(), await a.text()).toBe(201);
    const acerto = (await a.json()) as { id: string; versao: number };
    const ef = await request.post(`${API}/api/acertos/${acerto.id}/efetivar`, {
      headers: h,
      data: { versao: acerto.versao },
    });
    expect(ef.status(), await ef.text()).toBe(200);
  });

  await test.step('o CD monta a transferência e envia 5 fardos para a Loja 2', async () => {
    await erp.goto('/estoque/transferencias');
    await erp.getByRole('link', { name: /Nova transferência/ }).click();
    await expect(erp.getByRole('heading', { name: 'Nova transferência' })).toBeVisible();
    await escolher(erp, /^Estoque de origem/, 'CD - Estoque Ice Beer');
    await escolher(erp, /^Destino/, /Estoque Loja 2/);
    await erp.getByRole('textbox', { name: /^Motivo/ }).fill('Reposição semanal');
    const produto = erp.getByRole('combobox', {
      name: 'Produto ou código de barras da linha 1',
      exact: true,
    });
    await produto.click();
    await produto.fill('pilsen');
    await erp.getByRole('option', { name: /\d+ - CERV PILSEN LATA 350ML$/ }).click();
    await erp.getByRole('textbox', { name: 'Quant. da linha 1', exact: true }).fill('60');
    const grade = erp.getByRole('table', { name: 'Itens da transferência' });
    await expect(grade).toContainText('5 FD');
    await expect(grade).toContainText('100');
    await tela(erp, '01-transferencia-rascunho');
    await erp.getByRole('button', { name: 'Salvar e enviar' }).click();
    await erp
      .getByRole('dialog', { name: 'Enviar a transferência' })
      .getByRole('button', { name: 'Enviar' })
      .click();
    await expect(erp.getByText(/enviada: em trânsito até o destino receber/)).toBeVisible();
    await expect(erp).toHaveURL(/\/estoque\/transferencias\/[0-9a-f-]{36}$/);
    await expect(erp.getByText(/Em trânsito: a mercadoria saiu da origem/)).toBeVisible();
    await tela(erp, '02-transferencia-em-transito');
  });

  await test.step('o romaneio pela impressão do navegador', async () => {
    const [romaneio] = await Promise.all([
      erp.waitForEvent('popup'),
      erp.getByRole('button', { name: 'Romaneio' }).click(),
    ]);
    await expect(
      romaneio.getByRole('heading', { name: /Romaneio de transferência Nº \d+ – Em trânsito/ }),
    ).toBeVisible();
    await expect(romaneio.getByTestId('romaneio-empresa')).toContainText('CNPJ 11.222.333/0001-81');
    await expect(romaneio.getByTestId('romaneio-origem')).toContainText('Galpão 3, Rod. PR-445 km 2');
    await expect(romaneio.getByTestId('romaneio-destino')).toContainText('Loja: Loja 2 - Bairro');
    const itens = romaneio.getByRole('table', { name: 'Itens do romaneio' });
    await expect(itens).toContainText('FD × 12');
    await expect(itens).toContainText('5 FD');
    await expect(itens).toContainText('60 UN');
    await expect(romaneio.getByTestId('romaneio-assinaturas')).toContainText('Recebido e conferido por');
    await tela(romaneio, '03-romaneio');
    await romaneio.close();
  });

  await test.step('a loja recebe 58 de 60: recebida com divergência', async () => {
    await erp.getByRole('button', { name: 'Receber', exact: true }).click();
    const modal = erp.getByRole('dialog', { name: /Receber a transferência Nº \d+/ });
    const recebida = modal.getByRole('textbox', { name: 'Recebida da linha 1', exact: true });
    await recebida.fill('58');
    await expect(modal.getByTestId('aviso-divergencia')).toContainText('1 item(ns) com diferença');
    await tela(erp, '04-conferencia');
    await modal.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await expect(erp.getByText(/recebida com divergência: trate a diferença/)).toBeVisible();
    const grade = erp.getByRole('table', { name: 'Itens da transferência' });
    await expect(grade).toContainText('A tratar');
    await tela(erp, '05-recebida-divergencia');
  });

  await test.step('a diferença tratada como perda: recebida', async () => {
    await erp.getByRole('button', { name: 'Tratar diferença' }).click();
    const modal = erp.getByRole('dialog', { name: /Tratar a diferença/ });
    await modal.getByRole('combobox', { name: 'Tratamento da linha 1' }).selectOption('perda');
    await modal.getByRole('button', { name: 'Confirmar tratamento' }).click();
    await expect(erp.getByText(/Diferença tratada: transferência Nº \d+ recebida/)).toBeVisible();
    await expect(erp.getByRole('table', { name: 'Itens da transferência' })).toContainText(
      'Baixar como perda',
    );
    await tela(erp, '06-recebida');
  });

  await test.step('os saldos: 40 no CD e 58 na Loja 2, nada em trânsito nem a tratar', async () => {
    const r = await request.get(`${API}/api/produtos/${pilsen}/saldos`, { headers: h });
    expect(r.ok()).toBe(true);
    const saldos = (
      (await r.json()) as {
        saldos: Array<{
          estoqueId: string;
          quantidade: string;
          emTransito: string;
          divergenciaATratar: string;
        }>;
      }
    ).saldos;
    const de = (id: string) => saldos.find((s) => s.estoqueId === id)!;
    expect(de(cd)).toMatchObject({ quantidade: '40.000', emTransito: '0.000', divergenciaATratar: '0.000' });
    expect(de(estoqueLoja2)).toMatchObject({ quantidade: '58.000', emTransito: '0.000' });
    await erp.goto('/estoque/transferencias');
    await expect(erp.getByRole('cell', { name: 'Recebida', exact: true })).toBeVisible();
    await tela(erp, '07-listagem');
  });

  await erp.close();
});
