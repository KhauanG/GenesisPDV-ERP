/**
 * Histórico de preços do produto (Fase 2, F2-B37; MD 3.6.10; README da API › decisão 183): o `GET
 * /produtos/:id/historico-precos` com os filtros tipo, loja e período (dias no fuso da empresa, com a virada do dia
 * conferida em horas fixas perto da meia-noite), a página com o total, a faixa por quantidade (tipo `quantidade`:
 * criada, com o preço trocado e removida, com o intervalo e a loja) gravada pelo formulário; sem `produtos.ver_custo` o custo não aparece (e o filtro "Custo" é 403) e a linha de loja fora das
 * permitidas fica fora (o filtro dela é 403). As origens `recebimento`, `nota_entrada` e `importacao` pela rota estão
 * nos testes de cada fluxo (`recebimento-movimentar`, `notas-entrada-movimentar` e `importacao-dashboard`).
 */
import type { HistoricoPrecoProduto, Pagina } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
/** Estoquista da Loja 1: sem `produtos.ver_custo`. */
let estoquista: string;
/** Administrador (não Master) só da Loja 1: vê o custo, não vê a Loja 2. */
let gerente: string;
let un: string;
let loja1: string;
let loja2: string;
let produtoId: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Hoje (`AAAA-MM-DD`) no fuso da empresa de teste (o de Brasília). */
const diaEmBrasilia = (deslocamentoDias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() + deslocamentoDias * 86_400_000),
  );

const historico = (query: Record<string, string> = {}, token = admin, id = produtoId) =>
  amb.http().get(`/api/produtos/${id}/historico-precos`).query(query).set(bearer(token));

