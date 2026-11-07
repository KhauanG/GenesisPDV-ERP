/**
 * Relatório Estoque Atual (Fase 2, F2-B31; ERP 16.4, 13.6, 13.1.5; README da API › decisão 178), pela API do ERP: as
 * linhas por estoque × tipo com o custo (só com `produtos.ver_custo`), Atacado, iFood, o "Em trânsito" e a
 * "Divergência a tratar" (F2-B26); marca e departamento (a categoria e as filhas); o "Todas" somando só os estoques
 * permitidos e sem a loja de treino por padrão (D39); o "Vencendo em N dias" pelos lotes; a data-base no passado igual
 * ao saldo da época, pelos dois caminhos (a projeção menos o razão depois da data e a soma até a data, que a regra da
 * metade escolhe) e com o custo médio da época; o modal de ajuste (um "Definir" de origem `relatorio_estoque`,
 * `AJUSTE_RELATORIO`, que aparece na lista de acertos e desce ao PDV, com a regra do negativo e as permissões); a venda
 * offline anterior à hora do ajuste, que chega depois, compensada; e a exportação pela rota comum (na hora e em
 * tarefa), sem o custo para quem não o vê e só com os estoques permitidos. O razão refaz as projeções idênticas no fim
 * (`conferirRazaoDoBanco`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import {
  CONTRATOS_EVENTOS,
  filtrosEstoqueAtualSchema,
  jcs,
  respostaPullSchema,
  respostaPushSchema,
  type Ativar,
  type RespostaEstoqueAtual,
} from '@genesis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import ExcelJS from 'exceljs';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlEstoqueAtual, type MetodoDataBase } from '../../src/relatorios/estoque-atual.js';
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
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let loja1: string;
let estoque1: string;
let estoque2: string;
let estoqueTreino: string;
let cd: string;
let disponivel: string;
let avaria: string;
let un: string;
let operador: string;
let dinheiro: string;
let tokenAdmin: string;
/** Estoquista da Loja 1 (só o estoque dela): vê o relatório e ajusta, sem `produtos.ver_custo`. */
let tokenEstoquista: string;
/** O estoquista sem `estoque_acertos.criar`: vê o relatório, não ajusta. */
let tokenConsulta: string;
/** Sem `relatorios.estoque_atual`. */
let tokenVendedor: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
/** Hoje − `dias` no fuso de Brasília (`AAAA-MM-DD`), o da empresa de teste. */
const diaLocal = (dias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() - dias * 86_400_000),
  );

async function relatorio(query: Record<string, string>, tk = tokenAdmin): Promise<RespostaEstoqueAtual> {
  const r = await amb.http().get('/api/relatorios/estoque-atual').query(query).set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaEstoqueAtual;
}

async function criarProduto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '10', precoCusto: '4', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function entrada(
  estoqueId: string,
  produtoId: string,
  quantidade: string,
  custo = '4',
  extra: { tipoEstoqueId?: string; loteId?: string } = {},
) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId,
      tipoEstoqueId: extra.tipoEstoqueId ?? null,
      motivo: 'Saldo inicial',
      dataContagem: agora(),
      tipoAjuste: 'entrada',
      itens: [{ produtoId, quantidade, custoUnitario: custo, loteId: extra.loteId ?? null }],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
}

const ajustar = (corpo: Record<string, unknown>, tk = tokenAdmin) =>
  amb
    .http()
    .post('/api/relatorios/estoque-atual/ajustar')
    .set(bearer(tk))
    .send({ estoqueId: estoque1, motivo: 'Inventário', ...corpo });

async function ajustarOk(corpo: Record<string, unknown>, tk = tokenAdmin) {
  const r = await ajustar(corpo, tk);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { acertoId: string; codigo: number; diferenca: string; compensacoes: number };
}

const linha = (r: RespostaEstoqueAtual, produtoId: string, estoqueId: string | null = estoque1) =>
  r.itens.find(
    (l) => l.produtoId === produtoId && l.estoqueId === estoqueId && l.tipoEstoqueId === disponivel,
  );

// ---------------------------------------------------------------- Terminal e venda offline (como no definir-offline)

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
  numero: number;
  terminal: string;
  token: string;
  seq: number;
  sessao: string;
}

type Payload = Record<string, unknown>;

