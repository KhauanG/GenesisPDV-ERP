/**
 * Edição em massa pela planilha de produtos do Nuvem3 (ERP 8.6; decisões 102–104): fixture **sintética** com os 15
 * cabeçalhos exatos do arquivo que o Nuvem3 exporta e reimporta (IdProduto como número, unidade por extenso,
 * categoria em lista com vírgula, NCM que perdeu o zero, estoque negativo, EAN curto, Excluir). 1ª importação cria com
 * os códigos do Nuvem3; reimportação idêntica = tudo `sem_alteracao` (nada gravado); 2 células alteradas = 2
 * `atualizar` com o diff certo e só esses produtos gravados; Excluir=S inativa; a nossa exportação reimporta igual.
 */
import { setTimeout as esperar } from 'node:timers/promises';
import writeXlsxFile from 'write-excel-file/node';
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

process.env.IMPORTACAO_PREVIAS_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let lojaId: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-nuvem3-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  lojaId = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

/** EAN-13 com o dígito verificador certo a partir de 12 dígitos. */
function ean13(base: string): string {
  const soma = [...base].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${base}${(10 - (soma % 10)) % 10}`;
}

const CABECALHO = [
  'IdProduto',
  'NomeProduto',
  'CodigoInterno',
  'CodigoBarras',
  'NCM',
  'PrecoCusto',
  'PrecoPJ',
  'PrecoVenda',
  'EstoqueMinimo',
  'EstoqueAtual',
  'Categoria',
  'Unidade',
  'UsaNoMenuDigital',
  'UsaBalancaEtiquetadoraStr',
  'Excluir',
] as const;
type Linha = Partial<Record<(typeof CABECALHO)[number], string | number | null>>;

const EAN_CERVEJA = ean13('789100000001');
const EAN_ESSENCIA = ean13('789100000002');
const EAN_ESSENCIA_2 = ean13('789100000003');
const EAN_AGUA = ean13('789100000004');

/** Base sintética (formato do Nuvem3, dados inventados). */
const BASE: Linha[] = [
  {
    IdProduto: 91000202,
    NomeProduto: 'CERVEJA - TESTE ULTRA LN 330ML',
    CodigoBarras: EAN_CERVEJA,
    NCM: '22030000',
    PrecoCusto: 3.2,
    PrecoPJ: 0,
    PrecoVenda: 4.49,
    EstoqueMinimo: 12,
    EstoqueAtual: 48,
    Categoria: 'CERVEJA,',
    Unidade: 'Unidade',
  },
  {
    // CodigoInterno que é outro GTIN do produto; categoria cujo nome tem vírgula+espaço; estoque negativo.
    IdProduto: 91000203,
    NomeProduto: 'NICSALTS - ESSENCIA TESTE 30ML',
    CodigoInterno: EAN_ESSENCIA_2,
    CodigoBarras: EAN_ESSENCIA,
    NCM: '9030090',
    PrecoCusto: 20,
    PrecoPJ: 0,
    PrecoVenda: 39.9,
    EstoqueMinimo: 0,
    EstoqueAtual: -3,
    Categoria: 'NICSALTS, JUICE E PODS,',
    Unidade: 'Conjunto',
  },
  {
    // Duas categorias (a primeira é a principal); EAN curto; NCM vazio.
    IdProduto: 91000204,
    NomeProduto: 'MERCEARIA - PIPOCA TESTE 100G',
    CodigoBarras: '17',
    PrecoCusto: 1.5,
    PrecoPJ: 0,
    PrecoVenda: 3,
    EstoqueMinimo: 0,
    EstoqueAtual: 10,
    Categoria: 'MERCEARIA,PIPOCA,',
    Unidade: 'Pacote',
  },
  {
    // NCM como número sem o zero; unidade vazia (padrão UN); menu digital ligado.
    IdProduto: 91000205,
    NomeProduto: 'AGUA - TESTE SEM GAS 500ML',
    CodigoBarras: EAN_AGUA,
    NCM: 4022130,
    PrecoCusto: 0.8,
    PrecoPJ: 0,
    PrecoVenda: 2.5,
    EstoqueMinimo: 6,
    EstoqueAtual: 0,
    Categoria: 'ÁGUA,',
    UsaNoMenuDigital: 'S',
  },
];

async function xlsx(linhas: Linha[], cabecalho: readonly string[] = CABECALHO): Promise<Buffer> {
  return writeXlsxFile([
    cabecalho.map((c) => ({ value: c })),
    ...linhas.map((l) =>
      cabecalho.map((c) => {
        const v = (l as Record<string, string | number | null | undefined>)[c];
        return v === null || v === undefined ? null : { value: v };
      }),
    ),
  ]).toBuffer();
}

const OPCOES = {
  atualizarEstoque: true,
  atualizarEstoqueMinimo: true,
  atualizarPrecos: true,
  criarMarcasCategorias: true,
};

async function previa(linhas: Linha[], token = admin, cabecalho: readonly string[] = CABECALHO) {
  let req = amb.http().post('/api/importacoes/produtos/previa').set(bearer(token)).field('lojaId', lojaId);
  for (const [k, v] of Object.entries(OPCOES)) req = req.field(k, String(v));
  // A hora da contagem do "Atualizar estoque" (F2-B11): cada carga conta agora.
  req = req.field('dataContagem', new Date().toISOString());
  const r = await req.attach('arquivo', await xlsx(linhas, cabecalho), 'Produtos_30102026_1532.xlsx');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    arquivoId: string;
    colunasIgnoradas: string[];
    resumo: Record<string, number> & { porAviso: Record<string, number> };
    linhas: Array<{
      linha: number;
      acao: string;
      erros: string[];
      avisos: Array<{ codigo: string; mensagem: string }>;
      alteracoes?: Array<{ campo: string; rotulo: string; de: string | null; para: string | null }>;
    }>;
  };
}

async function confirmar(arquivoId: string, token = admin) {
  const c = await amb
    .http()
    .post('/api/importacoes/produtos/confirmar')
    .set(bearer(token))
    .send({ arquivoId, lojaId, ...OPCOES, dataContagem: new Date().toISOString() });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  const fim = Date.now() + 60_000;
  for (;;) {
    const r = await amb.http().get(`/api/tarefas/${c.body.tarefaId}`).set(bearer(token));
    if (r.body.status === 'concluida' || r.body.status === 'falhou') {
      expect(r.body.status, r.body.erro).toBe('concluida');
      return r.body.resultado as Record<string, unknown>;
    }
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
    await esperar(200);
  }
}

const versoes = async () =>
  new Map(
    (
      await consultar<{ codigo: number; versao: string }>(
        emp.nomeBanco,
        'select codigo, versao::text from produtos',
      )
    ).map((p) => [p.codigo, p.versao]),
  );
const auditorias = async () =>
  (
    await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where entidade = 'produtos' and origem = 'importacao'",
    )
  )[0]!.n;

describe('planilha de produtos do Nuvem3 (edição em massa)', () => {
  it('1ª importação: cria com o IdProduto do Nuvem3, unidade por extenso, categorias em lista e estoque negativo', async () => {
    const p = await previa(BASE);
    expect(p.resumo).toMatchObject({ linhas: 4, criar: 4, atualizar: 0, sem_alteracao: 0, ignorar: 0 });
    expect(p.colunasIgnoradas).toEqual([expect.stringMatching(/^PrecoPJ \(sem equivalente no GenesisPDV/)]);
    const porLinha = new Map(p.linhas.map((l) => [l.linha, l]));
    // NCM de 7 dígitos completado e existente: sem aviso; estoque negativo avisado; EAN curto avisado.
    expect(porLinha.get(3)!.avisos.map((a) => a.codigo)).toEqual(['estoque_negativo']);
    expect(
      porLinha
        .get(4)!
        .avisos.map((a) => a.codigo)
        .sort(),
    ).toEqual(['ean_invalido', 'ncm_invalido']);
    expect(porLinha.get(5)!.avisos).toEqual([]);
    expect(p.resumo.porAviso.codigo_conflito ?? 0).toBe(0);

    const r = await confirmar(p.arquivoId);
    expect(r).toMatchObject({ criados: 4, atualizados: 0, comErro: 0, acertoCodigo: expect.any(Number) });
    const produtos = await consultar<{
      codigo: number;
      unidade: string;
      ncm: string | null;
      usa_menu_digital: boolean;
      categorias: string;
      principal: string | null;
      saldo: string | null;
    }>(
      emp.nomeBanco,
      `select p.codigo, u.sigla as unidade, p.ncm, p.usa_menu_digital,
              (select string_agg(c.nome, '|' order by c.nome) from produtos_categorias pc join categorias c on c.id = pc.categoria_id
                where pc.produto_id = p.id and pc.excluido_em is null) as categorias,
              (select c.nome from categorias c where c.id = p.categoria_principal_id) as principal,
              (select s.quantidade::text from saldos_estoque s where s.produto_id = p.id) as saldo
         from produtos p join unidades_medida u on u.id = p.unidade_id order by p.codigo`,
    );
    expect(produtos).toEqual([
      {
        codigo: 91000202,
        unidade: 'UN',
        ncm: '22030000',
        usa_menu_digital: false,
        categorias: 'CERVEJA',
        principal: 'CERVEJA',
        saldo: '48.000',
      },
      {
        codigo: 91000203,
        unidade: 'CJ',
        ncm: '09030090',
        usa_menu_digital: false,
        categorias: 'NICSALTS, JUICE E PODS',
        principal: 'NICSALTS, JUICE E PODS',
        saldo: '-3.000',
      },
      {
        codigo: 91000204,
        unidade: 'PCT',
        ncm: null,
        usa_menu_digital: false,
        categorias: 'MERCEARIA|PIPOCA',
        principal: 'MERCEARIA',
        saldo: '10.000',
      },
      {
        codigo: 91000205,
        unidade: 'UN',
        ncm: '04022130',
        usa_menu_digital: true,
        categorias: 'ÁGUA',
        principal: 'ÁGUA',
        // Contado com 0 e sem movimento nunca: o item do "Definir" fica gravado, sem criar a linha zerada de saldo.
        saldo: null,
      },
    ]);
    // Novo produto pelo formulário continua na sequência normal (o código explícito não mexe nela).
    const un = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from unidades_medida where sigla = 'UN'",
    );
    const novo = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ nome: 'PRODUTO MANUAL', unidadeId: un[0]!.id, precoVenda: '1' });
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    const [manual] = await consultar<{ codigo: number }>(
      emp.nomeBanco,
      "select codigo from produtos where nome = 'PRODUTO MANUAL'",
    );
    expect(manual!.codigo).toBeLessThan(100);
  });

  it('reimportação idêntica: tudo sem_alteracao, nada gravado (auditoria, versão e acerto)', async () => {
    const antes = await versoes();
    const auditoriasAntes = await auditorias();
    const p = await previa(BASE);
    expect(p.resumo).toMatchObject({ linhas: 4, criar: 0, atualizar: 0, sem_alteracao: 4, ignorar: 0 });
    expect(p.linhas.every((l) => l.acao === 'sem_alteracao' && !l.alteracoes?.length)).toBe(true);
    // O estoque negativo já é o saldo: sem aviso repetido.
    expect(p.resumo.porAviso.estoque_negativo ?? 0).toBe(0);
    const r = await confirmar(p.arquivoId);
    expect(r).toMatchObject({ criados: 0, atualizados: 0, semAlteracao: 4, acertoId: null });
    expect(await versoes()).toEqual(antes);
    expect(await auditorias()).toBe(auditoriasAntes);
  });

  it('2 células alteradas: 2 atualizar com o diff certo e só esses campos/produtos gravados', async () => {
    const antes = await versoes();
    const auditoriasAntes = await auditorias();
    const alterada = BASE.map((l) => ({ ...l }));
    alterada[0]!.PrecoVenda = 4.99;
    alterada[3]!.NomeProduto = 'AGUA - TESTE SEM GAS 510ML';
    const p = await previa(alterada);
    expect(p.resumo).toMatchObject({ atualizar: 2, sem_alteracao: 2, criar: 0, ignorar: 0 });
    const porLinha = new Map(p.linhas.map((l) => [l.linha, l]));
    expect(porLinha.get(2)).toMatchObject({
      acao: 'atualizar',
      alteracoes: [{ campo: 'precoVenda', rotulo: 'Preço de venda', de: '4,49', para: '4,99' }],
    });
    expect(porLinha.get(5)).toMatchObject({
      acao: 'atualizar',
      alteracoes: [
        {
          campo: 'nome',
          rotulo: 'Nome',
          de: 'AGUA - TESTE SEM GAS 500ML',
          para: 'AGUA - TESTE SEM GAS 510ML',
        },
      ],
    });
    // Mudança grande, mas o nome ainda é parecido: sem aviso de código.
    expect(porLinha.get(5)!.avisos).toEqual([]);
    const r = await confirmar(p.arquivoId);
    expect(r).toMatchObject({ atualizados: 2, semAlteracao: 2, comErro: 0 });
    const depois = await versoes();
    const mudaram = [...depois].filter(([c, v]) => antes.get(c) !== v).map(([c]) => c);
    expect(mudaram.sort()).toEqual([91000202, 91000205]);
    expect(await auditorias()).toBe(auditoriasAntes + 2);
    const [aud] = await consultar<{ antes: string; depois: string }>(
      emp.nomeBanco,
      `select a.antes->>'precoVenda' as antes, a.depois->>'precoVenda' as depois from auditoria a
        where a.entidade = 'produtos' and a.acao = 'editar' and a.registro_id = (select id from produtos where codigo = 91000202)`,
    );
    expect(Number(aud!.antes)).toBe(4.49);
    expect(Number(aud!.depois)).toBe(4.99);
    const [agua] = await consultar<{ nome: string; preco_venda: string; preco_custo: string }>(
      emp.nomeBanco,
      'select nome, preco_venda::text, preco_custo::text from produtos where codigo = 91000205',
    );
    expect(agua).toEqual({
      nome: 'AGUA - TESTE SEM GAS 510ML',
      preco_venda: '2.5000',
      preco_custo: '0.8000',
    });
  });

  it('nossa exportação reimporta como sem_alteracao (ida e volta, ERP 8.5)', async () => {
    const exp = await amb
      .http()
      .get('/api/produtos/exportar?formato=xlsx')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(exp.status).toBe(200);
    const r = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .field('atualizarPrecos', 'true')
      .attach('arquivo', exp.body as Buffer, 'Produtos.xlsx');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumo).toMatchObject({ linhas: 5, sem_alteracao: 5 });
  });

  it('Excluir=S inativa o existente e ignora a linha de produto inexistente; proteções do código', async () => {
    const p = await previa([
      { ...BASE[0], Excluir: 'S' },
      { IdProduto: 99999901, NomeProduto: 'NAO EXISTE', PrecoVenda: 1, Excluir: 'Sim' },
      // Código achado, mas o EAN é de outro produto e o nome é totalmente diferente.
      { ...BASE[2], NomeProduto: 'CARVAO VEGETAL 3KG', CodigoBarras: EAN_AGUA },
      { IdProduto: 'abc', NomeProduto: 'CODIGO RUIM', PrecoVenda: 1 },
      { IdProduto: 91000205, NomeProduto: 'AGUA - TESTE SEM GAS 510ML', PrecoVenda: 2.5 },
      { IdProduto: 91000205, NomeProduto: 'AGUA REPETIDA', PrecoVenda: 2.5 },
    ]);
    const porLinha = new Map(p.linhas.map((l) => [l.linha, l]));
    expect(porLinha.get(2)).toMatchObject({
      acao: 'inativar',
      alteracoes: [{ campo: 'ativo', de: 'Sim', para: 'Não' }],
    });
    expect(porLinha.get(3)).toMatchObject({
      acao: 'ignorar',
      erros: [],
      avisos: [expect.objectContaining({ codigo: 'exclusao_sem_produto' })],
    });
    expect(porLinha.get(4)!.avisos.filter((a) => a.codigo === 'codigo_conflito')).toHaveLength(2);
    expect(porLinha.get(5)).toMatchObject({ acao: 'ignorar', erros: [expect.stringContaining('inválido')] });
    expect(porLinha.get(7)).toMatchObject({ acao: 'ignorar', erros: [expect.stringContaining('repetido')] });
    expect(p.resumo).toMatchObject({ inativar: 1 });

    const somenteExcluir = await previa([{ ...BASE[0], Excluir: 'X' }]);
    const r = await confirmar(somenteExcluir.arquivoId);
    expect(r).toMatchObject({ inativados: 1, comErro: 0 });
    const [cerveja] = await consultar<{ ativo: boolean; excluido_em: string | null }>(
      emp.nomeBanco,
      'select ativo, excluido_em from produtos where codigo = 91000202',
    );
    expect(cerveja).toEqual({ ativo: false, excluido_em: null });
    // Já inativo: reimportar com Excluir não muda nada.
    const de2 = await previa([{ ...BASE[0], Excluir: 'X' }]);
    expect(de2.resumo).toMatchObject({ sem_alteracao: 1, inativar: 0 });
  });

  it('subcategoria existente + categoria nova na mesma célula: liga à existente, sem raiz duplicada', async () => {
    const a: Linha = {
      IdProduto: 30000001,
      NomeProduto: 'SALGADINHO - TESTE A',
      PrecoVenda: 5,
      Categoria: 'ALIMENTOS > SALGADINHO,',
      Unidade: 'Unidade',
    };
    const b: Linha = {
      IdProduto: 30000002,
      NomeProduto: 'SALGADINHO - TESTE B',
      PrecoVenda: 6,
      Categoria: 'SALGADINHO,PROMO NOVA,',
      Unidade: 'Unidade',
    };
    await confirmar((await previa([a])).arquivoId);
    const p = await previa([b]);
    expect(p.linhas[0]).toMatchObject({ acao: 'criar', erros: [] });
    await confirmar(p.arquivoId);
    const categorias = await consultar<{ caminho_nomes: string }>(
      emp.nomeBanco,
      "select caminho_nomes from categorias where nome in ('SALGADINHO', 'PROMO NOVA') order by 1",
    );
    expect(categorias.map((c) => c.caminho_nomes)).toEqual(['ALIMENTOS > SALGADINHO', 'PROMO NOVA']);
    const [ligadas] = await consultar<{ principal: string; todas: string }>(
      emp.nomeBanco,
      `select (select c.caminho_nomes from categorias c where c.id = p.categoria_principal_id) as principal,
              (select string_agg(c.caminho_nomes, '|' order by c.caminho_nomes) from produtos_categorias pc
                 join categorias c on c.id = pc.categoria_id where pc.produto_id = p.id and pc.excluido_em is null) as todas
         from produtos p where p.codigo = 30000002`,
    );
    expect(ligadas).toEqual({
      principal: 'ALIMENTOS > SALGADINHO',
      todas: 'ALIMENTOS > SALGADINHO|PROMO NOVA',
    });
    // Reimportar o 1º só com o nome curto continua na categoria original.
    const de2 = await previa([{ ...a, Categoria: 'SALGADINHO,' }, b]);
    expect(de2.resumo).toMatchObject({ sem_alteracao: 2, atualizar: 0 });
  });

  it('produto sem controle de estoque: estoque atual diferente não vira atualizar fantasma', async () => {
    await consultar(emp.nomeBanco, 'update produtos set controla_estoque = false where codigo = 30000001');
    const p = await previa([
      {
        IdProduto: 30000001,
        NomeProduto: 'SALGADINHO - TESTE A',
        PrecoVenda: 5,
        EstoqueAtual: 7,
        Categoria: 'ALIMENTOS > SALGADINHO,',
        Unidade: 'Unidade',
      },
    ]);
    expect(p.linhas[0]).toMatchObject({ acao: 'sem_alteracao', alteracoes: [] });
    expect(p.linhas[0]!.avisos.map((a) => a.mensagem)).toContainEqual(
      expect.stringContaining('não controla estoque'),
    );
  });

  it('saldo negativo exige Master ou "Permitir saldo negativo no ERP" da loja (como a Saída)', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'gerente_imp', perfil: 'gerente', lojas: [lojaId] });
    const gerente = await amb.entrar(emp.codigo, 'gerente_imp', SENHA_TESTE);
    const linha = { ...BASE[2], EstoqueAtual: -4 };
    const sem = await previa([linha], gerente);
    expect(sem.linhas[0]).toMatchObject({ acao: 'sem_alteracao' });
    expect(sem.linhas[0]!.avisos).toContainEqual(
      expect.objectContaining({
        codigo: 'estoque_negativo',
        mensagem: expect.stringContaining('não lançado'),
      }),
    );
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('estoque.permite_negativo_erp', 'true'::jsonb)`,
    );
    try {
      const com = await previa([linha], gerente);
      expect(com.linhas[0]).toMatchObject({
        acao: 'atualizar',
        alteracoes: [expect.objectContaining({ campo: 'estoque_atual', de: '10', para: '-4' })],
      });
      expect(await confirmar(com.arquivoId, gerente)).toMatchObject({
        comErro: 0,
        acertoCodigo: expect.any(Number),
      });
      const [s] = await consultar<{ q: string }>(
        emp.nomeBanco,
        'select s.quantidade::text as q from saldos_estoque s join produtos p on p.id = s.produto_id where p.codigo = 91000204',
      );
      expect(s!.q).toBe('-4.000');
    } finally {
      await consultar(
        emp.nomeBanco,
        `delete from configuracoes where chave = 'estoque.permite_negativo_erp'`,
      );
    }
  });

  it('tipos sem suporte (F2-B1): a planilha não cria Com variações nem Com complementos; o legado atualiza e reimporta igual', async () => {
    const COM_TIPO = ['IdProduto', 'NomeProduto', 'Tipo', 'PrecoVenda'];
    const linhas = (nomeGelo: string, tipoGelo: string) =>
      [
        { IdProduto: 91000301, NomeProduto: 'LANCHE TESTE', Tipo: 'Com complementos', PrecoVenda: 20 },
        { IdProduto: 91000302, NomeProduto: 'CAMISETA TESTE', Tipo: 'Com variações', PrecoVenda: 50 },
        { IdProduto: 91000303, NomeProduto: nomeGelo, Tipo: tipoGelo, PrecoVenda: 8 },
      ] as unknown as Linha[];
    const criacao = await previa(linhas('GELO TESTE 5KG', 'Simples'), admin, COM_TIPO);
    expect(criacao.resumo).toMatchObject({ linhas: 3, criar: 1, ignorar: 2 });
    expect(criacao.linhas.map((l) => l.erros)).toEqual([
      ['Tipo disponível em breve: "Com complementos" ainda não tem suporte nesta versão'],
      ['Tipo disponível em breve: "Com variações" ainda não tem suporte nesta versão'],
      [],
    ]);
    expect(await confirmar(criacao.arquivoId)).toMatchObject({ criados: 1, comErro: 2 });

    // Legado: o "Com complementos" da carga do Nuvem3 continua passando (o tipo já é o gravado).
    await consultar(emp.nomeBanco, "update produtos set tipo = 'com_complementos' where codigo = 91000303");
    const igual = await previa(linhas('GELO TESTE 5KG', 'Com complementos').slice(2), admin, COM_TIPO);
    expect(igual.linhas[0]).toMatchObject({ acao: 'sem_alteracao', erros: [], alteracoes: [] });
    const mudou = await previa(linhas('GELO TESTE 10KG', 'Com complementos').slice(2), admin, COM_TIPO);
    expect(mudou.linhas[0]).toMatchObject({
      acao: 'atualizar',
      erros: [],
      alteracoes: [expect.objectContaining({ campo: 'nome', para: 'GELO TESTE 10KG' })],
    });
    expect(await confirmar(mudou.arquivoId)).toMatchObject({ atualizados: 1, comErro: 0 });
    const [gelo] = await consultar<{ nome: string; tipo: string }>(
      emp.nomeBanco,
      'select nome, tipo from produtos where codigo = 91000303',
    );
    expect(gelo).toEqual({ nome: 'GELO TESTE 10KG', tipo: 'com_complementos' });

    // Ida e volta: a exportação do filtro "Tipo sem suporte" reimporta sem alteração.
    const exp = await amb
      .http()
      .get('/api/produtos/exportar?formato=xlsx&situacaoCadastro=tipo_sem_suporte')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(exp.status).toBe(200);
    const volta = await amb
      .http()
      .post('/api/importacoes/produtos/previa')
      .set(bearer(admin))
      .field('lojaId', lojaId)
      .field('atualizarPrecos', 'true')
      .attach('arquivo', exp.body as Buffer, 'Produtos.xlsx');
    expect(volta.status, JSON.stringify(volta.body)).toBe(200);
    expect(volta.body.resumo).toMatchObject({ linhas: 1, sem_alteracao: 1 });
  });

  it('códigos explícitos à frente da sequência: o próximo do formulário salta a faixa ocupada de uma vez', async () => {
    const [seq] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select last_value::text as n from seq_codigo_produtos',
    );
    const inicio = Number(seq!.n) + 1;
    // Mais que as 10.000 tentativas do laço antigo (um nextval por código ocupado).
    await consultar(
      emp.nomeBanco,
      `insert into produtos (nome, unidade_id, codigo)
       select 'FAIXA ' || g, (select id from unidades_medida where sigla = 'UN'), g
         from generate_series($1::int, $1::int + 10049) g`,
      [inicio],
    );
    const [un] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from unidades_medida where sigla = 'UN'",
    );
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ nome: 'DEPOIS DA FAIXA', unidadeId: un!.id, precoVenda: '1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [p] = await consultar<{ codigo: number }>(
      emp.nomeBanco,
      "select codigo from produtos where nome = 'DEPOIS DA FAIXA'",
    );
    expect(p!.codigo).toBe(inicio + 10050);
    const [depois] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select last_value::text as n from seq_codigo_produtos',
    );
    expect(Number(depois!.n)).toBe(inicio + 10050);
  }, 60_000);
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
