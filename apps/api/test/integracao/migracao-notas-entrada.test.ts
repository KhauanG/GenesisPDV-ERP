/**
 * Migração 0024 (Fase 2, F2-B18; MD 3.8.2; README da API › decisão 163) em empresa nova e em empresa existente: a
 * nova nasce com as três tabelas, a sequência do `codigo`, os triggers de versão (`fn_versao_local`), de dados do XML
 * imutáveis, de imutabilidade depois de movimentada e dos filhos só com a nota aberta; a existente (esquema da 0023
 * com cadastro e um recebimento) recebe tudo sem mexer no que já estava. Também: a chave única (inclusive a nota
 * ignorada), os CHECKs do MD 3.8.2, a FK de `produtos_lojas.st_nota_entrada_id` e a leitura + validação da NF-e contra
 * o banco (`lerEValidarXmlNfe`: destinatário entre as lojas, o CD como depósito, chave já importada e a chave
 * `notas_entrada.assinatura_invalida`). O `Esquema.g.cs` do PDV não muda (nenhuma das tabelas está num fluxo).
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../../src/database/migracoes/preparacoes-empresa.js';
import { lerEValidarXmlNfe } from '../../src/entradas/xml/validacoes.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { TABELAS_DOS_FLUXOS } from '../../src/sync/fluxos.js';
import type { DbEmpresa } from '../../src/tenancy/tenancy.js';
import { CNPJ_CD, CNPJ_LOJA_1, fixtureNfe } from '../fixtures/nfe/fixtures.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === '0024_notas_entrada');

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m24`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;

const ids: Record<string, string> = {};
const TABELAS = ['notas_entrada', 'itens_nota_entrada', 'notas_entrada_duplicatas'];

/** O que a 0024 cria, lido do catálogo (as três tabelas, a sequência, os triggers que não são de FK e os CHECKs). */
async function estrutura(nome: string) {
  const triggers = await consultar<{ tabela: string; trigger: string; funcao: string }>(
    nome,
    `select c.relname as tabela, t.tgname as trigger, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relname = any($1) order by 1, 2`,
    [TABELAS],
  );
  const [seq] = await consultar<{ cache_size: number }>(
    nome,
    "select cache_size::int from pg_sequences where sequencename = 'seq_codigo_notas_entrada'",
  );
  const checks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint where contype = 'c' and conrelid::regclass::text = any($1) order by 1`,
    [TABELAS],
  );
  const [fk] = await consultar<{ n: number }>(
    nome,
    "select count(*)::int as n from pg_constraint where conname = 'fk_produtos_lojas_st_nota_entrada_id'",
  );
  return { triggers, seq, checks: checks.map((x) => x.conname), fkSt: fk!.n };
}

const um = async (sql: string, params: unknown[] = []) =>
  (await c.query<{ id: string }>(sql, params)).rows[0]!.id;

/** Nota mínima válida para os testes de trigger (os dados do XML como colunas). */
async function inserirNota(chave: string, extra: Record<string, unknown> = {}): Promise<string> {
  const colunas: Record<string, unknown> = {
    loja_id: ids.loja,
    estoque_id: ids.estoque,
    tipo_estoque_id: ids.tipo,
    fornecedor_id: ids.fornecedor,
    chave,
    serie: 1,
    numero: 12345,
    data_emissao: '2026-10-20T08:15:00-03:00',
    emitente_cnpj: '99887766000105',
    emitente_nome: 'DISTRIBUIDORA',
    emitente_uf: 'SP',
    destinatario_cnpj: CNPJ_LOJA_1,
    valor_produtos: '657.00',
    valor_total: '763.77',
    protocolo_numero: '135260000000101',
    protocolo_data: '2026-10-20T08:16:02-03:00',
    protocolo_status: 100,
    assinatura: 'valida',
    xml_arquivo_id: ids.arquivo,
    ...extra,
  };
  const nomes = Object.keys(colunas);
  return um(
    `insert into notas_entrada (${nomes.join(', ')}) values (${nomes.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(colunas),
  );
}

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_024,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000100',
    email: null,
    regime: 'simples_nacional',
  });
  // Cadastro da empresa antes da 0024: Loja 1 e o CD (depósito) com os CNPJs das fixtures, fornecedor, produto e
  // um recebimento em rascunho.
  ids.estoque = await um("insert into estoques (nome) values ('Estoque Loja 1') returning id");
  ids.loja = await um(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro,
       municipio_ibge, uf)
     values (1, 'Loja 1', 'Loja 1', 'Loja 1', $1, $2, '01001000', 'Praça da Sé', '1', 'Sé', 3550308, 'SP')
     returning id`,
    [CNPJ_LOJA_1, ids.estoque],
  );
  ids.estoqueCd = await um("insert into estoques (nome, tipo) values ('CD', 'deposito') returning id");
  ids.cd = await um(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, tipo, usa_pdv, cep, logradouro, numero,
       bairro, municipio_ibge, uf)
     values (2, 'CD', 'CD', 'CD', $1, $2, 'deposito', false, '01001000', 'Praça da Sé', '2', 'Sé', 3550308, 'SP')
     returning id`,
    [CNPJ_CD, ids.estoqueCd],
  );
  ids.fornecedor = await um("insert into pessoas (nome, tipo) values ('Distribuidora X', 'PJ') returning id");
  ids.produto = await um(
    "insert into produtos (nome, unidade_id) values ('Cerveja lata', (select id from unidades_medida where sigla = 'UN')) returning id",
  );
  ids.tipo = await um('select id from tipos_estoque where padrao');
  ids.recebimento = await um(
    `insert into recebimentos (loja_id, estoque_id, tipo_estoque_id, fornecedor_id)
     values ($1, $2, $3, $4) returning id`,
    [ids.loja, ids.estoque, ids.tipo, ids.fornecedor],
  );

  await aplicarMigracoes(c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });

  ids.arquivo = await um(
    `insert into arquivos (chave_armazenamento, nome_original, tipo_mime, tamanho_bytes, sha256, categoria)
     values ('empresa/xml/a.xml', 'a.xml', 'application/xml', 100, repeat('a', 64), 'xml_nfe_entrada') returning id`,
  );

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
  await amb?.fechar();
});