function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
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
    contexto: { loja_id: loja1, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

async function push(p: Ponto, eventos: unknown[]) {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Array<{ status: string }>;
}

let numeroCaixa = 0;

async function novoPonto(): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja1, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja1, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
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
    numero,
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    sessao: uuidv7(),
  };
  const [aberto] = await push(p, [
    evento(p, 'caixa.aberto', {
      sessoes_caixa: {
        id: p.sessao,
        loja_id: loja1,
        caixa_id: p.caixa,
        numero_caixa: p.numero,
        terminal_id: p.terminal,
        operador_id: operador,
        status: 'aberta',
        dia_operacional: '2026-10-31',
        aberta_em: horasAtras(5),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    }),
  ]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  return p;
}

function venda(p: Ponto, produto: string, quantidade: string, finalizadaEm: string) {
  const id = uuidv7();
  const total = (10 * Number(quantidade)).toFixed(2);
  return {
    vendas: {
      id,
      numero: p.seq + 1,
      numero_exibicao: `L01-C${String(p.numero).padStart(2, '0')}-${String(p.seq + 1).padStart(6, '0')}`,
      loja_id: loja1,
      caixa_id: p.caixa,
      numero_caixa: p.numero,
      terminal_id: p.terminal,
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-10-31',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: total,
      total,
      iniciada_em: finalizadaEm,
      finalizada_em: finalizadaEm,
    },
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produto,
        descricao: 'ITEM DE TESTE',
        unidade: 'UN',
        quantidade,
        preco_tabela: '10.0000',
        preco_unitario: '10.0000',
        valor_bruto: total,
        valor_liquido: total,
        incluido_em: finalizadaEm,
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
        valor: total,
        lanca_quitada: true,
      },
    ],
    vasilhames: [],
  };
}

async function puxarEstoque(token: string, desde: number) {
  const alteracoes: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=estoque&desde=${cursor}&limite=2000`)
      .set(cabecalhos(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...r.body.alteracoes);
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

// ---------------------------------------------------------------- Preparação

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-estoque-atual-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const treino = await criarLoja(emp.nomeBanco, 9, 'Treino');
  await consultar(
    emp.nomeBanco,
    "update lojas set treino = true, tipo_emissao = 'nao_fiscal' where id = $1",
    [treino],
  );
  const estoqueDa = async (loja: string) =>
    (
      (await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])) as [{ estoque_id: string }]
    )[0].estoque_id;
  estoque1 = await estoqueDa(loja1);
  estoque2 = await estoqueDa(loja2);
  estoqueTreino = await estoqueDa(treino);
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into estoques (nome, tipo) values ('CD - Estoque Teste', 'deposito') returning id`,
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoque1],
  });
  await consultar(
    emp.nomeBanco,
    `insert into usuarios_permissoes (usuario_id, permissao, efeito)
     select id, 'relatorios.exportar', 'conceder' from usuarios where login = 'estoquista'`,
  );
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, {
    login: 'consulta',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoque1],
  });
  await consultar(
    emp.nomeBanco,
    `insert into usuarios_permissoes (usuario_id, permissao, efeito)
     select id, 'estoque_acertos.criar', 'negar' from usuarios where login = 'consulta'`,
  );
  tokenConsulta = await amb.entrar(emp.codigo, 'consulta', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja1] });
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const tipos = await consultar<{ id: string; chave_sistema: string }>(
    emp.nomeBanco,
    `select id, chave_sistema from tipos_estoque where chave_sistema in ('disponivel', 'avaria')`,
  );
  disponivel = tipos.find((t) => t.chave_sistema === 'disponivel')!.id;
  avaria = tipos.find((t) => t.chave_sistema === 'avaria')!.id;
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

// ---------------------------------------------------------------- Testes

