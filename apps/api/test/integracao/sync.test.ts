/**
 * Contrato do protocolo de sincronização (SYNC 2–8, 21.1): ativação, estado, pull por fluxo com 2 lojas (o cursor
 * chega ao `cursor_teto` mesmo quando só a outra loja muda, SYNC 6.3–6.4), push idempotente (o mesmo evento duas
 * vezes → `duplicado`, SYNC 8.4) com ordem estrita por terminal, heartbeat com entrega de comandos e substituição de
 * terminal (SYNC 3.4, 13.3). Toda resposta passa pelos schemas estritos de `@genesis/shared` (os mesmos das fixtures
 * que o PDV testa) e o corpo da ativação sai da fixture `ativar.requisicao.json`.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  envelopeErroSyncSchema,
  jcs,
  respostaAtivacaoSchema,
  respostaEstadoSchema,
  respostaHeartbeatSchema,
  respostaPullSchema,
  respostaPushSchema,
  type Ativar,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AAD_CHAVE_BACKUP } from '../../src/sync/ativacao.js';
import { decifrarDoTerminal } from '../../src/seguranca/ecies.js';
import { tocar } from '../../src/sync/toque.js';
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

/** Fixtures do contrato (packages/shared/testes/sync), as mesmas do Vitest do shared e do xUnit do PDV. */
const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja1: string;
let loja2: string;
let caixa1: string;
let caixa2: string;
let tokenAdmin: string;

const HARDWARE = ATIVAR.maquina.id_hardware;

function cabecalhos(token?: string, extra: Record<string, string> = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': HARDWARE,
    ...extra,
  };
}

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

async function gerarCodigo(caixaId: string, lojaId: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId, caixaId, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(r.status).toBe(201);
  expect(r.body.codigo).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  return r.body.codigo as string;
}

/** Corpo da fixture com o que é deste ambiente: empresa, código, id da requisição e chaves válidas (as da fixture são de exemplo). */
function corpoAtivacao(codigo: string, requisicao = uuidv7()) {
  const terminal = generateKeyPairSync('x25519');
  const backup = generateKeyPairSync('x25519');
  return {
    backup,
    corpo: {
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: codigo,
      requisicao_ativacao_id: requisicao,
      chave_backup_publica: spki(backup.publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(terminal.publicKey) },
    },
  };
}

function evento(
  seq: number,
  tipo: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const id = uuidv7();
  return {
    evento_id: id,
    sequencia: seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: tipo === 'auditoria.registros' ? 'auditoria' : 'terminal',
    agregado_id: uuidv7(),
    dependencias: [],
    ocorrido_em: new Date().toISOString(),
    ocorrido_em_local: new Date().toISOString(),
    relogio_confiavel: true,
    usuario_id: null,
    contexto: {
      loja_id: loja1,
      caixa_id: caixa1,
      numero_caixa: 1,
      versao_app: '1.0.0',
      versao_schema_local: 1,
    },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
    ...extra,
  };
}

const auditoriaPayload = (descricao: string) => ({
  registros: [
    {
      id: uuidv7(),
      ocorrido_em: new Date().toISOString(),
      acao: 'gaveta_aberta',
      entidade: 'pdv',
      localizacao: 'PDV › Gaveta',
      descricao,
    },
  ],
  logins: [
    {
      id: uuidv7(),
      ocorrido_em: new Date().toISOString(),
      login_informado: 'maria',
      sucesso: false,
      motivo_falha: 'senha_invalida',
    },
  ],
});

let terminalId: string;
let token: string;

const push = (eventos: unknown[], tk = token, extra: Record<string, string> = {}) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(tk, extra))
    .send({ lote_id: uuidv7(), terminal_id: terminalId, enviado_em: new Date().toISOString(), eventos });

const pull = (fluxo: string, desde: number, limite = 500) =>
  amb.http().get(`/sync/pull?fluxo=${fluxo}&desde=${desde}&limite=${limite}`).set(cabecalhos(token));