describe('migração 0024_notas_entrada (F2-B18)', () => {
  it('empresa nova e empresa existente terminam com a mesma estrutura', async () => {
    const nova = await estrutura(bancoNovo);
    const existente = await estrutura(banco);
    expect(existente).toEqual(nova);
    expect(nova.seq).toEqual({ cache_size: 1 });
    expect(nova.fkSt).toBe(1);
    expect(nova.triggers).toEqual([
      {
        tabela: 'itens_nota_entrada',
        trigger: 'tg_itens_nota_entrada_aberta',
        funcao: 'fn_filhos_nota_entrada_aberta',
      },
      { tabela: 'itens_nota_entrada', trigger: 'tg_itens_nota_entrada_versao', funcao: 'fn_versao_local' },
      {
        tabela: 'itens_nota_entrada',
        trigger: 'tg_itens_nota_entrada_xml_imutavel',
        funcao: 'fn_protege_imutavel',
      },
      {
        tabela: 'notas_entrada',
        trigger: 'tg_notas_entrada_estornada_final',
        funcao: 'fn_protege_imutavel',
      },
      { tabela: 'notas_entrada', trigger: 'tg_notas_entrada_imutavel', funcao: 'fn_protege_imutavel' },
      { tabela: 'notas_entrada', trigger: 'tg_notas_entrada_versao', funcao: 'fn_versao_local' },
      { tabela: 'notas_entrada', trigger: 'tg_notas_entrada_xml_imutavel', funcao: 'fn_protege_imutavel' },
      {
        tabela: 'notas_entrada_duplicatas',
        trigger: 'tg_notas_entrada_duplicatas_aberta',
        funcao: 'fn_filhos_nota_entrada_aberta',
      },
      {
        tabela: 'notas_entrada_duplicatas',
        trigger: 'tg_notas_entrada_duplicatas_imutavel',
        funcao: 'fn_protege_imutavel',
      },
      {
        tabela: 'notas_entrada_duplicatas',
        trigger: 'tg_notas_entrada_duplicatas_versao',
        funcao: 'fn_versao_local',
      },
    ]);
    expect(nova.checks).toEqual([
      'ck_itens_nota_entrada_atualizar_preco',
      'ck_itens_nota_entrada_fator',
      'ck_itens_nota_entrada_ignorado',
      'ck_itens_nota_entrada_numero_item',
      'ck_itens_nota_entrada_validade',
      'ck_itens_nota_entrada_valores',
      'ck_itens_nota_entrada_vinculo',
      'ck_notas_entrada_assinatura',
      'ck_notas_entrada_chave',
      'ck_notas_entrada_destinatario_cnpj',
      'ck_notas_entrada_duplicatas_valor',
      'ck_notas_entrada_emitente_cnpj',
      'ck_notas_entrada_financeiro',
      'ck_notas_entrada_ignorada',
      'ck_notas_entrada_modelo',
      'ck_notas_entrada_movimentacao',
      'ck_notas_entrada_origem',
      'ck_notas_entrada_protocolo_status',
      'ck_notas_entrada_status',
      'ck_notas_entrada_valores',
    ]);
    for (const t of TABELAS) expect(TABELAS_DOS_FLUXOS).not.toContain(t);
  });

  it('na existente, o que já estava fica igual e a primeira nota é o Nº 1, pendente, com versão', async () => {
    const { rows } = await c.query('select status from recebimentos where id = $1', [ids.recebimento]);
    expect(rows).toEqual([{ status: 'rascunho' }]);
    const id = await inserirNota('35261099887766000105550010000111111102030401');
    const { rows: n } = await c.query<{ codigo: number; status: string; versao: string; origem: string }>(
      'select codigo, status, versao, origem, gerar_financeiro from notas_entrada where id = $1',
      [id],
    );
    expect(n[0]).toMatchObject({ codigo: 1, status: 'pendente', origem: 'upload', gerar_financeiro: false });
    expect(Number(n[0]!.versao)).toBeGreaterThan(0);
  });

  it('CHECKs: chave e CNPJ no formato, só modelo 55 e origem upload, protocolo autorizado, ignorada com motivo', async () => {
    const chave = '35261099887766000105550010000999991102030409';
    for (const extra of [
      { chave: '3526109988776600010555001000012345110203040' },
      { emitente_cnpj: '123' },
      { modelo: 65 },
      { origem: 'sefaz' },
      { protocolo_status: 110 },
      { status: 'ignorada' },
      { assinatura: 'talvez' },
      { valor_total: '-1' },
    ])
      await expect(inserirNota(chave, extra), JSON.stringify(extra)).rejects.toMatchObject({ code: '23514' });
    // O emitente produtor rural tem CPF.
    await expect(inserirNota(chave, { emitente_cnpj: '12345678909' })).resolves.toBeTruthy();
  });

  it('a mesma chave só uma vez, inclusive com a nota ignorada', async () => {
    const chave = '35261099887766000105550010000777771102030405';
    const id = await inserirNota(chave);
    await c.query(
      "update notas_entrada set status = 'ignorada', motivo_ignorada = 'Duplicada do fornecedor' where id = $1",
      [id],
    );
    await expect(inserirNota(chave)).rejects.toMatchObject({ code: '23505' });
    // Reabrir volta a pendente (o motivo sai).
    await c.query("update notas_entrada set status = 'pendente', motivo_ignorada = null where id = $1", [id]);
  });

  it('os dados do XML nunca mudam; depois de movimentada a nota, os itens e as duplicatas não mudam', async () => {
    const id = await inserirNota('35261099887766000105550010000555551102030401');
    await expect(
      c.query("update notas_entrada set valor_total = '1.00' where id = $1", [id]),
    ).rejects.toMatchObject({
      message: 'DOCUMENTO_IMUTAVEL',
    });
    await expect(c.query('update notas_entrada set chave = chave where id = $1', [id])).resolves.toBeTruthy();
    // Trocar o destino (loja/estoque) é livre enquanto aberta.
    await c.query('update notas_entrada set estoque_id = $2, loja_id = $3 where id = $1', [
      id,
      ids.estoqueCd,
      ids.cd,
    ]);
    const item = await um(
      `insert into itens_nota_entrada (nota_entrada_id, numero_item, codigo_fornecedor, descricao, cfop,
         unidade_comercial, quantidade_comercial, valor_unitario_comercial, valor_produto)
       values ($1, 1, 'CERV-LT350-CX12', 'CERVEJA LATA CX C/12', '5401', 'CX', 10, 39.9123456789, 399.12) returning id`,
      [id],
    );
    const { rows: casas } = await c.query(
      'select valor_unitario_comercial::text v, cfop_entrada from itens_nota_entrada where id = $1',
      [item],
    );
    expect(casas).toEqual([{ v: '39.9123456789', cfop_entrada: null }]);
    await expect(
      c.query("update itens_nota_entrada set descricao = 'OUTRA' where id = $1", [item]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    await c.query(
      'update itens_nota_entrada set produto_id = $2, fator = 12, quantidade_estoque = 120 where id = $1',
      [item, ids.produto],
    );
    await expect(
      c.query('update itens_nota_entrada set ignorado = true where id = $1', [item]),
    ).rejects.toMatchObject({ code: '23514' });
    await c.query(
      "insert into notas_entrada_duplicatas (nota_entrada_id, sequencia, numero, vencimento, valor) values ($1, 1, '001', '2026-11-19', 700)",
      [id],
    );
    await expect(
      c.query('update notas_entrada_duplicatas set valor = 1 where nota_entrada_id = $1', [id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });

    await c.query(
      "update notas_entrada set status = 'movimentada', data_movimentacao = now() where id = $1",
      [id],
    );
    await expect(
      c.query('update notas_entrada set loja_id = $2 where id = $1', [id, ids.loja]),
    ).rejects.toMatchObject({
      message: 'DOCUMENTO_IMUTAVEL',
    });
    await expect(
      c.query('update itens_nota_entrada set fator = 6 where id = $1', [item]),
    ).rejects.toMatchObject({
      message: 'DOCUMENTO_IMUTAVEL',
    });
    await expect(
      c.query(
        'insert into notas_entrada_duplicatas (nota_entrada_id, sequencia, valor) values ($1, 2, 63.77)',
        [id],
      ),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    // O estorno só mexe nas colunas do estorno.
    await c.query(
      "update notas_entrada set status = 'estornada', estornada_em = now(), motivo_estorno = 'Nota errada' where id = $1",
      [id],
    );
    // Estornada é o fim: voltar a movimentada ("desestornar", sem o RECEB_NFE de novo) ou mexer no estorno é barrado
    // pelo tg_notas_entrada_estornada_final, e voltar a pendente também (antes dele, o ck_notas_entrada_movimentacao).
    await expect(
      c.query(
        `update notas_entrada set status = 'movimentada', estornada_em = null, estornada_por_id = null,
           motivo_estorno = null where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' });
    await expect(
      c.query("update notas_entrada set motivo_estorno = 'Outro motivo' where id = $1", [id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    await expect(
      c.query("update notas_entrada set status = 'pendente', data_movimentacao = null where id = $1", [id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    const { rows } = await c.query('select status from notas_entrada where id = $1', [id]);
    expect(rows).toEqual([{ status: 'estornada' }]);
  });

  it('o recebimento estornado (0023) também é o fim: não volta a movimentado', async () => {
    const r = await um(
      `insert into recebimentos (loja_id, estoque_id, tipo_estoque_id, fornecedor_id)
       values ($1, $2, $3, $4) returning id`,
      [ids.loja, ids.estoque, ids.tipo, ids.fornecedor],
    );
    await c.query("update recebimentos set status = 'movimentado', movimentado_em = now() where id = $1", [
      r,
    ]);
    await c.query(
      "update recebimentos set status = 'estornado', estornado_em = now(), motivo_estorno = 'Entrada em dobro' where id = $1",
      [r],
    );
    await expect(
      c.query(
        `update recebimentos set status = 'movimentado', estornado_em = null, estornado_por_id = null,
           motivo_estorno = null where id = $1`,
        [r],
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' });
  });
});

describe('leitura e validação contra o banco (lerEValidarXmlNfe)', () => {
  const db = () => drizzle(c) as unknown as DbEmpresa;

  it('a nota da Loja 1 entra na Loja 1 e a do CD (depósito) no CD; a da loja que não existe é recusada', async () => {
    const r1 = await lerEValidarXmlNfe(db(), fixtureNfe('01-icms-st.xml'));
    expect(r1).toMatchObject({ aceita: true, loja: { id: ids.loja, tipo: 'ponto_venda' }, avisos: [] });
    const r7 = await lerEValidarXmlNfe(db(), Buffer.from(fixtureNfe('07-rastro-cd.xml')));
    expect(r7).toMatchObject({
      aceita: true,
      loja: { id: ids.cd, tipo: 'deposito' },
      assinatura: { situacao: 'valida' },
    });
    const r5 = await lerEValidarXmlNfe(db(), fixtureNfe('05-qtrib-diferente.xml'));
    expect(r5).toMatchObject({
      aceita: false,
      motivo: 'DESTINATARIO_FORA_DA_EMPRESA',
      chave: expect.any(String),
    });
  });

  it('NFC-e, nota sem protocolo, chave inválida e XXE são recusadas com o motivo', async () => {
    const base = fixtureNfe('01-icms-st.xml');
    const casos: Array<[string, string]> = [
      [fixtureNfe('08-nfce.xml'), 'MODELO_NAO_ACEITO'],
      [/<NFe[\s\S]*<\/NFe>/.exec(base)![0], 'SEM_PROTOCOLO'],
      [
        base.replaceAll(
          '35261099887766000105550010000123451102030401',
          '35261099887766000105550010000123451102030409',
        ),
        'CHAVE_INVALIDA',
      ],
      [
        `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${base.replace(/^<\?xml[^>]*\?>/, '')}`,
        'XML_COM_DTD',
      ],
    ];
    for (const [xml, motivo] of casos)
      expect(await lerEValidarXmlNfe(db(), xml), motivo).toMatchObject({
        aceita: false,
        motivo,
        mensagem: expect.any(String),
      });
  });

  it('a chave já importada é recusada com a nota existente', async () => {
    const xml = fixtureNfe('03-ipi-industria.xml');
    const chave = /<chNFe>(\d{44})<\/chNFe>/.exec(xml)![1]!;
    const id = await inserirNota(chave);
    const { rows } = await c.query<{ codigo: number }>('select codigo from notas_entrada where id = $1', [
      id,
    ]);
    expect(await lerEValidarXmlNfe(db(), xml)).toMatchObject({
      aceita: false,
      motivo: 'CHAVE_JA_IMPORTADA',
      chave,
      notaExistente: { id, codigo: rows[0]!.codigo, status: 'pendente' },
    });
  });

  it('notas_entrada.assinatura_invalida: avisar (padrão), recusar e não conferir', async () => {
    // Um campo do XML mudou depois de assinado (o CEP do emitente): a assinatura deixa de conferir.
    const alterado = fixtureNfe('04-embalagens-cx-fd-pct.xml').replace(
      '<CEP>01002000</CEP>',
      '<CEP>01002001</CEP>',
    );
    expect(await lerEValidarXmlNfe(db(), alterado)).toMatchObject({
      aceita: true,
      assinatura: { situacao: 'invalida' },
      avisos: [{ motivo: 'ASSINATURA_INVALIDA' }],
    });
    try {
      await c.query(
        `insert into configuracoes (escopo, chave, valor) values ('empresa', 'notas_entrada.assinatura_invalida', '"recusar"'::jsonb)`,
      );
      expect(await lerEValidarXmlNfe(db(), alterado)).toMatchObject({
        aceita: false,
        motivo: 'ASSINATURA_INVALIDA',
      });
      await c.query(
        `update configuracoes set valor = '"nao_conferir"'::jsonb where chave = 'notas_entrada.assinatura_invalida'`,
      );
      expect(await lerEValidarXmlNfe(db(), alterado)).toMatchObject({
        aceita: true,
        assinatura: { situacao: 'nao_conferida', detalhe: null },
        avisos: [],
      });
    } finally {
      await c.query("delete from configuracoes where chave = 'notas_entrada.assinatura_invalida'");
    }
  });
});
