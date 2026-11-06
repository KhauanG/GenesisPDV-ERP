import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Fase 1A de ponta a ponta (roadmap Fase 1): empresa nova → assistente da loja (CD "CD - Estoque Ice Beer" e "Loja
 * 1 - Ice Beer Hermes") → produto com fardo, atacado, grupo de preço (mix) e casco → "COMBO DE WHISKY 1L" com
 * energético alternativo → acerto de estoque efetivado → saldos → combos montáveis → dashboard → importação de
 * planilha do Nuvem3. As telas vão para `E2E_TELAS` (padrão `test-results/telas-fase1a`).
 */
interface Estado {
  email: string;
  senha: string;
  totp: string;
}

const estado = (): Estado => JSON.parse(readFileSync(process.env.E2E_ESTADO!, 'utf8')) as Estado;
const API = `http://127.0.0.1:${process.env.E2E_PORTA_API}`;
const TELAS = process.env.E2E_TELAS ?? join(process.cwd(), 'test-results', 'telas-fase1a');
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

/** Abre o bloco do acordeão (ERP 8.2) se estiver fechado. */
async function abrirBloco(page: Page, rotulo: RegExp) {
  const bloco = page.getByRole('button', { name: rotulo }).first();
  if ((await bloco.getAttribute('aria-expanded')) !== 'true') await bloco.click();
}

async function tela(page: Page, nome: string, inteira = true) {
  mkdirSync(TELAS, { recursive: true });
  // Espera a rede acalmar para a tela sair completa; `inteira = false` fotografa só a área visível (o cabeçalho
  // fixo do layout se repete no meio da página inteira quando ela foi rolada).
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(TELAS, `${nome}.png`), fullPage: inteira });
}

/** Select do Mantine: abre pelo rótulo e escolhe a opção. */
async function escolher(page: Page, rotulo: RegExp, opcao: string | RegExp, indice = 0) {
  await page.getByRole('combobox', { name: rotulo }).nth(indice).click();
  await page
    .getByRole('option', { name: opcao, exact: typeof opcao === 'string' })
    .first()
    .click();
}

