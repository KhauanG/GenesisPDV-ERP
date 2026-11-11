/**
 * **Cadastro em massa por estoque** (Fase 2, F2-B39; ERP 8.3; README da API › decisão 185): `POST
 * /produtos/cadastro-em-massa` e o "Pesquisar EAN". O critério de pronto (30 produtos novos com estoque no CD geram os
 * produtos, um acerto de Entrada e o histórico numa só confirmação); a Atualização pelo EAN (preço, estoque somado e
 * estoque mínimo da loja do estoque; a linha só de estoque não regrava o cadastro; a versão vista na pesquisa);
 * o limite de linhas tudo ou nada (a última com erro na conferência ou só na gravação não grava nenhuma) e uma a mais
 * recusada; a linha só de estoque com o corpo inteiro que o ERP monta (o custo com 4 casas); o EAN de produto novo já cadastrado
 * com "bloquear" (nada gravado, nem a marca nova) e com "avisar" (a confirmação); as permissões e o estoque permitido;
 * a concorrência com o push do PDV; e o razão refeito idêntico. Os EAN são inventados, com o dígito verificador
 * calculado; os nomes também.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  calcularDvGtin,
  CONTRATOS_EVENTOS,
  jcs,
  LIMITE_LINHAS_CADASTRO_MASSA,
  respostaPushSchema,
  type Ativar,
  type RespostaPesquisaEanCadastroMassa,
  type ResultadoCadastroMassa,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
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
import { conferirRazaoDoBanco } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
let tokenEstoquista: string;
/** Gerente só com o estoque da Loja 1 (o CD fora dos estoques permitidos). */
let tokenGerenteLoja: string;
let un: string;
let loja: string;
let estoqueLoja: string;
let cd: string;
let categoria: string;
let operador: string;
let dinheiro: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

/** EAN-13 inventado (789 + 9 dígitos de teste) com o dígito verificador certo. */
const ean = (n: number) => {
  const b = `78998${String(n).padStart(7, '0')}`;
  return `${b}${calcularDvGtin(b)}`;
};

