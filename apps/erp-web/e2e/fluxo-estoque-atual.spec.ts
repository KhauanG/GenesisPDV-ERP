import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Relatório Estoque Atual de ponta a ponta (Fase 2, F2-B31; ERP 16.4; README do ERP › decisão 66) — também o e2e da
 * casca `<Relatorio>` paginada no servidor e do ícone Tarefas (F2-B30), com um relatório de verdade: empresa nova →
 * pela API, a marca "Cervejaria Serra" com 25 cervejas (cada uma contada ontem ao meio-dia pelo "Ajustar" do produto,
 * a primeira com 10) e uma de outra marca, e mais 5 da primeira hoje → no ERP, Relatórios › Estoque Atual: o filtro da
 * marca no estoque da loja de contexto, 20 por página e a página 2 (o total vem da API), a data-base de ontem (10, sem
 * o ajuste no clique) e a de hoje (15), o clique no saldo com o modal de ajuste (nova quantidade 12, o motivo) → o saldo
 * 12 na tela, o acerto "Relatório Estoque Atual" na lista de acertos, e o Exportar Excel que vira tarefa (o servidor do
 * e2e baixa na hora só até 10 linhas, `E2E_EXPORTACAO_NA_HORA`): o aviso com o andamento e o link, e a tarefa no
 * ícone Tarefas. As telas vão para `E2E_TELAS` (padrão `test-results/telas-estoque-atual`).
 */
interface Estado {
  email: string;
  senha: string;
  totp: string;
}

const estado = (): Estado => JSON.parse(readFileSync(process.env.E2E_ESTADO!, 'utf8')) as Estado;
const API = `http://127.0.0.1:${process.env.E2E_PORTA_API}`;
const TELAS = process.env.E2E_TELAS ?? join(process.cwd(), 'test-results', 'telas-estoque-atual');
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

/** `AAAA-MM-DD` de hoje − `dias` no fuso de Brasília (o do navegador do teste e o da empresa). */
const dia = (dias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() - dias * 86_400_000),
  );
const br = (iso: string) => iso.split('-').reverse().join('/');

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