/** Carga inicial: páginas até `tem_mais = false`; devolve as alterações e o último cursor. */
async function cargaInicial(fluxo: string, desde = 0, limite = 500) {
  const alteracoes: Array<{ tabela: string; versao: number; linha: Record<string, unknown> }> = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await pull(fluxo, cursor, limite);
    expect(r.status).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...r.body.alteracoes);
    if (r.body.tem_mais) expect(r.body.novo_cursor).toBe(r.body.alteracoes.at(-1).versao);
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) {
      expect(r.body.novo_cursor).toBe(r.body.cursor_teto);
      return { alteracoes, cursor, teto: r.body.cursor_teto as number };
    }
  }
  throw new Error('carga inicial não terminou');
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  [{ id: caixa1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja1, 'Caixa 01'],
  )) as [{ id: string }];
  [{ id: caixa2 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja2, 'Caixa 01'],
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('POST /sync/ativar (SYNC 3)', () => {
  it('ativa com o código gerado no ERP; a repetição da mesma ativação devolve token novo', async () => {
    const codigo = await gerarCodigo(caixa1, loja1);
    const { corpo, backup } = corpoAtivacao(codigo);
    const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo);
    expect(r.status).toBe(201);
    respostaAtivacaoSchema.parse(r.body);
    expect(r.headers['x-agora-servidor']).toBeDefined();
    expect(r.body).toMatchObject({
      empresa: { codigo: emp.codigo },
      loja: { id: loja1, codigo: 1 },
      caixa: { id: caixa1, numero: 1 },
      numeracoes: { venda: { ultimo_numero: 0 }, vale: { ultimo_numero: 0 } },
      sequencia_terminal: { ultima_recebida: 0 },
      fluxos: ['configuracao', 'acesso', 'referencia', 'catalogo', 'estoque', 'pessoas', 'operacao'],
      versao_protocolo: 1,
    });
    expect(JSON.stringify(r.body)).not.toContain(emp.nomeBanco);
    terminalId = r.body.terminal_id;
    expect(r.body.token).toMatch(new RegExp(`^${terminalId}\\.[A-Za-z0-9_-]{43}$`));
    // A chave de backup desce cifrada para a chave efêmera do assistente e fica sob custódia (cifrada) na nuvem.
    const chave = decifrarDoTerminal(Buffer.from(r.body.chave_backup_cifrada, 'base64'), backup.privateKey);
    const [t] = await consultar<{ status: string; custodia: Buffer }>(
      amb.bancoControle,
      'select status, chave_backup_cifrada as custodia from terminais_pdv where id = $1',
      [terminalId],
    );
    expect(t!.status).toBe('ativo');
    expect(amb.servicos.cifra.decifrar(t!.custodia, AAD_CHAVE_BACKUP)).toEqual(chave);
    const [cx] = await consultar(emp.nomeBanco, 'select terminal_id from caixas where id = $1', [caixa1]);
    expect(cx).toEqual({ terminal_id: terminalId });
    const [aud] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'terminal_ativado' and registro_id = $1",
      [terminalId],
    );
    expect(aud).toEqual({ n: 1 });

    // Resposta perdida: o assistente repete com o mesmo requisicao_ativacao_id.
    const repetida = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo);
    expect(repetida.status).toBe(201);
    expect(repetida.body.terminal_id).toBe(terminalId);
    expect(repetida.body.token).not.toBe(r.body.token);
    token = repetida.body.token;
    expect((await amb.http().get('/sync/estado').set(cabecalhos(r.body.token))).status).toBe(401);
    const [audDepois] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'terminal_ativado' and registro_id = $1",
      [terminalId],
    );
    expect(audDepois).toEqual({ n: 1 });

    // Outra requisição com o mesmo código (já usado) → CODIGO_INVALIDO genérico.
    const outra = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo).corpo);
    expect(outra.status).toBe(422);
    envelopeErroSyncSchema.parse(outra.body);
    expect(outra.body.erro.codigo).toBe('CODIGO_INVALIDO');
  });

  it('caixa ocupado não gera código novo sem substituição; erros no envelope do sync', async () => {
    const r = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ lojaId: loja1, caixaId: caixa1, validadeHoras: 1 });
    expect(r.status).toBe(422);
    const semCabecalhos = await amb.http().get('/sync/estado').set('Authorization', `Bearer ${token}`);
    expect(semCabecalhos.status).toBe(400);
    envelopeErroSyncSchema.parse(semCabecalhos.body);
    expect(semCabecalhos.body.erro).toMatchObject({ codigo: 'REQUISICAO_INVALIDA' });
    expect(semCabecalhos.body.erro.requisicao_id).toMatch(/^[0-9a-f-]{36}$/);
    const tokenErrado = await amb
      .http()
      .get('/sync/estado')
      .set(cabecalhos(`${terminalId}.${'A'.repeat(43)}`));
    expect(tokenErrado.status).toBe(401);
    expect(tokenErrado.body.erro.codigo).toBe('TOKEN_INVALIDO');
    // O JWT do ERP não serve no sync e o token do terminal não serve no ERP.
    expect((await amb.http().get('/sync/estado').set(cabecalhos(tokenAdmin))).status).toBe(401);
    expect((await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});

describe('GET /sync/estado e GET /sync/pull (SYNC 5, 6)', () => {
  it('estado do terminal no handshake', async () => {
    const r = await amb.http().get('/sync/estado').set(cabecalhos(token));
    expect(r.status).toBe(200);
    respostaEstadoSchema.parse(r.body);
    expect(r.body).toMatchObject({
      terminal: {
        id: terminalId,
        status: 'ativo',
        loja_id: loja1,
        caixa_id: caixa1,
        id_hardware_confere: true,
      },
      empresa_status: 'ativa',
      loja: { ativa: true, usa_pdv: true },
      sequencia_terminal: { ultima_recebida: 0 },
      protocolo: { atual: 1, minimo: 1 },
      versoes_schema: { 'auditoria.registros': [1], 'terminal.configuracao_alterada': [1] },
    });
  });

  it('carga inicial de configuracao com 2 lojas: só a loja do terminal; o cursor chega ao teto', async () => {
    const { alteracoes, cursor } = await cargaInicial('configuracao', 0, 7);
    const lojas = alteracoes.filter((a) => a.tabela === 'lojas').map((a) => a.linha.id);
    expect(lojas).toEqual([loja1]);
    expect(alteracoes.filter((a) => a.tabela === 'caixas').map((a) => a.linha.id)).toEqual([caixa1]);
    const versoes = alteracoes.map((a) => a.versao);
    expect(versoes).toEqual([...versoes].sort((a, b) => a - b));
    const forma = alteracoes.find((a) => a.tabela === 'formas_pagamento')!.linha;
    expect(forma).not.toHaveProperty('conta_corrente_id');
    expect(forma).not.toHaveProperty('dias_recebimento');
    const loja = alteracoes.find((a) => a.tabela === 'lojas')!.linha;
    expect(loja.nfce_csc_cifrado).toBeNull();
    expect(loja.criado_em).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(loja.nfce_valor_exige_identificacao).toBe('10000.00');

    // Só a Loja 2 muda: nada desce, mas o cursor passa por cima das versões dela até o novo teto.
    await consultar(emp.nomeBanco, "update lojas set nome = 'Loja 2 - Bairro Novo' where id = $1", [loja2]);
    await consultar(emp.nomeBanco, "update caixas set descricao = 'Caixa 01 B' where id = $1", [caixa2]);
    const r = await pull('configuracao', cursor);
    expect(r.body.alteracoes).toEqual([]);
    expect(r.body.tem_mais).toBe(false);
    expect(r.body.cursor_teto).toBeGreaterThan(cursor);
    expect(r.body.novo_cursor).toBe(r.body.cursor_teto);
    // Mudança da Loja 1 desce.
    await consultar(emp.nomeBanco, "update lojas set nome = 'Loja 1 - Centro Novo' where id = $1", [loja1]);
    const r2 = await pull('configuracao', r.body.novo_cursor);
    expect(r2.body.alteracoes.map((a: { linha: { nome: string } }) => a.linha.nome)).toEqual([
      'Loja 1 - Centro Novo',
    ]);
  });

  it('fluxo sem tabelas nesta fase (operacao) termina a carga com o cursor no teto', async () => {
    for (const fluxo of ['operacao']) {
      const r = await pull(fluxo, 0);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ fluxo, tem_mais: false, alteracoes: [] });
      expect(r.body.novo_cursor).toBe(r.body.cursor_teto);
    }
    const invalido = await pull('vendas', 0);
    expect(invalido.status).toBe(400);
    expect(invalido.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
  });

  it('acesso: senha do ERP nunca desce; PIN só de quem tem acesso à loja do terminal', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'caixa_loja1', perfil: 'operador_caixa', lojas: [loja1] });
    await criarUsuario(emp.nomeBanco, { login: 'caixa_loja2', perfil: 'operador_caixa', lojas: [loja2] });
    await consultar(
      emp.nomeBanco,
      "update usuarios set senha_pdv_hash = 'pin-hash' where login like 'caixa_loja%'",
    );
    const { alteracoes } = await cargaInicial('acesso');
    const usuarios = alteracoes.filter((a) => a.tabela === 'usuarios').map((a) => a.linha);
    expect(usuarios.length).toBeGreaterThanOrEqual(3);
    for (const u of usuarios) {
      expect(u).not.toHaveProperty('senha_hash');
      expect(u).not.toHaveProperty('cpf');
    }
    const porLogin = new Map(usuarios.map((u) => [u.login, u]));
    expect(porLogin.get('caixa_loja1')!.senha_pdv_hash).toBe('pin-hash');
    expect(porLogin.get('caixa_loja2')!.senha_pdv_hash).toBeNull();
    const vinculos = alteracoes.filter((a) => a.tabela === 'usuarios_lojas').map((a) => a.linha.loja_id);
    expect(new Set(vinculos)).toEqual(new Set([loja1]));
    const permissoes = alteracoes
      .filter((a) => a.tabela === 'permissoes')
      .map((a) => a.linha.chave as string);
    expect(permissoes.length).toBeGreaterThan(0);
    expect(permissoes.every((p) => p.startsWith('pdv.'))).toBe(true);
  });
});

