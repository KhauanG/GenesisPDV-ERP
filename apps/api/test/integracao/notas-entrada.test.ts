/**
 * NF-e de fornecedor por XML: upload, fornecedor pelo emitente, listagem e ações (Fase 2, F2-B19; ERP 13.4; MD
 * 3.8.2; F2-Q3 = D6; README da API › decisão 164), com o S3 em memória e a fila pg-boss. Critério de pronto: um ZIP
 * de notas cria as notas "pendente" com o fornecedor certo, e a mesma nota subida de novo é recusada como já
 * importada. Também: o fornecedor criado uma vez só (duas notas do mesmo emitente no ZIP; a pessoa já cadastrada com
 * máscara), o XML no armazenamento, a permissão `notas_entrada.importar`, o estoque e a loja fora dos permitidos, o
 * CD como destinatário, NFC-e e XXE recusadas no envio, a listagem com os filtros, o detalhe com o aviso da SEFAZ,
 * "Ignorar" e "Reabrir", a troca do destino e o lote grande na tarefa `importar_xml_nfe`.
 *
 * Revisão do bloco: o teto do envio antes do multer (`Content-Length`) e o de arquivos, a duplicada de uma loja que
 * quem importa não vê (sem o link), o período no fuso da loja, o fornecedor e o estoque nos filtros, as duas
 * importações simultâneas da mesma chave (o 23505 vira "duplicada") e o segundo envio simultâneo do mesmo usuário
 * (429), a trava ocupada além da espera do ERP recusando só aquele arquivo, o rastro com as datas trocadas no meio de
 * um ZIP, a tarefa que espera a trava sem limite e a tarefa de quem perdeu a permissão ou o estoque.
 */
import { request as pedidoHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as esperar } from 'node:timers/promises';
import {
  AVISO_SEM_SEFAZ,
  completarCnpj,
  formatarCpfCnpj,
  LIMITES_UPLOAD_NFE,
  MOTIVOS_RECUSA_NFE,
} from '@genesis/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CNPJ_CD, CNPJ_LOJA_1, CNPJ_PETISCARIA_2, fixtureNfe } from '../fixtures/nfe/fixtures.js';
import { variarFixtureNfe } from '../fixtures/nfe/gerar.js';
import { montarZip } from '../fixtures/nfe/montar-zip.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.NFE_IMPORTACOES_POR_MINUTO = '1000';
/** Espera do ERP pela trava de versão neste arquivo: curta, para os testes da trava ocupada não demorarem. */
const ESPERA_TRAVA_MS = 2_500;

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let estoquista: string;
let vendedor: string;
const ids: Record<string, string> = {};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Emitentes das fixtures (CNPJs fictícios do `gerar.ts`). */
const DOC_DISTRIBUIDORA = completarCnpj('998877660001');
const DOC_ATACADO_RIO = completarCnpj('554433220001');
const DOC_INDUSTRIA = completarCnpj('776655440001');

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ERP_ESPERA_TRAVA_MS: String(ESPERA_TRAVA_MS),
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-nfe-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  // As três lojas com os CNPJs das fixtures: Loja 1, Petiscaria 2 e o CD (loja do tipo depósito, D6).
  ids.loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  ids.petiscaria = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  ids.cd = await criarLoja(emp.nomeBanco, 3, 'CD');
  for (const [id, cnpj] of [
    [ids.loja1, CNPJ_LOJA_1],
    [ids.petiscaria, CNPJ_PETISCARIA_2],
    [ids.cd, CNPJ_CD],
  ] as const)
    await consultar(emp.nomeBanco, 'update lojas set cnpj = $1 where id = $2', [cnpj, id]);
  await consultar(emp.nomeBanco, "update lojas set tipo = 'deposito', usa_pdv = false where id = $1", [
    ids.cd,
  ]);
  const estoques = await consultar<{ id: string; estoque_id: string }>(
    emp.nomeBanco,
    'select id, estoque_id from lojas where id = any($1::uuid[])',
    [[ids.loja1, ids.petiscaria, ids.cd]],
  );
  const estoqueDa = (loja: string) => estoques.find((e) => e.id === loja)!.estoque_id;
  ids.estoqueLoja1 = estoqueDa(ids.loja1);
  ids.estoquePetiscaria = estoqueDa(ids.petiscaria);
  ids.estoqueCd = estoqueDa(ids.cd);
  // Estoquista com a Loja 1 e a Petiscaria, mas só o estoque da Loja 1 (o da Petiscaria e o CD fora).
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [ids.loja1, ids.petiscaria],
    estoques: [ids.estoqueLoja1],
  });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [ids.loja1] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

function importar(
  token: string,
  arquivos: Array<{ nome: string; conteudo: string | Buffer }>,
  campos: Record<string, string> = {},
) {
  let r = amb.http().post('/api/notas-entrada/importar').set(bearer(token));
  for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
  for (const a of arquivos) r = r.attach('arquivos', Buffer.from(a.conteudo), a.nome);
  return r;
}

const pessoasComDocumento = async (doc: string) =>
  consultar<{ id: string; origem: string; nome: string; rg_ie: string | null }>(
    emp.nomeBanco,
    'select id, origem, nome, rg_ie from pessoas where cpf_cnpj = $1 and excluido_em is null',
    [doc],
  );