describe('Estoque Atual: linhas, colunas e filtros (ERP 16.4)', () => {
  it('por estoque × tipo, com Atacado, iFood, em trânsito, divergência, totais e o custo só com "Ver custo"', async () => {
    const p = await criarProduto('CERV COLUNAS 600', {
      codigoInterno: 'COL-600',
      precoAtacado: '9',
      precoIfood: '12.5',
    });
    await entrada(estoque1, p, '10', '4');
    await entrada(estoque1, p, '2', '3', { tipoEstoqueId: avaria });
    await entrada(cd, p, '30', '5');
    // 6 a caminho da Loja 1, saídas do CD.
    const t = await amb
      .http()
      .post('/api/transferencias')
      .set(bearer())
      .send({
        estoqueOrigemId: cd,
        estoqueDestinoId: estoque1,
        motivo: 'Reposição',
        itens: [{ produtoId: p, quantidade: '6' }],
      });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const env = await amb.http().post(`/api/transferencias/${t.body.id}/enviar`).set(bearer()).send({});
    expect(env.status, JSON.stringify(env.body)).toBe(200);

    const r = await relatorio({ estoqueId: estoque1, nome: 'COL-600', tamanho: '50' });
    expect(r.itens.map((l) => [l.tipoEstoqueNome, l.quantidade])).toEqual([
      ['Avaria', '2.000'],
      ['Disponível', '10.000'],
    ]);
    expect(linha(r, p)).toMatchObject({
      estoqueNome: 'Estoque Loja 1 - Centro',
      codigoInterno: 'COL-600',
      quantidade: '10.000',
      emTransito: '6.000',
      divergenciaATratar: '0.000',
      custoMedio: '4.0000',
      custoTotal: '40.00',
      precoVenda: '10.0000',
      precoAtacado: '9.0000',
      precoIfood: '12.5000',
      vendaTotal: '100.00',
      vencendo: null,
    });
    expect(r.totais).toEqual({ quantidadeItens: 2, custoTotal: '46.00', vendaTotal: '120.00' });
    expect(r.total).toBe(2);
    // Sem "Ver custo" (o estoquista), o custo some da linha e dos totais.
    const semCusto = await relatorio({ estoqueId: estoque1, nome: 'COL-600' }, tokenEstoquista);
    expect(linha(semCusto, p)).toMatchObject({ custoMedio: null, custoTotal: null, vendaTotal: '100.00' });
    expect(semCusto.totais.custoTotal).toBeNull();
    const ordenarCusto = await amb
      .http()
      .get('/api/relatorios/estoque-atual')
      .query({ ordenar: 'custo_total:desc' })
      .set(bearer(tokenEstoquista));
    expect(ordenarCusto.status).toBe(422);
    // Sem a permissão do relatório: 403.
    const proibido = await amb.http().get('/api/relatorios/estoque-atual').set(bearer(tokenVendedor));
    expect(proibido.status).toBe(403);
  });

  it('marca e departamento com as filhas; situação do saldo; paginação com o total do relatório', async () => {
    const marca = await amb.http().post('/api/marcas').set(bearer()).send({ descricao: 'Cervejaria Serra' });
    expect(marca.status, JSON.stringify(marca.body)).toBe(201);
    const cat = async (nome: string, categoriaPaiId: string | null = null) => {
      const r = await amb.http().post('/api/categorias').set(bearer()).send({ nome, categoriaPaiId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const bebidas = await cat('Bebidas Rel');
    const cervejas = await cat('Cervejas Rel', bebidas);
    const daMarca = await criarProduto('SERRA IPA REL', {
      marcaId: marca.body.id,
      categorias: [cervejas],
      categoriaPrincipalId: cervejas,
    });
    const outra = await criarProduto('REFRI REL', { categorias: [bebidas], categoriaPrincipalId: bebidas });
    await entrada(estoque2, daMarca, '5');
    await entrada(estoque2, outra, '0.5');
    const porMarca = await relatorio({ estoqueId: estoque2, marcaId: marca.body.id });
    expect(porMarca.itens.map((l) => [l.produtoNome, l.marcaNome])).toEqual([
      ['SERRA IPA REL', 'Cervejaria Serra'],
    ]);
    // O departamento pai traz os produtos das filhas.
    const porPai = await relatorio({ estoqueId: estoque2, categoriaId: bebidas });
    expect(porPai.itens.map((l) => l.produtoNome).sort()).toEqual(['REFRI REL', 'SERRA IPA REL']);
    const porFilha = await relatorio({ estoqueId: estoque2, categoriaId: cervejas });
    expect(porFilha.itens.map((l) => l.produtoNome)).toEqual(['SERRA IPA REL']);
    // Situação do saldo e página além do fim (o total continua certo).
    const negativo = await relatorio({ estoqueId: estoque2, situacaoSaldo: 'negativo' });
    expect(negativo.total).toBe(0);
    const p2 = await relatorio({ estoqueId: estoque2, categoriaId: bebidas, tamanho: '20', pagina: '3' });
    expect(p2.itens).toEqual([]);
    expect(p2.total).toBe(2);
  });

  it('"Todas" soma só os estoques permitidos e deixa a loja de treino de fora por padrão (D39)', async () => {
    const p = await criarProduto('CERV TODAS REL', { codigoInterno: 'TODAS-1' });
    await entrada(estoque1, p, '10', '4');
    await entrada(estoque2, p, '5', '7');
    await entrada(estoqueTreino, p, '100', '1');
    await entrada(cd, p, '20', '4');

    const todas = await relatorio({ nome: 'TODAS-1' });
    expect(todas.itens).toHaveLength(1);
    expect(linha(todas, p, null)).toMatchObject({
      estoqueNome: 'Todas',
      quantidade: '35.000',
      // (10 × 4 + 5 × 7 + 20 × 4) / 35
      custoMedio: '4.4286',
      custoTotal: '155.00',
      vendaTotal: '350.00',
    });
    const comTreino = await relatorio({ nome: 'TODAS-1', treino: 'incluir' });
    expect(linha(comTreino, p, null)?.quantidade).toBe('135.000');
    const soTreino = await relatorio({ nome: 'TODAS-1', treino: 'somente' });
    expect(linha(soTreino, p, null)?.quantidade).toBe('100.000');
    // O estoque de treino escolhido aparece mesmo com o padrão "sem a loja de treino".
    const escolhido = await relatorio({ nome: 'TODAS-1', estoqueId: estoqueTreino });
    expect(linha(escolhido, p, estoqueTreino)?.quantidade).toBe('100.000');
    // `estoqueId=todas` é o mesmo que vazio.
    expect(linha(await relatorio({ nome: 'TODAS-1', estoqueId: 'todas' }), p, null)?.quantidade).toBe(
      '35.000',
    );
    // O estoquista só tem a Loja 1: o "Todas" dele é só ela; o CD escolhido fica vazio.
    const restrito = await relatorio({ nome: 'TODAS-1' }, tokenEstoquista);
    expect(linha(restrito, p, null)?.quantidade).toBe('10.000');
    const foraDoPermitido = await relatorio({ nome: 'TODAS-1', estoqueId: cd }, tokenEstoquista);
    expect(foraDoPermitido.itens).toEqual([]);
  });

  it('"Vencendo em N dias": só os lotes com validade até o limite, com a quantidade e a validade mais próxima', async () => {
    const p = await criarProduto('IOGURTE VENCENDO REL');
    const outro = await criarProduto('CERV SEM LOTE REL');
    const lote = async (codigo: string, dias: number) =>
      (
        (await consultar<{ id: string }>(
          emp.nomeBanco,
          `insert into produtos_lotes (produto_id, lote, validade) values ($1, $2, current_date + $3::int) returning id`,
          [p, codigo, dias],
        )) as [{ id: string }]
      )[0].id;
    await entrada(estoque1, p, '4', '2', { loteId: await lote('L-PERTO', 3) });
    await entrada(estoque1, p, '6', '2', { loteId: await lote('L-LONGE', 60) });
    await entrada(estoque1, outro, '9');
    const r = await relatorio({ estoqueId: estoque1, vencendoEmDias: '7' });
    const l = r.itens.filter((x) => x.produtoId === p || x.produtoId === outro);
    expect(l.map((x) => [x.produtoNome, x.quantidade, x.vencendo?.quantidade])).toEqual([
      ['IOGURTE VENCENDO REL', '10.000', '4.000'],
    ]);
    expect(l[0]!.vencendo!.validade).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const longe = await relatorio({ estoqueId: estoque1, nome: 'IOGURTE VENCENDO', vencendoEmDias: '90' });
    expect(longe.itens[0]!.vencendo!.quantidade).toBe('10.000');
    // Não combina com a data-base.
    const invalido = await amb
      .http()
      .get('/api/relatorios/estoque-atual')
      .query({ vencendoEmDias: '7', dataBase: diaLocal(1) })
      .set(bearer());
    expect(invalido.status).toBe(422);
    expect(Object.keys(invalido.body.campos)).toEqual(['vencendoEmDias']);
  });

  it('"Divergência a tratar" na linha do estoque de origem e somada no "Todas"', async () => {
    const p = await criarProduto('CERV DIVERGENCIA REL', { codigoInterno: 'DIV-1' });
    await entrada(cd, p, '20', '5');
    const t = await amb
      .http()
      .post('/api/transferencias')
      .set(bearer())
      .send({
        estoqueOrigemId: cd,
        estoqueDestinoId: estoque1,
        motivo: 'Reposição',
        itens: [{ produtoId: p, quantidade: '6' }],
      });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const env = await amb.http().post(`/api/transferencias/${t.body.id}/enviar`).set(bearer()).send({});
    expect(env.status, JSON.stringify(env.body)).toBe(200);
    // Chegam 4 de 6: os 2 a menor ficam como divergência a tratar na origem (o CD), fora do saldo e do trânsito.
    const rc = await amb
      .http()
      .post(`/api/transferencias/${t.body.id}/receber`)
      .set(bearer())
      .send({ itens: [{ itemId: t.body.itens[0].id, quantidadeRecebida: '4' }] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    expect(rc.body.status).toBe('recebida_divergencia');
    expect(linha(await relatorio({ estoqueId: cd, nome: 'DIV-1' }), p, cd)).toMatchObject({
      quantidade: '14.000',
      emTransito: '0.000',
      divergenciaATratar: '2.000',
    });
    expect(linha(await relatorio({ estoqueId: estoque1, nome: 'DIV-1' }), p)).toMatchObject({
      quantidade: '4.000',
      emTransito: '0.000',
      divergenciaATratar: '0.000',
    });
    expect(linha(await relatorio({ nome: 'DIV-1' }), p, null)).toMatchObject({
      quantidade: '18.000',
      emTransito: '0.000',
      divergenciaATratar: '2.000',
    });
  });

  it('"Zerado" e "Abaixo do mínimo" trazem o produto sem movimento no estoque, com saldo 0 no tipo padrão', async () => {
    // Cadastrado com mínimo de 24 na Loja 1 e nunca recebido: sem linha de saldo.
    const p = await criarProduto('CERV NOVA SEM MOV REL', {
      codigoInterno: 'SEMMOV-1',
      lojas: [{ lojaId: loja1, estoqueMinimo: '24' }],
    });
    await criarProduto('SACOLA SEM MOV REL', {
      codigoInterno: 'SEMMOV-2',
      controlaEstoque: false,
    });
    const [{ n }] = (await consultar<{ n: string }>(
      emp.nomeBanco,
      'select count(*)::text as n from saldos_estoque where produto_id = $1',
      [p],
    )) as [{ n: string }];
    expect(n).toBe('0');
    const filtros = { estoqueId: estoque1, nome: 'SEM MOV REL' };
    // Na situação "todos" (o padrão) e no "positivo", não aparece (seria o catálogo inteiro em cada estoque).
    expect((await relatorio(filtros)).itens).toEqual([]);
    for (const situacaoSaldo of ['abaixo_minimo', 'zerado']) {
      const r = await relatorio({ ...filtros, situacaoSaldo });
      // O que não controla estoque fica de fora.
      expect(
        r.itens.map((l) => l.produtoId),
        situacaoSaldo,
      ).toEqual([p]);
      expect(linha(r, p), situacaoSaldo).toMatchObject({
        estoqueId: estoque1,
        tipoEstoqueId: disponivel,
        quantidade: '0.000',
        estoqueMinimo: '24.000',
        custoMedio: '0.0000',
        custoTotal: '0.00',
        vendaTotal: '0.00',
        emTransito: '0.000',
        divergenciaATratar: '0.000',
      });
    }
    // No tipo escolhido: a linha sai nele; na data-base também (0 na data), sem pendências.
    const avariaZerado = await relatorio({ ...filtros, situacaoSaldo: 'zerado', tipoEstoqueId: avaria });
    expect(avariaZerado.itens.map((l) => [l.produtoId, l.tipoEstoqueId])).toEqual([[p, avaria]]);
    const naData = await relatorio({ ...filtros, situacaoSaldo: 'abaixo_minimo', dataBase: diaLocal(1) });
    expect(linha(naData, p)).toMatchObject({
      quantidade: '0.000',
      emTransito: null,
      divergenciaATratar: null,
    });
    // "Todas": o produto sem linha em nenhum estoque, com a soma dos mínimos (só a Loja 1 tem).
    const todas = await relatorio({ nome: 'SEM MOV REL', situacaoSaldo: 'abaixo_minimo' });
    expect(todas.itens.map((l) => [l.estoqueNome, l.produtoId, l.quantidade, l.estoqueMinimo])).toEqual([
      ['Todas', p, '0.000', '24.000'],
    ]);
    // Depois da primeira entrada (10, ainda abaixo do mínimo), é a linha de verdade, sem a de "sem movimento".
    await entrada(estoque1, p, '10', '4');
    const depois = await relatorio({ ...filtros, situacaoSaldo: 'abaixo_minimo' });
    expect(depois.itens.map((l) => [l.tipoEstoqueNome, l.quantidade])).toEqual([['Disponível', '10.000']]);
    expect((await relatorio({ ...filtros, situacaoSaldo: 'zerado' })).itens).toEqual([]);
    // Na Loja 2 (sem mínimo), o "Zerado" ainda o traz; o "Todas" já é a soma das linhas (10, e o mínimo 24).
    const loja2 = await relatorio({ estoqueId: estoque2, nome: 'SEM MOV REL', situacaoSaldo: 'zerado' });
    expect(loja2.itens.map((l) => [l.produtoId, l.quantidade, l.estoqueMinimo])).toEqual([
      [p, '0.000', null],
    ]);
    const todasDepois = await relatorio({ nome: 'SEM MOV REL', situacaoSaldo: 'abaixo_minimo' });
    expect(todasDepois.itens.map((l) => [l.produtoId, l.quantidade, l.estoqueMinimo])).toEqual([
      [p, '10.000', '24.000'],
    ]);
  });
});

describe('Estoque Atual: data-base "Saldo em <data>" (ERP 16.4; decisão 176)', () => {
  /**
   * A consulta do relatório com o caminho forçado, direto no banco (o Master: todos os estoques e o custo), com o fuso
   * da empresa de teste como a tela e a exportação o passam (`prepararFiltrosEstoqueAtual`).
   */
  async function porMetodo(filtros: Record<string, string>, metodo: MetodoDataBase) {
    const q = new PgDialect().sqlToQuery(
      sqlEstoqueAtual(
        { estoques: null, permissoes: new Set(['produtos.ver_custo']) },
        { ...filtrosEstoqueAtualSchema.parse(filtros), fuso: 'America/Sao_Paulo' },
        { metodoDataBase: metodo },
      ),
    );
    return consultar<{ produto_id: string; quantidade: string; custo_medio: string; recente?: boolean }>(
      emp.nomeBanco,
      q.sql,
      q.params as unknown[],
    );
  }

  it('a data-base no passado bate com o saldo da época, pelos dois caminhos e com o custo médio da época', async () => {
    const p = await criarProduto('CERV DATA BASE REL', { codigoInterno: 'DB-1' });
    // Contou 10 há 3 dias ao meio-dia e 7 ontem ao meio-dia (os "Definir" lançam na hora da contagem); hoje entram 5
    // a 6,00.
    await ajustarOk({ produtoId: p, quantidade: '10', dataContagem: `${diaLocal(3)}T12:00:00-03:00` });
    await ajustarOk({ produtoId: p, quantidade: '7', dataContagem: `${diaLocal(1)}T12:00:00-03:00` });
    await entrada(estoque1, p, '5', '6');
    const filtros = { estoqueId: estoque1, nome: 'DB-1' };
    expect(linha(await relatorio(filtros), p)?.quantidade).toBe('12.000');
    const casos: Array<[number, string | null]> = [
      [4, null],
      [3, '10.000'],
      [2, '10.000'],
      [1, '7.000'],
      [0, '12.000'],
    ];
    for (const [dias, esperado] of casos) {
      const r = await relatorio({ ...filtros, dataBase: diaLocal(dias) });
      expect(r.dataBase).toBe(diaLocal(dias));
      expect(linha(r, p)?.quantidade ?? null, `data-base ${diaLocal(dias)}`).toBe(esperado);
      if (esperado) {
        // Sem pendências na data-base.
        expect(linha(r, p)).toMatchObject({ emTransito: null, divergenciaATratar: null });
        // Os dois caminhos dão o mesmo resultado.
        for (const metodo of ['projecao', 'soma'] as const) {
          const linhas = await porMetodo({ ...filtros, dataBase: diaLocal(dias) }, metodo);
          expect(
            linhas.map((x) => x.quantidade),
            `${metodo} em ${diaLocal(dias)}`,
          ).toEqual([esperado]);
        }
      } else {
        for (const metodo of ['projecao', 'soma'] as const)
          expect(await porMetodo({ ...filtros, dataBase: diaLocal(dias) }, metodo)).toEqual([]);
      }
    }
    // Custo médio da época: 4 até ontem (o custo de cadastro do Definir), (7 × 4 + 5 × 6) / 12 hoje.
    expect(linha(await relatorio({ ...filtros, dataBase: diaLocal(1) }), p)?.custoMedio).toBe('4.0000');
    expect(linha(await relatorio(filtros), p)?.custoMedio).toBe('4.8333');
    // A regra da metade: a data antiga (há 3 dias, o começo da história) vai pela soma; a de ontem, pela projeção.
    const [antiga] = await porMetodo({ ...filtros, dataBase: diaLocal(3) }, 'automatico');
    expect(antiga?.recente).toBe(false);
    const [nova] = await porMetodo({ ...filtros, dataBase: diaLocal(1) }, 'automatico');
    expect(nova?.recente).toBe(true);
    // Data futura: 422.
    const futura = await amb
      .http()
      .get('/api/relatorios/estoque-atual')
      .query({ dataBase: diaLocal(-2) })
      .set(bearer());
    expect(futura.status).toBe(422);
    expect(Object.keys(futura.body.campos)).toEqual(['dataBase']);
  });

  it('o custo da data segue a ordem de lançamento: o "Definir" retroativo lançado depois da compra não traz o custo dela', async () => {
    const p = await criarProduto('CERV CUSTO RETRO REL', { codigoInterno: 'RETRO-1' });
    // 10 contados há 3 dias (ao custo de cadastro, 4); hoje entram 10 a 8,00 (custo 6); depois a contagem de 9 de
    // anteontem, lançada agora com a data de anteontem: uma saída de 1 que grava o custo vigente no lançamento (6).
    await ajustarOk({ produtoId: p, quantidade: '10', dataContagem: `${diaLocal(3)}T12:00:00-03:00` });
    await entrada(estoque1, p, '10', '8');
    const retro = await ajustarOk({
      produtoId: p,
      quantidade: '9',
      dataContagem: `${diaLocal(2)}T12:00:00-03:00`,
    });
    expect(retro.diferenca).toBe('-1.000');
    const [mov] = await consultar<{ custo: string }>(
      emp.nomeBanco,
      'select custo_medio_posterior::text as custo from movimentos_estoque where documento_id = $1',
      [retro.acertoId],
    );
    expect(mov!.custo).toBe('6.0000');
    const filtros = { estoqueId: estoque1, nome: 'RETRO-1' };
    // Anteontem e ontem: 9 ao custo de antes da compra (4), pelos dois caminhos; hoje, 19 a 6.
    for (const dias of [2, 1]) {
      expect(linha(await relatorio({ ...filtros, dataBase: diaLocal(dias) }), p)).toMatchObject({
        quantidade: '9.000',
        custoMedio: '4.0000',
        custoTotal: '36.00',
      });
      for (const metodo of ['projecao', 'soma'] as const)
        expect(
          (await porMetodo({ ...filtros, dataBase: diaLocal(dias) }, metodo)).map((x) => [
            x.quantidade,
            x.custo_medio,
          ]),
          `${metodo} em ${diaLocal(dias)}`,
        ).toEqual([['9.000', '4.0000']]);
    }
    expect(linha(await relatorio({ ...filtros, dataBase: diaLocal(0) }), p)).toMatchObject({
      quantidade: '19.000',
      custoMedio: '6.0000',
    });
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('"Todas" na data-base: a soma dos estoques e a média ponderada do custo da época', async () => {
    const p = await criarProduto('CERV TODAS DATA REL', { codigoInterno: 'TDB-1' });
    // Anteontem: 10 na Loja 1 ao custo de cadastro 4 e 5 na Loja 2 ao custo de cadastro 7 (trocado no meio).
    await ajustarOk({ produtoId: p, quantidade: '10', dataContagem: `${diaLocal(2)}T12:00:00-03:00` });
    await consultar(emp.nomeBanco, 'update produtos set preco_custo = 7 where id = $1', [p]);
    await ajustarOk({
      produtoId: p,
      estoqueId: estoque2,
      quantidade: '5',
      dataContagem: `${diaLocal(2)}T12:00:00-03:00`,
    });
    // Hoje entram 5 a 10,00 na Loja 1: (10 × 4 + 5 × 10) / 15 = 6.
    await entrada(estoque1, p, '5', '10');
    const filtros = { nome: 'TDB-1' };
    // Ontem: 15, (10 × 4 + 5 × 7) / 15 = 5, custo total 75; sem pendências na data-base.
    expect(linha(await relatorio({ ...filtros, dataBase: diaLocal(1) }), p, null)).toMatchObject({
      estoqueNome: 'Todas',
      quantidade: '15.000',
      custoMedio: '5.0000',
      custoTotal: '75.00',
      emTransito: null,
      divergenciaATratar: null,
    });
    for (const metodo of ['projecao', 'soma'] as const)
      expect(
        (await porMetodo({ ...filtros, dataBase: diaLocal(1) }, metodo)).map((x) => [
          x.quantidade,
          x.custo_medio,
        ]),
        metodo,
      ).toEqual([['15.000', '5.0000']]);
    // Hoje: 20, (15 × 6 + 5 × 7) / 20 = 6,25, custo total 125.
    expect(linha(await relatorio(filtros), p, null)).toMatchObject({
      quantidade: '20.000',
      custoMedio: '6.2500',
      custoTotal: '125.00',
    });
  });
});

describe('Estoque Atual: modal de ajuste (ERP 16.4, 13.6, 13.1.5)', () => {
  it('cria e efetiva um Definir de origem relatorio_estoque (AJUSTE_RELATORIO), na lista de acertos e no PDV', async () => {
    const ponto = await novoPonto();
    const { cursor } = await puxarEstoque(ponto.token, 0);
    const p = await criarProduto('CERV AJUSTE REL');
    await entrada(estoque1, p, '8');
    const r = await ajustarOk({ produtoId: p, quantidade: '11' }, tokenEstoquista);
    expect(r).toMatchObject({ diferenca: '3.000', compensacoes: 0 });
    const [a] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      'select origem, tipo_ajuste, status, motivo from acertos_estoque where id = $1',
      [r.acertoId],
    );
    expect(a).toEqual({
      origem: 'relatorio_estoque',
      tipo_ajuste: 'definir',
      status: 'efetivado',
      motivo: 'Inventário',
    });
    const movs = await consultar<{ tipo_movimento: string; quantidade: string }>(
      emp.nomeBanco,
      `select tipo_movimento, quantidade::text from movimentos_estoque where documento_id = $1`,
      [r.acertoId],
    );
    expect(movs).toEqual([{ tipo_movimento: 'AJUSTE_RELATORIO', quantidade: '3.000' }]);
    // O acerto aparece na lista de acertos, com a origem.
    const lista = await amb
      .http()
      .get('/api/acertos')
      .query({ estoqueId: estoque1, tamanho: '50' })
      .set(bearer());
    expect(lista.status).toBe(200);
    expect(lista.body.itens.find((x: { id: string }) => x.id === r.acertoId)).toMatchObject({
      origem: 'relatorio_estoque',
      status: 'efetivado',
    });
    // O relatório mostra o saldo novo, e o PDV da loja recebe a linha com 11.
    expect(linha(await relatorio({ estoqueId: estoque1, nome: 'CERV AJUSTE REL' }), p)?.quantidade).toBe(
      '11.000',
    );
    const { alteracoes } = await puxarEstoque(ponto.token, cursor);
    const doProduto = alteracoes.filter((x) => x.tabela === 'saldos_estoque' && x.linha.produto_id === p);
    expect(Number(doProduto.at(-1)!.linha.quantidade)).toBe(11);
    // Auditoria no acerto (criar + efetivar), com a localização do relatório.
    const auds = await consultar<{ acao: string; localizacao: string }>(
      emp.nomeBanco,
      `select acao, localizacao from auditoria where entidade = 'acertos_estoque' and registro_id = $1`,
      [r.acertoId],
    );
    expect(auds.map((x) => x.acao).sort()).toEqual(['criar', 'efetivar']);
    expect(new Set(auds.map((x) => x.localizacao))).toEqual(new Set(['Relatórios › Estoque Atual']));
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('a venda offline anterior à hora do ajuste, que chega depois, é compensada (13.1.5)', async () => {
    const ponto = await novoPonto();
    const p = await criarProduto('CERV AJUSTE OFFLINE REL');
    // 30 contados há 2 h (a Entrada de agora seria posterior à contagem de há 30 min, que não a viu).
    await ajustarOk({ produtoId: p, quantidade: '30', dataContagem: horasAtras(2) });
    // Contagem de 20 há 30 min; a venda de 3 de 1 hora atrás chega depois (o caixa estava offline).
    const r = await ajustarOk({ produtoId: p, quantidade: '20', dataContagem: horasAtras(0.5) });
    expect(r.diferenca).toBe('-10.000');
    const [res] = await push(ponto, [
      evento(ponto, 'venda.finalizada', venda(ponto, p, '3.000', horasAtras(1))),
    ]);
    expect(res, JSON.stringify(res)).toMatchObject({ status: 'aplicado' });
    // A venda baixou 3 e a compensação devolveu 3: o saldo continua o contado.
    expect(linha(await relatorio({ estoqueId: estoque1, nome: 'CERV AJUSTE OFFLINE' }), p)?.quantidade).toBe(
      '20.000',
    );
    const comp = await consultar<{ quantidade: string; documento_id: string }>(
      emp.nomeBanco,
      `select quantidade::text, documento_id from movimentos_estoque
        where tipo_movimento = 'ACERTO_COMPENSACAO' and produto_id = $1`,
      [p],
    );
    expect(comp).toEqual([{ quantidade: '3.000', documento_id: r.acertoId }]);
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('exige estoque_acertos.criar e o estoque permitido; valida o contrato', async () => {
    const p = await criarProduto('CERV AJUSTE PERMISSAO REL');
    const semAjuste = await ajustar({ produtoId: p, quantidade: '1' }, tokenConsulta);
    expect(semAjuste.status).toBe(403);
    // O consulta continua vendo o relatório.
    await relatorio({ estoqueId: estoque1 }, tokenConsulta);
    const fora = await ajustar({ produtoId: p, estoqueId: cd, quantidade: '1' }, tokenEstoquista);
    expect(fora.status, JSON.stringify(fora.body)).toBe(403);
    expect(fora.body.campos).toEqual({ estoqueId: ['Fora dos seus estoques permitidos'] });
    // O contrato: a nova quantidade não é negativa e o motivo é obrigatório.
    const invalido = await ajustar({ produtoId: p, quantidade: '-1', motivo: '' });
    expect(invalido.status).toBe(422);
    expect(Object.keys(invalido.body.campos).sort()).toEqual(['motivo', 'quantidade']);
    // Com a permissão e no estoque permitido, ajusta.
    const ok = await ajustarOk({ produtoId: p, quantidade: '2' }, tokenEstoquista);
    expect(ok.diferenca).toBe('2.000');
    await conferirRazaoDoBanco(emp.nomeBanco);
  });
});

describe('Estoque Atual: exportação pela rota comum (F2-B29)', () => {
  async function aguardarTarefa(token: string, id: string) {
    const fim = Date.now() + 60_000;
    for (;;) {
      const r = await amb.http().get(`/api/tarefas/${id}`).set(bearer(token));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (r.body.status === 'concluida' || r.body.status === 'falhou') return r.body;
      if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
      await esperar(200);
    }
  }

  it('na hora (CSV) e em tarefa (.xlsx), sem o custo para quem não o vê e só com os estoques permitidos', async () => {
    const p = await criarProduto('CERV EXPORTA REL', { codigoInterno: 'EXP-1' });
    await entrada(estoque1, p, '4', '5');
    await entrada(cd, p, '9', '5');
    const csv = await amb
      .http()
      .get('/api/relatorios/estoque-atual/exportar')
      .query({ formato: 'csv', nome: 'EXP-1' })
      .set(bearer())
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toMatch(
      /Relatorio_Estoque_Atual_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.csv/,
    );
    const linhas = (csv.body as Buffer)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(linhas[0]).toContain('Preço Custo');
    expect(linhas[0]).toContain('Em trânsito');
    expect(linhas.slice(1)).toHaveLength(1);
    expect(linhas[1]).toContain('Todas');
    expect(linhas[1]).toContain('13');

    // Em tarefa (a partir de 1 linha), pelo estoquista: sem "Ver custo" e só com a Loja 1.
    const antes = amb.servicos.exportacoes.opcoes.limiteNaHora;
    amb.servicos.exportacoes.opcoes.limiteNaHora = 0;
    try {
      const pedido = await amb
        .http()
        .get('/api/relatorios/estoque-atual/exportar')
        .query({ formato: 'xlsx', nome: 'EXP-1' })
        .set(bearer(tokenEstoquista));
      expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
      expect(pedido.body.linhas).toBe(1);
      const t = await aguardarTarefa(tokenEstoquista, pedido.body.tarefaId);
      expect(t.status, JSON.stringify(t)).toBe('concluida');
      const arquivo = Buffer.from(await (await fetch(t.download)).arrayBuffer());
      const livro = new ExcelJS.Workbook();
      await livro.xlsx.load(arquivo as unknown as ArrayBuffer);
      const aba = livro.worksheets[0]!;
      const cabecalho = (aba.getRow(1).values as unknown[]).slice(1);
      expect(cabecalho).not.toContain('Preço Custo');
      expect(cabecalho).not.toContain('Custo total');
      const dados = (aba.getRow(2).values as unknown[]).slice(1);
      expect(dados).toContain('Todas');
      expect(dados).toContain(4);
      expect(aba.rowCount).toBe(2);
    } finally {
      amb.servicos.exportacoes.opcoes.limiteNaHora = antes;
    }
  });
});