describe('fluxos catalogo, estoque, pessoas e referencia da Fase 1A (MD 6.1, 6.2)', () => {
  it('catalogo: produto sem custo; dados por loja e faixas só da loja do terminal (ou de todas)', async () => {
    const [{ id: un }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from unidades_medida where sigla = 'UN'",
    )) as [{ id: string }];
    const [{ id: prod }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into produtos (nome, unidade_id, preco_custo, preco_venda, ncm) values ('Cerveja lata 350ml', $1, '2.5000', '4.9900', '22030000')
       returning id`,
      [un],
    )) as [{ id: string }];
    await consultar(
      emp.nomeBanco,
      "insert into produtos_codigos_barras (produto_id, codigo, principal) values ($1, '7891149103102', true)",
      [prod],
    );
    for (const loja of [loja1, loja2]) {
      await consultar(
        emp.nomeBanco,
        "insert into produtos_lojas (produto_id, loja_id, preco_venda, estoque_maximo) values ($1, $2, '4.4900', 100)",
        [prod, loja],
      );
      await consultar(
        emp.nomeBanco,
        "insert into produtos_precos_quantidade (produto_id, loja_id, quantidade_inicial, preco) values ($1, $2, 12, '3.9900')",
        [prod, loja],
      );
    }
    await consultar(
      emp.nomeBanco,
      "insert into produtos_precos_quantidade (produto_id, quantidade_inicial, quantidade_final, preco) values ($1, 6, 12, '4.2900')",
      [prod],
    );
    const { alteracoes } = await cargaInicial('catalogo');
    const por = (t: string) => alteracoes.filter((a) => a.tabela === t).map((a) => a.linha);
    expect(por('marcas').map((m) => m.descricao)).toEqual(['SEM MARCA']);
    const [p] = por('produtos');
    expect(p).toMatchObject({ id: prod, preco_venda: '4.9900', ncm: '22030000' });
    expect(p).not.toHaveProperty('preco_custo');
    expect(p).not.toHaveProperty('custo_medio');
    expect(p).not.toHaveProperty('busca');
    expect(por('produtos_codigos_barras').map((c) => c.codigo)).toEqual(['7891149103102']);
    const pl = por('produtos_lojas');
    expect(pl.map((x) => x.loja_id)).toEqual([loja1]);
    expect(pl[0]).not.toHaveProperty('estoque_maximo');
    expect(
      por('produtos_precos_quantidade')
        .map((x) => x.loja_id)
        .sort(),
    ).toEqual([loja1, null].sort());
  });

  it('estoque: só o saldo vendável do estoque da loja, sem custo', async () => {
    const [prod] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from produtos where nome = 'Cerveja lata 350ml'",
    );
    const tipos = await consultar<{ id: string; chave_sistema: string }>(
      emp.nomeBanco,
      'select id, chave_sistema from tipos_estoque',
    );
    const tipo = (k: string) => tipos.find((t) => t.chave_sistema === k)!.id;
    for (const loja of [loja1, loja2]) {
      for (const t of ['disponivel', 'avaria']) {
        await consultar(
          emp.nomeBanco,
          `insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio)
           values ((select estoque_id from lojas where id = $1), $2, $3, 24, '2.5000')`,
          [loja, prod!.id, tipo(t)],
        );
      }
    }
    const { alteracoes } = await cargaInicial('estoque');
    expect(alteracoes).toHaveLength(1);
    expect(alteracoes[0]!.linha).toMatchObject({
      produto_id: prod!.id,
      tipo_estoque_id: tipo('disponivel'),
      quantidade: '24.000',
    });
    expect(alteracoes[0]!.linha).not.toHaveProperty('custo_medio');
  });

  it('pessoas: só as relevantes para a loja do terminal (LGPD, MD 3.5.4), sem observações', async () => {
    const pessoa = async (nome: string) =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          "insert into pessoas (nome, observacoes) values ($1, 'interna') returning id",
          [nome],
        )
      )[0]!.id;
    const daLoja1 = await pessoa('Cliente Loja 1');
    const daLoja2 = await pessoa('Cliente Loja 2');
    const todas = await pessoa('Funcionário');
    await pessoa('Sem relevância');
    const relevancia = (p: string, loja: string | null, motivo: string) =>
      consultar(
        emp.nomeBanco,
        'insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em) values ($1, $2, $3, now())',
        [p, loja, motivo],
      );
    await relevancia(daLoja1, loja1, 'compra');
    await relevancia(daLoja2, loja2, 'compra');
    await relevancia(todas, null, 'funcionario');
    for (const p of [daLoja1, daLoja2]) {
      await consultar(
        emp.nomeBanco,
        "insert into pessoas_telefones (pessoa_id, ddd, numero, principal) values ($1, '41', '999990000', true)",
        [p],
      );
    }
    const { alteracoes } = await cargaInicial('pessoas');
    const pessoas = alteracoes.filter((a) => a.tabela === 'pessoas').map((a) => a.linha);
    expect(pessoas.map((p) => p.id).sort()).toEqual([daLoja1, todas].sort());
    for (const p of pessoas) expect(p).not.toHaveProperty('observacoes');
    expect(alteracoes.filter((a) => a.tabela === 'pessoas_telefones').map((a) => a.linha.pessoa_id)).toEqual([
      daLoja1,
    ]);
    expect(alteracoes.filter((a) => a.tabela === 'pessoas_relevancia_loja')).toHaveLength(2);
  });

  it('pessoas.senha_hash só desce com a exigência ligada na loja e crediário habilitado (SYNC 4.1)', async () => {
    const pessoa = async (nome: string, extra: string) =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          `insert into pessoas (nome, senha_hash${extra ? `, ${extra.split('=')[0]}` : ''})
           values ($1, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'${extra ? `, ${extra.split('=')[1]}` : ''})
           returning id`,
          [nome],
        )
      )[0]!.id;
    const comLimite = await pessoa('Crediário com limite', 'limite_compras=500');
    const semLimite = await pessoa('Sem crediário', '');
    const bloqueada = await pessoa('Crediário bloqueado', 'bloqueada_credito=true');
    for (const p of [comLimite, semLimite, bloqueada]) {
      await consultar(
        emp.nomeBanco,
        "insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em) values ($1, null, 'compra', now())",
        [p],
      );
    }
    const hashes = async () =>
      new Map(
        (await cargaInicial('pessoas')).alteracoes
          .filter((a) => a.tabela === 'pessoas')
          .map((a) => [a.linha.id as string, a.linha.senha_hash as string | null]),
      );
    // Exigência desligada (padrão): nenhuma senha desce.
    let h = await hashes();
    expect([h.get(comLimite), h.get(semLimite), h.get(bloqueada)]).toEqual([null, null, null]);
    // Ligada na loja do terminal: só quem tem crediário habilitado (limite próprio > 0, não bloqueado).
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor) values ('loja', $1, 'pdv.crediario_exige_senha_cliente', 'true')`,
      [loja1],
    );
    h = await hashes();
    expect(h.get(comLimite)).toMatch(/^\$argon2id\$/);
    expect(h.get(semLimite)).toBeNull();
    expect(h.get(bloqueada)).toBeNull();
    // Limite padrão da empresa habilita quem não tem limite próprio (o bloqueado continua sem).
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('financeiro.limite_credito_padrao', '"300.00"')`,
    );
    h = await hashes();
    expect(h.get(semLimite)).toMatch(/^\$argon2id\$/);
    expect(h.get(bloqueada)).toBeNull();
  });

  it('trocar a exigência de senha no ERP dá versão nova às pessoas com senha: o pull seguinte traz a projeção nova', async () => {
    // O PDV só aplica versão maior: refazer o fluxo traria as linhas com a mesma versão e o valor novo seria ignorado.
    const [{ id: pessoa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into pessoas (nome, senha_hash, limite_compras)
       values ('Crediário da troca', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA', 500) returning id`,
    )) as [{ id: string }];
    const [{ id: semSenha }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into pessoas (nome, limite_compras) values ('Sem senha', 500) returning id",
    )) as [{ id: string }];
    for (const p of [pessoa, semSenha]) {
      await consultar(
        emp.nomeBanco,
        "insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em) values ($1, null, 'compra', now())",
        [p],
      );
    }
    const gravar = (valor: boolean) =>
      amb
        .http()
        .put('/api/configuracoes')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ lojaId: loja1, valores: { 'pdv.crediario_exige_senha_cliente': valor } });
    const pessoasDesde = async (desde: number) => {
      const r = await cargaInicial('pessoas', desde);
      return {
        cursor: r.cursor,
        linhas: new Map(
          r.alteracoes.filter((a) => a.tabela === 'pessoas').map((a) => [a.linha.id as string, a.linha]),
        ),
      };
    };
    // A exigência está ligada na loja 1 (teste anterior): o hash desce.
    let atual = await pessoasDesde(0);
    expect(atual.linhas.get(pessoa)?.senha_hash).toMatch(/^\$argon2id\$/);
    const versaoAntes = atual.linhas.get(pessoa)!.versao as number;

    expect((await gravar(false)).status).toBe(200);
    let depois = await pessoasDesde(atual.cursor);
    expect(depois.linhas.get(pessoa)).toMatchObject({ senha_hash: null });
    expect(depois.linhas.get(pessoa)!.versao as number).toBeGreaterThan(versaoAntes);
    // Quem não tem senha não muda de projeção e não é tocado.
    expect(depois.linhas.has(semSenha)).toBe(false);

    atual = depois;
    expect((await gravar(true)).status).toBe(200);
    depois = await pessoasDesde(atual.cursor);
    expect(depois.linhas.get(pessoa)?.senha_hash).toMatch(/^\$argon2id\$/);
    // Nada de ressincronizar o fluxo inteiro: o toque basta.
    const comandos = await consultar(
      emp.nomeBanco,
      "select 1 from comandos_terminal where terminal_id = $1 and tipo = 'ressincronizar_fluxo' and parametros->>'fluxo' = 'pessoas'",
      [terminalId],
    );
    expect(comandos).toEqual([]);
  });

  it('o toque de muitas pessoas (todas as com senha) vai em fatias, abaixo do limite de parâmetros do PostgreSQL', async () => {
    const [{ id: pessoa, versao }] = (await consultar<{ id: string; versao: string }>(
      emp.nomeBanco,
      "insert into pessoas (nome) values ('Toque em fatias') returning id, versao",
    )) as [{ id: string; versao: string }];
    // 70 mil ids passariam dos 65.535 parâmetros de uma consulta só.
    const ids = [...Array.from({ length: 70_000 }, () => uuidv7()), pessoa];
    const contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
    const tocadas = await amb.servicos.tenancy.executarNaEmpresa(contexto, () =>
      amb.servicos.tenancy.cx().transacao((tx) => tocar(tx, 'pessoas', 'id', ids), { travaVersao: true }),
    );
    expect(tocadas).toBe(1);
    const [depois] = await consultar<{ versao: string }>(
      emp.nomeBanco,
      'select versao from pessoas where id = $1',
      [pessoa],
    );
    expect(BigInt(depois!.versao)).toBeGreaterThan(BigInt(versao));
  });

  it('referencia: NCM completo e parametros_fiscais_uf só da UF da loja, sem fundamento/pendências', async () => {
    const antes = await cargaInicial('referencia');
    expect(antes.alteracoes.filter((a) => a.tabela === 'ncms').length).toBeGreaterThan(10_000);
    expect(antes.alteracoes.filter((a) => a.tabela === 'parametros_fiscais_uf')).toEqual([]);
    // Loja 1 passa ao PR (Curitiba), aqui por SQL: a linha do PR desce na carga refeita do zero. Pelo ERP, a troca de
    // UF manda `ressincronizar_fluxo` de `referencia` e `catalogo` aos terminais da loja (MD 6.4 regra 3; descida.test).
    await consultar(emp.nomeBanco, "update lojas set uf = 'PR', municipio_ibge = 4106902 where id = $1", [
      loja1,
    ]);
    const depois = await cargaInicial('referencia');
    const [pr, ...resto] = depois.alteracoes
      .filter((a) => a.tabela === 'parametros_fiscais_uf')
      .map((a) => a.linha);
    expect(resto).toEqual([]);
    expect(pr).toMatchObject({
      uf: 'PR',
      prazo_cancelamento_min: 30,
      qrcode_versoes_aceitas: [2, 3],
      vigencia_inicio: '2026-08-03',
    });
    expect(pr).not.toHaveProperty('fundamento');
    expect(pr).not.toHaveProperty('pendencias');
  });
});