/** `<SeletorProduto>`: digita a busca e escolhe pelo nome. */
async function produto(page: Page, campo: ReturnType<Page['getByRole']>, busca: string, nome: string) {
  await campo.click();
  await campo.fill(busca);
  await page
    .getByRole('option', { name: new RegExp(`\\d+ - ${nome}$`) })
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

async function preencherLoja(page: Page, d: { nome: string; cnpj: string; numero: string }) {
  await page.getByRole('textbox', { name: /^Nome( \*)?$/ }).fill(d.nome);
  await page.getByLabel(/^CNPJ/).fill(d.cnpj);
  await page.getByLabel(/^Razão social/).fill(`Ice Beer Comércio de Bebidas Ltda – ${d.nome}`);
  await page.getByLabel(/^Fantasia/).fill(d.nome);
  await page.getByLabel(/^CEP/).fill('86020-000');
  await page.getByLabel(/^Endereço/).fill('Av. Higienópolis');
  await page.getByLabel(/^Número/).fill(d.numero);
  await page.getByLabel(/^Bairro/).fill('Centro');
  await escolher(page, /^UF/, 'PR');
  await page.getByRole('combobox', { name: /^Cidade/ }).fill('Londrina');
  await page.getByRole('option', { name: 'Londrina', exact: true }).click();
}

test('Fase 1A de ponta a ponta: lojas, produtos (fardo, atacado, mix, casco, combo), acerto e combos montáveis', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  const admin = estado();
  let codigo = '';
  let senhaProvisoria = '';

  await test.step('painel: cria a empresa', async () => {
    await page.goto('/plataforma/login');
    await page.getByLabel('E-mail').fill(admin.email);
    await page.getByLabel('Senha').fill(admin.senha);
    // O painel recusa o código já usado (sem reuso de TOTP): se o outro e2e entrou nesta janela de 30 s, espera a
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

  const erp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await test.step('ERP: primeiro acesso (troca da senha) e o dashboard vazio', async () => {
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
    await expect(erp.getByText('Primeira configuração', { exact: true })).toBeVisible();
    await tela(erp, '01-dashboard-primeiro-acesso');
  });

  await test.step('assistente da loja: CD (depósito) com o estoque "CD - Estoque Ice Beer"', async () => {
    await erp.goto('/cadastros/lojas/novo');
    await expect(erp.getByText('Primeira configuração da loja')).toBeVisible();
    await preencherLoja(erp, { nome: 'CD Ice Beer', cnpj: '11.222.333/0002-62', numero: '1000' });
    await escolher(erp, /^Tipo/, 'Depósito / CD');
    await erp.getByLabel('Nome do estoque').fill('CD - Estoque Ice Beer');
    await tela(erp, '02-assistente-cd');
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp).toHaveURL(/\/cadastros\/lojas\/[0-9a-f-]{36}/);
    await expect(erp.getByText('Registro gravado')).toBeVisible();
  });

  await test.step('assistente da loja: "Loja 1 - Ice Beer Hermes" com o estoque homônimo', async () => {
    await erp.goto('/cadastros/lojas/novo');
    await preencherLoja(erp, { nome: 'Loja 1 - Ice Beer Hermes', cnpj: '11.222.333/0001-81', numero: '500' });
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp).toHaveURL(/\/cadastros\/lojas\/[0-9a-f-]{36}/);
    await erp.goto('/cadastros/lojas');
    await expect(erp.getByRole('link', { name: 'Loja 1 - Ice Beer Hermes' })).toBeVisible();
    await expect(erp.getByRole('cell', { name: 'CD - Estoque Ice Beer' })).toBeVisible();
    await tela(erp, '03-lojas-cd-e-loja1');
    await erp.goto('/estoque/locais');
    await expect(erp.getByRole('link', { name: 'Loja 1 - Ice Beer Hermes' })).toBeVisible();
  });

  // Componentes, casco e grupo de preço pela API (o formulário do produto é exercitado abaixo, no fardo e no combo).
  let un = '';
  await test.step('API: componentes do combo, casco e grupo de preço "CERVEJA 600ML" (mix)', async () => {
    const token = await apiLogin(request, codigo);
    const h = { Authorization: `Bearer ${token}` };
    const unidades = (await (
      await request.get(`${API}/api/referencias/unidades`, { headers: h })
    ).json()) as Array<{
      id: string;
      sigla: string;
    }>;
    un = unidades.find((u) => u.sigla === 'UN')!.id;
    const criar = async (d: Record<string, unknown>) => {
      const r = await request.post(`${API}/api/produtos`, { headers: h, data: { unidadeId: un, ...d } });
      expect(r.status(), await r.text()).toBe(201);
    };
    await criar({
      nome: 'WHISKY RED LABEL 1L',
      precoCusto: '80',
      precoVenda: '119,90',
      codigosBarras: [{ codigo: '7896004000015', principal: true }],
    });
    await criar({
      nome: 'ENERGETICO RED BULL 2L',
      precoCusto: '12',
      precoVenda: '19,90',
      codigosBarras: [{ codigo: '7896004000022', principal: true }],
    });
    await criar({ nome: 'ENERGETICO MONSTER 2L', precoCusto: '11', precoVenda: '18,90' });
    await criar({ nome: 'GELO DE COCO', precoCusto: '1,50', precoVenda: '3' });
    await criar({ nome: 'CASCO CERVEJA 600ML', tipo: 'vasilhame', precoCusto: '1', precoVenda: '2,50' });
    const g = await request.post(`${API}/api/grupos-preco-quantidade`, {
      headers: h,
      data: {
        nome: 'CERVEJA 600ML',
        modoPreco: 'grupo',
        faixas: [{ quantidadeInicial: '12', preco: '8,99' }],
      },
    });
    expect(g.status(), await g.text()).toBe(201);
  });

  await test.step('produto com fardo (DUN-14 × 12), atacado, mix e casco pelo formulário', async () => {
    await erp.goto('/produtos/novo');
    await erp.getByRole('textbox', { name: /^Nome/ }).first().fill('CERV ORIGINAL 600ML');
    await erp.getByLabel(/Cód. barras \(EAN-13\)/).fill('7894900011517');
    await erp.getByLabel(/^Preço de custo/).fill('6,00');
    await erp.getByLabel(/^Preço de venda/).fill('10,00');
    await abrirBloco(erp, /^Preços complementares/);
    await erp.getByLabel('Atacado', { exact: true }).fill('9,49');
    await erp.getByLabel('Qtd. mínima atacado').fill('12');
    await abrirBloco(erp, /^Embalagens e códigos adicionais/);
    await erp.getByRole('button', { name: 'Inserir código' }).click();
    await erp.getByRole('textbox', { name: 'Código', exact: true }).fill('17891149101006');
    await erp.getByRole('textbox', { name: 'Descrição', exact: true }).fill('FARDO 12');
    await erp.getByLabel('Fator', { exact: true }).fill('12');
    await erp.getByLabel('Preço da embalagem', { exact: true }).fill('108,00');
    await abrirBloco(erp, /^Outras informações/);
    await produto(
      erp,
      erp.getByRole('combobox', { name: /^Vasilhame \(casco\)/ }),
      'casco',
      'CASCO CERVEJA 600ML',
    );
    await abrirBloco(erp, /^Preço por quantidade/);
    await escolher(erp, /^Grupo de preço por quantidade/, 'CERVEJA 600ML');
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp.getByText('Registro gravado')).toBeVisible();
    await expect(erp).toHaveURL(/\/produtos\/[0-9a-f-]{36}/);
    await tela(erp, '04-produto-fardo-atacado-mix-casco');
  });

  await test.step('"COMBO DE WHISKY 1L" com energético alternativo (Monster no lugar do Red Bull)', async () => {
    await erp.goto('/produtos/novo');
    await erp.getByRole('textbox', { name: /^Nome/ }).first().fill('COMBO DE WHISKY 1L');
    await escolher(erp, /^Tipo/, 'Combo / kit');
    await erp.getByLabel(/^Preço de venda/).fill('149,90');
    await abrirBloco(erp, /^Combo \(kit\)/);
    const inserirPosicao = erp.getByRole('button', { name: 'Inserir posição' });
    await inserirPosicao.click();
    await erp.getByRole('textbox', { name: 'Posição 1', exact: true }).fill('Whisky 1L');
    await produto(
      erp,
      erp.getByRole('combobox', { name: /^Produto padrão/ }).nth(0),
      'whisky',
      'WHISKY RED LABEL 1L',
    );
    await inserirPosicao.click();
    await erp.getByRole('textbox', { name: 'Posição 2', exact: true }).fill('Energético 2L');
    await produto(
      erp,
      erp.getByRole('combobox', { name: /^Produto padrão/ }).nth(1),
      'red bull',
      'ENERGETICO RED BULL 2L',
    );
    await erp.getByRole('switch', { name: 'Permite troca' }).nth(1).check();
    await erp.getByRole('button', { name: 'Inserir alternativa' }).first().click();
    await produto(
      erp,
      erp.getByRole('combobox', { name: 'Produto alternativo' }).first(),
      'monster',
      'ENERGETICO MONSTER 2L',
    );
    await inserirPosicao.click();
    await erp.getByRole('textbox', { name: 'Posição 3', exact: true }).fill('Gelo de sabor');
    await produto(erp, erp.getByRole('combobox', { name: /^Produto padrão/ }).nth(2), 'gelo', 'GELO DE COCO');
    await erp.getByRole('textbox', { name: 'Qtd', exact: true }).nth(2).fill('2');
    await expect(erp.getByTestId('resumo-combo')).toContainText('R$ 95,00');
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp.getByText('Registro gravado')).toBeVisible();
    await expect(erp).toHaveURL(/\/produtos\/[0-9a-f-]{36}/);
    await tela(erp, '05-combo-whisky-com-alternativa');
  });

  await test.step('acerto de estoque: Entrada na Loja 1 (rascunho → efetivado)', async () => {
    await erp.goto('/estoque/acertos/novo');
    await expect(erp.getByRole('heading', { name: 'Novo acerto de estoque' })).toBeVisible();
    await escolher(erp, /^Estoque \(loja\)/, 'Loja 1 - Ice Beer Hermes');
    await erp.getByRole('combobox', { name: /^Motivo/ }).fill('Saldo inicial');
    const itens: Array<[string, string, string, string]> = [
      ['whisky', 'WHISKY RED LABEL 1L', '10', '80,00'],
      ['red bull', 'ENERGETICO RED BULL 2L', '6', '12,00'],
      ['monster', 'ENERGETICO MONSTER 2L', '4', '11,00'],
      ['gelo', 'GELO DE COCO', '20', '1,50'],
      ['original', 'CERV ORIGINAL 600ML', '120', '6,00'],
    ];
    for (const [i, [busca, nome, q, custo]] of itens.entries()) {
      if (i > 0) await erp.getByRole('button', { name: 'Inserir item' }).click();
      await produto(
        erp,
        erp.getByRole('combobox', { name: `Produto da linha ${i + 1}`, exact: true }),
        busca,
        nome,
      );
      await erp.getByRole('textbox', { name: `Quant. da linha ${i + 1}`, exact: true }).fill(q);
      await erp.getByRole('textbox', { name: `Custo unit. da linha ${i + 1}`, exact: true }).fill(custo);
    }
    await expect(erp.getByTestId('totais-acerto')).toContainText('Qtd produtos: 5');
    await erp.getByRole('button', { name: 'Salvar' }).click();
    await expect(erp).toHaveURL(/\/estoque\/acertos\/[0-9a-f-]{36}/);
    await expect(erp.getByRole('button', { name: 'Efetivar' })).toBeEnabled();
    await tela(erp, '06-acerto-rascunho');
    await erp.getByRole('button', { name: 'Efetivar' }).click();
    await expect(erp.getByText('Acerto efetivado: estoque atualizado')).toBeVisible();
    await expect(erp.getByText(/o documento não muda mais/)).toBeVisible();
    await tela(erp, '07-acerto-efetivado');
    await erp.goto('/estoque/acertos');
    await expect(erp.getByRole('cell', { name: 'Efetivado' })).toBeVisible();
    await tela(erp, '08-acertos-listagem');
  });

  await test.step('saldos por estoque com custo e venda total', async () => {
    await erp.goto('/estoque/saldos');
    await expect(erp.getByRole('link', { name: /CERV ORIGINAL 600ML/ })).toBeVisible();
    await expect(erp.getByTestId('totais-saldos')).toContainText('Itens: 5');
    await tela(erp, '09-saldos-estoque');
  });

  await test.step('combo: combos montáveis por estoque = mínimo(saldo ÷ quantidade)', async () => {
    await erp.goto('/produtos?nome=COMBO');
    await erp.getByRole('link', { name: 'COMBO DE WHISKY 1L', exact: true }).click();
    await abrirBloco(erp, /^Estoque/);
    const montaveis = erp.getByTestId('montaveis');
    // Loja 1: whisky 10 ÷ 1, Red Bull (padrão) 6 ÷ 1, gelo 20 ÷ 2 → 6; o CD está zerado.
    await expect(montaveis.getByRole('row', { name: /Loja 1 - Ice Beer Hermes/ })).toContainText('6');
    await expect(montaveis.getByRole('row', { name: /CD - Estoque Ice Beer/ })).toContainText('0');
    await montaveis.scrollIntoViewIfNeeded();
    await tela(erp, '10-combos-montaveis', false);
  });

  await test.step('importação de produtos pela planilha exportada do Nuvem3 (prévia, tarefa e relatório)', async () => {
    await erp.goto('/produtos/importacao');
    // O cabeçalho também tem o seletor "Loja" (loja de contexto): o da tela é o último.
    await erp.getByRole('combobox', { name: /^Loja/ }).last().click();
    await erp
      .getByRole('option', { name: /Loja 1 - Ice Beer Hermes/ })
      .first()
      .click();
    await erp.getByLabel(/Atualizar estoque \(a coluna/).check();
    await erp.getByLabel('Atualizar estoque mínimo').check();
    const csv = [
      'Id Produto;Ref. Interna;Código de Barras;Produto;Unidade;Marca;Departamento;Preço Custo;Venda;Atacado;Est. Mínimo;Est. Atual;NCM',
      '201;SKOL350;7891149105106;CERV SKOL LT 350ML;UN;SKOL;CERVEJA > LATA;2,10;3,49;3,19;24;48;22030000',
      '202;HEINEKEN600;7894900010015;CERV HEINEKEN LN 600ML;UN;HEINEKEN;CERVEJA > LONG NECK;5,00;8,99;;100;24;22030000',
      '205;SKOL350B;7891149105106;CERV SKOL LATA 350ML (CADASTRO DUPLICADO);UN;SKOL;CERVEJA > LATA;2,10;3,49;;;;22030000',
      '203;GELO5KG;;GELO 5KG;UN;;;3,00;;;;;22011000',
      '204;CARVAO;;CARVAO 3KG;UN;;;8,00;15,90;;;10;99999999',
    ].join('\r\n');
    await erp.locator('input[type="file"]').setInputFiles({
      name: 'Exportacao Nuvem3.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'latin1'),
    });
    // A hora da contagem do "Atualizar estoque" (F2-B11): a carga conta agora.
    await erp.getByRole('button', { name: /Data\/hora da contagem/ }).click();
    await erp.getByRole('button', { name: 'Agora' }).click();
    await erp.keyboard.press('Escape');
    await erp.getByRole('button', { name: 'Pré-visualizar' }).click();
    const resumo = erp.getByTestId('resumo-importacao');
    await expect(resumo).toContainText('Criar');
    await erp.getByText('Todas', { exact: true }).click();
    await tela(erp, '11-importacao-previa');
    await erp.getByRole('button', { name: 'Confirmar importação' }).click();
    await expect(erp.getByText('Importação concluída')).toBeVisible({ timeout: 60_000 });
    await expect(erp.getByRole('link', { name: 'Baixar relatório de inconsistências' })).toBeVisible();
    await tela(erp, '12-importacao-resultado');
  });
  await test.step('dashboard: vendas do dia/mês por loja (zero) e os cards', async () => {
    await erp.goto('/');
    await expect(erp.getByRole('table', { name: 'Vendas por loja' })).toContainText(
      'Loja 1 - Ice Beer Hermes',
    );
    await expect(erp.getByTestId('cards-dashboard')).toContainText('Produtos');
    // Heineken importada com 24 no estoque e mínimo 100.
    await expect(erp.getByRole('table', { name: 'Estoque abaixo do mínimo' })).toContainText(
      'CERV HEINEKEN LN 600ML',
    );
    await tela(erp, '13-dashboard');
  });

  await erp.close();
});