async function linhas(query: Record<string, string> = {}, token = admin) {
  const r = await historico({ tamanho: '50', ...query }, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Pagina<HistoricoPrecoProduto>;
}

/** O essencial de uma linha, para comparar sem o id e a hora. */
const resumo = (h: HistoricoPrecoProduto) => ({
  tipo: h.tipoPreco,
  loja: h.lojaNome,
  faixa: h.quantidadeInicial === null ? null : `${h.quantidadeInicial}-${h.quantidadeFinal ?? ''}`,
  de: h.valorAnterior,
  para: h.valorNovo,
  origem: h.origem,
});

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja Praia');
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [loja1] });
  await criarUsuario(emp.nomeBanco, { login: 'gerente', perfil: 'administrador', lojas: [loja1] });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  gerente = await amb.entrar(emp.codigo, 'gerente', SENHA_TESTE);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;

  // Cadastro: preço, custo, o preço das duas lojas e duas faixas (a de todas as lojas e a da Loja 2).
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({
      nome: 'CERV HEINEKEN LN 600ML',
      unidadeId: un,
      precoCusto: '5,00',
      precoVenda: '9,90',
      lojas: [
        { lojaId: loja1, precoVenda: '9,50' },
        { lojaId: loja2, precoVenda: '9,70' },
      ],
      precosQuantidade: [
        { lojaId: null, quantidadeInicial: '6', quantidadeFinal: '11', preco: '9,40' },
        { lojaId: loja2, quantidadeInicial: '12', quantidadeFinal: null, preco: '9,20' },
      ],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  produtoId = r.body.id as string;
  // O cadastro "aconteceu" há 10 dias (para o filtro do período).
  await consultar(
    emp.nomeBanco,
    `update produtos_historico_precos set criado_em = now() - interval '10 days' where produto_id = $1`,
    [produtoId],
  );

  // Alteração: o preço de 9,90 para 10,90, o custo, o preço da Loja 2, a faixa geral com outro preço, a da Loja 2
  // removida e uma nova na Loja 1.
  const atual = (await amb.http().get(`/api/produtos/${produtoId}`).set(bearer(admin))).body;
  const faixaGeral = (atual.precosQuantidade as Array<{ lojaId: string | null }>).find(
    (f) => f.lojaId === null,
  )!;
  const a = await amb
    .http()
    .put(`/api/produtos/${produtoId}`)
    .set(bearer(admin))
    .send({
      ...atual,
      precoVenda: '10,90',
      precoCusto: '5,50',
      lojas: [
        { lojaId: loja1, precoVenda: '9,50' },
        { lojaId: loja2, precoVenda: '9,80' },
      ],
      precosQuantidade: [
        { ...faixaGeral, preco: '9,30' },
        { lojaId: loja1, quantidadeInicial: '12', quantidadeFinal: null, preco: '9,10' },
      ],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('histórico de preços do produto (F2-B37)', () => {
  it('lista a mais recente primeiro, com a faixa, a loja, a origem e o usuário', async () => {
    const p = await linhas();
    // 6 no cadastro (venda, custo, as duas lojas e as duas faixas) e 6 na alteração.
    expect(p.total).toBe(12);
    expect(p.itens).toHaveLength(12);
    // A alteração (hoje) antes do cadastro (há 10 dias).
    const hoje = p.itens.slice(0, 6).map(resumo);
    expect(hoje).toEqual(
      expect.arrayContaining([
        { tipo: 'venda', loja: null, faixa: null, de: '9.9000', para: '10.9000', origem: 'cadastro' },
        { tipo: 'custo', loja: null, faixa: null, de: '5.0000', para: '5.5000', origem: 'cadastro' },
        { tipo: 'loja', loja: 'Loja Praia', faixa: null, de: '9.7000', para: '9.8000', origem: 'cadastro' },
        {
          tipo: 'quantidade',
          loja: null,
          faixa: '6.000-11.000',
          de: '9.4000',
          para: '9.3000',
          origem: 'cadastro',
        },
        {
          tipo: 'quantidade',
          loja: 'Loja Praia',
          faixa: '12.000-',
          de: '9.2000',
          para: null,
          origem: 'cadastro',
        },
        {
          tipo: 'quantidade',
          loja: 'Loja Centro',
          faixa: '12.000-',
          de: null,
          para: '9.1000',
          origem: 'cadastro',
        },
      ]),
    );
    const cadastro = p.itens.slice(6).map(resumo);
    expect(cadastro).toEqual(
      expect.arrayContaining([
        { tipo: 'venda', loja: null, faixa: null, de: null, para: '9.9000', origem: 'cadastro' },
        {
          tipo: 'quantidade',
          loja: null,
          faixa: '6.000-11.000',
          de: null,
          para: '9.4000',
          origem: 'cadastro',
        },
        {
          tipo: 'quantidade',
          loja: 'Loja Praia',
          faixa: '12.000-',
          de: null,
          para: '9.2000',
          origem: 'cadastro',
        },
      ]),
    );
    expect(p.itens.every((h) => h.documento === null && h.usuarioNome !== null)).toBe(true);
    expect(Date.parse(p.itens[0]!.criadoEm)).toBeGreaterThan(Date.parse(p.itens.at(-1)!.criadoEm));
    // O preço da Loja 1 não mudou na alteração: nenhuma linha nova dela além da faixa.
    expect(hoje.filter((h) => h.tipo === 'loja' && h.loja === 'Loja Centro')).toEqual([]);
  });

  it('pagina com o total', async () => {
    const r = await historico({ tamanho: '20', pagina: '1' });
    expect(r.body).toMatchObject({ total: 12, pagina: 1, tamanho: 20 });
    const r2 = await historico({ tamanho: '20', pagina: '2' });
    expect(r2.body).toMatchObject({ total: 12, itens: [] });
  });

  it('filtra pelo tipo, pela loja (e o geral) e pelo período no fuso da empresa', async () => {
    const faixas = await linhas({ tipo: 'quantidade' });
    expect(faixas.total).toBe(5);
    expect(faixas.itens.every((h) => h.tipoPreco === 'quantidade')).toBe(true);

    const praia = await linhas({ loja: loja2 });
    expect(praia.itens.map(resumo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tipo: 'loja', de: '9.7000', para: '9.8000' }),
        expect.objectContaining({ tipo: 'quantidade', de: '9.2000', para: null }),
      ]),
    );
    expect(praia.itens.every((h) => h.lojaId === loja2)).toBe(true);

    const geral = await linhas({ loja: 'geral' });
    expect(geral.itens.length).toBeGreaterThan(0);
    expect(geral.itens.every((h) => h.lojaId === null)).toBe(true);

    // Só a alteração (de 5 dias atrás até hoje) e só o cadastro (até ontem).
    const recentes = await linhas({ dataInicial: diaEmBrasilia(-5), dataFinal: diaEmBrasilia() });
    expect(recentes.total).toBe(6);
    const antigos = await linhas({ dataFinal: diaEmBrasilia(-1) });
    expect(antigos.total).toBe(6);
    expect(antigos.itens.every((h) => h.valorAnterior === null)).toBe(true);
  });

  it('o período vira o dia à meia-noite do fuso da empresa, não à do UTC', async () => {
    // Outro produto, com as duas linhas em horas fixas: 23:30 de 09/11 em Brasília (02:30 UTC de 10/11) e 00:30 de
    // 10/11 (03:30 UTC). Comparar a data em UTC, ou virar o dia à meia-noite UTC, troca a primeira de dia.
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ nome: 'CERV ORIGINAL LN 600ML', unidadeId: un, precoCusto: '5,00', precoVenda: '9,90' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    await consultar(
      emp.nomeBanco,
      `update produtos_historico_precos
          set criado_em = case tipo_preco when 'venda' then timestamptz '2026-11-09 23:30:00-03'
                                          else timestamptz '2026-11-10 00:30:00-03' end
        where produto_id = $1`,
      [id],
    );
    const tipos = async (query: Record<string, string>) => {
      const resp = await historico({ tamanho: '50', ...query }, admin, id);
      expect(resp.status, JSON.stringify(resp.body)).toBe(200);
      return (resp.body as Pagina<HistoricoPrecoProduto>).itens.map((h) => h.tipoPreco).sort();
    };
    expect(await tipos({})).toEqual(['custo', 'venda']);
    expect(await tipos({ dataFinal: '2026-11-09' })).toEqual(['venda']);
    expect(await tipos({ dataInicial: '2026-11-09', dataFinal: '2026-11-09' })).toEqual(['venda']);
    expect(await tipos({ dataInicial: '2026-11-10' })).toEqual(['custo']);
    expect(await tipos({ dataInicial: '2026-11-10', dataFinal: '2026-11-10' })).toEqual(['custo']);
  });

  it('sem produtos.ver_custo não há custo; a loja fora das permitidas fica fora', async () => {
    const p = await linhas({}, estoquista);
    expect(p.itens.some((h) => h.tipoPreco === 'custo')).toBe(false);
    expect(p.itens.some((h) => h.lojaId === loja2)).toBe(false);
    // O preço geral e a faixa de todas as lojas são de todos; a Loja 1 é dele.
    expect(p.itens.map(resumo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tipo: 'venda', de: '9.9000', para: '10.9000' }),
        expect.objectContaining({ tipo: 'quantidade', loja: null, de: '9.4000', para: '9.3000' }),
        expect.objectContaining({ tipo: 'quantidade', loja: 'Loja Centro', para: '9.1000' }),
      ]),
    );
    // 12 menos os 2 custos e as 4 linhas da Loja 2 (o preço e a faixa, no cadastro e na alteração).
    expect(p.total).toBe(6);

    expect((await historico({ tipo: 'custo' }, estoquista)).status).toBe(403);
    expect((await historico({ loja: loja2 }, estoquista)).status).toBe(403);

    // Com o custo e só a Loja 1: o custo aparece, a Loja 2 não.
    const g = await linhas({}, gerente);
    expect(g.itens.filter((h) => h.tipoPreco === 'custo')).toHaveLength(2);
    expect(g.itens.some((h) => h.lojaId === loja2)).toBe(false);
    expect(g.total).toBe(8);
    expect((await historico({ tipo: 'custo' }, gerente)).status).toBe(200);
  });

  it('produto desconhecido 404; filtros inválidos 422', async () => {
    const r = await historico({}, admin, '0190a000-0000-7000-8000-000000000001');
    expect(r.status).toBe(404);
    expect((await historico({ tipo: 'markup' })).status).toBe(422);
    expect((await historico({ loja: 'qualquer' })).status).toBe(422);
    expect((await historico({ dataInicial: '2026-11-10', dataFinal: '2026-11-01' })).status).toBe(422);
    expect((await historico({ dataInicial: '2026-02-30' })).status).toBe(422);
  });
});