describe('POST /sync/push (SYNC 7, 8)', () => {
  it('o mesmo evento enviado duas vezes é aplicado uma vez; a segunda resposta é duplicado', async () => {
    const ev = evento(1, 'auditoria.registros', auditoriaPayload('Gaveta aberta sem venda'));
    const r1 = await push([ev]);
    expect(r1.status).toBe(200);
    respostaPushSchema.parse(r1.body);
    expect(r1.body.resultados).toHaveLength(1);
    const res1 = r1.body.resultados[0];
    expect(res1).toMatchObject({ evento_id: ev.evento_id, sequencia: 1, status: 'aplicado' });
    expect(res1.versao_nuvem_fim).toBeGreaterThan(res1.versao_nuvem);
    expect(r1.body.proxima_sequencia_esperada).toBe(2);

    const r2 = await push([ev]);
    expect(r2.body.resultados[0]).toMatchObject({
      status: 'duplicado',
      versao_nuvem: res1.versao_nuvem,
      versao_nuvem_fim: res1.versao_nuvem_fim,
      resultado: res1.resultado,
    });
    const linhas = await consultar(
      emp.nomeBanco,
      "select origem, terminal_id, loja_id, evento_id from auditoria where descricao = 'Gaveta aberta sem venda'",
    );
    expect(linhas).toEqual([
      { origem: 'pdv', terminal_id: terminalId, loja_id: loja1, evento_id: ev.evento_id },
    ]);
    const logins = await consultar(
      emp.nomeBanco,
      "select origem, terminal_id from historico_logins where login_informado = 'maria'",
    );
    expect(logins).toEqual([{ origem: 'pdv', terminal_id: terminalId }]);

    // O teto do pull inclui o marcador de fim do evento (SYNC 6.4 passo 3).
    const p = await pull('configuracao', 0, 2000);
    expect(p.body.cursor_teto).toBeGreaterThanOrEqual(res1.versao_nuvem_fim);
  });

  it('ordem estrita por terminal: lacuna → fora_de_ordem; demais do lote nao_processado', async () => {
    const r = await push([
      evento(3, 'auditoria.registros', auditoriaPayload('fora de ordem')),
      evento(4, 'auditoria.registros', auditoriaPayload('depois')),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.resultados.map((x: { status: string }) => x.status)).toEqual([
      'fora_de_ordem',
      'nao_processado',
    ]);
    expect(r.body.proxima_sequencia_esperada).toBe(2);
  });

  it('hash divergente → rejeitado PAYLOAD_INVALIDO (ocupa a sequência); tipo ainda sem handler → erro_temporario', async () => {
    const ev = evento(2, 'auditoria.registros', auditoriaPayload('hash errado'));
    ev.payload_sha256 = 'f'.repeat(64);
    // `nfce.autorizada` só ganha handler na 1D (o `venda.finalizada` deste teste passou a ter o seu no C6b).
    const desconhecido = evento(3, 'nfce.autorizada', { documentos_fiscais: { id: uuidv7() } });
    const r = await push([ev, desconhecido]);
    respostaPushSchema.parse(r.body);
    expect(r.body.resultados[0]).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(r.body.resultados[1]).toMatchObject({
      status: 'erro_temporario',
      erro: { codigo: 'SCHEMA_DESCONHECIDO' },
    });
    expect(r.body.proxima_sequencia_esperada).toBe(3);
    const [linha] = await consultar(
      emp.nomeBanco,
      'select status, erro_codigo from eventos_recebidos where evento_id = $1',
      [ev.evento_id],
    );
    expect(linha).toEqual({ status: 'erro', erro_codigo: 'PAYLOAD_INVALIDO' });

    // Dependência do evento com erro → retido; o seguinte sem dependência segue aplicado.
    const retido = evento(
      3,
      'terminal.configuracao_alterada',
      {
        alteracoes: [{ chave: 'impressora.modelo', valor_anterior: 'A', valor_novo: 'B' }],
        configuracao_completa: { 'impressora.modelo': 'B' },
      },
      { dependencias: [{ agregado_tipo: ev.agregado_tipo, agregado_id: ev.agregado_id }] },
    );
    const livre = evento(4, 'terminal.configuracao_alterada', {
      alteracoes: [{ chave: 'gaveta.modo', valor_anterior: 'impressora', valor_novo: 'serial' }],
      configuracao_completa: { 'gaveta.modo': 'serial' },
    });
    const r2 = await push([retido, livre]);
    expect(r2.body.resultados.map((x: { status: string }) => x.status)).toEqual(['retido', 'aplicado']);
    const [t] = await consultar(emp.nomeBanco, 'select configuracao_local from terminais where id = $1', [
      terminalId,
    ]);
    expect(t).toEqual({ configuracao_local: { 'gaveta.modo': 'serial' } });
  });

  it('mesmo evento_id com conteúdo diferente → EVENTO_DIVERGENTE + alerta; sequência reusada → REGRESSAO_DETECTADA', async () => {
    const [primeiro] = await consultar<{ evento_id: string }>(
      emp.nomeBanco,
      'select evento_id from eventos_recebidos where sequencia_terminal = 1 and terminal_id = $1',
      [terminalId],
    );
    const adulterado = {
      ...evento(1, 'auditoria.registros', auditoriaPayload('adulterado')),
      evento_id: primeiro!.evento_id,
    };
    const r = await push([adulterado]);
    expect(r.body.resultados[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'EVENTO_DIVERGENTE' },
    });
    const [alerta] = await consultar(
      emp.nomeBanco,
      "select severidade from alertas where tipo = 'EVENTO_DIVERGENTE'",
    );
    expect(alerta).toEqual({ severidade: 'critico' });
    const regressao = await push([evento(2, 'auditoria.registros', auditoriaPayload('banco restaurado'))]);
    expect(regressao.status).toBe(409);
    envelopeErroSyncSchema.parse(regressao.body);
    expect(regressao.body.erro).toMatchObject({
      codigo: 'REGRESSAO_DETECTADA',
      detalhes: { sequencia: 2, proxima_sequencia_esperada: 5 },
    });
  });

  it('lote de outro terminal → 403 ESCOPO_INVALIDO; hardware divergente → 409 HARDWARE_ALTERADO (pull continua)', async () => {
    const outro = await amb
      .http()
      .post('/sync/push')
      .set(cabecalhos(token))
      .send({
        lote_id: uuidv7(),
        terminal_id: uuidv7(),
        enviado_em: new Date().toISOString(),
        eventos: [{}],
      });
    expect(outro.status).toBe(403);
    expect(outro.body.erro.codigo).toBe('ESCOPO_INVALIDO');
    const outroHw = { 'X-Genesis-Id-Hardware': 'f'.repeat(64) };
    const r = await push([evento(5, 'auditoria.registros', auditoriaPayload('clone'))], token, outroHw);
    expect(r.status).toBe(409);
    expect(r.body.erro.codigo).toBe('HARDWARE_ALTERADO');
    const p = await amb.http().get('/sync/pull?fluxo=configuracao&desde=0').set(cabecalhos(token, outroHw));
    expect(p.status).toBe(200);
    const e = await amb.http().get('/sync/estado').set(cabecalhos(token, outroHw));
    expect(e.body.terminal.id_hardware_confere).toBe(false);
    const [t] = await consultar(
      amb.bancoControle,
      'select id_hardware, id_hardware_pendente from terminais_pdv where id = $1',
      [terminalId],
    );
    expect(t).toEqual({ id_hardware: HARDWARE, id_hardware_pendente: 'f'.repeat(64) });
  });
});