const gravar = (corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb.http().post('/api/produtos/cadastro-em-massa').set(bearer(token)).send(corpo);

const pesquisar = (estoqueId: string, codigos: string[], token = tokenAdmin) =>
  amb
    .http()
    .post('/api/produtos/cadastro-em-massa/pesquisar-ean')
    .set(bearer(token))
    .send({ estoqueId, codigos });

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function saldo(estoqueId: string, produtoId: string) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select s.quantidade::text, s.custo_medio::text
       from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id
      where s.estoque_id = $1 and s.produto_id = $2 and t.padrao`,
    [estoqueId, produtoId],
  );
  return s;
}

const contarProdutos = async (prefixo: string) =>
  Number(
    (
      await consultar<{ n: string }>(
        emp.nomeBanco,
        'select count(*)::text as n from produtos where nome like $1 and excluido_em is null',
        [`${prefixo}%`],
      )
    )[0]!.n,
  );

const contarAcertosMassa = async () =>
  Number(
    (
      await consultar<{ n: string }>(
        emp.nomeBanco,
        "select count(*)::text as n from acertos_estoque where origem = 'cadastro_massa'",
      )
    )[0]!.n,
  );

// ---------------------------------------------------------------- PDV (a venda concorrente)

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

interface Ponto {
  caixa: string;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: 1,
  terminal_id: p.terminal,
});

function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) {
  const contrato = CONTRATOS_EVENTOS[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato.agregadoTipo,
    agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
    dependencias:
      tipo === 'venda.finalizada' ? [{ agregado_tipo: 'sessao_caixa', agregado_id: p.sessao }] : [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: 1, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

const push = (p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({
      lote_id: uuidv7(),
      terminal_id: p.terminal,
      enviado_em: agora(),
      eventos: [evento(p, tipo, payload)],
    });

async function aplicar(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) {
  const r = await push(p, tipo, payload);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  expect(r.body.resultados[0], JSON.stringify(r.body)).toMatchObject({ status: 'aplicado' });
}

async function novoPonto(): Promise<Ponto> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const p: Ponto = {
    caixa,
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    venda: 0,
    sessao: uuidv7(),
  };
  await aplicar(p, 'caixa.aberto', {
    sessoes_caixa: {
      id: p.sessao,
      ...linhaDoPonto(p),
      operador_id: operador,
      status: 'aberta',
      dia_operacional: '2026-11-10',
      aberta_em: minutosAtras(300),
      fundo_troco: '0.00',
    },
    movimentos_caixa: [],
  });
  return p;
}

/** Venda finalizada de 1 unidade (sem lote), paga em dinheiro. */
function venda(p: Ponto, produtoId: string) {
  const id = uuidv7();
  const numero = ++p.venda;
  const quando = minutosAtras(1);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C01-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-11-10',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: '5.00',
      total: '5.00',
      iniciada_em: quando,
      finalizada_em: quando,
    },
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produtoId,
        descricao: 'ITEM DE TESTE',
        unidade: 'UN',
        quantidade: '1.000',
        preco_tabela: '5.0000',
        preco_unitario: '5.0000',
        valor_bruto: '5.00',
        valor_liquido: '5.00',
        incluido_em: quando,
        componentes_estoque: [],
      },
    ],
    pagamentos_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        forma_pagamento_id: dinheiro,
        descricao_forma: 'Dinheiro',
        meio_pagamento_fiscal: '01',
        tipo_forma: 'dinheiro',
        valor: '5.00',
        lanca_quitada: true,
      },
    ],
    vasilhames: [],
  };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  [{ estoque_id: estoqueLoja }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  )) as [{ estoque_id: string }];
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Teste', 'deposito') returning id",
  )) as [{ id: string }];
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [loja] });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, {
    login: 'gerenteloja',
    perfil: 'gerente',
    lojas: [loja],
    estoques: [estoqueLoja],
  });
  tokenGerenteLoja = await amb.entrar(emp.codigo, 'gerenteloja', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  const c = await amb.http().post('/api/categorias').set(bearer()).send({ nome: 'Cervejas teste' });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  categoria = c.body.id as string;
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('cadastro em massa (F2-B39; ERP 8.3)', () => {
  it('30 produtos novos com estoque no CD: os produtos, um acerto de Entrada e o histórico numa só confirmação (critério de pronto)', async () => {
    const linhas = Array.from({ length: 30 }, (_, i) => ({
      ean: ean(100 + i),
      nome: `MASSA CD CERVEJA ${String(i + 1).padStart(2, '0')} LATA 350ML`,
      unidadeId: un,
      ...(i === 0
        ? { marcaNova: 'Cervejaria Teste Nova' }
        : i === 1
          ? { marcaNova: 'CERVEJARIA TESTE NOVA' }
          : {}),
      categoriaId: categoria,
      precoCusto: '3,00',
      markupPct: '50',
      precoVenda: '4,50',
      estoque: String(10 + i),
    }));
    const r = await gravar({ estoqueId: cd, linhas });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const res = r.body as ResultadoCadastroMassa;
    expect(res).toMatchObject({ criados: 30, atualizados: 0, marcasCriadas: 1 });
    expect(res.produtos.map((p) => p.linha)).toEqual(linhas.map((_, i) => i + 1));
    expect(res.acerto).toMatchObject({ itens: 30, movimentos: 30 });

    // Simples, ativo, com o EAN principal, a marca nova (uma só para as duas grafias) e a categoria principal.
    const produtos = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select p.tipo, p.ativo, p.controla_estoque, p.preco_custo::text, p.markup_pct::text, p.preco_venda::text,
              m.descricao as marca, p.categoria_principal_id,
              (select cb.codigo from produtos_codigos_barras cb where cb.produto_id = p.id and cb.principal) as ean
         from produtos p left join marcas m on m.id = p.marca_id
        where p.nome like 'MASSA CD %' order by p.nome`,
    );
    expect(produtos).toHaveLength(30);
    expect(produtos[0]).toEqual({
      tipo: 'simples',
      ativo: true,
      controla_estoque: true,
      preco_custo: '3.0000',
      markup_pct: '50.0000',
      preco_venda: '4.5000',
      marca: 'Cervejaria Teste Nova',
      categoria_principal_id: categoria,
      ean: ean(100),
    });
    expect(produtos[1]!.marca).toBe('Cervejaria Teste Nova');

    // Um acerto de Entrada efetivado, origem `cadastro_massa`, com os movimentos AJUSTE_CADASTRO ao custo da linha.
    const [a] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select tipo_ajuste, status, origem, motivo, estoque_id, qtd_itens from acertos_estoque where id = $1`,
      [res.acerto!.id],
    );
    expect(a).toEqual({
      tipo_ajuste: 'entrada',
      status: 'efetivado',
      origem: 'cadastro_massa',
      motivo: 'Cadastro em massa',
      estoque_id: cd,
      qtd_itens: 30,
    });
    const movs = await consultar<{ tipo_movimento: string; quantidade: string; custo_unitario: string }>(
      emp.nomeBanco,
      `select tipo_movimento, quantidade::text, custo_unitario::text from movimentos_estoque
        where documento_tipo = 'acerto' and documento_id = $1 order by quantidade`,
      [res.acerto!.id],
    );
    expect(movs).toHaveLength(30);
    expect(new Set(movs.map((m) => m.tipo_movimento))).toEqual(new Set(['AJUSTE_CADASTRO']));
    expect(movs[0]).toMatchObject({ quantidade: '10.000', custo_unitario: '3.0000' });
    const primeiro = res.produtos[0]!.id;
    expect(await saldo(cd, primeiro)).toEqual({ quantidade: '10.000', custo_medio: '3.0000' });

    // O histórico com a origem `cadastro_massa` (venda e custo), e a auditoria com a localização da tela.
    const hist = await consultar<{ tipo_preco: string; valor_novo: string; origem: string }>(
      emp.nomeBanco,
      `select tipo_preco, valor_novo::text, origem from produtos_historico_precos where produto_id = $1 order by tipo_preco`,
      [primeiro],
    );
    expect(hist).toEqual([
      { tipo_preco: 'custo', valor_novo: '3.0000', origem: 'cadastro_massa' },
      { tipo_preco: 'venda', valor_novo: '4.5000', origem: 'cadastro_massa' },
    ]);
    const aud = await consultar<{ entidade: string; acao: string; descricao: string | null }>(
      emp.nomeBanco,
      `select entidade, acao, descricao from auditoria where localizacao = 'Produtos › Cadastro em massa'
        order by entidade, acao`,
    );
    expect(aud.filter((x) => x.entidade === 'produtos')).toHaveLength(30);
    // A descrição legível da gravação do produto (F2-B42, decisão 188), com o custo só com o rótulo.
    for (const x of aud.filter((y) => y.entidade === 'produtos'))
      expect(x.descricao).toMatch(/^Nome: .+; .*Preço de custo: \(preenchido\)/);
    expect(aud.filter((x) => x.entidade === 'marcas')).toHaveLength(1);
    expect(aud.filter((x) => x.entidade === 'acertos_estoque').map((x) => x.acao)).toEqual([
      'criar',
      'efetivar',
    ]);
  }, 120_000);

  it('Pesquisar EAN acha o produto (e a embalagem com o fator); a Atualização troca o preço, soma o estoque e grava o mínimo da loja', async () => {
    const codigo = ean(500);
    const fardo = ean(501);
    const id = await produto('ATUALIZA AGUA TESTE 500ML', {
      codigosBarras: [
        { codigo, principal: true },
        { codigo: fardo, descricao: 'Fardo 12', fator: '12' },
      ],
    });
    // Sem saldo: a Entrada sem custo informado entra ao preço de custo do cadastro (R$ 4,00).
    const p = await pesquisar(estoqueLoja, [codigo, fardo, ean(599)]);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const res = p.body as RespostaPesquisaEanCadastroMassa;
    expect(res.itens.map((x) => x.codigo).sort()).toEqual([codigo, fardo].sort());
    const achado = res.itens.find((x) => x.codigo === codigo)!.produtos[0]!;
    expect(achado).toMatchObject({
      id,
      nome: 'ATUALIZA AGUA TESTE 500ML',
      tipo: 'simples',
      precoVenda: '8.0000',
      precoCusto: '4.0000',
      estoqueMinimo: null,
      variacao: false,
      fator: '1.000',
      temEstoqueProprio: true,
    });
    expect(res.itens.find((x) => x.codigo === fardo)!.produtos[0]).toMatchObject({ id, fator: '12.000' });

    const r = await gravar({
      estoqueId: estoqueLoja,
      linhas: [
        {
          produtoId: id,
          versao: achado.versao,
          ean: codigo,
          precoVenda: '9,50',
          estoque: '6',
          estoqueMinimo: '3',
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ criados: 0, atualizados: 1 });
    const [cad] = await consultar<{ preco_venda: string; versao: string }>(
      emp.nomeBanco,
      'select preco_venda::text, versao::text from produtos where id = $1',
      [id],
    );
    expect(cad!.preco_venda).toBe('9.5000');
    expect(await saldo(estoqueLoja, id)).toEqual({ quantidade: '6.000', custo_medio: '4.0000' });
    const [pl] = await consultar<{ estoque_minimo: string }>(
      emp.nomeBanco,
      'select estoque_minimo::text from produtos_lojas where produto_id = $1 and loja_id = $2 and excluido_em is null',
      [id, loja],
    );
    expect(pl!.estoque_minimo).toBe('3.000');
    const hist = await consultar<{ tipo_preco: string; valor_anterior: string; valor_novo: string }>(
      emp.nomeBanco,
      `select tipo_preco, valor_anterior::text, valor_novo::text from produtos_historico_precos
        where produto_id = $1 and origem = 'cadastro_massa'`,
      [id],
    );
    expect(hist).toEqual([{ tipo_preco: 'venda', valor_anterior: '8.0000', valor_novo: '9.5000' }]);

    // A versão vista na pesquisa ficou velha: a linha é recusada (nada gravado).
    const velha = await gravar({
      estoqueId: estoqueLoja,
      linhas: [{ produtoId: id, versao: achado.versao, ean: codigo, estoque: '1' }],
    });
    expect(velha.status, JSON.stringify(velha.body)).toBe(422);
    expect(velha.body.campos['linhas.0.ean'][0]).toMatch(/pesquise o EAN de novo/);
    expect((await saldo(estoqueLoja, id))!.quantidade).toBe('6.000');

    // Só o estoque: o cadastro não é regravado (a versão fica), e o acerto soma.
    const atual = ((await pesquisar(estoqueLoja, [codigo])).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    expect(atual.estoqueMinimo).toBe('3.000');
    const so = await gravar({
      estoqueId: estoqueLoja,
      linhas: [{ produtoId: id, versao: atual.versao, ean: codigo, estoque: '2' }],
    });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    const depois = ((await pesquisar(estoqueLoja, [codigo])).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    expect(depois.versao).toBe(atual.versao);
    expect((await saldo(estoqueLoja, id))!.quantidade).toBe('8.000');

    // O estoque mínimo no CD (sem loja) é recusado.
    const semLoja = await gravar({
      estoqueId: cd,
      linhas: [
        { ean: ean(502), nome: 'MASSA SEM LOJA TESTE', unidadeId: un, precoVenda: '2', estoqueMinimo: '1' },
      ],
    });
    expect(semLoja.status).toBe(422);
    expect(semLoja.body.campos['linhas.0.estoqueMinimo'][0]).toMatch(/não é de uma loja/);
  });

  it(`${LIMITE_LINHAS_CADASTRO_MASSA} linhas, a última com erro: nada é gravado; as válidas gravam; uma a mais é recusada`, async () => {
    const n = LIMITE_LINHAS_CADASTRO_MASSA;
    const linha = (i: number) => ({
      ean: ean(10_000 + i),
      nome: `MASSA LOTE ${String(i).padStart(3, '0')} TESTE`,
      unidadeId: un,
      precoVenda: '5',
      estoque: '1',
    });
    const linhas = Array.from({ length: n }, (_, i) => linha(i));
    const ruim = await gravar({
      estoqueId: estoqueLoja,
      linhas: [...linhas.slice(0, n - 1), { ...linhas[n - 1]!, categoriaId: uuidv7() }],
    });
    expect(ruim.status, JSON.stringify(ruim.body).slice(0, 500)).toBe(422);
    expect(ruim.body.campos[`linhas.${n - 1}.categoriaId`]).toEqual(['Categoria inexistente']);
    expect(await contarProdutos('MASSA LOTE ')).toBe(0);
    const acertosAntes = await contarAcertosMassa();

    const inicio = Date.now();
    const ok = await gravar({ estoqueId: estoqueLoja, linhas });
    expect(ok.status, JSON.stringify(ok.body).slice(0, 500)).toBe(201);
    expect(ok.body).toMatchObject({ criados: n, acerto: { itens: n, movimentos: n } });
    expect(await contarProdutos('MASSA LOTE ')).toBe(n);
    expect(await contarAcertosMassa()).toBe(acertosAntes + 1);
    // Registro do tempo da gravação inteira (uma transação com a 7300001); sem limite rígido no CI.
    console.info(`cadastro em massa: ${n} linhas em ${Date.now() - inicio} ms`);

    const demais = await gravar({ estoqueId: estoqueLoja, linhas: [...linhas, linha(n)] });
    expect(demais.status).toBe(422);
    expect(demais.body.campos.linhas[0]).toMatch(new RegExp(`No máximo ${n} linhas`));
  }, 300_000);

  it('o erro que só aparece na gravação (o preço sem "Alterar preço" na última linha) volta com a linha e desfaz tudo', async () => {
    const n = LIMITE_LINHAS_CADASTRO_MASSA;
    // Quem cria e edita produto, mas não altera preço com "Altera Preço do Produto no ERP" desligado: a conferência
    // não olha o preço (é o `atualizarProduto` que confere), então o erro chega depois de gravadas as outras linhas.
    const [{ id: perfil }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('teste_tardio', 'teste', 'teste_tardio') returning id",
    )) as [{ id: string }];
    for (const permissao of [
      'produtos.cadastro_massa',
      'produtos.criar',
      'produtos.editar',
      'estoque_acertos.criar',
    ])
      await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
        perfil,
        permissao,
      ]);
    await criarUsuario(emp.nomeBanco, {
      login: 'massa_tardio',
      perfil: 'teste_tardio',
      lojas: [loja],
      estoques: [estoqueLoja],
    });
    const token = await amb.entrar(emp.codigo, 'massa_tardio', SENHA_TESTE);
    const codigo = ean(980);
    const id = await produto('MASSA TARDIO EXISTENTE TESTE', {
      codigosBarras: [{ codigo, principal: true }],
    });
    const achado = ((await pesquisar(estoqueLoja, [codigo])).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    const linhas = [
      ...Array.from({ length: n - 1 }, (_, i) => ({
        ean: ean(20_000 + i),
        nome: `MASSA TARDIO ${String(i).padStart(3, '0')} TESTE`,
        unidadeId: un,
        precoVenda: '5',
        estoque: '1',
      })),
      { produtoId: id, versao: achado.versao, ean: codigo, precoVenda: '9', estoque: '1' },
    ];
    const acertosAntes = await contarAcertosMassa();
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.altera_preco_produto_erp', 'false')`,
    );
    try {
      const r = await gravar({ estoqueId: estoqueLoja, linhas }, token);
      expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(403);
      expect(r.body.mensagem).toMatch(new RegExp(`^Linha ${n}: Alterar preço`));
      expect(r.body.campos[`linhas.${n - 1}._linha`][0]).toMatch(/Alterar preço/);
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where escopo = 'empresa' and chave = 'geral.altera_preco_produto_erp'",
      );
    }
    expect(await contarProdutos('MASSA TARDIO 0')).toBe(0);
    expect(await contarAcertosMassa()).toBe(acertosAntes);
    expect((await saldo(estoqueLoja, id))?.quantidade ?? '0.000').toBe('0.000');
    const [cad] = await consultar<{ preco_venda: string }>(
      emp.nomeBanco,
      'select preco_venda::text from produtos where id = $1',
      [id],
    );
    expect(cad!.preco_venda).toBe('8.0000');
  }, 300_000);

  it('EAN de produto novo já cadastrado: "bloquear" não grava nada (nem a marca nova); "avisar" pede a confirmação e grava', async () => {
    const codigo = ean(700);
    await produto('MASSA EAN EXISTENTE TESTE', { codigosBarras: [{ codigo, principal: true }] });
    const corpo = {
      estoqueId: estoqueLoja,
      linhas: [
        {
          ean: ean(701),
          nome: 'MASSA EAN OUTRO TESTE',
          unidadeId: un,
          precoVenda: '3',
          marcaNova: 'Marca Bloqueio Teste',
        },
        { ean: codigo, nome: 'MASSA EAN REPETIDO TESTE', unidadeId: un, precoVenda: '3', estoque: '2' },
      ],
    };
    const bloq = await gravar(corpo);
    expect(bloq.status, JSON.stringify(bloq.body)).toBe(409);
    expect(bloq.body.detalhes.eanDuplicado).toMatchObject({ modo: 'bloquear', confirmar: false });
    expect(bloq.body.campos['linhas.1.ean'][0]).toMatch(/já está no produto/);
    expect(await contarProdutos('MASSA EAN OUTRO')).toBe(0);
    expect(
      await consultar(emp.nomeBanco, "select 1 from marcas where descricao = 'Marca Bloqueio Teste'"),
    ).toHaveLength(0);

    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"')`,
    );
    try {
      const aviso = await gravar(corpo);
      expect(aviso.status, JSON.stringify(aviso.body)).toBe(409);
      expect(aviso.body.detalhes.eanDuplicado).toMatchObject({ modo: 'avisar', confirmar: true });
      expect(await contarProdutos('MASSA EAN ')).toBe(1);
      const conf = await gravar({ ...corpo, confirmarEanDuplicado: true });
      expect(conf.status, JSON.stringify(conf.body)).toBe(201);
      expect(conf.body).toMatchObject({ criados: 2, marcasCriadas: 1 });
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where escopo = 'empresa' and chave = 'geral.ean_duplicado'",
      );
    }
  });

  it('a grade recusa o EAN repetido e o produto novo incompleto pelo contrato', async () => {
    const r = await gravar({
      estoqueId: estoqueLoja,
      linhas: [
        { ean: ean(800), nome: 'MASSA REPETIDA A', unidadeId: un, precoVenda: '1' },
        { ean: ean(800), nome: 'MASSA REPETIDA B', unidadeId: un, precoVenda: '1' },
        { nome: 'X', precoVenda: '0' },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.campos['linhas.1.ean'][0]).toMatch(/EAN repetido na grade \(linha 1\)/);
    expect(r.body.campos['linhas.2.unidadeId']).toBeDefined();
    expect(r.body.campos['linhas.2.precoVenda']).toBeDefined();
  });

  it('permissões: sem produtos.cadastro_massa é 403; o estoque fora dos permitidos é 403', async () => {
    const linhas = [
      { ean: ean(900), nome: 'MASSA PERMISSAO TESTE', unidadeId: un, precoVenda: '1', estoque: '1' },
    ];
    expect((await gravar({ estoqueId: estoqueLoja, linhas }, tokenEstoquista)).status).toBe(403);
    expect((await pesquisar(estoqueLoja, [ean(900)], tokenEstoquista)).status).toBe(403);
    const fora = await gravar({ estoqueId: cd, linhas }, tokenGerenteLoja);
    expect(fora.status, JSON.stringify(fora.body)).toBe(403);
    expect((await pesquisar(cd, [ean(900)], tokenGerenteLoja)).status).toBe(403);
    const dentro = await gravar({ estoqueId: estoqueLoja, linhas }, tokenGerenteLoja);
    expect(dentro.status, JSON.stringify(dentro.body)).toBe(201);
  });

  it('perfil só com o cadastro em massa e o acerto: sem custo na pesquisa; soma estoque, mas não cria nem muda o cadastro', async () => {
    const [{ id: perfil }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('teste_massa', 'teste', 'teste_massa') returning id",
    )) as [{ id: string }];
    for (const permissao of ['produtos.cadastro_massa', 'estoque_acertos.criar'])
      await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
        perfil,
        permissao,
      ]);
    await criarUsuario(emp.nomeBanco, {
      login: 'so_massa',
      perfil: 'teste_massa',
      lojas: [loja],
      estoques: [estoqueLoja],
    });
    const token = await amb.entrar(emp.codigo, 'so_massa', SENHA_TESTE);
    const codigo = ean(910);
    const id = await produto('MASSA SO ESTOQUE TESTE', { codigosBarras: [{ codigo, principal: true }] });
    const achado = ((await pesquisar(estoqueLoja, [codigo], token)).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    expect(achado).toMatchObject({ id, precoCusto: null, markupPct: null, precoVenda: '8.0000' });
    const linha = {
      produtoId: id,
      versao: achado.versao,
      ean: codigo,
      nome: achado.nome,
      precoVenda: '8,00',
    };
    const so = await gravar({ estoqueId: estoqueLoja, linhas: [{ ...linha, estoque: '3' }] }, token);
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect((await saldo(estoqueLoja, id))!.quantidade).toBe('3.000');
    const preco = await gravar({ estoqueId: estoqueLoja, linhas: [{ ...linha, precoVenda: '9' }] }, token);
    expect(preco.status, JSON.stringify(preco.body)).toBe(403);
    expect(preco.body.mensagem).toMatch(/Produtos: Editar/);
    const novo = await gravar(
      { estoqueId: estoqueLoja, linhas: [{ nome: 'MASSA SO NOVO', unidadeId: un, precoVenda: '1' }] },
      token,
    );
    expect(novo.status).toBe(403);
    expect(novo.body.mensagem).toMatch(/Produtos: Criar/);
  });

  it('a linha só de estoque com o corpo inteiro que o ERP monta (o custo de 4 casas) não regrava o cadastro, nem pede "Produtos: Editar"', async () => {
    const [{ id: perfil }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('teste_so_estoque', 'teste', 'teste_so_estoque') returning id",
    )) as [{ id: string }];
    for (const permissao of ['produtos.cadastro_massa', 'estoque_acertos.criar', 'produtos.ver_custo'])
      await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
        perfil,
        permissao,
      ]);
    await criarUsuario(emp.nomeBanco, {
      login: 'so_estoque_custo',
      perfil: 'teste_so_estoque',
      lojas: [loja],
      estoques: [estoqueLoja],
    });
    const token = await amb.entrar(emp.codigo, 'so_estoque_custo', SENHA_TESTE);
    const codigo = ean(990);
    // O custo de um recebimento (o fardo de 41,48 por 12): 4 casas.
    const id = await produto('MASSA CUSTO 4 CASAS TESTE', {
      codigosBarras: [{ codigo, principal: true }],
      precoCusto: '3.4567',
      categoriaPrincipalId: categoria,
      categorias: [categoria],
    });
    const achado = ((await pesquisar(estoqueLoja, [codigo], token)).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    expect(achado).toMatchObject({ precoCusto: '3.4567', categoriaId: categoria });
    // Os valores gravados de volta, como a grade mandava antes de mandar nulo no que não mudou.
    const r = await gravar(
      {
        estoqueId: estoqueLoja,
        linhas: [
          {
            produtoId: id,
            versao: achado.versao,
            ean: codigo,
            nome: achado.nome,
            unidadeId: achado.unidadeId,
            ncm: achado.ncm,
            marcaId: achado.marcaId,
            categoriaId: achado.categoriaId,
            precoCusto: achado.precoCusto,
            markupPct: achado.markupPct,
            precoVenda: achado.precoVenda,
            estoque: '24',
          },
        ],
      },
      token,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ criados: 0, atualizados: 1, acerto: { itens: 1 } });
    const depois = ((await pesquisar(estoqueLoja, [codigo], token)).body as RespostaPesquisaEanCadastroMassa)
      .itens[0]!.produtos[0]!;
    expect(depois).toMatchObject({ versao: achado.versao, precoCusto: '3.4567' });
    expect(
      await consultar(
        emp.nomeBanco,
        "select 1 from produtos_historico_precos where produto_id = $1 and origem = 'cadastro_massa'",
        [id],
      ),
    ).toHaveLength(0);
    // A Entrada ao custo gravado, sem arredondar.
    expect(await saldo(estoqueLoja, id)).toEqual({ quantidade: '24.000', custo_medio: '3.4567' });
  });

  it('concorrência com o push do PDV: 10 gravações somando 2 junto de 10 vendas de 1, todas terminam e o saldo fecha', async () => {
    const codigo = ean(950);
    const id = await produto('MASSA CONCORRENCIA TESTE', { codigosBarras: [{ codigo, principal: true }] });
    const p = await novoPonto();
    for (let i = 0; i < 10; i++) {
      const achado = ((await pesquisar(estoqueLoja, [codigo])).body as RespostaPesquisaEanCadastroMassa)
        .itens[0]!.produtos[0]!;
      const [g, v] = await Promise.all([
        gravar({
          estoqueId: estoqueLoja,
          linhas: [
            { produtoId: id, versao: achado.versao, ean: codigo, precoVenda: String(8 + i), estoque: '2' },
            {
              ean: ean(960 + i),
              nome: `MASSA CONCORRENCIA NOVO ${i}`,
              unidadeId: un,
              precoVenda: '2',
              estoque: '1',
            },
          ],
        }),
        push(p, 'venda.finalizada', venda(p, id)),
      ]);
      expect(g.status, JSON.stringify(g.body)).toBe(201);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.resultados[0]).toMatchObject({ status: 'aplicado' });
    }
    expect((await saldo(estoqueLoja, id))!.quantidade).toBe('10.000');
    expect(await contarProdutos('MASSA CONCORRENCIA NOVO')).toBe(10);
  }, 180_000);

  it('o razão refaz as projeções idênticas (db:recalcular-saldos)', async () => {
    const { movimentos: n } = await conferirRazaoDoBanco(emp.nomeBanco);
    expect(n).toBeGreaterThan(0);
  });
});
