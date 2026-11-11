/**
 * Foto e imagens do produto, categorias e marcas completas (Fase 2, F2-B44; ERP 8.2.6, 8.4, 8.7; README da API ›
 * decisão 190), com o S3 em memória e imagens geradas na hora (nada de foto real: o repositório é público). Critério de
 * pronto: o produto tem foto, "Cervejas long neck" é arrastada para dentro de "Cervejas" e reordenada, e a marca mostra
 * o logotipo e imprime a ficha.
 *
 * Também: a galeria do produto (incluir, reordenar, tirar, o corpo sem os campos mantém, `null` tira a foto), a
 * versão do cadastro que conta a galeria (409), o anexo de outro destino, de outro cadastro ou de outra empresa (422
 * no campo, nada gravado, nem a ligação do envio válido que veio antes na galeria), a auditoria legível; a atualização
 * parcial ("Definir NCM", cadastro em massa e importação, pelo `entradaDoDetalhe`) mantém a foto e a galeria; a reordenação das irmãs com a versão de cada uma (409 com a versão
 * velha, com a irmã nova que a lista não traz, com a categoria movida ou excluída no meio; 404 para o id de outra
 * empresa; nada muda no erro), sem mexer no caminho nem no nível, só as que mudaram com versão nova e auditoria; o
 * mover sem ciclo; e a ficha da marca (outra empresa 404, sem `produtos.ver` 403).
 */