describe('push concorrente do mesmo terminal (SYNC 8.1)', () => {
  it('dois envios simultâneos do mesmo lote aplicam o evento uma única vez', async () => {
    const ev = evento(5, 'auditoria.registros', auditoriaPayload('concorrente'));
    const [a, b] = await Promise.all([push([ev]), push([ev])]);
    const desfechos = [a, b]
      .map((r) => (r.status === 200 ? r.body.resultados[0].status : r.body.erro.codigo))
      .sort();
    expect(['aplicado', 'duplicado', 'PUSH_EM_ANDAMENTO']).toEqual(expect.arrayContaining(desfechos));
    expect(desfechos.filter((d) => d === 'aplicado')).toHaveLength(1);
    const [n] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where descricao = 'concorrente'",
    );
    expect(n).toEqual({ n: 1 });
  });
});

describe('POST /sync/heartbeat (SYNC 21.1)', () => {
  it('grava a telemetria e entrega comandos até o ack', async () => {
    const [cmd] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into comandos_terminal (terminal_id, tipo, parametros) values ($1, \'mensagem\', \'{"texto":"Inventário amanhã"}\') returning id',
      [terminalId],
    );
    const corpo = {
      versao_app: '1.0.0',
      estado_local: 'ativo',
      so: 'Windows 11 Pro 24H2 x64',
      eventos_pendentes: 2,
      ultima_sequencia_gerada: 6,
      venda_ultimo_numero: 12,
      vale_ultimo_numero: 1,
      dinheiro_estimado_gaveta: '150.00',
      cursor_pull: { configuracao: 10 },
      sse_conectado: false,
    };
    const hb = await amb.http().post('/sync/heartbeat').set(cabecalhos(token)).send(corpo);
    expect(hb.status).toBe(200);
    respostaHeartbeatSchema.parse(hb.body);
    expect(hb.body).toMatchObject({
      status_terminal: 'ativo',
      renovar_token: false,
      intervalos: { heartbeat_s: 30, pull_s: 30, pull_com_sse_s: 300, push_pendente_s: 15 },
    });
    expect(hb.body.comandos).toEqual([
      { id: cmd!.id, tipo: 'mensagem', parametros: { texto: 'Inventário amanhã' } },
    ]);
    const [t] = await consultar(
      emp.nomeBanco,
      'select eventos_pendentes, venda_ultimo_numero::int as venda, dinheiro_estimado_gaveta::text as gaveta from terminais where id = $1',
      [terminalId],
    );
    expect(t).toEqual({ eventos_pendentes: 2, venda: 12, gaveta: '150.00' });
    const estado = await amb.http().get('/sync/estado').set(cabecalhos(token));
    expect(estado.body.numeracoes.venda.ultimo_numero).toBe(12);
    expect(estado.body.informado_pelo_terminal.ultima_sequencia_gerada).toBe(6);

    // Ack "recebido": continua sendo reenviado até executar.
    const ack = await amb
      .http()
      .post('/sync/heartbeat')
      .set(cabecalhos(token))
      .send({ ...corpo, comandos_resultado: [{ comando_id: cmd!.id, status: 'recebido' }] });
    expect(ack.body.comandos).toHaveLength(1);
    const fim = await amb
      .http()
      .post('/sync/heartbeat')
      .set(cabecalhos(token))
      .send({
        ...corpo,
        comandos_resultado: [{ comando_id: cmd!.id, status: 'executado', resultado: { ok: true } }],
      });
    expect(fim.body.comandos).toEqual([]);
    const [c] = await consultar(
      emp.nomeBanco,
      'select status, entregue_em is not null as entregue from comandos_terminal where id = $1',
      [cmd!.id],
    );
    expect(c).toEqual({ status: 'executado', entregue: true });
  });

  it('empresa suspensa: pull/heartbeat recusados, push aceito; terminal revogado → 401 TERMINAL_REVOGADO', async () => {
    await amb.servicos.provisionamento.alterarStatus(emp.codigo, 'suspender', 'inadimplência');
    try {
      const p = await pull('configuracao', 0);
      expect(p.status).toBe(403);
      expect(p.body.erro.codigo).toBe('EMPRESA_SUSPENSA');
      const r = await push([evento(6, 'auditoria.registros', auditoriaPayload('suspensa'))]);
      expect(r.status).toBe(200);
      expect(r.body.resultados[0].status).toBe('aplicado');
    } finally {
      await amb.servicos.provisionamento.alterarStatus(emp.codigo, 'reativar', null);
    }
    // "Revogar imediatamente" pelo ERP (ERP 12.4), confirmando o nº do caixa.
    const revogar = await amb
      .http()
      .post(`/api/terminais/${terminalId}/revogar`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ modo: 'imediato', confirmacaoCaixa: 1 });
    expect(revogar.status, JSON.stringify(revogar.body)).toBe(200);
    const rev = await amb.http().get('/sync/estado').set(cabecalhos(token));
    expect(rev.status).toBe(401);
    envelopeErroSyncSchema.parse(rev.body);
    expect(rev.body.erro.codigo).toBe('TERMINAL_REVOGADO');
  });
});

