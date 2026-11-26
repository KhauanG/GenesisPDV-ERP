/**
 * Fluxos de pull da Fase 3 (F3-B7; MD 6.1, 6.2; SYNC 6, 16.3; D90; README da API › decisão 226): as promoções descem
 * inteiras no `catalogo`, os vales de todas as lojas na janela da D90 no `pessoas`, e o `operacao` ganha os orçamentos
 * da loja (os itens pelo pai) e o status das vendas do **caixa** do terminal alteradas nos últimos 90 dias, inclusive
 * para o terminal que substituiu outro no mesmo caixa. O teto avança com o fluxo vazio (só a outra loja mudou) e os
 * templates do PDV seguem a MD 3.1.3 (`recibo_venda` e `orcamento_*` descem, `recibo_receber` não). O
 * `registrarStatusPdv` (F3-B10, decisão 228) grava a linha com o estado atual da venda quando a mudança é da nuvem ou de
 * outro terminal, só mantém em dia a que já existe quando é do próprio terminal e não gera versão sem mudança real.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { montarCodigoVale, respostaPullSchema, type Ativar } from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIAS_JANELA_PDV, TEMPLATES_PDV } from '../../src/sync/fluxos.js';
import { registrarStatusPdv, type OrigemMudancaVenda } from '../../src/sync/status-pdv.js';
import type { DbEmpresa } from '../../src/tenancy/tenancy.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

type Alteracao = { tabela: string; versao: number; linha: Record<string, unknown> };

let amb: Ambiente;
let emp: EmpresaTeste;
let loja1: string;
let loja2: string;
let caixa1: string;
let caixa2: string;
let caixaLoja2: string;
let admin: string;
let usuarioId: string;
let produtoId: string;
let terminal1: { id: string; token: string };

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

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

/** Código de ativação do ERP e a ativação do PDV (com a substituição, quando pedida). */
async function ativar(lojaId: string, caixaId: string, substituiTerminalId?: string) {
  const codigo = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer(admin))
    .send({ lojaId, caixaId, validadeHoras: 1, ...(substituiTerminalId ? { substituiTerminalId } : {}) });
  expect(codigo.status, JSON.stringify(codigo.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: codigo.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.terminal_id as string, token: r.body.token as string };
}

