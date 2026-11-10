/**
 * Importação de produtos e clientes por planilha (ERP 8.6, 23.14) com a fila pg-boss e o S3 em memória: colunas do
 * export do Nuvem3, prévia sem gravar (EAN duplicado, NCM inválido, sem preço, coluna ignorada, atualização pelo
 * código interno), confirmação em tarefa, acerto "Definir" do estoque, relatório de inconsistências; e o dashboard
 * (casca da Fase 1, ERP 6).
 */
import { setTimeout as esperar } from 'node:timers/promises';
import writeXlsxFile from 'write-excel-file/node';
import { mesOperacionalEm } from '@genesis/shared';
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
import { conferirRazaoDasEmpresas } from './razao.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

// Muitas prévias seguidas do mesmo usuário (o limite real é 10/min, IMPORTACAO_PREVIAS_POR_MINUTO).
process.env.IMPORTACAO_PREVIAS_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let vendedor: string;
let lojaId: string;
let existenteId: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      DASHBOARD_CACHE_MS: '0',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-imp-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  lojaId = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Ice Beer Hermes');
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [lojaId] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  const un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({
      nome: 'CERV SKOL LT 350ML',
      unidadeId: un,
      codigoInterno: 'SKOL350',
      precoCusto: '2',
      precoVenda: '3,29',
      codigosBarras: [{ codigo: '7891149105106', principal: true }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  existenteId = r.body.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

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

/** Cabeçalho como no "Exportar Produtos" do Nuvem3 (nomes diferentes do nosso layout) + uma coluna desconhecida. */
const CSV_NUVEM3 = [
  'Id Produto;Ref. Interna;Código de Barras;Produto;Unidade;Marca;Departamento;Preço Custo;Venda;Atacado;Qtd Atacado;Est. Mínimo;Est. Atual;NCM;Cor do rótulo',
  '101;BRAHMA350;7891149103102;CERV BRAHMA LT 350ML;UN;BRAHMA;CERVEJA > LATA;2,10;3,49;3,19;12;24;120;22030000;vermelho',
  '102;HEINEKEN600;7891149105106;CERV HEINEKEN LN 600ML;UN;HEINEKEN;CERVEJA > LONG NECK;5,00;8,99;;;6;30;2203.00.00;verde',
  '103;GELO5KG;;GELO 5KG;UN;;;3,00;;;;;;22011000;',
  '104;CARVAO;123;CARVAO 3KG;UN;;;8,00;15,90;;;;10;99999999;',
  '105;SKOL350;;CERV SKOL LT 350ML;UN;;;2,20;3,39;;;;48;22030000;',
].join('\r\n');

describe('importação de produtos (ERP 8.6)', () => {
  let arquivoId: string;

  it('modelo: xlsx com o nosso layout (ida e volta com a exportação)', async () => {
    const r = await amb
      .http()
      .get('/api/importacoes/produtos/modelo')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('modelo_importacao_produtos.xlsx');
    expect((r.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('prévia: colunas do Nuvem3 reconhecidas, inconsistências por linha e nada gravado', async () => {
    const r = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .field('atualizarEstoque', 'true')
      .field('dataContagem', new Date().toISOString())
      .field('atualizarEstoqueMinimo', 'true')
      .field('atualizarPrecos', 'true')
      .field('criarMarcasCategorias', 'true')
      .attach('arquivo', Buffer.from(`\uFEFF${CSV_NUVEM3}`, 'utf8'), 'Exportacao Nuvem3.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    arquivoId = r.body.arquivoId;
    expect(r.body.nomeArquivo).toBe('Exportacao Nuvem3.csv');
    expect(r.body.colunasReconhecidas).toEqual(
      expect.arrayContaining([
        'codigo_interno',
        'ean',
        'nome',
        'preco_custo',
        'preco_venda',
        'estoque_atual',
        'ncm',
      ]),
    );
    expect(r.body.colunasIgnoradas).toEqual(['Cor do rótulo']);
    expect(r.body.resumo).toMatchObject({ linhas: 5, criar: 3, atualizar: 1, ignorar: 1 });
    expect(r.body.resumo.porAviso).toMatchObject({
      ean_duplicado: 1,
      ncm_invalido: 1,
      ean_invalido: 1,
    });
    // Linha sem preço vira só erro (o aviso `sem_preco` repetiria a mesma informação).
    expect(r.body.resumo.porAviso.sem_preco ?? 0).toBe(0);
    const porLinha = new Map((r.body.linhas as Array<{ linha: number }>).map((l) => [l.linha, l]));
    expect(porLinha.get(4)).toMatchObject({
      acao: 'ignorar',
      erros: [expect.stringContaining('Sem preço')],
      avisos: [],
    });
    expect(porLinha.get(3)).toMatchObject({
      acao: 'criar',
      avisos: [
        expect.objectContaining({ codigo: 'ean_duplicado', mensagem: expect.stringContaining('CERV SKOL') }),
      ],
    });
    expect(porLinha.get(5)).toMatchObject({
      acao: 'criar',
      avisos: expect.arrayContaining([
        expect.objectContaining({ codigo: 'ncm_invalido' }),
        expect.objectContaining({ codigo: 'ean_invalido' }),
      ]),
    });
    expect(porLinha.get(6)).toMatchObject({ acao: 'atualizar', registroId: existenteId });
    // Erros e avisos primeiro.
    expect(r.body.linhas[0].linha).toBe(4);
    const [n] = await consultar<{ n: number }>(emp.nomeBanco, 'select count(*)::int as n from produtos');
    expect(n!.n).toBe(1);
  });

  it('confirmar: tarefa grava as linhas, cria marcas/categorias, define o estoque e gera o relatório', async () => {
    const c = await amb.http().post('/api/importacoes/produtos/confirmar').set(bearer(admin)).send({
      arquivoId,
      lojaId,
      atualizarEstoque: true,
      dataContagem: new Date().toISOString(),
      atualizarEstoqueMinimo: true,
      atualizarPrecos: true,
      criarMarcasCategorias: true,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    const t = await aguardarTarefa(c.body.tarefaId);
    expect(t.status, t.erro).toBe('concluida');
    expect(t.resultado).toMatchObject({
      tipo: 'produtos',
      criados: 3,
      atualizados: 1,
      comErro: 1,
      porAviso: { ean_duplicado: 1, ncm_invalido: 1, ean_invalido: 1 },
      acertoCodigo: expect.any(Number),
    });
    expect(t.download).toMatch(/^http/);

    const produtos = await consultar<{
      nome: string;
      ncm: string | null;
      preco_venda: string;
      marca: string | null;
      categoria: string | null;
    }>(
      emp.nomeBanco,
      `select p.nome, p.ncm, p.preco_venda::text, m.descricao as marca, c.caminho_nomes as categoria
         from produtos p left join marcas m on m.id = p.marca_id left join categorias c on c.id = p.categoria_principal_id
        order by p.nome`,
    );
    expect(produtos).toEqual([
      { nome: 'CARVAO 3KG', ncm: null, preco_venda: '15.9000', marca: null, categoria: null },
      {
        nome: 'CERV BRAHMA LT 350ML',
        ncm: '22030000',
        preco_venda: '3.4900',
        marca: 'BRAHMA',
        categoria: 'CERVEJA > LATA',
      },
      {
        nome: 'CERV HEINEKEN LN 600ML',
        ncm: '22030000',
        preco_venda: '8.9900',
        marca: 'HEINEKEN',
        categoria: 'CERVEJA > LONG NECK',
      },
      { nome: 'CERV SKOL LT 350ML', ncm: '22030000', preco_venda: '3.3900', marca: null, categoria: null },
    ]);
    // F2-B15: o preço alterado pela planilha entra no histórico com a origem `importacao` (não `cadastro`).
    const historico = await consultar<{ tipo_preco: string; valor_novo: string; origem: string }>(
      emp.nomeBanco,
      `select tipo_preco, valor_novo::text, origem from produtos_historico_precos
        where produto_id = $1 and origem <> 'cadastro' order by tipo_preco`,
      [existenteId],
    );
    expect(historico).toEqual([
      { tipo_preco: 'custo', valor_novo: '2.2000', origem: 'importacao' },
      { tipo_preco: 'venda', valor_novo: '3.3900', origem: 'importacao' },
    ]);
    // A consulta do histórico (F2-B37) mostra a origem `importacao`, sem documento.
    const consulta = await amb
      .http()
      .get(`/api/produtos/${existenteId}/historico-precos`)
      .query({ loja: 'geral' })
      .set(bearer(admin));
    expect(consulta.status, JSON.stringify(consulta.body)).toBe(200);
    expect(
      (consulta.body.itens as Array<Record<string, unknown>>)
        .filter((h) => h.origem === 'importacao')
        .map((h) => ({ tipo: h.tipoPreco, novo: h.valorNovo, documento: h.documento }))
        .sort((a, b) => String(a.tipo).localeCompare(String(b.tipo))),
    ).toEqual([
      { tipo: 'custo', novo: '2.2000', documento: null },
      { tipo: 'venda', novo: '3.3900', documento: null },
    ]);
    // EAN duplicado gravado (migração) e o inválido como código interno.
    const codigos = await consultar<{ codigo: string; tipo: string; nome: string }>(
      emp.nomeBanco,
      `select cb.codigo, cb.tipo, p.nome from produtos_codigos_barras cb join produtos p on p.id = cb.produto_id
        where cb.excluido_em is null order by cb.codigo, p.nome`,
    );
    expect(codigos).toEqual([
      { codigo: '123', tipo: 'interno', nome: 'CARVAO 3KG' },
      { codigo: '7891149103102', tipo: 'gtin', nome: 'CERV BRAHMA LT 350ML' },
      { codigo: '7891149105106', tipo: 'gtin', nome: 'CERV HEINEKEN LN 600ML' },
      { codigo: '7891149105106', tipo: 'gtin', nome: 'CERV SKOL LT 350ML' },
    ]);
    // Estoque atual = acerto Definir efetivado com origem importação (AJUSTE_IMPORTACAO).
    const [acerto] = await consultar<{
      origem: string;
      tipo_ajuste: string;
      status: string;
      motivo: string;
      qtd_itens: number;
    }>(emp.nomeBanco, 'select origem, tipo_ajuste, status, motivo, qtd_itens from acertos_estoque');
    expect(acerto).toEqual({
      origem: 'importacao',
      tipo_ajuste: 'definir',
      status: 'efetivado',
      motivo: 'Importação de planilha',
      qtd_itens: 4,
    });
    const saldos = await consultar<{ nome: string; quantidade: string; tipo_movimento: string }>(
      emp.nomeBanco,
      `select p.nome, s.quantidade::text, (select m.tipo_movimento from movimentos_estoque m where m.produto_id = p.id limit 1)
         from saldos_estoque s join produtos p on p.id = s.produto_id order by p.nome`,
    );
    expect(saldos).toEqual([
      { nome: 'CARVAO 3KG', quantidade: '10.000', tipo_movimento: 'AJUSTE_IMPORTACAO' },
      { nome: 'CERV BRAHMA LT 350ML', quantidade: '120.000', tipo_movimento: 'AJUSTE_IMPORTACAO' },
      { nome: 'CERV HEINEKEN LN 600ML', quantidade: '30.000', tipo_movimento: 'AJUSTE_IMPORTACAO' },
      { nome: 'CERV SKOL LT 350ML', quantidade: '48.000', tipo_movimento: 'AJUSTE_IMPORTACAO' },
    ]);
    const [minimo] = await consultar<{ estoque_minimo: string }>(
      emp.nomeBanco,
      `select pl.estoque_minimo::text from produtos_lojas pl join produtos p on p.id = pl.produto_id
        where p.nome = 'CERV BRAHMA LT 350ML'`,
    );
    expect(minimo!.estoque_minimo).toBe('24.000');
    // Auditoria com a origem `importacao`.
    const [aud] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where origem = 'importacao' and entidade = 'produtos'",
    );
    expect(aud!.n).toBe(4);
    // Relatório xlsx no armazenamento (linhas com erro/aviso).
    if (s3) {
      const relatorio = [...s3.objetos.values()].find((o) => o.tipo.includes('spreadsheetml'));
      expect(relatorio?.corpo.subarray(0, 2).toString()).toBe('PK');
    }
  });

  it('xlsx com células numéricas (EAN/NCM como número) e "Atualizar preços" desligado mantém o preço', async () => {
    const xlsx = await writeXlsxFile([
      [
        { value: 'Código interno' },
        { value: 'Nome' },
        { value: 'Preço de venda' },
        { value: 'NCM' },
        { value: 'EAN' },
      ],
      [
        { value: 'BRAHMA350' },
        { value: 'CERV BRAHMA LATA 350ML' },
        { value: 99 },
        { value: 22030000 },
        { value: 7891149103102 },
      ],
      [
        { value: 'NOVO1' },
        { value: 'AGUA MINERAL 500ML' },
        { value: 2.5 },
        { value: 22011000 },
        { value: 7896000000002 },
      ],
    ]).toBuffer();
    const r = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .attach('arquivo', xlsx, 'produtos.xlsx');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toMatchObject({ linhas: 2, criar: 1, atualizar: 1, ignorar: 0 });
    const c = await amb
      .http()
      .post('/api/importacoes/produtos/confirmar')
      .set(bearer(admin))
      .send({ arquivoId: r.body.arquivoId, lojaId });
    const t = await aguardarTarefa(c.body.tarefaId);
    expect(t.resultado).toMatchObject({ criados: 1, atualizados: 1, comErro: 0, acertoId: null });
    const linhas = await consultar<{ nome: string; preco_venda: string }>(
      emp.nomeBanco,
      "select nome, preco_venda::text from produtos where codigo_interno in ('BRAHMA350', 'NOVO1') order by nome",
    );
    expect(linhas).toEqual([
      { nome: 'AGUA MINERAL 500ML', preco_venda: '2.5000' },
      { nome: 'CERV BRAHMA LATA 350ML', preco_venda: '3.4900' },
    ]);
  });

  it('erros do arquivo e permissões', async () => {
    const semColuna = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .attach('arquivo', Buffer.from('Cor;Tamanho\nazul;P\n'), 'x.csv');
    expect(semColuna.status).toBe(422);
    expect(semColuna.body.mensagem).toContain('Nenhuma coluna reconhecida');
    const semLoja = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .attach('arquivo', Buffer.from(CSV_NUVEM3), 'x.csv');
    expect(semLoja.status).toBe(422);
    const xls = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .attach('arquivo', Buffer.from('x'), 'antigo.pdf');
    expect(xls.status).toBe(422);
    const negado = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(vendedor))
      .field('lojaId', lojaId)
      .attach('arquivo', Buffer.from(CSV_NUVEM3), 'x.csv');
    expect(negado.status).toBe(403);
    const outro = await amb
      .http()
      .post('/api/importacoes/produtos/confirmar')
      .set(bearer(admin))
      .send({ arquivoId: '0190f1a0-0000-7000-8000-000000000000', lojaId });
    expect(outro.status).toBe(404);
  });
});

describe('importação de clientes (ERP 8.6)', () => {
  it('cria pelo CPF, avisa documento inválido e cidade não encontrada; reimportar atualiza', async () => {
    const csv = [
      'Cliente;CPF/CNPJ;Fone;E-mail;CEP;Endereço;Número;Bairro;Cidade;UF;Data Nascimento',
      'MARIA DA SILVA;529.982.247-25;(43) 99999-0000;maria@exemplo.com;86010-000;Rua Exemplo;100;Centro;Londrina;PR;15/03/1990',
      'JOAO SOUZA;111.111.111-11;;;;;;;Cidade Que Não Existe;PR;',
      'BAR DO ZE LTDA;11.222.333/0001-81;4333334444;;;;;;;;',
    ].join('\n');
    const previa = async () => {
      const r = await amb
        .http()
        .post('/api/importacoes/clientes/previa')
        .set(bearer(admin))
        .attach('arquivo', Buffer.from(csv, 'latin1'), 'clientes.csv');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    const p = await previa();
    expect(p.resumo).toMatchObject({
      linhas: 3,
      criar: 3,
      porAviso: { documento_invalido: 1, cidade_inexistente: 1 },
    });
    const c = await amb
      .http()
      .post('/api/importacoes/clientes/confirmar')
      .set(bearer(admin))
      .send({ arquivoId: p.arquivoId });
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    const t = await aguardarTarefa(c.body.tarefaId);
    expect(t.resultado).toMatchObject({ tipo: 'clientes', criados: 3, comErro: 0 });
    const pessoas = await consultar<{
      nome: string;
      tipo: string;
      cpf_cnpj: string | null;
      origem: string;
      cidade: string | null;
    }>(
      emp.nomeBanco,
      `select p.nome, p.tipo, p.cpf_cnpj, p.origem, m.nome as cidade from pessoas p
         left join pessoas_enderecos e on e.pessoa_id = p.id left join municipios m on m.codigo_ibge = e.municipio_ibge
        order by p.nome`,
    );
    expect(pessoas).toEqual([
      { nome: 'BAR DO ZE LTDA', tipo: 'PJ', cpf_cnpj: '11222333000181', origem: 'importacao', cidade: null },
      { nome: 'JOAO SOUZA', tipo: 'PF', cpf_cnpj: null, origem: 'importacao', cidade: null },
      {
        nome: 'MARIA DA SILVA',
        tipo: 'PF',
        cpf_cnpj: '52998224725',
        origem: 'importacao',
        cidade: 'Londrina',
      },
    ]);
    const p2 = await previa();
    expect(p2.resumo).toMatchObject({ criar: 1, atualizar: 2 });
  });
});

describe('dashboard (ERP 6)', () => {
  it('cards de pessoas/produtos, vendas por loja zeradas, estoque abaixo do mínimo e permissões', async () => {
    // O mês padrão é o do dia operacional da empresa (corte 05:00, D7); as pessoas novas contam pelo mês do
    // calendário em que foram criadas, então os cards vão com o mês do calendário explícito (sem depender da hora).
    const antes = mesOperacionalEm(new Date(), '05:00');
    const padrao = await amb.http().get('/api/dashboard').set(bearer(admin));
    expect(padrao.status, JSON.stringify(padrao.body)).toBe(200);
    expect([antes, mesOperacionalEm(new Date(), '05:00')]).toContain(padrao.body.mes);
    const mesCalendario = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
      .format(new Date())
      .slice(0, 7);
    const r = await amb.http().get('/api/dashboard').set(bearer(admin)).query({ mes: mesCalendario });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      mes: mesCalendario,
      rotuloMes: expect.stringMatching(/\/\d{4}$/),
      pessoas: { ativas: 3, novasNoMes: 3 },
      produtos: { ativos: 5, semPreco: 0, ncmInvalido: 1 },
      vendas: {
        total: '0.00',
        quantidade: 0,
        porLoja: [{ lojaId, lojaNome: 'Loja 1 - Ice Beer Hermes', totalDia: '0.00', totalMes: '0.00' }],
      },
      pdvs: { total: 0, online: 0 },
      estoqueBaixo: [],
    });
    expect(r.body.vendasPorDia.length).toBeGreaterThanOrEqual(28);
    await consultar(
      emp.nomeBanco,
      `update produtos_lojas set estoque_minimo = 200 where produto_id = (select id from produtos where codigo_interno = 'BRAHMA350')`,
    );
    const baixo = await amb.http().get('/api/dashboard').set(bearer(admin)).query({ lojaId, mes: '2026-10' });
    expect(baixo.body.rotuloMes).toBe('Outubro/2026');
    expect(baixo.body.estoqueBaixo).toEqual([
      expect.objectContaining({
        produtoNome: 'CERV BRAHMA LATA 350ML',
        quantidade: '120.000',
        estoqueMinimo: '200.000',
      }),
    ]);
    // Sem `dashboard.ver_financeiro` o card financeiro não vem; loja fora das permitidas é 403.
    const v = await amb.http().get('/api/dashboard').set(bearer(vendedor));
    expect(v.status).toBe(200);
    expect(v.body.financeiro).toBeNull();
    const fora = await amb
      .http()
      .get('/api/dashboard')
      .set(bearer(vendedor))
      .query({ lojaId: '0190f1a0-0000-7000-8000-000000000000' });
    expect(fora.status).toBe(403);
    const invalido = await amb.http().get('/api/dashboard').set(bearer(admin)).query({ mes: '2026-13' });
    expect(invalido.status).toBe(422);
  });
});

// Depois do dashboard (que conta os produtos e pessoas das importações acima).
describe('importação: limites, permissões e combo (revisão da Fase 1)', () => {
  /** Zip mínimo (um arquivo, deflate) com o tamanho declarado que quisermos. */
  async function zipCom(nome: string, conteudo: Buffer, declarado = conteudo.length): Promise<Buffer> {
    const { deflateRawSync, crc32 } = await import('node:zlib');
    const dados = deflateRawSync(conteudo);
    const n = Buffer.from(nome);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(conteudo), 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(conteudo), 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(0, 42);
    const inicioCentral = local.length + n.length + dados.length;
    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0);
    fim.writeUInt16LE(1, 8);
    fim.writeUInt16LE(1, 10);
    fim.writeUInt32LE(central.length + n.length, 12);
    fim.writeUInt32LE(inicioCentral, 16);
    return Buffer.concat([local, n, dados, central, n, fim]);
  }

  const previa = (token: string, arquivo: Buffer, nome: string, campos: Record<string, string> = {}) => {
    let req = amb.http().post('/api/importacoes/produtos/previa').set(bearer(token)).field('lojaId', lojaId);
    for (const [k, v] of Object.entries(campos)) req = req.field(k, v);
    return req.attach('arquivo', arquivo, nome);
  };

  it('zip-bomba (taxa e tamanho declarado mentiroso) e CSV de 10 MB de quebras de linha → 422 sem derrubar a API', async () => {
    // 20 MB de zeros viram ~20 KB: taxa > 100:1.
    const bomba = await zipCom('xl/worksheets/sheet1.xml', Buffer.alloc(20 * 1024 * 1024));
    const r1 = await previa(admin, bomba, 'bomba.xlsx');
    expect(r1.status).toBe(422);
    expect(r1.body.mensagem).toContain('grande demais');
    // Cabeçalho mente (declara 1 KB): a descompactação real para no tamanho declarado.
    const mentiroso = await zipCom('xl/worksheets/sheet1.xml', Buffer.alloc(512 * 1024, 'a'), 1024);
    const r2 = await previa(admin, mentiroso, 'mentiroso.xlsx');
    expect(r2.status).toBe(422);
    expect(r2.body.mensagem).toContain('grande demais');
    const quebras = await previa(admin, Buffer.alloc(10 * 1024 * 1024 - 1024, '\n'), 'quebras.csv');
    expect([413, 422]).toContain(quebras.status);
    const colunas = await previa(admin, Buffer.from(`nome${';'.repeat(5000)}\nx\n`), 'colunas.csv');
    expect(colunas.status).toBe(422);
    expect(colunas.body.mensagem).toContain('colunas');
    // Erro da biblioteca não volta ao usuário.
    const quebrado = await zipCom('lixo.txt', Buffer.from('não é planilha'));
    const r3 = await previa(admin, quebrado, 'quebrado.xlsx');
    expect(r3.status).toBe(422);
    expect(r3.body.mensagem).toBe(
      'Não foi possível ler a planilha: salve de novo como .xlsx ou .csv e envie outra vez.',
    );
    expect((await amb.http().get('/api/saude').set(bearer(admin))).status).toBeLessThan(500);
  });

  it('Estoquista: sem marcas.criar/categorias.editar não cria marca nem categoria; sem acertos não atualiza estoque; sem criar/editar a linha vira erro', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [lojaId] });
    const est = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
    const csv = Buffer.from(
      'Ref. Interna;Produto;Venda;Marca;Departamento;NCM\nEST1;REFRI EST 2L;9,99;MARCA NOVA EST;BEBIDA > REFRI;22021000\n',
    );
    const r = await previa(est, csv, 'est.csv', { criarMarcasCategorias: 'true' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const avisos = (r.body.linhas[0].avisos as Array<{ codigo: string }>).map((a) => a.codigo);
    expect(avisos).toEqual(expect.arrayContaining(['marca_inexistente', 'categoria_inexistente']));
    // O seed do Estoquista tem estoque_acertos.*: "Atualizar estoque" passa; sem a permissão → 403.
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito)
       select id, 'estoque_acertos.criar', 'negar' from usuarios where login = 'estoquista'`,
    );
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito)
       select id, 'produtos.criar', 'negar' from usuarios where login = 'estoquista'`,
    );
    await consultar(
      emp.nomeBanco,
      "update usuarios set permissoes_versao = permissoes_versao + 1 where login = 'estoquista'",
    );
    const semAcerto = await previa(est, csv, 'est.csv', {
      atualizarEstoque: 'true',
      dataContagem: new Date().toISOString(),
    });
    expect(semAcerto.status).toBe(403);
    const semCriar = await previa(est, csv, 'est.csv');
    expect(semCriar.status).toBe(200);
    expect(semCriar.body.linhas[0]).toMatchObject({
      acao: 'ignorar',
      erros: [expect.stringContaining('Produtos: Criar')],
    });
    // Planilha de clientes não é confirmada como de produtos.
    const cli = await amb
      .http()
      .post('/api/importacoes/clientes/previa')
      .set(bearer(admin))
      .attach('arquivo', Buffer.from('Nome;CPF\nFULANO;\n'), 'cli.csv');
    expect(cli.status, JSON.stringify(cli.body)).toBe(200);
    const trocado = await amb
      .http()
      .post('/api/importacoes/produtos/confirmar')
      .set(bearer(admin))
      .send({ arquivoId: cli.body.arquivoId, lojaId });
    expect(trocado.status).toBe(404);
    const [mime] = await consultar<{ tipo_mime: string }>(
      emp.nomeBanco,
      'select tipo_mime from arquivos where id = $1',
      [cli.body.arquivoId],
    );
    expect(mime!.tipo_mime).toBe('text/csv');
  });

  it('combo pela coluna Composição (componentes da mesma planilha) e combo sem composição criado inativo', async () => {
    const csv = Buffer.from(
      [
        'Ref. Interna;Produto;Tipo;Venda;NCM;Composição',
        'CMB1;COMBO WHISKY TESTE;grupo de itens;129,90;;WHK1*1 | GELO1*2 [Gelo de sabor]',
        'WHK1;WHISKY TESTE 1L;Simples;99,90;22083020;',
        'GELO1;GELO COCO TESTE;Simples;3,00;22011000;',
        'CMB2;COMBO SEM POSICOES;combo;50,00;;',
      ].join('\n'),
    );
    const r = await previa(admin, csv, 'combo.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const porLinha = new Map((r.body.linhas as Array<{ linha: number }>).map((l) => [l.linha, l]));
    expect(porLinha.get(2)).toMatchObject({ acao: 'criar', erros: [] });
    expect(porLinha.get(5)).toMatchObject({
      acao: 'criar',
      avisos: [expect.objectContaining({ codigo: 'combo_sem_posicoes' })],
    });
    const c = await amb
      .http()
      .post('/api/importacoes/produtos/confirmar')
      .set(bearer(admin))
      .send({ arquivoId: r.body.arquivoId, lojaId });
    const t = await aguardarTarefa(c.body.tarefaId);
    expect(t.status, t.erro).toBe('concluida');
    expect(t.resultado).toMatchObject({ criados: 4, comErro: 0 });
    const pos = await consultar<{ componente: string; quantidade: string; rotulo: string | null }>(
      emp.nomeBanco,
      `select c.nome as componente, pc.quantidade::text, pc.rotulo_posicao as rotulo
         from produtos_componentes pc join produtos k on k.id = pc.produto_id join produtos c on c.id = pc.componente_id
        where k.codigo_interno = 'CMB1' and pc.excluido_em is null order by pc.ordem`,
    );
    expect(pos).toEqual([
      { componente: 'WHISKY TESTE 1L', quantidade: '1.000', rotulo: null },
      { componente: 'GELO COCO TESTE', quantidade: '2.000', rotulo: 'Gelo de sabor' },
    ]);
    const [semPos] = await consultar<{ ativo: boolean; tipo: string }>(
      emp.nomeBanco,
      "select ativo, tipo from produtos where codigo_interno = 'CMB2'",
    );
    expect(semPos).toEqual({ ativo: false, tipo: 'kit' });
  });
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