describe('substituição de terminal (SYNC 3.4, 13.3; ERP 12)', () => {
  it('exige terminais.revogar; o novo fica ativo, o antigo desativando nos dois bancos e a numeração salta +1000', async () => {
    const [{ id: caixa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into caixas (loja_id, numero, descricao) values ($1, 2, $2) returning id',
      [loja1, 'Caixa 02'],
    )) as [{ id: string }];
    const antigo = await amb
      .http()
      .post('/sync/ativar')
      .set(cabecalhos())
      .send(corpoAtivacao(await gerarCodigo(caixa, loja1)).corpo);
    expect(antigo.status).toBe(201);
    const antigoId = antigo.body.terminal_id as string;
    // O antigo vendeu até a venda 37 e o vale 3, mas nunca confirmou a desativação (a máquina "morreu").
    const hb = await amb.http().post('/sync/heartbeat').set(cabecalhos(antigo.body.token)).send({
      venda_ultimo_numero: 37,
      vale_ultimo_numero: 3,
    });
    expect(hb.status).toBe(200);

    // Substituir também revoga o antigo: só com terminais.revogar (o gerente sem ela recebe 403).
    await criarUsuario(emp.nomeBanco, { login: 'gerente_sub', perfil: 'gerente', lojas: [loja1] });
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito)
       select id, 'terminais.revogar', 'negar' from usuarios where login = 'gerente_sub'`,
    );
    const gerente = await amb.entrar(emp.codigo, 'gerente_sub', SENHA_TESTE);
    const pedido = { lojaId: loja1, caixaId: caixa, validadeHoras: 1, substituiTerminalId: antigoId };
    const negado = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set('Authorization', `Bearer ${gerente}`)
      .send(pedido);
    expect(negado.status).toBe(403);
    const permitido = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send(pedido);
    expect(permitido.status).toBe(201);

    const novo = await amb
      .http()
      .post('/sync/ativar')
      .set(cabecalhos())
      .send(corpoAtivacao(permitido.body.codigo).corpo);
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    respostaAtivacaoSchema.parse(novo.body);
    expect(novo.body.numeracoes).toMatchObject({
      venda: { ultimo_numero: 1037 },
      vale: { ultimo_numero: 1003 },
    });
    const novoId = novo.body.terminal_id as string;

    const controle = await consultar<{
      id: string;
      status: string;
      substituido: string | null;
      carencia: boolean;
    }>(
      amb.bancoControle,
      `select id, status, substituido_por_terminal_id as substituido, carencia_ate > now() as carencia
       from terminais_pdv where id = any($1) order by ativado_em`,
      [[antigoId, novoId]],
    );
    expect(controle).toEqual([
      { id: antigoId, status: 'desativando', substituido: novoId, carencia: true },
      { id: novoId, status: 'ativo', substituido: null, carencia: null },
    ]);
    const empresa = await consultar<{ id: string; status: string }>(
      emp.nomeBanco,
      'select id, status from terminais where caixa_id = $1 order by ativado_em',
      [caixa],
    );
    expect(empresa).toEqual([
      { id: antigoId, status: 'desativando' },
      { id: novoId, status: 'ativo' },
    ]);
    const [cx] = await consultar(
      emp.nomeBanco,
      'select terminal_id, terminal_anterior_id from caixas where id = $1',
      [caixa],
    );
    expect(cx).toEqual({ terminal_id: novoId, terminal_anterior_id: antigoId });
    const [aud] = await consultar<{ depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select depois from auditoria where acao = 'terminal_ativado' and registro_id = $1",
      [novoId],
    );
    expect(aud!.depois).toMatchObject({ terminal_anterior_id: antigoId, salto: true });
    const nums = await consultar(
      emp.nomeBanco,
      "select tipo, ultimo_numero::int as n from numeracoes where caixa_id = $1 and tipo in ('venda', 'vale') order by tipo",
      [caixa],
    );
    expect(nums).toEqual([
      { tipo: 'vale', n: 1003 },
      { tipo: 'venda', n: 1037 },
    ]);

    // O antigo continua autenticando em `desativando` (envia as pendências até confirmar, SYNC 3.8).
    const estadoAntigo = await amb.http().get('/sync/estado').set(cabecalhos(antigo.body.token));
    expect(estadoAntigo.status).toBe(200);
    expect(respostaEstadoSchema.parse(estadoAntigo.body).terminal.status).toBe('desativando');
  });

  it('falha na etapa da empresa desfaz a substituição: o antigo volta a ativo e a nova tentativa aponta para o novo', async () => {
    const [{ id: caixa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into caixas (loja_id, numero, descricao) values ($1, 3, $2) returning id',
      [loja1, 'Caixa 03'],
    )) as [{ id: string }];
    const antigo = await amb
      .http()
      .post('/sync/ativar')
      .set(cabecalhos())
      .send(corpoAtivacao(await gerarCodigo(caixa, loja1)).corpo);
    expect(antigo.status).toBe(201);
    const antigoId = antigo.body.terminal_id as string;
    const pedido = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ lojaId: loja1, caixaId: caixa, validadeHoras: 1, substituiTerminalId: antigoId });
    expect(pedido.status).toBe(201);

    // Falha simulada da etapa da empresa (no lugar de banco fora, migração em curso ou caixa excluído no meio).
    await consultar(
      emp.nomeBanco,
      `create function teste_falhar_etapa() returns trigger language plpgsql as $$
       begin raise exception 'falha simulada da etapa da empresa'; end $$;
       create trigger teste_falhar_etapa before insert on terminais for each row
       when (new.caixa_id = '${caixa}') execute function teste_falhar_etapa();`,
    );
    let falhaId: string;
    try {
      const falha = await amb
        .http()
        .post('/sync/ativar')
        .set(cabecalhos())
        .send(corpoAtivacao(pedido.body.codigo).corpo);
      expect(falha.status).toBe(503);
      expect(envelopeErroSyncSchema.parse(falha.body).erro.codigo).toBe('MANUTENCAO');
      const [t] = await consultar<{ id: string }>(
        amb.bancoControle,
        "select id from terminais_pdv where caixa_id = $1 and motivo_revogacao = 'falha_ativacao'",
        [caixa],
      );
      falhaId = t!.id;
    } finally {
      await consultar(
        emp.nomeBanco,
        'drop trigger teste_falhar_etapa on terminais; drop function teste_falhar_etapa()',
      );
    }

    const estadoControle = () =>
      consultar<{ id: string; status: string; substituido: string | null; carencia: string | null }>(
        amb.bancoControle,
        `select id, status, substituido_por_terminal_id as substituido, carencia_ate as carencia
         from terminais_pdv where caixa_id = $1 order by ativado_em`,
        [caixa],
      );
    expect(await estadoControle()).toEqual([
      { id: antigoId, status: 'ativo', substituido: null, carencia: null },
      { id: falhaId, status: 'revogado', substituido: null, carencia: null },
    ]);
    // O caixa que funcionava continua: estado `ativo` e o heartbeat não entrega `revogar`.
    const estado = await amb.http().get('/sync/estado').set(cabecalhos(antigo.body.token));
    expect(respostaEstadoSchema.parse(estado.body).terminal.status).toBe('ativo');
    const hb = await amb.http().post('/sync/heartbeat').set(cabecalhos(antigo.body.token)).send({});
    expect(hb.status).toBe(200);
    expect(respostaHeartbeatSchema.parse(hb.body).comandos.map((c) => c.tipo)).not.toContain('revogar');

    // O código voltou a `pendente`: a nova tentativa substitui de verdade e o antigo aponta para quem concluiu.
    const novo = await amb
      .http()
      .post('/sync/ativar')
      .set(cabecalhos())
      .send(corpoAtivacao(pedido.body.codigo).corpo);
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    const novoId = novo.body.terminal_id as string;
    const depois = await estadoControle();
    expect(depois.map(({ id, status, substituido }) => ({ id, status, substituido }))).toEqual([
      { id: antigoId, status: 'desativando', substituido: novoId },
      { id: falhaId, status: 'revogado', substituido: null },
      { id: novoId, status: 'ativo', substituido: null },
    ]);
    expect(depois[0]!.carencia).not.toBeNull();
  });

  it('duas ativações simultâneas do mesmo caixa: uma ativa, a outra recebe 422 CAIXA_OCUPADO (sem 500)', async () => {
    const [{ id: caixa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into caixas (loja_id, numero, descricao) values ($1, 4, $2) returning id',
      [loja1, 'Caixa 04'],
    )) as [{ id: string }];
    const codigos = [await gerarCodigo(caixa, loja1), await gerarCodigo(caixa, loja1)];
    const falhasAntes = await consultar<{ n: number }>(
      amb.bancoControle,
      'select count(*)::int as n from tentativas_ativacao where not sucesso and motivo_falha is null',
    );
    // Corrida determinística: com `terminais_pdv` em SHARE (o select passa, o insert espera), as duas ativações ficam
    // presas no mesmo ponto antes de soltar. Sem a trava por caixa, ambas teriam lido o caixa vazio.
    const bloqueio = await conectar(amb.bancoControle);
    const respostas = await (async () => {
      try {
        await bloqueio.query('begin');
        await bloqueio.query('lock table terminais_pdv in share mode');
        // `.then` dispara o envio já (o supertest só envia quando é aguardado).
        const envios = codigos.map((c) =>
          amb
            .http()
            .post('/sync/ativar')
            .set(cabecalhos())
            .send(corpoAtivacao(c).corpo)
            .then((r) => ({ status: r.status, body: r.body as unknown })),
        );
        for (let i = 0; ; i++) {
          const [{ n }] = (
            await bloqueio.query<{ n: number }>(
              `select count(*)::int as n from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
            )
          ).rows as [{ n: number }];
          if (n >= 2) break;
          if (i > 200) throw new Error('as ativações não chegaram ao ponto de espera');
          await new Promise((r) => setTimeout(r, 25));
        }
        await bloqueio.query('commit');
        return await Promise.all(envios);
      } finally {
        await bloqueio.end();
      }
    })();
    expect(respostas.map((r) => r.status).sort()).toEqual([201, 422]);
    const recusa = respostas.find((r) => r.status === 422)!;
    expect(envelopeErroSyncSchema.parse(recusa.body).erro.codigo).toBe('CAIXA_OCUPADO');
    // A recusa entra em `tentativas_ativacao` como qualquer outra falha conhecida.
    const falhasDepois = await consultar<{ n: number }>(
      amb.bancoControle,
      'select count(*)::int as n from tentativas_ativacao where not sucesso and motivo_falha is null',
    );
    expect(falhasDepois[0]!.n).toBe(falhasAntes[0]!.n + 1);
    const ocupantes = await consultar(
      amb.bancoControle,
      "select id from terminais_pdv where caixa_id = $1 and status in ('provisionando', 'ativo')",
      [caixa],
    );
    expect(ocupantes).toHaveLength(1);
  });
});