/** Páginas do fluxo desde `desde` até `tem_mais = false` (o laço do ciclo do PDV). */
async function puxar(token: string, fluxo: string, desde = 0, limite = 500) {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=${limite}`)
      .set(cabecalhos(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) {
      expect(r.body.novo_cursor).toBe(r.body.cursor_teto);
      return { alteracoes, cursor, teto: r.body.cursor_teto as number };
    }
  }
  throw new Error('pull não terminou');
}

const ids = (alteracoes: Alteracao[], tabela: string) =>
  alteracoes.filter((a) => a.tabela === tabela).map((a) => a.linha.id as string);

async function inserir(tabela: string, dados: Record<string, unknown>): Promise<string> {
  const colunas = Object.keys(dados);
  const [linha] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into ${tabela} (${colunas.join(', ')}) values (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(dados),
  );
  return linha!.id;
}

/**
 * Envelhece a linha como se a última mudança tivesse sido há `dias` dias (e, se pedido, a validade), sem os triggers
 * (`session_replication_role = replica`: o `fn_versao` regravaria `atualizado_em` e daria versão nova). A versão fica a
 * da última mudança real, como na produção: quem sai da janela pelo relógio não ganha versão.
 */
async function envelhecer(tabela: string, id: string, dias: number, validadeDias?: number): Promise<void> {
  const c = await conectar(emp.nomeBanco);
  try {
    await c.query('set session_replication_role = replica');
    await c.query(
      `update ${tabela} set atualizado_em = now() - make_interval(days => $2)
       ${validadeDias === undefined ? '' : `, validade = (now() at time zone 'America/Sao_Paulo')::date + $3::int`}
       where id = $1`,
      validadeDias === undefined ? [id, dias] : [id, dias, validadeDias],
    );
  } finally {
    await c.end();
  }
}

let sequenciaVale = 0;
/** Vale da loja 1, caixa 01, com o código válido (DV Luhn, SYNC 13.4). */
function vale(extra: Record<string, unknown> = {}): Promise<string> {
  sequenciaVale++;
  return inserir('vales', {
    codigo: montarCodigoVale(1, 1, sequenciaVale),
    tipo: 'vale_troca',
    loja_emissao_id: loja1,
    valor_original: '50.00',
    saldo: '50.00',
    validade: '2099-12-31',
    origem_tipo: 'manual',
    emitido_em: new Date(),
    emitido_por_id: usuarioId,
    ...extra,
  });
}

let numeroVenda = 0;
/** Uma sessão aberta por terminal (`uq_sessoes_caixa_aberta`). */
const sessoes = new Map<string, string>();
/** Venda finalizada do terminal no caixa, para a projeção de status apontar (FK). */
async function venda(lojaId: string, caixaId: string, terminalId: string): Promise<string> {
  numeroVenda++;
  let sessao = sessoes.get(terminalId);
  if (!sessao) {
    sessao = await inserir('sessoes_caixa', {
      loja_id: lojaId,
      caixa_id: caixaId,
      numero_caixa: 1,
      terminal_id: terminalId,
      operador_id: usuarioId,
      dia_operacional: '2026-11-20',
      aberta_em: new Date(),
      fundo_troco: '0.00',
    });
    sessoes.set(terminalId, sessao);
  }
  return inserir('vendas', {
    numero: numeroVenda,
    numero_exibicao: `L01-C01-${String(numeroVenda).padStart(6, '0')}`,
    loja_id: lojaId,
    caixa_id: caixaId,
    numero_caixa: 1,
    terminal_id: terminalId,
    sessao_caixa_id: sessao,
    tipo: 'pdv',
    operador_id: usuarioId,
    iniciada_em: new Date(),
    status: 'finalizada',
    finalizada_em: new Date(),
    total: '10.00',
  });
}

function statusVenda(vendaId: string, caixaId: string, terminalId: string): Promise<string> {
  return inserir('vendas_status_pdv', {
    id: vendaId,
    caixa_id: caixaId,
    terminal_id: terminalId,
    status: 'cancelada',
    status_fiscal: 'nao_aplicavel',
    devolucao: 'nenhuma',
    cancelada_em: new Date(),
    cancelamento_origem: 'erp',
  });
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const caixa = async (lojaId: string, numero: number) =>
    (
      await consultar<{ id: string }>(
        emp.nomeBanco,
        'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
        [lojaId, numero, `Caixa 0${numero}`],
      )
    )[0]!.id;
  caixa1 = await caixa(loja1, 1);
  caixa2 = await caixa(loja1, 2);
  caixaLoja2 = await caixa(loja2, 1);
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: usuarioId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: produtoId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into produtos (nome, unidade_id) values ('CERV LATA 350ML', (select id from unidades_medida where sigla = 'UN')) returning id",
  )) as [{ id: string }];
  terminal1 = await ativar(loja1, caixa1);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('catalogo: promoções (MD 3.6.11)', () => {
  it('promoção e itens descem inteiros, com as listas em JSON; a inativa e a de outra loja também (o PDV filtra)', async () => {
    const ativa = await inserir('promocoes', {
      nome: 'Leve 3 pague 2',
      tipo: 'leve_pague',
      parametros: JSON.stringify({ leve: 3, pague: 2 }),
      dias_semana: '{5,6}',
      hora_inicio: '18:00',
      hora_fim: '23:59:59',
      lojas: `{${loja1},${loja2}}`,
    });
    const outra = await inserir('promocoes', {
      nome: 'Só na loja 2',
      tipo: 'desconto_pct_item',
      parametros: JSON.stringify({ pct: '10.0000' }),
      lojas: `{${loja2}}`,
      ativo: false,
    });
    const item = await inserir('promocoes_itens', {
      promocao_id: ativa,
      produto_id: produtoId,
      papel: 'gatilho',
    });
    const { alteracoes } = await puxar(terminal1.token, 'catalogo');
    expect(ids(alteracoes, 'promocoes').sort()).toEqual([ativa, outra].sort());
    expect(ids(alteracoes, 'promocoes_itens')).toEqual([item]);
    const linha = alteracoes.find((a) => a.linha.id === ativa)!.linha;
    expect(linha).toMatchObject({
      tipo: 'leve_pague',
      parametros: { leve: 3, pague: 2 },
      dias_semana: [5, 6],
      hora_inicio: '18:00:00',
      hora_fim: '23:59:59',
      lojas: [loja1, loja2],
      prioridade: 0,
      ativo: true,
    });
    expect(alteracoes.find((a) => a.linha.id === item)!.linha).toMatchObject({ quantidade: '1.000' });
  });
});

describe('pessoas: vales na janela da D90 (F3-Q19 = A)', () => {
  it('desce o vale utilizável e o que mudou nos últimos 90 dias; o vencido ou zerado há mais de 90 dias, não', async () => {
    const utilizavel = await vale();
    const deOutraLoja = await vale({ loja_emissao_id: loja2 });
    // Zerado (usado) há 89 e há 91 dias: só o primeiro ainda desce.
    const zerado89 = await vale({ saldo: '0.00', status: 'utilizado' });
    const zerado91 = await vale({ saldo: '0.00', status: 'utilizado' });
    // Ativo com saldo, vencido há 89 e há 91 dias, sem mudança há 120 dias: o de 89 continua utilizável com o
    // supervisor (D88); o de 91 saiu da janela.
    const vencido89 = await vale();
    const vencido91 = await vale();
    // Negativo (usado em dois caixas sem internet, D89) há 100 dias: zerado, fora.
    const negativo = await vale({ saldo: '-3.50' });
    // Cancelado há 91 dias, com saldo: fora (o status não é `ativo`).
    const cancelado = await vale({
      status: 'cancelado',
      cancelado_em: new Date(),
      cancelado_por_id: usuarioId,
      motivo_cancelamento: 'Emitido errado',
    });
    // Vencido há muito, mas mudou ontem: desce (mudou nos últimos 90 dias).
    const vencidoMudou = await vale();
    await envelhecer('vales', zerado89, DIAS_JANELA_PDV - 1);
    await envelhecer('vales', zerado91, DIAS_JANELA_PDV + 1);
    await envelhecer('vales', vencido89, 120, -(DIAS_JANELA_PDV - 1));
    await envelhecer('vales', vencido91, 120, -(DIAS_JANELA_PDV + 1));
    await envelhecer('vales', negativo, 100);
    await envelhecer('vales', cancelado, DIAS_JANELA_PDV + 1);
    await envelhecer('vales', vencidoMudou, 1, -400);

    const { alteracoes } = await puxar(terminal1.token, 'pessoas');
    expect(ids(alteracoes, 'vales').sort()).toEqual(
      [utilizavel, deOutraLoja, zerado89, vencido89, vencidoMudou].sort(),
    );
    const linha = alteracoes.find((a) => a.linha.id === utilizavel)!.linha;
    expect(linha).toMatchObject({
      saldo: '50.00',
      validade: '2099-12-31',
      status: 'ativo',
      loja_emissao_id: loja1,
    });
    expect(linha).toHaveProperty('conferencia_hash');

    // A mudança real (o ERP cancela o vale zerado há 91 dias) devolve a linha à janela com versão nova.
    await consultar(
      emp.nomeBanco,
      "update vales set status = 'cancelado', cancelado_em = now(), cancelado_por_id = $2 where id = $1",
      [zerado91, usuarioId],
    );
    const depois = await puxar(terminal1.token, 'pessoas');
    expect(ids(depois.alteracoes, 'vales')).toContain(zerado91);
  });
});

describe('operacao: orçamentos da loja e status das vendas do caixa (MD 3.11.1, 3.11.9; SYNC 16.3)', () => {
  it('o orçamento da loja 2 não desce ao terminal da loja 1; os itens seguem o pai', async () => {
    const orcamento = (lojaId: string) => inserir('orcamentos', { loja_id: lojaId, nome: 'Bar do Teste' });
    const item = (orcamentoId: string) =>
      inserir('itens_orcamento', {
        orcamento_id: orcamentoId,
        sequencia: 1,
        produto_id: produtoId,
        descricao: 'CERV LATA 350ML',
        unidade: 'UN',
        quantidade: '12.000',
        preco_unitario: '5.0000',
        valor_total: '60.00',
      });
    const daLoja1 = await orcamento(loja1);
    const daLoja2 = await orcamento(loja2);
    const item1 = await item(daLoja1);
    await item(daLoja2);
    const { alteracoes } = await puxar(terminal1.token, 'operacao');
    expect(ids(alteracoes, 'orcamentos')).toEqual([daLoja1]);
    expect(ids(alteracoes, 'itens_orcamento')).toEqual([item1]);
    const linha = alteracoes.find((a) => a.linha.id === daLoja1)!.linha;
    // A coluna gerada desce (só muda junto de `data` e `dias_validade`, que versionam); o PDV a calcula igual.
    expect(linha.valido_ate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(linha).toMatchObject({
      status: 'aberto',
      dias_validade: 15,
      origem: 'erp',
      reservado_terminal_id: null,
    });
  });

  it('o status desce pelo caixa do terminal nos últimos 90 dias; o de 91 dias e o de outro caixa, não', async () => {
    const recente = await venda(loja1, caixa1, terminal1.id);
    const antigo = await venda(loja1, caixa1, terminal1.id);
    const quase = await venda(loja1, caixa1, terminal1.id);
    await statusVenda(recente, caixa1, terminal1.id);
    await statusVenda(antigo, caixa1, terminal1.id);
    await statusVenda(quase, caixa1, terminal1.id);
    await envelhecer('vendas_status_pdv', antigo, DIAS_JANELA_PDV + 1);
    await envelhecer('vendas_status_pdv', quase, DIAS_JANELA_PDV - 1);
    // Venda do caixa 02 da mesma loja (outro terminal): o status não é deste caixa.
    const terminal2 = await ativar(loja1, caixa2);
    const doCaixa2 = await venda(loja1, caixa2, terminal2.id);
    await statusVenda(doCaixa2, caixa2, terminal2.id);

    const { alteracoes } = await puxar(terminal1.token, 'operacao');
    expect(ids(alteracoes, 'vendas_status_pdv').sort()).toEqual([recente, quase].sort());
    expect(alteracoes.find((a) => a.linha.id === recente)!.linha).toMatchObject({
      caixa_id: caixa1,
      terminal_id: terminal1.id,
      status: 'cancelada',
      cancelamento_origem: 'erp',
    });
    expect(ids((await puxar(terminal2.token, 'operacao')).alteracoes, 'vendas_status_pdv')).toEqual([
      doCaixa2,
    ]);
  });

  it('o teto avança com o fluxo vazio: só a loja 2 mudou, nada desce e o cursor passa por cima', async () => {
    const { cursor } = await puxar(terminal1.token, 'operacao');
    const [{ id: orcamentoLoja2 }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into orcamentos (loja_id, nome) values ($1, 'Outra loja') returning id",
      [loja2],
    )) as [{ id: string }];
    const terminalLoja2 = await ativar(loja2, caixaLoja2);
    const vendaLoja2 = await venda(loja2, caixaLoja2, terminalLoja2.id);
    await statusVenda(vendaLoja2, caixaLoja2, terminalLoja2.id);
    const r = await puxar(terminal1.token, 'operacao', cursor);
    expect(r.alteracoes).toEqual([]);
    expect(r.teto).toBeGreaterThan(cursor);
    expect(r.cursor).toBe(r.teto);
    // O terminal da loja 2 recebe os dela.
    const daLoja2 = await puxar(terminalLoja2.token, 'operacao');
    expect(ids(daLoja2.alteracoes, 'orcamentos')).toContain(orcamentoLoja2);
    expect(ids(daLoja2.alteracoes, 'vendas_status_pdv')).toEqual([vendaLoja2]);
  });

  it('registrarStatusPdv: a nuvem e outro terminal gravam o estado atual; o próprio terminal só atualiza a linha', async () => {
    /** A mudança e o registro na mesma transação, como o handler e o ERP farão. */
    async function mudar(vendaId: string, origem: OrigemMudancaVenda, alteracao?: string) {
      const c = await conectar(emp.nomeBanco);
      try {
        await c.query('begin');
        if (alteracao) await c.query(`update vendas set ${alteracao} where id = $1`, [vendaId]);
        const gravou = await registrarStatusPdv(
          drizzle(c) as unknown as DbEmpresa,
          vendaId.toUpperCase(),
          origem,
        );
        await c.query('commit');
        return gravou;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        await c.end();
      }
    }
    const linha = async (vendaId: string) =>
      (
        await consultar<{
          status: string;
          devolucao: string;
          cancelamento_origem: string | null;
          versao: string;
        }>(
          emp.nomeBanco,
          'select status, devolucao, cancelamento_origem, versao::text from vendas_status_pdv where id = $1',
          [vendaId],
        )
      )[0];
    const { cursor } = await puxar(terminal1.token, 'operacao');

    // O próprio terminal, sem linha: nada (o caixa já sabe o que fez).
    const doCaixa = await venda(loja1, caixa1, terminal1.id);
    expect(
      await mudar(
        doCaixa,
        { terminalId: terminal1.id },
        "status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'Cliente desistiu', cancelamento_origem = 'pdv'",
      ),
    ).toBe(false);
    expect(await linha(doCaixa)).toBeUndefined();

    // A nuvem (o cancelamento pelo ERP do F3-B11): a linha com o estado atual, presa ao caixa e ao terminal da venda.
    const peloErp = await venda(loja1, caixa1, terminal1.id);
    expect(
      await mudar(
        peloErp,
        'nuvem',
        "status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'Cliente desistiu', cancelamento_origem = 'erp'",
      ),
    ).toBe(true);
    const primeira = await linha(peloErp);
    expect(primeira).toMatchObject({ status: 'cancelada', devolucao: 'nenhuma', cancelamento_origem: 'erp' });
    // O mesmo estado de novo não gera versão (o caixa não puxa a linha outra vez).
    expect(await mudar(peloErp, 'nuvem')).toBe(true);
    expect((await linha(peloErp))!.versao).toBe(primeira!.versao);

    // Outro terminal (a troca no caixa 02, F3-B43) grava; depois o próprio terminal muda e a linha acompanha.
    // O `registrarStatusPdv` só compara o terminal com o da venda (não o procura no banco): qualquer outro id serve, sem
    // depender do terminal que outro teste ativou no caixa 02.
    const trocada = await venda(loja1, caixa1, terminal1.id);
    expect(await mudar(trocada, { terminalId: uuidv7() }, "devolucao = 'parcial'")).toBe(true);
    expect(await linha(trocada)).toMatchObject({ status: 'finalizada', devolucao: 'parcial' });
    expect(
      await mudar(
        trocada,
        { terminalId: terminal1.id },
        "status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'Cliente desistiu', cancelamento_origem = 'pdv'",
      ),
    ).toBe(true);
    expect(await linha(trocada)).toMatchObject({ status: 'cancelada', cancelamento_origem: 'pdv' });

    const { alteracoes } = await puxar(terminal1.token, 'operacao', cursor);
    expect(ids(alteracoes, 'vendas_status_pdv').sort()).toEqual([peloErp, trocada].sort());
    expect(alteracoes.find((a) => a.linha.id === trocada)!.linha).toMatchObject({
      caixa_id: caixa1,
      terminal_id: terminal1.id,
      status: 'cancelada',
      devolucao: 'parcial',
    });
  });

  it('o terminal substituto do mesmo caixa recebe o status das vendas do terminal antigo', async () => {
    const [{ id: caixa3 }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into caixas (loja_id, numero, descricao) values ($1, 3, 'Caixa 03') returning id",
      [loja1],
    )) as [{ id: string }];
    const antigo = await ativar(loja1, caixa3);
    const vendaAntiga = await venda(loja1, caixa3, antigo.id);
    await statusVenda(vendaAntiga, caixa3, antigo.id);
    const novo = await ativar(loja1, caixa3, antigo.id);
    expect(novo.id).not.toBe(antigo.id);
    const { alteracoes } = await puxar(novo.token, 'operacao');
    expect(ids(alteracoes, 'vendas_status_pdv')).toEqual([vendaAntiga]);
    expect(alteracoes.find((a) => a.linha.id === vendaAntiga)!.linha).toMatchObject({
      caixa_id: caixa3,
      terminal_id: antigo.id,
    });
  });
});

describe('configuracao: templates do PDV (MD 3.1.3)', () => {
  it('recibo_venda e orcamento_* descem; recibo_receber, não', async () => {
    const { alteracoes } = await puxar(terminal1.token, 'configuracao');
    const tipos = new Set(
      alteracoes.filter((a) => a.tabela === 'templates_documentos').map((a) => a.linha.tipo as string),
    );
    expect(tipos.has('recibo_venda')).toBe(true);
    expect(tipos.has('orcamento_logado')).toBe(true);
    expect(tipos.has('recibo_receber')).toBe(false);
    for (const tipo of tipos) expect(TEMPLATES_PDV as readonly string[]).toContain(tipo);
  });
});