/** Segura a trava de versão (7300001) numa conexão à parte até `soltar`, como os caixas despejando vendas. */
async function segurarTrava(): Promise<{ soltar(): Promise<void>; esperando(): Promise<number> }> {
  const c: pg.Client = await conectar(emp.nomeBanco);
  await c.query('begin');
  await c.query('select fn_trava_versao()');
  return {
    async soltar() {
      await c.query('commit').catch(() => undefined);
      await c.end();
    },
    /** Quantas transações esperam a trava agora. */
    async esperando() {
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
          where locktype = 'advisory' and objid = 7300001 and not granted
            and database = (select oid from pg_database where datname = current_database())`,
      );
      return rows[0]!.n;
    },
  };
}

async function aguardar(condicao: () => Promise<boolean>, rotulo: string) {
  const fim = Date.now() + 15_000;
  while (!(await condicao())) {
    if (Date.now() > fim) throw new Error(`não aconteceu: ${rotulo}`);
    await esperar(25);
  }
}

async function aguardarTarefa(id: string) {
  const fim = Date.now() + 30_000;
  for (;;) {
    const r = await amb.http().get(`/api/tarefas/${id}`).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (r.body.status === 'concluida' || r.body.status === 'falhou') return r.body;
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
    await esperar(200);
  }
}

describe('upload de XML (ERP 13.4 "Por Arquivo")', () => {
  it('exige notas_entrada.importar', async () => {
    const r = await importar(vendedor, [{ nome: '01.xml', conteudo: fixtureNfe('01-icms-st.xml') }]);
    expect(r.status).toBe(403);
    const lista = await amb.http().get('/api/notas-entrada').set(bearer(vendedor));
    expect(lista.status).toBe(403);
  });

  it('um XML: a nota "pendente" na Loja 1, o fornecedor criado pelo emitente e o XML no armazenamento', async () => {
    const xml = fixtureNfe('01-icms-st.xml');
    const r = await importar(admin, [{ nome: '01-icms-st.xml', conteudo: xml }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tarefaId).toBeNull();
    expect(r.body.resumo).toEqual({ importadas: 1, duplicadas: 0, recusadas: 0 });
    const [res] = r.body.resultados;
    expect(res).toMatchObject({
      arquivo: '01-icms-st.xml',
      situacao: 'importada',
      motivo: null,
      numero: expect.any(Number),
      fornecedorCriado: true,
      avisos: [],
    });
    ids.nota01 = res.notaId;
    const [nota] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select n.status, n.loja_id, n.estoque_id, n.fornecedor_id, n.origem, n.assinatura, n.valor_total::text,
              a.chave_armazenamento, a.categoria, a.entidade, a.registro_id, a.sha256,
              (select count(*)::int from itens_nota_entrada i where i.nota_entrada_id = n.id) as itens,
              (select count(*)::int from notas_entrada_duplicatas d where d.nota_entrada_id = n.id) as duplicatas
         from notas_entrada n join arquivos a on a.id = n.xml_arquivo_id where n.id = $1`,
      [ids.nota01],
    );
    expect(nota).toMatchObject({
      status: 'pendente',
      loja_id: ids.loja1,
      estoque_id: ids.estoqueLoja1,
      origem: 'upload',
      assinatura: 'valida',
      categoria: 'xml_nfe_entrada',
      entidade: 'notas_entrada',
      registro_id: ids.nota01,
      duplicatas: 2,
    });
    expect(Number(nota!.itens)).toBeGreaterThan(0);
    // Endereçado pelo conteúdo (`emp/<codigo>/xml/<sha256>.xml`), com o XML como foi enviado.
    expect(nota!.chave_armazenamento).toBe(`emp/${emp.codigo}/xml/${String(nota!.sha256)}.xml`);
    const guardado = await amb.servicos.armazenamento.ler(nota!.chave_armazenamento as string);
    expect(guardado.toString('utf8')).toBe(xml);
    // O fornecedor: o emitente com o nome, a IE e o endereço do XML, origem `nfe`, categoria Fornecedor.
    const [p] = await pessoasComDocumento(DOC_DISTRIBUIDORA);
    expect(p).toMatchObject({ id: nota!.fornecedor_id, origem: 'nfe', rg_ie: '110042490114' });
    expect(p!.nome).toBe('DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA');
    const end = await consultar(
      emp.nomeBanco,
      'select uf, municipio_ibge, cep, logradouro from pessoas_enderecos where pessoa_id = $1',
      [p!.id],
    );
    expect(end).toEqual([{ uf: 'SP', municipio_ibge: 3550308, cep: '01001000', logradouro: 'RUA DE TESTE' }]);
    const cat = await consultar(
      emp.nomeBanco,
      'select categoria from pessoas_categorias where pessoa_id = $1 and excluido_em is null',
      [p!.id],
    );
    expect(cat).toEqual([{ categoria: 'fornecedor' }]);
    const aud = await consultar(
      emp.nomeBanco,
      "select acao from auditoria where entidade = 'notas_entrada' and registro_id = $1",
      [ids.nota01],
    );
    expect(aud).toEqual([{ acao: 'importar' }]);
  });

  it('o emitente já cadastrado com máscara é reaproveitado, sem duplicar a pessoa', async () => {
    const rapido = await amb
      .http()
      .post('/api/pessoas/fornecedor-rapido')
      .set(bearer(admin))
      .send({ cpfCnpj: formatarCpfCnpj(DOC_ATACADO_RIO), nome: 'Atacado Rio (cadastro manual)' });
    expect(rapido.status, JSON.stringify(rapido.body)).toBe(200);
    const r = await importar(admin, [{ nome: '02.xml', conteudo: fixtureNfe('02-fcp-st.xml') }]);
    expect(r.body.resultados[0]).toMatchObject({ situacao: 'importada', fornecedorCriado: false });
    const pessoas = await pessoasComDocumento(DOC_ATACADO_RIO);
    expect(pessoas).toHaveLength(1);
    // O cadastro existente fica como estava (o nome do XML não sobrescreve).
    expect(pessoas[0]!.nome).toBe('Atacado Rio (cadastro manual)');
    const [n] = await consultar<{ fornecedor_id: string }>(
      emp.nomeBanco,
      'select fornecedor_id from notas_entrada where id = $1',
      [r.body.resultados[0].notaId],
    );
    expect(n!.fornecedor_id).toBe(rapido.body.pessoa.id);
  });

  it('ZIP com 3 notas, 1 já importada: 2 "pendente", 1 duplicada, e o fornecedor novo criado uma vez só', async () => {
    const variante = variarFixtureNfe('03-ipi-industria.xml', {
      nNF: '7702',
      cNF: '31415926',
      nProt: '135260000000377',
    });
    const zip = montarZip([
      { nome: 'notas/01-de-novo.xml', dados: Buffer.from(fixtureNfe('01-icms-st.xml')) },
      { nome: 'notas/03.xml', dados: Buffer.from(fixtureNfe('03-ipi-industria.xml')) },
      { nome: 'notas/03-outra.xml', dados: Buffer.from(variante.xml) },
    ]);
    const r = await importar(admin, [{ nome: 'compras.zip', conteudo: zip }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toEqual({ importadas: 2, duplicadas: 1, recusadas: 0 });
    const [dup, a, b] = r.body.resultados;
    expect(dup).toMatchObject({
      arquivo: 'compras.zip › notas/01-de-novo.xml',
      situacao: 'duplicada',
      motivo: 'CHAVE_JA_IMPORTADA',
      notaId: ids.nota01,
    });
    expect(dup.mensagem).toContain('já foi importada');
    expect(a).toMatchObject({ situacao: 'importada', fornecedorCriado: true });
    expect(b).toMatchObject({ situacao: 'importada', fornecedorCriado: false, chave: variante.chave });
    const pessoas = await pessoasComDocumento(DOC_INDUSTRIA);
    expect(pessoas).toHaveLength(1);
    const notas = await consultar<{ status: string; fornecedor_id: string }>(
      emp.nomeBanco,
      'select status, fornecedor_id from notas_entrada where id = any($1::uuid[])',
      [[a.notaId, b.notaId]],
    );
    expect(notas.map((n) => n.status)).toEqual(['pendente', 'pendente']);
    expect(new Set(notas.map((n) => n.fornecedor_id))).toEqual(new Set([pessoas[0]!.id]));
  });

  it('a mesma nota subida de novo é recusada como já importada (critério de pronto)', async () => {
    const r = await importar(admin, [{ nome: '01.xml', conteudo: fixtureNfe('01-icms-st.xml') }]);
    expect(r.body.resultados[0]).toMatchObject({
      situacao: 'duplicada',
      motivo: 'CHAVE_JA_IMPORTADA',
      notaId: ids.nota01,
    });
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada where chave = $1',
      [r.body.resultados[0].chave],
    );
    expect(n!.n).toBe(1);
  });

  it('o CD (loja do tipo depósito) como destinatário: a nota vai para o estoque do CD', async () => {
    const r = await importar(admin, [{ nome: '07.xml', conteudo: fixtureNfe('07-rastro-cd.xml') }]);
    expect(r.body.resultados[0], JSON.stringify(r.body)).toMatchObject({ situacao: 'importada' });
    ids.notaCd = r.body.resultados[0].notaId;
    const [n] = await consultar(
      emp.nomeBanco,
      'select loja_id, estoque_id, destinatario_cnpj from notas_entrada where id = $1',
      [ids.notaCd],
    );
    expect(n).toEqual({ loja_id: ids.cd, estoque_id: ids.estoqueCd, destinatario_cnpj: CNPJ_CD });
    // O lote do `rastro` é a sugestão do item (F2-B20), e o rastro inteiro fica guardado.
    const itens = await consultar<{ lote: string | null; rastro: unknown[] | null }>(
      emp.nomeBanco,
      'select lote, rastro from itens_nota_entrada where nota_entrada_id = $1 order by numero_item',
      [ids.notaCd],
    );
    expect(itens.some((i) => i.lote !== null && Array.isArray(i.rastro))).toBe(true);
  });

  it('NFC-e, XXE, arquivo que não é XML e ZIP corrompido são recusados com o motivo, sem derrubar o envio', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><nfeProc>&e;</nfeProc>`;
    const r = await importar(admin, [
      { nome: '08-nfce.xml', conteudo: fixtureNfe('08-nfce.xml') },
      { nome: 'xxe.xml', conteudo: xxe },
      { nome: 'leia-me.txt', conteudo: 'oi' },
      { nome: 'quebrado.zip', conteudo: Buffer.from('PK\u0003\u0004 não é um zip de verdade') },
      { nome: 'so-texto.zip', conteudo: montarZip([{ nome: 'a.txt', dados: Buffer.from('x') }]) },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toEqual({ importadas: 0, duplicadas: 0, recusadas: 6 });
    expect(r.body.resultados.map((x: { arquivo: string; motivo: string }) => [x.arquivo, x.motivo])).toEqual([
      ['08-nfce.xml', 'MODELO_NAO_ACEITO'],
      ['xxe.xml', 'XML_COM_DTD'],
      ['leia-me.txt', 'NAO_E_XML'],
      ['quebrado.zip', 'ZIP_CORROMPIDO'],
      ['so-texto.zip › a.txt', 'NAO_E_XML'],
      ['so-texto.zip', 'ZIP_SEM_XML'],
    ]);
    const vazio = await importar(admin, []);
    expect(vazio.status).toBe(422);
  });

  it('o envio acima de 20 MB é recusado pelo Content-Length antes do multer, sem chegar ao serviço', async () => {
    const espiao = vi.spyOn(amb.servicos.notasEntrada, 'importar');
    try {
      const { port } = amb.app!.getHttpServer().address() as AddressInfo;
      // Só os cabeçalhos: o corpo prometido nunca é mandado, e a resposta vem antes de o multer ler qualquer parte.
      const r = await new Promise<{ status: number; corpo: string }>((ok, falha) => {
        const req = pedidoHttp(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/notas-entrada/importar',
            headers: {
              ...bearer(admin),
              'content-type': 'multipart/form-data; boundary=x',
              'content-length': String(LIMITES_UPLOAD_NFE.bytes + 300 * 1024),
            },
          },
          (res) => {
            let corpo = '';
            res.on('data', (d: Buffer) => (corpo += d.toString('utf8')));
            res.on('end', () => {
              ok({ status: res.statusCode!, corpo });
              req.destroy();
            });
          },
        );
        req.on('error', falha);
        req.write('--x\r\n');
      });
      expect(r.status, r.corpo).toBe(422);
      const erro = JSON.parse(r.corpo);
      expect(erro.mensagem).toBe('O envio passa de 20 MB: divida os arquivos.');
      expect(erro.campos.arquivos).toEqual(['Até 20 MB por envio']);
      expect(espiao).not.toHaveBeenCalled();
    } finally {
      espiao.mockRestore();
    }
  });

  it(`mais de ${LIMITES_UPLOAD_NFE.arquivos} arquivos no envio: 422 no campo arquivos, com a mensagem da tela`, async () => {
    const xml = fixtureNfe('01-icms-st.xml');
    const r = await importar(
      admin,
      Array.from({ length: LIMITES_UPLOAD_NFE.arquivos + 1 }, (_, i) => ({
        nome: `n${i}.xml`,
        conteudo: xml,
      })),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.mensagem).toBe('No máximo 100 arquivos por envio: junte as notas num .zip.');
    expect(r.body.campos.arquivos).toEqual(['Até 100 arquivos por envio']);
  });

  it('estoque fora dos permitidos: o escolhido é 403 no campo, o da loja recusa a nota; loja fora recusa a nota', async () => {
    const escolhido = await importar(
      estoquista,
      [{ nome: '04.xml', conteudo: fixtureNfe('04-embalagens-cx-fd-pct.xml') }],
      { estoqueId: ids.estoqueCd! },
    );
    expect(escolhido.status).toBe(403);
    expect(escolhido.body.campos.estoqueId).toBeTruthy();
    const r = await importar(estoquista, [
      // Petiscaria: a loja é permitida, o estoque dela não.
      { nome: '05.xml', conteudo: fixtureNfe('05-qtrib-diferente.xml') },
      // CD: a loja não está entre as do estoquista.
      {
        nome: '07-outra.xml',
        conteudo: variarFixtureNfe('07-rastro-cd.xml', {
          nNF: '9907',
          cNF: '27182818',
          nProt: '135260000000977',
        }).xml,
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resultados.map((x: { motivo: string }) => x.motivo)).toEqual([
      'ESTOQUE_NAO_PERMITIDO',
      'LOJA_NAO_PERMITIDA',
    ]);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada where loja_id = $1',
      [ids.petiscaria],
    );
    expect(n!.n).toBe(0);
    // A mesma nota da Petiscaria para o estoque da Loja 1 (escolhido e permitido) entra.
    const ok = await importar(
      estoquista,
      [{ nome: '05.xml', conteudo: fixtureNfe('05-qtrib-diferente.xml') }],
      {
        estoqueId: ids.estoqueLoja1!,
      },
    );
    expect(ok.body.resultados[0]).toMatchObject({ situacao: 'importada' });
    const [p] = await consultar(
      emp.nomeBanco,
      'select loja_id, estoque_id from notas_entrada where id = $1',
      [ok.body.resultados[0].notaId],
    );
    expect(p).toEqual({ loja_id: ids.petiscaria, estoque_id: ids.estoqueLoja1 });
  });

  it('a duplicada de uma nota que quem importa não vê volta sem o link e sem o código (D45)', async () => {
    // A nota do CD já foi importada pelo admin; o estoquista não tem a loja nem o estoque do CD.
    const r = await importar(estoquista, [{ nome: '07.xml', conteudo: fixtureNfe('07-rastro-cd.xml') }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resultados[0]).toMatchObject({
      situacao: 'duplicada',
      motivo: 'CHAVE_JA_IMPORTADA',
      mensagem: MOTIVOS_RECUSA_NFE.CHAVE_JA_IMPORTADA,
      notaId: null,
      notaCodigo: null,
    });
    // A da Loja 1 (loja e estoque dele) volta com o link para a nota existente.
    const visivel = await importar(estoquista, [{ nome: '01.xml', conteudo: fixtureNfe('01-icms-st.xml') }]);
    expect(visivel.body.resultados[0]).toMatchObject({
      situacao: 'duplicada',
      notaId: ids.nota01,
      notaCodigo: expect.any(Number),
    });
  });
});

describe('listagem, detalhe e XML', () => {
  it('filtros: situação, loja, número/chave, emitente; o estoquista só vê as notas dos estoques dele', async () => {
    const todas = await amb.http().get('/api/notas-entrada?tamanho=50').set(bearer(admin));
    expect(todas.status, JSON.stringify(todas.body)).toBe(200);
    expect(todas.body.total).toBe(6);
    const doCd = await amb.http().get(`/api/notas-entrada?lojaId=${ids.cd}`).set(bearer(admin));
    expect(doCd.body.itens.map((n: { id: string }) => n.id)).toEqual([ids.notaCd]);
    const nota01 = todas.body.itens.find((n: { id: string }) => n.id === ids.nota01);
    expect(nota01).toMatchObject({ status: 'pendente', lojaId: ids.loja1, assinatura: 'valida' });
    const porNumero = await amb
      .http()
      .get(`/api/notas-entrada?numeroChave=${nota01.numero}`)
      .set(bearer(admin));
    expect(porNumero.body.itens.map((n: { id: string }) => n.id)).toContain(ids.nota01);
    const porChave = await amb
      .http()
      .get(`/api/notas-entrada?numeroChave=${nota01.chave.slice(0, 30)}`)
      .set(bearer(admin));
    expect(porChave.body.itens.map((n: { id: string }) => n.id)).toEqual([ids.nota01]);
    // Pela razão social ou pela fantasia do emitente.
    const porNome = await amb.http().get('/api/notas-entrada?nome=atacado rio').set(bearer(admin));
    expect(porNome.body.itens.map((n: { emitenteNome: string }) => n.emitenteNome)).toEqual([
      'ATACADO RIO BEBIDAS LTDA',
    ]);
    const ignoradas = await amb.http().get('/api/notas-entrada?status=ignorada').set(bearer(admin));
    expect(ignoradas.body.total).toBe(0);
    const doFornecedor = await amb
      .http()
      .get(`/api/notas-entrada?fornecedorId=${nota01.fornecedorId}`)
      .set(bearer(admin));
    expect(doFornecedor.body.itens.map((n: { id: string }) => n.id)).toEqual([ids.nota01]);
    const doEstoqueCd = await amb
      .http()
      .get(`/api/notas-entrada?estoqueId=${ids.estoqueCd}`)
      .set(bearer(admin));
    expect(doEstoqueCd.body.itens.map((n: { id: string }) => n.id)).toEqual([ids.notaCd]);
    const doEstoquista = await amb.http().get('/api/notas-entrada?tamanho=50').set(bearer(estoquista));
    expect(
      doEstoquista.body.itens.every((n: { estoqueId: string }) => n.estoqueId === ids.estoqueLoja1),
    ).toBe(true);
    const cdOculta = await amb.http().get(`/api/notas-entrada/${ids.notaCd}`).set(bearer(estoquista));
    expect(cdOculta.status).toBe(404);
  });

  it('período pela emissão e pelo recebimento, com o dia no fuso da loja destinatária (ERP 1.5)', async () => {
    const ids_ = (r: { body: { itens: Array<{ id: string }> } }) => r.body.itens.map((n) => n.id);
    const lista = (q: string) => amb.http().get(`/api/notas-entrada?tamanho=50&${q}`).set(bearer(admin));
    // A 01 foi emitida em 2026-10-20 08:15 -03:00 (Loja 1, America/Sao_Paulo).
    const dia20 = await lista('periodo=emissao&dataInicial=2026-10-20&dataFinal=2026-10-20');
    expect(ids_(dia20)).toEqual([ids.nota01]);
    expect(ids_(await lista('periodo=emissao&dataInicial=2026-10-21&dataFinal=2026-10-21'))).not.toContain(
      ids.nota01,
    );
    // A do CD, emitida em 2026-10-26 16:10 -03:00: com o CD em Tóquio (+09:00) o dia da emissão é o 27.
    await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'Asia/Tokyo' where id = $1", [ids.cd]);
    try {
      const doCd = (dia: string) =>
        lista(`lojaId=${ids.cd}&periodo=emissao&dataInicial=${dia}&dataFinal=${dia}`);
      expect(ids_(await doCd('2026-10-27'))).toEqual([ids.notaCd]);
      expect(ids_(await doCd('2026-10-26'))).toEqual([]);
    } finally {
      await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'America/Sao_Paulo' where id = $1", [
        ids.cd,
      ]);
    }
    // O recebimento é a importação (hoje, no fuso da loja); a emissão das fixtures é de outubro.
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const recebidasHoje = await lista(`periodo=recebimento&dataInicial=${hoje}&dataFinal=${hoje}`);
    expect(recebidasHoje.body.total).toBe(6);
    expect((await lista(`periodo=emissao&dataInicial=${hoje}&dataFinal=${hoje}`)).body.total).toBe(0);
  });

  it('detalhe com as duplicatas, os itens e o aviso fixo da SEFAZ; o XML como foi enviado', async () => {
    const r = await amb.http().get(`/api/notas-entrada/${ids.nota01}`).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'pendente', lojaId: ids.loja1, emitenteCnpj: DOC_DISTRIBUIDORA });
    expect(r.body.avisos).toEqual([AVISO_SEM_SEFAZ]);
    expect(r.body.duplicatas.map((d: { sequencia: number }) => d.sequencia)).toEqual([1, 2]);
    expect(r.body.duplicatas[0]).toMatchObject({ numero: '001', vencimento: '2026-11-19', valor: '700.00' });
    expect(r.body.itens.length).toBeGreaterThan(0);
    expect(r.body.fornecedor.nome).toBe('DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA');
    const x = await amb.http().get(`/api/notas-entrada/${ids.nota01}/xml`).set(bearer(admin));
    expect(x.status).toBe(200);
    expect(x.body.xml).toBe(fixtureNfe('01-icms-st.xml'));
    expect(x.body.nomeArquivo).toBe(`${r.body.chave}-nfe.xml`);
  });
});

describe('ações', () => {
  it('"Ignorar nota" com motivo, a chave continua ocupada, e "Reabrir" volta a pendente', async () => {
    const d = await amb.http().get(`/api/notas-entrada/${ids.nota01}`).set(bearer(admin));
    const semMotivo = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/ignorar`)
      .set(bearer(admin))
      .send({ motivo: ' ' });
    expect(semMotivo.status).toBe(422);
    const velha = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/ignorar`)
      .set(bearer(admin))
      .send({ motivo: 'x', versao: d.body.versao - 1 });
    expect(velha.status).toBe(409);
    const ign = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/ignorar`)
      .set(bearer(admin))
      .send({ motivo: 'Nota em duplicidade do fornecedor', versao: d.body.versao });
    expect(ign.status, JSON.stringify(ign.body)).toBe(200);
    expect(ign.body).toMatchObject({
      status: 'ignorada',
      motivoIgnorada: 'Nota em duplicidade do fornecedor',
    });
    const denovo = await importar(admin, [{ nome: '01.xml', conteudo: fixtureNfe('01-icms-st.xml') }]);
    expect(denovo.body.resultados[0]).toMatchObject({ situacao: 'duplicada', notaId: ids.nota01 });
    const dupla = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/ignorar`)
      .set(bearer(admin))
      .send({ motivo: 'de novo' });
    expect(dupla.status).toBe(422);
    const reaberta = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/reabrir`)
      .set(bearer(admin))
      .send({});
    expect(reaberta.status).toBe(200);
    expect(reaberta.body).toMatchObject({ status: 'pendente', motivoIgnorada: null });
    const outra = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota01}/reabrir`)
      .set(bearer(admin))
      .send({});
    expect(outra.status).toBe(422);
  });

  it('troca do destino entre os permitidos (a loja gravada e a nova também)', async () => {
    const d = await amb.http().get(`/api/notas-entrada/${ids.nota01}`).set(bearer(admin));
    const r = await amb
      .http()
      .put(`/api/notas-entrada/${ids.nota01}/destino`)
      .set(bearer(admin))
      .send({ versao: d.body.versao, lojaId: ids.loja1, estoqueId: ids.estoqueCd });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ lojaId: ids.loja1, estoqueId: ids.estoqueCd });
    // O estoquista não vê o CD: a nota agora é 404 para ele; e não leva uma nota para o estoque que não tem.
    const oculta = await amb
      .http()
      .put(`/api/notas-entrada/${ids.nota01}/destino`)
      .set(bearer(estoquista))
      .send({ versao: r.body.versao, lojaId: ids.loja1, estoqueId: null });
    expect(oculta.status).toBe(404);
    const volta = await amb
      .http()
      .put(`/api/notas-entrada/${ids.nota01}/destino`)
      .set(bearer(admin))
      .send({ versao: r.body.versao, lojaId: ids.loja1, estoqueId: '' });
    expect(volta.body).toMatchObject({ estoqueId: ids.estoqueLoja1 });
    const proibido = await amb
      .http()
      .put(`/api/notas-entrada/${ids.nota01}/destino`)
      .set(bearer(estoquista))
      .send({ versao: volta.body.versao, lojaId: ids.loja1, estoqueId: ids.estoqueCd });
    expect(proibido.status).toBe(403);
    expect(proibido.body.campos.estoqueId).toBeTruthy();
  });
});

describe('lote grande em tarefa (importar_xml_nfe)', () => {
  it('acima do teto vai para a tarefa, com o mesmo resultado por arquivo', async () => {
    process.env.NFE_IMPORTACAO_SINCRONA_MAX = '1';
    try {
      const zip = montarZip([
        {
          nome: '06.xml',
          dados: Buffer.from(fixtureNfe('06-sem-gtin-produtor-rural.xml')),
        },
        {
          nome: '04.xml',
          dados: Buffer.from(fixtureNfe('04-embalagens-cx-fd-pct.xml')),
        },
      ]);
      const r = await importar(admin, [{ nome: 'lote.zip', conteudo: zip }]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.tarefaId).toEqual(expect.any(String));
      expect(r.body.resultados).toEqual([]);
      const t = await aguardarTarefa(r.body.tarefaId);
      expect(t.status, JSON.stringify(t)).toBe('concluida');
      expect(t.resultado.resumo).toEqual({ importadas: 2, duplicadas: 0, recusadas: 0 });
      expect(t.resultado.resultados.map((x: { arquivo: string }) => x.arquivo)).toEqual([
        'lote.zip › 06.xml',
        'lote.zip › 04.xml',
      ]);
    } finally {
      delete process.env.NFE_IMPORTACAO_SINCRONA_MAX;
    }
  });
});

describe('concorrência e erros por arquivo (revisão do F2-B19)', () => {
  it('a mesma chave em dois envios simultâneos: o 23505 vira "duplicada" com a nota que ganhou; o 2º envio do mesmo usuário é 429', async () => {
    const nova = variarFixtureNfe('01-icms-st.xml', {
      nNF: '8801',
      cNF: '88010001',
      nProt: '135260000008801',
    });
    const trava = await segurarTrava();
    // Os dois passam pela validação (a chave ainda não existe) e esperam a trava para gravar (o `then` dispara o
    // pedido do supertest agora).
    const pedidos = [admin, estoquista].map((t) =>
      importar(t, [{ nome: 'mesma.xml', conteudo: nova.xml }]).then((r) => r),
    );
    try {
      await aguardar(async () => (await trava.esperando()) === 2, 'os dois envios na trava');
      const outro = await importar(admin, [{ nome: 'outro.xml', conteudo: nova.xml }]);
      expect(outro.status, JSON.stringify(outro.body)).toBe(429);
      expect(outro.body.codigo).toBe('LIMITE_TAXA');
    } finally {
      await trava.soltar();
    }
    const respostas = await Promise.all(pedidos);
    for (const r of respostas) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [x, y] = respostas.map((r) => r.body.resultados[0]!);
    const importada = x!.situacao === 'importada' ? x! : y!;
    const duplicada = importada === x ? y! : x!;
    expect(importada).toMatchObject({ situacao: 'importada', chave: nova.chave });
    expect(duplicada).toMatchObject({
      situacao: 'duplicada',
      motivo: 'CHAVE_JA_IMPORTADA',
      notaId: importada.notaId,
      chave: nova.chave,
    });
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada where chave = $1',
      [nova.chave],
    );
    expect(n!.n).toBe(1);
  });

  it('a trava ocupada além da espera do ERP recusa só aquele arquivo (ERRO_AO_GRAVAR), e os outros seguem', async () => {
    const nova = variarFixtureNfe('01-icms-st.xml', {
      nNF: '8802',
      cNF: '88020002',
      nProt: '135260000008802',
    });
    const trava = await segurarTrava();
    let r;
    try {
      r = await importar(admin, [
        { nome: '01.xml', conteudo: fixtureNfe('01-icms-st.xml') },
        { nome: 'nova.xml', conteudo: nova.xml },
      ]);
    } finally {
      await trava.soltar();
    }
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toEqual({ importadas: 0, duplicadas: 1, recusadas: 1 });
    expect(r.body.resultados[1]).toMatchObject({
      arquivo: 'nova.xml',
      situacao: 'recusada',
      motivo: 'ERRO_AO_GRAVAR',
    });
    expect(r.body.resultados[1].mensagem).toContain('ocupado');
    // Nada ficou gravado pela metade, e o mesmo arquivo de novo entra.
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada where chave = $1',
      [nova.chave],
    );
    expect(n!.n).toBe(0);
    const denovo = await importar(admin, [{ nome: 'nova.xml', conteudo: nova.xml }]);
    expect(denovo.body.resultados[0]).toMatchObject({ situacao: 'importada' });
  });

  it('o rastro com a fabricação depois da validade no meio de um ZIP: as 3 entram, a do meio com o aviso e sem a fabricação na sugestão', async () => {
    const variar = (nNF: string, rastroTrocado = false) =>
      variarFixtureNfe('07-rastro-cd.xml', {
        nNF,
        cNF: `${nNF}0000`.padStart(8, '7'),
        nProt: `13526000000${nNF}`,
        rastroTrocado,
      });
    const [a, b, c] = [variar('9911'), variar('9912', true), variar('9913')];
    const zip = montarZip([
      { nome: 'a.xml', dados: Buffer.from(a.xml) },
      { nome: 'b.xml', dados: Buffer.from(b.xml) },
      { nome: 'c.xml', dados: Buffer.from(c.xml) },
    ]);
    const r = await importar(admin, [{ nome: 'cd.zip', conteudo: zip }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toEqual({ importadas: 3, duplicadas: 0, recusadas: 0 });
    const meio = r.body.resultados[1];
    expect(meio.avisos).toEqual([
      expect.objectContaining({
        motivo: 'RASTRO_FABRICACAO_APOS_VALIDADE',
        detalhe: expect.stringContaining('L2610A'),
      }),
    ]);
    expect(r.body.resultados[0].avisos).toEqual([]);
    const [item] = await consultar<{
      lote: string;
      validade: string;
      fabricacao: string | null;
      rastro: unknown;
    }>(
      emp.nomeBanco,
      `select lote, validade::text, fabricacao::text, rastro from itens_nota_entrada
        where nota_entrada_id = $1 and numero_item = 1`,
      [meio.notaId],
    );
    expect(item).toMatchObject({ lote: 'L2610A', validade: '2026-10-10', fabricacao: null });
    // O rastro fica como veio no XML.
    expect(item!.rastro).toEqual(
      expect.arrayContaining([expect.objectContaining({ fabricacao: '2026-11-25', validade: '2026-10-10' })]),
    );
  });
});

describe('tarefa importar_xml_nfe (revisão do F2-B19)', () => {
  it('espera a trava de versão sem limite (como as outras tarefas) em vez de falhar com a espera do ERP', async () => {
    const [a, b] = [
      variarFixtureNfe('01-icms-st.xml', { nNF: '8803', cNF: '88030003', nProt: '135260000008803' }),
      variarFixtureNfe('01-icms-st.xml', { nNF: '8804', cNF: '88040004', nProt: '135260000008804' }),
    ];
    process.env.NFE_IMPORTACAO_SINCRONA_MAX = '1';
    const trava = await segurarTrava();
    let tarefaId: string;
    try {
      const r = await importar(admin, [
        { nome: 'a.xml', conteudo: a.xml },
        { nome: 'b.xml', conteudo: b.xml },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      tarefaId = r.body.tarefaId;
      await aguardar(async () => (await trava.esperando()) === 1, 'a tarefa na trava');
      await esperar(ESPERA_TRAVA_MS + 700);
      const [t] = await consultar<{ status: string }>(
        emp.nomeBanco,
        'select status from tarefas where id = $1',
        [tarefaId],
      );
      expect(t!.status).toBe('executando');
      expect(await trava.esperando()).toBe(1);
    } finally {
      await trava.soltar();
      delete process.env.NFE_IMPORTACAO_SINCRONA_MAX;
    }
    const t = await aguardarTarefa(tarefaId);
    expect(t.status, JSON.stringify(t)).toBe('concluida');
    expect(t.resultado.resumo).toEqual({ importadas: 2, duplicadas: 0, recusadas: 0 });
  });

  it('refaz a sessão com o acesso do momento: sem notas_entrada.importar ou sem o estoque escolhido, falha sem gravar', async () => {
    // Os arquivos de um lote já guardado, numa tarefa nova de quem não tem mais o acesso (o executor roda direto,
    // como o trabalhador da fila faria depois de o acesso mudar).
    const [ultima] = await consultar<{
      parametros: { arquivos: unknown[]; opcoes: Record<string, unknown> };
    }>(
      emp.nomeBanco,
      "select parametros from tarefas where tipo = 'importar_xml_nfe' order by criado_em desc limit 1",
    );
    const [vend] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'vendedor'",
    );
    const [esto] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'estoquista'",
    );
    const antes = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada',
    );
    const casos = [
      { usuarioId: vend!.id, opcoes: {}, erro: 'O usuário não tem mais a permissão de importar NF-e.' },
      {
        usuarioId: esto!.id,
        opcoes: { estoqueId: ids.estoqueCd },
        erro: 'O estoque está fora dos seus estoques permitidos.',
      },
    ];
    for (const caso of casos) {
      const [t] = await consultar<{ id: string }>(
        emp.nomeBanco,
        `insert into tarefas (tipo, parametros, usuario_id) values ('importar_xml_nfe', $1, $2) returning id`,
        [JSON.stringify({ arquivos: ultima!.parametros.arquivos, opcoes: caso.opcoes }), caso.usuarioId],
      );
      await amb.servicos.tarefas.executar(emp.empresaId, t!.id);
      const [fim] = await consultar<{ status: string; erro: string }>(
        emp.nomeBanco,
        'select status, erro from tarefas where id = $1',
        [t!.id],
      );
      expect(fim).toEqual({ status: 'falhou', erro: caso.erro });
    }
    const depois = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from notas_entrada',
    );
    expect(depois).toEqual(antes);
  });
});