describe('força bruta na ativação (SYNC 3.1)', () => {
  it('5 códigos errados do mesmo IP em 10 min → 429 IP_BLOQUEADO', async () => {
    const [{ n }] = (await consultar<{ n: number }>(
      amb.bancoControle,
      "select count(*)::int as n from tentativas_ativacao where not sucesso and motivo_falha = 'codigo_invalido'",
    )) as [{ n: number }];
    for (let i = n; i < 5; i++) {
      const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao('ZZZZZZZZ').corpo);
      expect(r.status).toBe(422);
      expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    }
    const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao('ZZZZZZZZ').corpo);
    expect(r.status).toBe(429);
    expect(r.body.erro.codigo).toBe('IP_BLOQUEADO');
    // O mesmo valor da fixture `erros.json` com que o xUnit do PDV confere o `RepetirApos`.
    const { casos } = JSON.parse(readFileSync(new URL('erros.json', FIXTURES), 'utf8')) as {
      casos: Array<{ corpo: { erro: { codigo: string } }; cabecalhos?: Record<string, string> }>;
    };
    const caso = casos.find((c) => c.corpo.erro.codigo === 'IP_BLOQUEADO')!;
    expect(r.headers['retry-after']).toBe(caso.cabecalhos!['Retry-After']);
  });
});