import {
  calcularDvGtin,
  criarProdutoSchema,
  type ArquivoInfo,
  type CategoriaNo,
  type FichaMarca,
  type ProdutoDetalhe,
  type RespostaPesquisaEanCadastroMassa,
} from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entradaDoDetalhe } from '../../src/produtos/produtos.controller.js';
import { imagemTeste } from '../fixtures/imagens.js';
import {
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.ARQUIVOS_ENVIOS_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let outra: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let adminOutra: string;
let estoquista: string;
let vendedor: string;
let un: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-imagens-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  outra = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  adminOutra = await amb.entrar(outra.codigo, 'admin', outra.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor' });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer(admin))).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

let lado = 40;
/** Envia uma imagem gerada (cada uma de um tamanho, para o sha256 mudar) e devolve o id. */
async function enviar(destino: string, token = admin): Promise<string> {
  const r = await amb
    .http()
    .post(`/api/arquivos?destino=${destino}`)
    .set(bearer(token))
    .attach('arquivo', await imagemTeste(lado++, 30, 'png'), {
      filename: 'img.png',
      contentType: 'image/png',
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as ArquivoInfo).id;
}

const registroDoArquivo = async (id: string, banco = emp.nomeBanco) =>
  (
    await consultar<{ registro_id: string | null }>(banco, 'select registro_id from arquivos where id = $1', [
      id,
    ])
  )[0]?.registro_id;

const produto = async (id: string) =>
  (await amb.http().get(`/api/produtos/${id}`).set(bearer(admin))).body as ProdutoDetalhe;

/** O corpo do PUT a partir do detalhe (o que o formulário manda), com as mudanças. */
const corpoProduto = (d: ProdutoDetalhe, extra: Record<string, unknown>) => ({
  nome: d.nome,
  unidadeId: d.unidadeId,
  precoVenda: d.precoVenda,
  versao: d.versao,
  ...extra,
});

describe('foto e galeria do produto', () => {
  let p: string;
  let foto: string;
  let g1: string;
  let g2: string;
  let g3: string;

  it('o produto tem foto (critério de pronto): o envio fica ligado ao produto e a galeria na ordem', async () => {
    foto = await enviar('produto_foto');
    g1 = await enviar('produto_foto');
    g2 = await enviar('produto_foto');
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        nome: 'CERV FICTICIA LN 355',
        unidadeId: un,
        precoVenda: '6.9',
        fotoPrincipalArquivoId: foto.toUpperCase(),
        imagens: [g1, g2],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = (r.body as ProdutoDetalhe).id;
    expect(r.body).toMatchObject({
      fotoPrincipalArquivoId: foto,
      imagens: [
        { arquivoId: g1, ordem: 1 },
        { arquivoId: g2, ordem: 2 },
      ],
    });
    for (const a of [foto, g1, g2]) expect(await registroDoArquivo(a)).toBe(p);
    const [col] = await consultar<{ foto_principal_arquivo_id: string }>(
      emp.nomeBanco,
      'select foto_principal_arquivo_id from produtos where id = $1',
      [p],
    );
    expect(col!.foto_principal_arquivo_id).toBe(foto);
    // A miniatura da foto, pela API (o ERP a mostra no formulário).
    const c = await amb.http().get(`/api/arquivos/${foto}/conteudo?variante=pdv_256`).set(bearer(admin));
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toBe('image/webp');
  });

  it('reordena, tira e inclui na galeria; a auditoria conta a mudança e a versão do cadastro sobe', async () => {
    const antes = await produto(p);
    g3 = await enviar('produto_foto');
    const r = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(antes, { imagens: [g3, g2] }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    expect(d.imagens.map((i) => [i.arquivoId, i.ordem])).toEqual([
      [g3, 1],
      [g2, 1 + 1],
    ]);
    expect(d.fotoPrincipalArquivoId).toBe(foto);
    expect(d.versao).toBeGreaterThan(antes.versao);
    // A linha que saiu fica excluída logicamente (o arquivo continua guardado).
    const [g1Linha] = await consultar<{ excluido_em: Date | null }>(
      emp.nomeBanco,
      'select excluido_em from produtos_imagens where produto_id = $1 and arquivo_id = $2',
      [p, g1],
    );
    expect(g1Linha!.excluido_em).not.toBeNull();
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'
        order by criado_em desc limit 1`,
      [p],
    );
    expect(aud!.descricao).toContain('Imagem da galeria removida (posição 1)');
    expect(aud!.descricao).toContain('Imagem da galeria adicionada (posição 1)');
  });

  it('a versão velha depois de mexer só na galeria é 409 (a versão do cadastro conta as imagens)', async () => {
    const d = await produto(p);
    const r1 = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(d, { imagens: [g2, g3] }));
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const r2 = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(d, { imagens: [g3, g2] }));
    expect(r2.status).toBe(409);
    expect(r2.body.codigo).toBe('CONFLITO_VERSAO');
    expect((await produto(p)).imagens.map((i) => i.arquivoId)).toEqual([g2, g3]);
  });

  it('o corpo sem a foto e sem a galeria mantém as gravadas; null tira a foto e [] esvazia a galeria', async () => {
    let d = await produto(p);
    let r = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(d, { nome: 'CERV FICTICIA LN 355 GELADA' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ fotoPrincipalArquivoId: foto });
    expect((r.body as ProdutoDetalhe).imagens.map((i) => i.arquivoId)).toEqual([g2, g3]);
    d = r.body as ProdutoDetalhe;
    r = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(d, { fotoPrincipalArquivoId: null, imagens: [] }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ fotoPrincipalArquivoId: null, imagens: [] });
    // Volta a foto que já era dele (o arquivo continua do produto).
    d = r.body as ProdutoDetalhe;
    r = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(admin))
      .send(corpoProduto(d, { fotoPrincipalArquivoId: foto, imagens: [g1] }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ fotoPrincipalArquivoId: foto, imagens: [{ arquivoId: g1, ordem: 1 }] });
  });

  it('recusa o anexo de outro destino, de outro produto, de outra empresa e o inexistente (422, nada gravado)', async () => {
    const logo = await enviar('marca_logotipo');
    const daOutra = await enviar('produto_foto', adminOutra);
    const outroProduto = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ nome: 'AGUA FICTICIA 500ML', unidadeId: un, precoVenda: '2.5' });
    expect(outroProduto.status, JSON.stringify(outroProduto.body)).toBe(201);
    const antesTotal = (
      await consultar<{ n: number }>(emp.nomeBanco, 'select count(*)::int as n from produtos')
    )[0]!.n;
    // O envio válido antes do de outra empresa: o vincularArquivo já o ligou quando o segundo falha (o rollback desfaz).
    const valido = await enviar('produto_foto');
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ fotoPrincipalArquivoId: logo }, 'fotoPrincipalArquivoId'],
      [{ imagens: [foto] }, 'imagens.0'],
      [{ imagens: [valido, daOutra] }, 'imagens.1'],
      [{ fotoPrincipalArquivoId: '01928f3a-0000-7000-8000-00000000dead' }, 'fotoPrincipalArquivoId'],
    ];
    for (const [extra, campo] of casos) {
      const r = await amb
        .http()
        .post('/api/produtos')
        .set(bearer(admin))
        .send({ nome: 'CERV FICTICIA RECUSADA', unidadeId: un, precoVenda: '4', ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(Object.keys(r.body.campos)).toEqual([campo]);
    }
    // A foto de um produto também não vai para outro na alteração.
    const o = outroProduto.body as ProdutoDetalhe;
    const r = await amb
      .http()
      .put(`/api/produtos/${o.id}`)
      .set(bearer(admin))
      .send(corpoProduto(o, { fotoPrincipalArquivoId: foto }));
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos)).toEqual(['fotoPrincipalArquivoId']);
    expect(
      (await consultar<{ n: number }>(emp.nomeBanco, 'select count(*)::int as n from produtos'))[0]!.n,
    ).toBe(antesTotal);
    expect(await registroDoArquivo(logo)).toBeNull();
    expect(await registroDoArquivo(valido)).toBeNull();
    expect(await registroDoArquivo(daOutra, outra.nomeBanco)).toBeNull();
    // O produto de outra empresa não existe aqui.
    expect((await amb.http().get(`/api/produtos/${p}`).set(bearer(adminOutra))).status).toBe(404);
  });

  it('o estoquista (produtos.editar) grava a foto do produto', async () => {
    const d = await produto(p);
    const nova = await enviar('produto_foto', estoquista);
    const r = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(estoquista))
      .send(corpoProduto(d, { fotoPrincipalArquivoId: nova }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.fotoPrincipalArquivoId).toBe(nova);
  });
});

describe('a atualização parcial mantém a foto e a galeria (entradaDoDetalhe)', () => {
  let q: string;
  let foto: string;
  let ga: string;
  let gb: string;
  const codigo = (() => {
    const b = '789980000771';
    return `${b}${calcularDvGtin(b)}`;
  })();
  const imagensDe = (d: ProdutoDetalhe) => ({
    fotoPrincipalArquivoId: d.fotoPrincipalArquivoId,
    imagens: d.imagens.map((i) => [i.arquivoId, i.ordem]),
  });

  beforeAll(async () => {
    foto = await enviar('produto_foto');
    ga = await enviar('produto_foto');
    gb = await enviar('produto_foto');
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        nome: 'CERV FICTICIA PARCIAL 600',
        unidadeId: un,
        precoVenda: '9.9',
        codigosBarras: [{ codigo, principal: true }],
        fotoPrincipalArquivoId: foto,
        imagens: [ga, gb],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    q = (r.body as ProdutoDetalhe).id;
  });

  it('a base da atualização parcial não leva a foto nem a galeria, e passa no schema do formulário', async () => {
    const d = await produto(q);
    expect(d.imagens).toHaveLength(2);
    const base = entradaDoDetalhe(d);
    expect(base).not.toHaveProperty('fotoPrincipalArquivoId');
    expect(base).not.toHaveProperty('imagens');
    const r = criarProdutoSchema.safeParse(base);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('o "Definir NCM" em lote grava o NCM e mantém a foto e a galeria', async () => {
    const d = await produto(q);
    const r = await amb
      .http()
      .post('/api/relatorios/ncm-invalidos/definir-ncm')
      .set(bearer(admin))
      .send({ ncm: '22030000', produtos: [{ id: q, versao: d.versao }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const depois = await produto(q);
    expect(depois.ncm).toBe('22030000');
    expect(depois.versao).toBeGreaterThan(d.versao);
    expect(imagensDe(depois)).toEqual(imagensDe(d));
    expect(imagensDe(depois)).toEqual({
      fotoPrincipalArquivoId: foto,
      imagens: [
        [ga, 1],
        [gb, 2],
      ],
    });
  });

  it('a Atualização do cadastro em massa troca o preço e mantém a foto e a galeria', async () => {
    const d = await produto(q);
    const [{ id: estoqueId }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('Deposito Teste Imagens', 'deposito') returning id",
    )) as [{ id: string }];
    const p = await amb
      .http()
      .post('/api/produtos/cadastro-em-massa/pesquisar-ean')
      .set(bearer(admin))
      .send({ estoqueId, codigos: [codigo] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const achado = (p.body as RespostaPesquisaEanCadastroMassa).itens[0]!.produtos[0]!;
    const r = await amb
      .http()
      .post('/api/produtos/cadastro-em-massa')
      .set(bearer(admin))
      .send({
        estoqueId,
        linhas: [{ produtoId: q, versao: achado.versao, ean: codigo, precoVenda: '10,50' }],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const depois = await produto(q);
    expect(Number(depois.precoVenda)).toBe(10.5);
    expect(imagensDe(depois)).toEqual(imagensDe(d));
  });
});

describe('categorias: imagem, arrastar para dentro e reordenar as irmãs', () => {
  const ids = {} as { cervejas: string; vinhos: string; longNeck: string; lata: string };
  const arvore = async (token = admin) =>
    (await amb.http().get('/api/categorias/arvore').set(bearer(token))).body as CategoriaNo[];
  const no = async (id: string) => (await arvore()).find((n) => n.id === id)!;
  const criar = async (nome: string, extra: Record<string, unknown> = {}) => {
    const r = await amb
      .http()
      .post('/api/categorias')
      .set(bearer(admin))
      .send({ nome, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as CategoriaNo).id;
  };
  const reordenar = (
    categoriaPaiId: string | null,
    itens: Array<{ id: string; versao: number }>,
    token = admin,
  ) => amb.http().post('/api/categorias/reordenar').set(bearer(token)).send({ categoriaPaiId, itens });

  it('a imagem da categoria grava na criação e na alteração, e a de outro destino é recusada', async () => {
    const imagem = await enviar('categoria_imagem');
    ids.cervejas = await criar('Cervejas', { imagemArquivoId: imagem });
    expect((await no(ids.cervejas)).imagemArquivoId).toBe(imagem);
    expect(await registroDoArquivo(imagem)).toBe(ids.cervejas);
    ids.vinhos = await criar('Vinhos');
    ids.longNeck = await criar('Cervejas long neck');
    const v = await no(ids.vinhos);
    const recusa = await amb
      .http()
      .put(`/api/categorias/${ids.vinhos}`)
      .set(bearer(admin))
      .send({ nome: 'Vinhos', versao: v.versao, imagemArquivoId: imagem });
    expect(recusa.status).toBe(422);
    expect(Object.keys(recusa.body.campos)).toEqual(['imagemArquivoId']);
    const foto = await enviar('produto_foto');
    const outra = await amb
      .http()
      .put(`/api/categorias/${ids.vinhos}`)
      .set(bearer(admin))
      .send({ nome: 'Vinhos', versao: v.versao, imagemArquivoId: foto });
    expect(outra.status).toBe(422);
    const ok = await amb
      .http()
      .put(`/api/categorias/${ids.vinhos}`)
      .set(bearer(admin))
      .send({ nome: 'Vinhos', versao: v.versao, imagemArquivoId: await enviar('categoria_imagem') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Sem o campo, mantém; com null, tira.
    const mantida = await amb
      .http()
      .put(`/api/categorias/${ids.vinhos}`)
      .set(bearer(admin))
      .send({ nome: 'Vinhos', versao: (ok.body as CategoriaNo).versao });
    expect((mantida.body as CategoriaNo).imagemArquivoId).toBe((ok.body as CategoriaNo).imagemArquivoId);
    const tirada = await amb
      .http()
      .put(`/api/categorias/${ids.vinhos}`)
      .set(bearer(admin))
      .send({ nome: 'Vinhos', versao: (mantida.body as CategoriaNo).versao, imagemArquivoId: null });
    expect((tirada.body as CategoriaNo).imagemArquivoId).toBeNull();
  });

  it('"Cervejas long neck" é arrastada para dentro de "Cervejas" e reordenada (critério de pronto)', async () => {
    ids.lata = await criar('Cervejas lata', { categoriaPaiId: ids.cervejas, ordem: 20 });
    const ln = await no(ids.longNeck);
    // Arrastar para dentro: o mover com a ordem do fim da lista.
    const m = await amb
      .http()
      .post(`/api/categorias/${ids.longNeck}/mover`)
      .set(bearer(admin))
      .send({ versao: ln.versao, categoriaPaiId: ids.cervejas, ordem: 30 });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body).toMatchObject({
      categoriaPaiId: ids.cervejas,
      caminhoNomes: 'Cervejas > Cervejas long neck',
      nivel: 2,
    });
    // Soltar antes de "Cervejas lata": a lista inteira das irmãs na ordem nova.
    const lata = await no(ids.lata);
    const r = await reordenar(ids.cervejas, [
      { id: ids.longNeck, versao: (m.body as CategoriaNo).versao },
      { id: ids.lata, versao: lata.versao },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const filhas = (r.body as CategoriaNo[])
      .filter((n) => n.categoriaPaiId === ids.cervejas)
      .sort((a, b) => a.ordem - b.ordem);
    expect(filhas.map((f) => [f.nome, f.ordem, f.nivel, f.caminhoNomes])).toEqual([
      ['Cervejas long neck', 10, 2, 'Cervejas > Cervejas long neck'],
      ['Cervejas lata', 20, 2, 'Cervejas > Cervejas lata'],
    ]);
    // A lata já estava na 20: sem versão nova e sem auditoria; a long neck, uma linha "Categoria reordenada".
    expect(filhas[1]!.versao).toBe(lata.versao);
    const aud = await consultar<{ registro_id: string; antes: { ordem: number }; depois: { ordem: number } }>(
      emp.nomeBanco,
      `select registro_id, antes, depois from auditoria
        where entidade = 'categorias' and descricao = 'Categoria reordenada' order by criado_em`,
    );
    expect(aud.map((a) => [a.registro_id, a.antes.ordem, a.depois.ordem])).toEqual([[ids.longNeck, 30, 10]]);
  });

  it('as raízes também se reordenam (pai vazio)', async () => {
    const nos = (await arvore()).filter((n) => n.categoriaPaiId === null);
    const vinhos = nos.find((n) => n.id === ids.vinhos)!;
    const cervejas = nos.find((n) => n.id === ids.cervejas)!;
    const r = await reordenar(null, [
      { id: vinhos.id, versao: vinhos.versao },
      { id: cervejas.id, versao: cervejas.versao },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const raizes = (r.body as CategoriaNo[]).filter((n) => n.categoriaPaiId === null);
    expect(raizes.sort((a, b) => a.ordem - b.ordem).map((n) => n.nome)).toEqual(['Vinhos', 'Cervejas']);
  });

  it('versão velha, irmã nova fora da lista, categoria de outro pai ou excluída: 409 e nada muda', async () => {
    const ordens = async () =>
      Object.fromEntries((await arvore()).map((n) => [n.nome, [n.ordem, n.versao] as const]));
    const ln = await no(ids.longNeck);
    const lata = await no(ids.lata);
    const antes = await ordens();
    // Versão velha (outro usuário alterou a lata depois que a tela carregou).
    let r = await reordenar(ids.cervejas, [
      { id: ids.lata, versao: lata.versao - 1 },
      { id: ids.longNeck, versao: ln.versao },
    ]);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'CONFLITO_VERSAO', detalhes: { versaoAtual: lata.versao } });
    // A lista sem uma das irmãs (a irmã criada por outro no meio).
    r = await reordenar(ids.cervejas, [{ id: ids.lata, versao: lata.versao }]);
    expect(r.status).toBe(409);
    // A categoria de outro pai (movida por outro) na lista.
    const vinhos = await no(ids.vinhos);
    r = await reordenar(ids.cervejas, [
      { id: ids.lata, versao: lata.versao },
      { id: ids.longNeck, versao: ln.versao },
      { id: ids.vinhos, versao: vinhos.versao },
    ]);
    expect(r.status).toBe(409);
    // A excluída no meio.
    const extra = await criar('Cervejas sem álcool', { categoriaPaiId: ids.cervejas });
    const ex = await no(extra);
    expect((await amb.http().delete(`/api/categorias/${extra}`).set(bearer(admin))).status).toBe(204);
    r = await reordenar(ids.cervejas, [
      { id: ids.lata, versao: lata.versao },
      { id: ids.longNeck, versao: ln.versao },
      { id: extra, versao: ex.versao },
    ]);
    expect(r.status).toBe(409);
    expect(await ordens()).toEqual(antes);
  });

  it('o id de outra empresa é 404; sem categorias.editar é 403; o pai inexistente é 422', async () => {
    const lata = await no(ids.lata);
    const ln = await no(ids.longNeck);
    const r = await reordenar(
      ids.cervejas,
      [
        { id: ids.lata, versao: lata.versao },
        { id: ids.longNeck, versao: ln.versao },
      ],
      adminOutra,
    );
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos)).toEqual(['categoriaPaiId']);
    const raizOutra = await amb
      .http()
      .post('/api/categorias')
      .set(bearer(adminOutra))
      .send({ nome: 'Destilados' });
    expect(raizOutra.status).toBe(201);
    const r404 = await reordenar(null, [
      { id: raizOutra.body.id as string, versao: raizOutra.body.versao as number },
    ]);
    expect(r404.status).toBe(404);
    const r403 = await reordenar(ids.cervejas, [{ id: ids.lata, versao: lata.versao }], estoquista);
    expect(r403.status).toBe(403);
  });

  it('o mover não cria ciclo: "Cervejas" não entra na própria filha', async () => {
    const c = await no(ids.cervejas);
    const r = await amb
      .http()
      .post(`/api/categorias/${ids.cervejas}/mover`)
      .set(bearer(admin))
      .send({ versao: c.versao, categoriaPaiId: ids.longNeck });
    expect(r.status).toBe(422);
    expect((await no(ids.cervejas)).categoriaPaiId).toBeNull();
  });
});

describe('marcas: logotipo e ficha', () => {
  let marca: string;
  let logo: string;

  it('a marca mostra o logotipo e imprime a ficha com os produtos dela (critério de pronto)', async () => {
    logo = await enviar('marca_logotipo');
    const r = await amb
      .http()
      .post('/api/marcas')
      .set(bearer(admin))
      .send({ descricao: 'CERVEJARIA FICTICIA', logotipoArquivoId: logo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    marca = r.body.id as string;
    expect(r.body.logotipoArquivoId).toBe(logo);
    expect(await registroDoArquivo(logo)).toBe(marca);
    for (const [nome, ativo] of [
      ['PILSEN FICTICIA LT 350', true],
      ['ALE FICTICIA LN 355', false],
    ] as const) {
      const p = await amb
        .http()
        .post('/api/produtos')
        .set(bearer(admin))
        .send({
          nome,
          unidadeId: un,
          precoVenda: '5.5',
          precoCusto: '3.1',
          ativo,
          marcaId: marca,
          codigosBarras: [
            { codigo: nome.startsWith('PILSEN') ? '7891234567895' : '7890000000017', principal: true },
          ],
        });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
    }
    const f = await amb.http().get(`/api/marcas/${marca}/ficha`).set(bearer(admin));
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const ficha = f.body as FichaMarca;
    expect(ficha.marca).toMatchObject({
      descricao: 'CERVEJARIA FICTICIA',
      logotipoArquivoId: logo,
      produtos: 2,
    });
    expect(ficha.totalProdutos).toBe(2);
    expect(ficha.produtos.map((p) => [p.nome, p.ativo, p.ean, p.unidadeSigla, Number(p.precoVenda)])).toEqual(
      [
        ['ALE FICTICIA LN 355', false, '7890000000017', 'UN', 5.5],
        ['PILSEN FICTICIA LT 350', true, '7891234567895', 'UN', 5.5],
      ],
    );
    // Nada de custo na ficha.
    expect(JSON.stringify(ficha)).not.toMatch(/custo/i);
  });

  it('troca e tira o logotipo; recusa o de outro destino; a ficha: outra empresa 404, sem produtos.ver 403', async () => {
    const m = (await amb.http().get(`/api/marcas/${marca}`).set(bearer(admin))).body as { versao: number };
    const foto = await enviar('produto_foto');
    const recusa = await amb
      .http()
      .put(`/api/marcas/${marca}`)
      .set(bearer(admin))
      .send({ descricao: 'CERVEJARIA FICTICIA', versao: m.versao, logotipoArquivoId: foto });
    expect(recusa.status).toBe(422);
    expect(Object.keys(recusa.body.campos)).toEqual(['logotipoArquivoId']);
    const tirado = await amb
      .http()
      .put(`/api/marcas/${marca}`)
      .set(bearer(admin))
      .send({ descricao: 'CERVEJARIA FICTICIA', versao: m.versao, logotipoArquivoId: null });
    expect(tirado.status, JSON.stringify(tirado.body)).toBe(200);
    expect(tirado.body.logotipoArquivoId).toBeNull();
    const de = await amb
      .http()
      .put(`/api/marcas/${marca}`)
      .set(bearer(admin))
      .send({ descricao: 'CERVEJARIA FICTICIA', versao: tirado.body.versao, logotipoArquivoId: logo });
    expect(de.status, JSON.stringify(de.body)).toBe(200);
    expect(de.body.logotipoArquivoId).toBe(logo);
    expect((await amb.http().get(`/api/marcas/${marca}/ficha`).set(bearer(adminOutra))).status).toBe(404);
    expect((await amb.http().get(`/api/marcas/${marca}/ficha`).set(bearer(vendedor))).status).toBe(403);
    expect((await amb.http().get(`/api/marcas/${marca}/ficha`).set(bearer(estoquista))).status).toBe(200);
  });
});