test('Estoque Atual: marca, paginação, saldo de ontem, ajuste no clique e exportação em tarefa', async ({
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

  let estoqueNome = '';
  await test.step('API: a Loja 1, a marca, 25 cervejas contadas ontem (a primeira com 10), +5 hoje e uma de outra marca', async () => {
    const h = { Authorization: `Bearer ${await apiLogin(request, codigo)}` };
    const loja = await request.post(`${API}/api/lojas`, {
      headers: h,
      data: {
        nome: 'Loja 1 - Centro',
        razaoSocial: 'Ice Beer Comércio de Bebidas Ltda',
        nomeFantasia: 'Ice Beer Centro',
        cnpj: '11.222.333/0001-81',
        cep: '86020-000',
        logradouro: 'Rua das Flores',
        numero: '10',
        bairro: 'Centro',
        municipioIbge: 4113700,
        uf: 'PR',
        nomeEstoque: 'Estoque Loja 1',
      },
    });
    expect(loja.status(), await loja.text()).toBe(201);
    const estoque = { id: ((await loja.json()) as { estoqueId: string }).estoqueId };
    estoqueNome = 'Estoque Loja 1';
    const marca = await request.post(`${API}/api/marcas`, {
      headers: h,
      data: { descricao: 'Cervejaria Serra' },
    });
    expect(marca.status(), await marca.text()).toBe(201);
    const marcaId = ((await marca.json()) as { id: string }).id;
    const unidades = (await (
      await request.get(`${API}/api/referencias/unidades`, { headers: h })
    ).json()) as Array<{ id: string; sigla: string }>;
    const un = unidades.find((u) => u.sigla === 'UN')!.id;
    const ontem = `${dia(1)}T12:00:00-03:00`;
    const produto = async (nome: string, marcaDele: string | null, quantidade: string) => {
      const p = await request.post(`${API}/api/produtos`, {
        headers: h,
        data: { nome, unidadeId: un, precoCusto: '4', precoVenda: '9,90', marcaId: marcaDele },
      });
      expect(p.status(), await p.text()).toBe(201);
      const id = ((await p.json()) as { id: string }).id;
      const a = await request.post(`${API}/api/produtos/${id}/ajustar-estoque`, {
        headers: h,
        data: { estoqueId: estoque.id, quantidade, motivo: 'Inventário', dataContagem: ontem },
      });
      expect(a.status(), await a.text()).toBe(200);
      return id;
    };
    const primeira = await produto('SERRA IPA 01', marcaId, '10');
    for (let i = 2; i <= 25; i++)
      await produto(`SERRA IPA ${String(i).padStart(2, '0')}`, marcaId, String(i));
    await produto('OUTRA PILSEN', null, '50');
    const a = await request.post(`${API}/api/acertos`, {
      headers: h,
      data: {
        estoqueId: estoque.id,
        motivo: 'Bonificação',
        dataContagem: new Date().toISOString(),
        tipoAjuste: 'entrada',
        itens: [{ produtoId: primeira, quantidade: '5', custoUnitario: '4' }],
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

  const tabela = erp.getByRole('table', { name: 'Estoque Atual' });
  const linhaDa = (nome: string) => tabela.getByRole('row').filter({ hasText: nome });
  await test.step('a marca no estoque da loja de contexto, 20 por página e a página 2', async () => {
    await erp.goto('/relatorios/estoque-atual');
    await expect(erp.getByRole('heading', { name: 'Estoque Atual' })).toBeVisible();
    await escolher(erp, /^Loja \(estoque\)/, estoqueNome);
    await escolher(erp, /^Marca/, 'Cervejaria Serra');
    await erp.getByRole('button', { name: 'Filtrar' }).click();
    await expect(linhaDa('SERRA IPA 01')).toContainText('15');
    await expect(erp.getByText('25 registros', { exact: true })).toBeVisible();
    await expect(tabela).not.toContainText('OUTRA PILSEN');
    await erp.getByRole('combobox', { name: 'Linhas por página' }).click();
    await erp.getByRole('option', { name: '20', exact: true }).click();
    await expect(erp.getByText('Página 1 de 2', { exact: true })).toBeVisible();
    await tela(erp, '01-estoque-atual-pagina-1');
    await erp.getByRole('button', { name: 'Próxima página' }).click();
    await expect(erp.getByText('Página 2 de 2', { exact: true })).toBeVisible();
    await expect(tabela.getByRole('row').filter({ hasText: /SERRA IPA \d\d/ })).toHaveCount(5);
    await expect(erp).toHaveURL(/pagina=2/);
    await erp.getByRole('button', { name: 'Primeira página' }).click();
    await expect(erp.getByText('Página 1 de 2', { exact: true })).toBeVisible();
  });

  await test.step('o saldo de ontem pela data-base, sem o ajuste no clique', async () => {
    await erp.getByLabel('Saldo em (data-base)').fill(dia(1));
    await erp.getByRole('button', { name: 'Filtrar' }).click();
    await expect(tabela.getByRole('columnheader', { name: `Saldo em ${br(dia(1))}` })).toBeVisible();
    await expect(linhaDa('SERRA IPA 01').getByRole('cell').nth(7)).toHaveText('10');
    await expect(tabela.getByRole('button', { name: /Ajustar o saldo/ })).toHaveCount(0);
    await tela(erp, '02-estoque-atual-ontem');
    await erp.getByLabel('Saldo em (data-base)').fill('');
    await erp.getByRole('button', { name: 'Filtrar' }).click();
    await expect(tabela.getByRole('columnheader', { name: 'Est. Atual' })).toBeVisible();
    await expect(linhaDa('SERRA IPA 01').getByRole('cell').nth(7)).toHaveText('15');
  });

  await test.step('o clique no saldo ajusta o item: 15 → 12', async () => {
    await linhaDa('SERRA IPA 01')
      .getByRole('button', { name: /Ajustar o saldo de SERRA IPA 01/ })
      .click();
    const modal = erp.getByRole('dialog', { name: 'Ajustar o saldo' });
    await expect(modal.getByLabel('Produto', { exact: true })).toHaveValue(/SERRA IPA 01/);
    await expect(modal.getByLabel('Estoque', { exact: true })).toHaveValue(estoqueNome);
    await expect(modal.getByTestId('saldo-atual-ajuste')).toContainText('15');
    await modal.getByLabel(/^Nova quantidade/).fill('12');
    await modal.getByLabel(/^Motivo/).fill('Contagem pelo relatório');
    await tela(erp, '03-modal-ajuste');
    await modal.getByRole('button', { name: 'Gravar' }).click();
    await expect(erp.getByText(/Acerto Nº \d+ efetivado/)).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(linhaDa('SERRA IPA 01').getByRole('cell').nth(7)).toHaveText('12');
  });

  await test.step('o Excel vira tarefa: o aviso, o link e o ícone Tarefas', async () => {
    await erp.getByRole('button', { name: 'Exportar' }).click();
    await erp.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
    const aviso = erp.getByTestId('exportacao-em-tarefa');
    await expect(aviso).toContainText('Exportação em segundo plano · 25 linhas');
    await expect(
      aviso.getByText(/Exportação concluída: Relatorio_Estoque_Atual_.*\.xlsx \(25 linhas\)/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(aviso.getByRole('link', { name: 'Baixar o arquivo' })).toBeVisible();
    await tela(erp, '04-exportacao-tarefa');
    // As notificações do canto (a da exportação, a da conclusão) ficam por cima do ícone: abre pelo teclado.
    await erp.getByRole('button', { name: /^Tarefas/ }).focus();
    await erp.keyboard.press('Enter');
    const painel = erp.getByRole('region', { name: 'Painel de tarefas' });
    await expect(painel).toContainText('Exportação de relatório');
    await expect(painel.getByRole('link', { name: /Baixar/ }).first()).toBeVisible();
    await tela(erp, '05-icone-tarefas');
    await erp.keyboard.press('Escape');
  });

  await test.step('o acerto do ajuste na lista de acertos, com a origem do relatório', async () => {
    await erp.goto('/estoque/acertos');
    const doRelatorio = erp.getByRole('row').filter({ hasText: 'Contagem pelo relatório' });
    await expect(doRelatorio).toHaveCount(1);
    await doRelatorio.getByRole('link').first().click();
    await expect(erp.getByText('Relatório Estoque Atual')).toBeVisible();
    await tela(erp, '06-acerto');
  });

  await erp.close();
});
