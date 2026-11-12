/**
 * Protocolo do PDV da Fase 2 (F2-B45; SYNC 6.12, 17.2; MD 6.2, 3.6.8; README da API › decisões 191 e 192), pelas rotas
 * reais, com o S3 em memória e imagens geradas na hora (nada de foto real: o repositório é público). Critério de pronto
 * do lado da API: o pull do `catalogo` traz `foto_url` e `foto_sha256` (e `imagem_*` na categoria, `logotipo_*` na
 * marca), estáveis entre dois pulls, e o terminal baixa a variante pelo `/sync/arquivos`.
 *
 * Também: o download com o `Content-Type` fixo, `nosniff`, o `ETag` com o sha256 e o `304`; o terminal de outra loja
 * da mesma empresa baixa a foto do produto (o catálogo desce a todas), o de outra empresa recebe 404; o envio solto,
 * o de outra categoria (logotipo da loja), o do produto excluído, o id inválido e o desconhecido 404; a variante
 * ausente ou outra 400; sem token 401; o terminal em desativação 403; o limite por terminal 429. E os complementos:
 * os CHECKs da MD 3.6.8, a exclusão física recusada (DELETE e TRUNCATE), a inativação que desce como tombstone e as
 * duas tabelas no pull com todas as colunas.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ArquivoInfo, Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imagemTeste } from '../fixtures/imagens.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.ARQUIVOS_ENVIOS_POR_MINUTO = '1000';
process.env.SYNC_ARQUIVOS_POR_MINUTO = '1000';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let s3: S3Falso | null = null;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.12.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

interface Empresa {
  emp: EmpresaTeste;
  tokenAdmin: string;
  numeroCaixa: number;
}

interface Ponto {
  terminal: string;
  token: string;
}

async function novaEmpresa(): Promise<Empresa> {
  const emp = await amb.criarEmpresa();
  return { emp, tokenAdmin: await amb.entrar(emp.codigo, 'admin', emp.senha), numeroCaixa: 0 };
}

async function novoPonto(e: Empresa, loja: string): Promise<Ponto> {
  const numero = ++e.numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    e.emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set({ Authorization: `Bearer ${e.tokenAdmin}` })
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: e.emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { terminal: r.body.terminal_id as string, token: r.body.token as string };
}

let lado = 60;
async function enviar(e: Empresa, query: string): Promise<ArquivoInfo> {
  const r = await amb
    .http()
    .post(`/api/arquivos?${query}`)
    .set({ Authorization: `Bearer ${e.tokenAdmin}` })
    .attach('arquivo', await imagemTeste(lado++, 40, 'png'), {
      filename: 'img.png',
      contentType: 'image/png',
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as ArquivoInfo;
}

interface Alteracao {
  tabela: string;
  versao: number;
  linha: Record<string, unknown>;
}

async function puxarCatalogo(
  tk: string,
  desde = 0,
): Promise<{ alteracoes: Alteracao[]; novo_cursor: number }> {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (;;) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=catalogo&desde=${cursor}&limite=500`)
      .set(cabecalhos(tk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor as number;
    if (!r.body.tem_mais) return { alteracoes, novo_cursor: cursor };
  }
}

const linhaDe = (alts: Alteracao[], tabela: string, id: string) =>
  alts.filter((a) => a.tabela === tabela && a.linha.id === id).at(-1)?.linha;

const baixar = (tk: string, id: string, extra: Record<string, string> = {}, query = '?variante=pdv_256') =>
  amb
    .http()
    .get(`/sync/arquivos/${id}${query}`)
    .set({ ...cabecalhos(tk), ...extra })
    .buffer(true)
    .parse((res, ok) => {
      const partes: Buffer[] = [];
      res.on('data', (d: Buffer) => partes.push(d));
      res.on('end', () => ok(null, Buffer.concat(partes)));
    });

const erroDe = (r: { body: unknown }) => JSON.parse((r.body as Buffer).toString('utf8')).erro;

let a: Empresa;
let b: Empresa;
let loja1: string;
let loja2: string;
let ponto: Ponto;
let pontoLoja2: Ponto;
let pontoOutra: Ponto;
let un: string;
let foto: ArquivoInfo;
let logo: ArquivoInfo;
let imagem: ArquivoInfo;
let produto: string;
let semFoto: string;
let marca: string;
let categoria: string;

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-sync-arquivos-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  a = await novaEmpresa();
  b = await novaEmpresa();
  loja1 = await criarLoja(a.emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(a.emp.nomeBanco, 2, 'Loja 2');
  const lojaB = await criarLoja(b.emp.nomeBanco, 1, 'Loja B');
  ponto = await novoPonto(a, loja1);
  pontoLoja2 = await novoPonto(a, loja2);
  pontoOutra = await novoPonto(b, lojaB);
  const unidades = (
    await amb
      .http()
      .get('/api/referencias/unidades')
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
  ).body as Array<{ id: string; sigla: string }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;

  foto = await enviar(a, 'destino=produto_foto');
  logo = await enviar(a, 'destino=marca_logotipo');
  imagem = await enviar(a, 'destino=categoria_imagem');
  const m = await amb
    .http()
    .post('/api/marcas')
    .set({ Authorization: `Bearer ${a.tokenAdmin}` })
    .send({ descricao: 'CERVEJARIA FICTICIA', logotipoArquivoId: logo.id });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  marca = m.body.id as string;
  const c = await amb
    .http()
    .post('/api/categorias')
    .set({ Authorization: `Bearer ${a.tokenAdmin}` })
    .send({ nome: 'Cervejas', imagemArquivoId: imagem.id });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  categoria = c.body.id as string;
  const criar = async (nome: string, extra: Record<string, unknown> = {}) => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({ nome, unidadeId: un, precoVenda: '6.9', ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  produto = await criar('CERV FICTICIA LN 355', { fotoPrincipalArquivoId: foto.id, marcaId: marca });
  semFoto = await criar('AGUA FICTICIA 500');
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

describe('campos calculados das imagens no pull do catalogo (MD 6.2; SYNC 6.12)', () => {
  it('foto_url e foto_sha256 no produto, imagem_* na categoria e logotipo_* na marca (critério de pronto)', async () => {
    const { alteracoes } = await puxarCatalogo(ponto.token);
    const p = linhaDe(alteracoes, 'produtos', produto)!;
    expect(p.foto_principal_arquivo_id).toBe(foto.id);
    expect(p.foto_url).toBe(`/sync/arquivos/${foto.id}?variante=pdv_256`);
    expect(p.foto_sha256).toBe(foto.variantes.pdv_256!.sha256);
    expect(p.foto_sha256).toMatch(/^[0-9a-f]{64}$/);
    // O sha256 é o da variante, não o do original (o caixa confere o que baixa).
    expect(p.foto_sha256).not.toBe(foto.sha256);
    const sem = linhaDe(alteracoes, 'produtos', semFoto)!;
    expect(sem).toMatchObject({ foto_url: null, foto_sha256: null });
    expect(linhaDe(alteracoes, 'marcas', marca)).toMatchObject({
      logotipo_url: `/sync/arquivos/${logo.id}?variante=pdv_256`,
      logotipo_sha256: logo.variantes.pdv_256!.sha256,
    });
    expect(linhaDe(alteracoes, 'categorias', categoria)).toMatchObject({
      imagem_url: `/sync/arquivos/${imagem.id}?variante=pdv_256`,
      imagem_sha256: imagem.variantes.pdv_256!.sha256,
    });
  });

  it('foto_url é estável entre dois pulls (nunca URL assinada) e não gera versão nova', async () => {
    const primeiro = await puxarCatalogo(ponto.token);
    const segundo = await puxarCatalogo(pontoLoja2.token);
    const p1 = linhaDe(primeiro.alteracoes, 'produtos', produto)!;
    const p2 = linhaDe(segundo.alteracoes, 'produtos', produto)!;
    expect(p2.foto_url).toBe(p1.foto_url);
    expect(p2.versao).toBe(p1.versao);
    // A partir do cursor, nada novo: a projeção não muda a linha.
    const depois = await puxarCatalogo(ponto.token, primeiro.novo_cursor);
    expect(depois.alteracoes.filter((x) => x.tabela === 'produtos')).toEqual([]);
  });

  it('trocar a foto troca o id na linha: versão nova, URL e sha256 novos', async () => {
    const { novo_cursor } = await puxarCatalogo(ponto.token);
    const nova = await enviar(a, 'destino=produto_foto');
    const d = (
      await amb
        .http()
        .get(`/api/produtos/${semFoto}`)
        .set({ Authorization: `Bearer ${a.tokenAdmin}` })
    ).body as { nome: string; unidadeId: string; precoVenda: string; versao: number };
    const r = await amb
      .http()
      .put(`/api/produtos/${semFoto}`)
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({
        nome: d.nome,
        unidadeId: d.unidadeId,
        precoVenda: d.precoVenda,
        versao: d.versao,
        fotoPrincipalArquivoId: nova.id,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { alteracoes } = await puxarCatalogo(ponto.token, novo_cursor);
    expect(linhaDe(alteracoes, 'produtos', semFoto)).toMatchObject({
      foto_url: `/sync/arquivos/${nova.id}?variante=pdv_256`,
      foto_sha256: nova.variantes.pdv_256!.sha256,
    });
  });
});

describe('GET /sync/arquivos/{id}?variante=pdv_256 (SYNC 6.12)', () => {
  it('o terminal baixa a variante: Content-Type fixo, nosniff, ETag com o sha256; If-None-Match igual → 304', async () => {
    const r = await baixar(ponto.token, foto.id);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['etag']).toBe(`"${foto.variantes.pdv_256!.sha256}"`);
    expect(r.headers['content-disposition']).toBe(`inline; filename="${foto.id}.pdv_256.webp"`);
    expect(r.headers['x-agora-servidor']).toBeTruthy();
    const corpo = r.body as Buffer;
    expect(sha(corpo)).toBe(foto.variantes.pdv_256!.sha256);
    expect(corpo.subarray(8, 12).toString('ascii')).toBe('WEBP');

    const n = await baixar(ponto.token, foto.id, { 'If-None-Match': `"${foto.variantes.pdv_256!.sha256}"` });
    expect(n.status).toBe(304);
    expect((n.body as Buffer).length).toBe(0);
    const outroEtag = await baixar(ponto.token, foto.id, { 'If-None-Match': '"0000"' });
    expect(outroEtag.status).toBe(200);
    // O id em maiúsculas é o mesmo arquivo.
    expect((await baixar(ponto.token, foto.id.toUpperCase())).status).toBe(200);
  });

  it('a marca e a categoria também; o terminal de outra loja da empresa baixa a foto do produto', async () => {
    for (const arq of [logo, imagem]) {
      const r = await baixar(ponto.token, arq.id);
      expect(r.status).toBe(200);
      expect(sha(r.body as Buffer)).toBe(arq.variantes.pdv_256!.sha256);
    }
    expect((await baixar(pontoLoja2.token, foto.id)).status).toBe(200);
  });

  it('terminal de outra empresa recebe 404 (o arquivo não existe no banco dele)', async () => {
    const r = await baixar(pontoOutra.token, foto.id);
    expect(r.status).toBe(404);
    expect(erroDe(r).codigo).toBe('NAO_ENCONTRADO');
  });

  it('envio solto, logotipo da loja, produto excluído, id inválido ou desconhecido → 404', async () => {
    const solto = await enviar(a, 'destino=produto_foto');
    const daLoja = await enviar(a, `destino=loja_logotipo&lojaId=${loja1}`);
    const excluido = await enviar(a, 'destino=produto_foto');
    const r = await amb
      .http()
      .post('/api/produtos')
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({
        nome: 'PRODUTO FICTICIO EXCLUIDO',
        unidadeId: un,
        precoVenda: '1',
        fotoPrincipalArquivoId: excluido.id,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await baixar(ponto.token, excluido.id)).status).toBe(200);
    await consultar(a.emp.nomeBanco, 'update produtos set excluido_em = now() where id = $1', [r.body.id]);
    for (const id of [
      solto.id,
      daLoja.id,
      excluido.id,
      'nao-e-uuid',
      '01928f3a-0000-7000-8000-00000000dead',
    ]) {
      const x = await baixar(ponto.token, id);
      expect(x.status, id).toBe(404);
      expect(erroDe(x).codigo, id).toBe('NAO_ENCONTRADO');
    }
  });

  it('sem a variante do caixa → 400; sem token → 401', async () => {
    for (const q of ['', '?variante=original', '?variante=cupom_mono']) {
      const x = await baixar(ponto.token, foto.id, {}, q);
      expect(x.status, q).toBe(400);
      expect(erroDe(x).codigo).toBe('REQUISICAO_INVALIDA');
    }
    const semToken = await amb.http().get(`/sync/arquivos/${foto.id}?variante=pdv_256`).set(cabecalhos());
    expect(semToken.status).toBe(401);
  });

  it('limite por terminal: 429 com Retry-After', async () => {
    const p = await novoPonto(a, loja2);
    const q = await novoPonto(a, loja2);
    process.env.SYNC_ARQUIVOS_POR_MINUTO = '2';
    try {
      expect((await baixar(p.token, foto.id)).status).toBe(200);
      expect((await baixar(p.token, foto.id)).status).toBe(200);
      const x = await baixar(p.token, foto.id);
      expect(x.status).toBe(429);
      expect(x.headers['retry-after']).toBe('60');
      // O limite é do terminal: o outro caixa segue baixando.
      expect((await baixar(q.token, foto.id)).status).toBe(200);
    } finally {
      process.env.SYNC_ARQUIVOS_POR_MINUTO = '1000';
    }
  });

  it('terminal em desativação: 403 como no pull do catalogo', async () => {
    const p = await novoPonto(a, loja2);
    expect((await baixar(p.token, foto.id)).status).toBe(200);
    const rev = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({ modo: 'aceitar_pendencias' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const x = await baixar(p.token, foto.id);
    expect(x.status).toBe(403);
    expect(erroDe(x).codigo).toBe('ESCOPO_INVALIDO');
  });
});

describe('complementos (MD 3.6.8; F2-Q1 = D43)', () => {
  let grupo: string;
  let opcao: string;

  const inserirGrupo = (campos: string, valores: string) =>
    consultar<{ id: string }>(
      a.emp.nomeBanco,
      `insert into produtos_grupos_complementos (produto_id, nome${campos}) values ($1, 'Gelo'${valores}) returning id`,
      [produto],
    );
  const inserirOpcao = (campos: string, valores: string, g = grupo) =>
    consultar<{ id: string }>(
      a.emp.nomeBanco,
      `insert into produtos_complementos (grupo_id${campos}) values ($1${valores}) returning id`,
      [g],
    );

  it('descem no pull do catalogo com todas as colunas', async () => {
    const { novo_cursor } = await puxarCatalogo(ponto.token);
    grupo = (await inserirGrupo(', minimo, maximo, obrigatorio', ', 1, 2, true'))[0]!.id;
    opcao = (
      await inserirOpcao(', produto_id, preco_adicional, baixa_estoque', `, '${semFoto}', '1.5000', true`)
    )[0]!.id;
    const livre = (await inserirOpcao(', descricao', ", 'Limão espremido'"))[0]!.id;
    const { alteracoes } = await puxarCatalogo(ponto.token, novo_cursor);
    expect(linhaDe(alteracoes, 'produtos_grupos_complementos', grupo)).toMatchObject({
      produto_id: produto,
      nome: 'Gelo',
      minimo: 1,
      maximo: 2,
      obrigatorio: true,
      ordem: 0,
      excluido_em: null,
    });
    expect(linhaDe(alteracoes, 'produtos_complementos', opcao)).toMatchObject({
      grupo_id: grupo,
      produto_id: semFoto,
      descricao: null,
      preco_adicional: '1.5000',
      baixa_estoque: true,
      quantidade_baixa: '1.000',
      ativo: true,
    });
    expect(linhaDe(alteracoes, 'produtos_complementos', livre)).toMatchObject({
      produto_id: null,
      descricao: 'Limão espremido',
    });
  });

  it('CHECKs: mínimo ≤ máximo, obrigatório ⇒ mínimo ≥ 1, vinculado ou livre, preço adicional ≥ 0', async () => {
    const recusas: Array<[() => Promise<unknown>, string]> = [
      [() => inserirGrupo(', minimo, maximo', ', 3, 2'), 'ck_produtos_grupos_complementos_quantidades'],
      [
        () => inserirGrupo(', obrigatorio, minimo', ', true, 0'),
        'ck_produtos_grupos_complementos_quantidades',
      ],
      [() => inserirGrupo(', minimo', ', -1'), 'ck_produtos_grupos_complementos_quantidades'],
      [() => inserirOpcao('', ''), 'ck_produtos_complementos_origem'],
      [() => inserirOpcao(', descricao, baixa_estoque', ", 'Livre', true"), 'ck_produtos_complementos_baixa'],
      [
        () => inserirOpcao(', descricao, preco_adicional', ", 'Livre', -0.01"),
        'ck_produtos_complementos_valores',
      ],
      [
        () => inserirOpcao(', descricao, quantidade_baixa', ", 'Livre', 0"),
        'ck_produtos_complementos_valores',
      ],
    ];
    for (const [fn, ck] of recusas)
      await expect(fn(), ck).rejects.toMatchObject({ code: '23514', constraint: ck });
  });

  it('exclusão física recusada (DELETE e TRUNCATE); a inativação desce como tombstone', async () => {
    // O `detail` é a tabela do trigger que recusou (`tg_table_name`): no truncate dos grupos, o `cascade` leva junto as
    // opções, cujo trigger também recusaria; os BEFORE TRUNCATE disparam primeiro na tabela citada, então o detail
    // separa os dois casos e prova que o trigger dos grupos existe.
    for (const [sql, tabela] of [
      [`delete from produtos_complementos where id = '${opcao}'`, 'produtos_complementos'],
      [`delete from produtos_grupos_complementos where id = '${grupo}'`, 'produtos_grupos_complementos'],
      // `cascade`: sem ele o PostgreSQL já recusa pela FK; com ele o trigger recusa antes de esvaziar as vendas.
      ['truncate produtos_complementos cascade', 'produtos_complementos'],
      ['truncate produtos_grupos_complementos cascade', 'produtos_grupos_complementos'],
    ] as const) {
      await expect(consultar(a.emp.nomeBanco, sql), sql).rejects.toMatchObject({
        code: 'P0001',
        message: 'EXCLUSAO_FISICA_PROIBIDA',
        detail: tabela,
      });
    }
    const { novo_cursor } = await puxarCatalogo(ponto.token);
    await consultar(a.emp.nomeBanco, 'update produtos_complementos set excluido_em = now() where id = $1', [
      opcao,
    ]);
    const { alteracoes } = await puxarCatalogo(ponto.token, novo_cursor);
    expect(linhaDe(alteracoes, 'produtos_complementos', opcao)?.excluido_em).toBeTruthy();
  });

  it('itens_venda_complementos.complemento_id → produtos_complementos com on delete set null', async () => {
    const [fk] = await consultar<{ alvo: string; acao: string }>(
      a.emp.nomeBanco,
      `select confrelid::regclass::text as alvo, confdeltype as acao from pg_constraint
        where conname = 'fk_itens_venda_complementos_complemento_id'`,
    );
    expect(fk).toEqual({ alvo: 'produtos_complementos', acao: 'n' });
  });
});
