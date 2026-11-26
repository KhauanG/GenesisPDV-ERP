/**
 * Versões de payload por tipo e a auditoria com ação desconhecida (SYNC 17.5 e 9.22; Fase 3, F3-B4): um tipo de teste
 * com a v2 no handler e a v1 pelo upcast, contra o banco de verdade. O payload gravado em `eventos_recebidos` continua
 * o original; o evento v1 que foi a `erro` por defeito do upcaster se resolve com o upcaster corrigido e o
 * Reprocessar da fila de decisão (que usa o mesmo caminho do push); o v1 recusado pela regra da v1 continua recusado
 * depois do upcast. No `auditoria.registros`, a ação que a nuvem não conhece é gravada como `acao_desconhecida` com o
 * texto original e o alerta no terminal, e a reservada ao servidor continua recusando o lote. O erro que um upcaster
 * lança de propósito sobe como está e só depois da retenção, e o `entidades`/`dependencias` do handler leem o payload
 * já convertido (também no evento retido).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ACAO_AUDITORIA_DESCONHECIDA,
  ALERTA_AUDITORIA_ACAO_DESCONHECIDA,
  jcs,
  type Ativar,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SessaoErp } from '../../src/auth/auth.service.js';
import { ErroRegraEvento, ErroTransitorioEvento } from '../../src/sync/erros.js';
import {
  ALERTAS_ACAO_DESCONHECIDA_POR_LOTE,
  HANDLERS,
  chaveAcaoDesconhecida,
  versoesSchemaAceitas,
  type CatalogoHandlers,
  type ContextoHandler,
} from '../../src/sync/eventos.js';
import { PushSync } from '../../src/sync/push.js';
import type { TerminalAutenticado } from '../../src/sync/terminal.js';
import { FilaDecisao } from '../../src/terminais/fila-decisao.js';
import type { ContextoEmpresa } from '../../src/tenancy/contexto.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let contexto: ContextoEmpresa;
let loja1: string;
let caixa1: string;
let terminalId: string;
let token: string;
let adminId: string;
let tokenAdmin: string;
let seq = 0;

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

function evento(
  tipo: string,
  versao: number,
  payload: Record<string, unknown>,
  dependencias: Array<{ agregado_tipo: string; agregado_id: string }> = [],
) {
  return {
    evento_id: uuidv7(),
    sequencia: ++seq,
    tipo,
    versao_schema: versao,
    agregado_tipo: 'teste',
    agregado_id: uuidv7(),
    dependencias,
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
  };
}

const lote = (eventos: unknown[]) => ({
  lote_id: uuidv7(),
  terminal_id: terminalId,
  enviado_em: new Date().toISOString(),
  eventos,
});

const naEmpresa = <T>(fn: () => Promise<T>) => amb.servicos.tenancy.executarNaEmpresa(contexto, fn);

const terminal = () =>
  ({
    terminalId,
    lojaId: loja1,
    caixaId: caixa1,
    numeroCaixa: 1,
    ip: '127.0.0.1',
  }) as unknown as TerminalAutenticado;

const v1 = z.object({ quantidade: z.number().int() });
const v2 = z.object({ quantidade: z.number().int(), unidade: z.enum(['un', 'cx']) });
type V2 = z.infer<typeof v2>;

/**
 * O tipo de teste: v2 no handler (ainda não anunciada, como no meio de uma onda) e a v1 pelo upcast, que dá para
 * trocar entre o com defeito e o corrigido (como um deploy de upcaster). Na v1, quantidade negativa era recusada (e
 * continua recusada para quem veio dela); na v2 é um estorno. Cada aplicação grava uma linha em `caixas` (número =
 * quantidade + 60), para o teste ver o efeito no banco.
 */
const upcaster = { atual: (p: z.infer<typeof v1>): unknown => ({ ...p, unidade: 'un' }) };

/**
 * Segundo tipo de teste, para a retenção e as entidades: a v2 renomeia os campos da v1 (`item_id` → `item.id`,
 * `depende_de` → `depende`). O upcaster dá para trocar por um que lança um erro de regra ou um transitório de propósito.
 */
const ligadoV1 = z.object({ item_id: z.uuid(), depende_de: z.uuid().nullable() });
const ligadoV2 = z.object({ item: z.object({ id: z.uuid() }), depende: z.uuid().nullable() });
type LigadoV2 = z.infer<typeof ligadoV2>;
const upcastLigadoCerto = (p: z.infer<typeof ligadoV1>): unknown => ({
  item: { id: p.item_id },
  depende: p.depende_de,
});
const upcasterLigado = { atual: upcastLigadoCerto };
const aplicacoes: Array<{ versaoOrigem: number; payload: V2 }> = [];
const catalogo: CatalogoHandlers = {
  ...HANDLERS,
  'teste.versionado': {
    2: {
      schema: v2,
      anunciada: false,
      versoes: { 1: { schema: v1, upcast: (p: z.infer<typeof v1>) => upcaster.atual(p) } },
      async aplicar(ctx: ContextoHandler, p: V2) {
        if (ctx.versaoOrigem === 1 && p.quantidade < 0) {
          throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Quantidade negativa não existe na v1.');
        }
        aplicacoes.push({ versaoOrigem: ctx.versaoOrigem, payload: p });
        await ctx.c.query('insert into caixas (loja_id, numero, descricao) values ($1, $2, $3)', [
          ctx.terminal.lojaId,
          60 + Math.abs(p.quantidade),
          `teste ${p.unidade}`,
        ]);
        return { unidade: p.unidade };
      },
    },
  },
  'teste.ligado': {
    2: {
      schema: ligadoV2,
      versoes: { 1: { schema: ligadoV1, upcast: (p: z.infer<typeof ligadoV1>) => upcasterLigado.atual(p) } },
      // Os dois leem campos que só existem depois do upcast (`item.id`, `depende`): com o payload v1 cru, falhariam.
      entidades: (p: LigadoV2) => [{ tipo: 'item_teste', id: p.item.id }],
      dependencias: (_ctx: ContextoHandler, p: LigadoV2) =>
        Promise.resolve(p.depende ? [{ agregado_tipo: 'teste', agregado_id: p.depende }] : []),
      async aplicar(_ctx: ContextoHandler, p: LigadoV2) {
        return { item: p.item.id };
      },
    },
  },
};

let pushTeste: PushSync;
let fila: FilaDecisao;

const linhaDoEvento = async (eventoId: string) => {
  const [l] = await consultar<{
    id: string;
    status: string;
    erro_codigo: string | null;
    erro: string | null;
    payload: unknown;
    versao_schema: number;
    detalhes: Record<string, unknown> | null;
  }>(
    emp.nomeBanco,
    `select id, status, erro_codigo, erro, payload, versao_schema, resultado -> 'detalhes' as detalhes
       from eventos_recebidos where evento_id = $1`,
    [eventoId],
  );
  return l!;
};

const reprocessar = (linhaId: string) =>
  naEmpresa(() =>
    fila.reprocessar({ lojas: null, usuarioId: adminId } as unknown as SessaoErp, linhaId, {
      origem: 'erp',
      usuarioId: adminId,
    }),
  );

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  [{ id: caixa1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja1, 'Caixa 01'],
  )) as [{ id: string }];
  [{ id: adminId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId: loja1, caixaId: caixa1, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status).toBe(201);
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
  expect(r.status).toBe(201);
  terminalId = r.body.terminal_id;
  token = r.body.token;
  pushTeste = new PushSync(amb.servicos.tenancy, { handlers: catalogo });
  fila = new FilaDecisao(
    amb.servicos.tenancy,
    amb.servicos.auditoria,
    amb.servicos.tarefas,
    amb.servicos.permissoes,
    catalogo,
  );
});

afterAll(async () => {
  await amb?.fechar();
});

describe('tipo com duas versões (SYNC 17.5)', () => {
  it('a v1 aplica pelo upcast e a v2 direto; o payload gravado é o original e a v2 não anunciada fica fora das versões anunciadas', async () => {
    const e1 = evento('teste.versionado', 1, { quantidade: 1 });
    const e2 = evento('teste.versionado', 2, { quantidade: 2, unidade: 'cx' });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e1, e2])));
    expect(r.resultados.map((x) => [x.status, x.resultado])).toEqual([
      ['aplicado', { unidade: 'un' }],
      ['aplicado', { unidade: 'cx' }],
    ]);
    expect(await linhaDoEvento(e1.evento_id)).toMatchObject({ versao_schema: 1, payload: { quantidade: 1 } });
    expect(aplicacoes.slice(-2).map((a) => a.versaoOrigem)).toEqual([1, 2]);
    const caixasTeste = await consultar(
      emp.nomeBanco,
      'select numero, descricao from caixas where numero in (61, 62) order by numero',
    );
    expect(caixasTeste).toEqual([
      { numero: 61, descricao: 'teste un' },
      { numero: 62, descricao: 'teste cx' },
    ]);
    // O `/sync/estado` monta o `versoes_schema` pelo `versoesSchemaAceitas` do catálogo de verdade, que não tem o tipo
    // de teste: a regra do `anunciada: false` se confere na mesma função, com o catálogo do teste (a v2 aceita fica
    // fora; a v1 que ela converte continua anunciada). No endpoint, a v1 dos tipos da 1C continua anunciada.
    expect(versoesSchemaAceitas(catalogo)['teste.versionado']).toEqual([1]);
    expect(versoesSchemaAceitas(catalogo)['teste.ligado']).toEqual([1, 2]);
    const estado = await amb.http().get('/sync/estado').set(cabecalhos(token));
    expect(estado.status).toBe(200);
    expect(estado.body.versoes_schema['venda.finalizada']).toContain(1);
    expect(estado.body.versoes_schema['vasilhame.movimentado']).toContain(1);
  });

  it('a v1 em erro por defeito do upcaster: corrigido o upcaster, o Reprocessar aplica sobre o payload original', async () => {
    upcaster.atual = (p) => ({ ...p, unidade: 'litro' });
    const e = evento('teste.versionado', 1, { quantidade: 4 });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    const antes = await linhaDoEvento(e.evento_id);
    expect(antes).toMatchObject({
      status: 'erro',
      erro_codigo: 'PAYLOAD_INVALIDO',
      erro: 'Payload convertido da v1 fora do schema da v2.',
      payload: { quantidade: 4 },
      detalhes: { versao_origem: 1, versao: 2 },
    });

    // Reprocessar com o upcaster ainda com defeito: continua em erro, nada aplicado.
    expect((await reprocessar(antes.id)).status).toBe('erro');
    expect(await consultar(emp.nomeBanco, 'select 1 from caixas where numero = 64')).toEqual([]);

    // O "deploy" do upcaster corrigido e o Reprocessar: aplicado, com o payload gravado sem mudança.
    upcaster.atual = (p) => ({ ...p, unidade: 'un' });
    expect(await reprocessar(antes.id)).toMatchObject({ status: 'aplicado' });
    const depois = await linhaDoEvento(e.evento_id);
    expect(depois).toMatchObject({ status: 'aplicado', erro_codigo: null, payload: { quantidade: 4 } });
    expect(await consultar(emp.nomeBanco, 'select descricao from caixas where numero = 64')).toEqual([
      { descricao: 'teste un' },
    ]);
    expect(aplicacoes.at(-1)).toEqual({ versaoOrigem: 1, payload: { quantidade: 4, unidade: 'un' } });
  });

  it('o upcaster que lança também é PAYLOAD_INVALIDO (não ERRO_INTERNO), com a falha nos detalhes', async () => {
    upcaster.atual = () => {
      throw new TypeError('defeito de teste no upcaster');
    };
    const e = evento('teste.versionado', 1, { quantidade: 5 });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(await linhaDoEvento(e.evento_id)).toMatchObject({
      status: 'erro',
      erro: 'Falha na conversão do payload da v1 para a v2.',
      detalhes: { falha: 'defeito de teste no upcaster' },
    });
    upcaster.atual = (p) => ({ ...p, unidade: 'un' });
    expect(await reprocessar((await linhaDoEvento(e.evento_id)).id)).toMatchObject({ status: 'aplicado' });
  });

  it('a v1 recusada pela regra da v1 continua recusada depois do upcast, também no Reprocessar', async () => {
    const e = evento('teste.versionado', 1, { quantidade: -6 });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    const l = await linhaDoEvento(e.evento_id);
    expect(l).toMatchObject({ status: 'erro', erro: 'Quantidade negativa não existe na v1.' });
    expect(await reprocessar(l.id)).toMatchObject({ status: 'erro', erroCodigo: 'PAYLOAD_INVALIDO' });
    expect(await consultar(emp.nomeBanco, 'select 1 from caixas where numero = 66')).toEqual([]);
    // Na v2 o mesmo valor é um estorno aceito.
    const e2 = evento('teste.versionado', 2, { quantidade: -7, unidade: 'cx' });
    const r2 = await naEmpresa(() => pushTeste.receber(terminal(), lote([e2])));
    expect(r2.resultados[0]).toMatchObject({ status: 'aplicado' });
  });
});

describe('upcast com retenção e entidades (SYNC 8.5 e 17.5)', () => {
  const entidadesDoEvento = (eventoId: string) =>
    consultar<{ entidade_tipo: string; entidade_id: string }>(
      emp.nomeBanco,
      'select entidade_tipo, entidade_id from entidades_evento where evento_id = $1',
      [eventoId],
    );
  /** Um evento em `erro` (a regra da v1 do `teste.versionado`), para servir de dependência pendente. */
  const eventoEmErro = async (quantidade: number) => {
    const e = evento('teste.versionado', 1, { quantidade });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'rejeitado' });
    return e;
  };

  it('o dependencias e o entidades do handler leem o payload convertido: a v1 retida grava a entidade da v2', async () => {
    const bloqueador = await eventoEmErro(-8);
    const item = uuidv7();
    // A dependência só aparece no payload convertido (`depende`); o envelope não traz nenhuma.
    const e = evento('teste.ligado', 1, { item_id: item, depende_de: bloqueador.agregado_id });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
    expect(await linhaDoEvento(e.evento_id)).toMatchObject({ status: 'retido', payload: { item_id: item } });
    expect(await entidadesDoEvento(e.evento_id)).toEqual([
      { entidade_tipo: 'item_teste', entidade_id: item },
    ]);

    // Quem depende do item (pela entidade que o evento retido registrou) também espera (SYNC 8.5).
    const dependente = evento('teste.versionado', 2, { quantidade: 9, unidade: 'un' }, [
      { agregado_tipo: 'item_teste', agregado_id: item },
    ]);
    const r2 = await naEmpresa(() => pushTeste.receber(terminal(), lote([dependente])));
    expect(r2.resultados[0]).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
    expect(await consultar(emp.nomeBanco, 'select 1 from caixas where numero = 69')).toEqual([]);
  });

  it('o erro de regra lançado pelo upcaster espera a dependência; sem ela, sobe com o próprio código', async () => {
    upcasterLigado.atual = () => {
      throw new ErroRegraEvento('REFERENCIA_INEXISTENTE', 'Item da v1 sem correspondente na v2.');
    };
    try {
      const bloqueador = await eventoEmErro(-10);
      const retido = evento('teste.ligado', 1, { item_id: uuidv7(), depende_de: null }, [
        { agregado_tipo: 'teste', agregado_id: bloqueador.agregado_id },
      ]);
      const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([retido])));
      expect(r.resultados[0]).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
      expect(await linhaDoEvento(retido.evento_id)).toMatchObject({
        status: 'retido',
        erro_codigo: 'DEPENDENCIA_PENDENTE',
      });

      const sozinho = evento('teste.ligado', 1, { item_id: uuidv7(), depende_de: null });
      const r2 = await naEmpresa(() => pushTeste.receber(terminal(), lote([sozinho])));
      expect(r2.resultados[0]).toMatchObject({
        status: 'rejeitado',
        erro: { codigo: 'REFERENCIA_INEXISTENTE' },
      });
      expect(await linhaDoEvento(sozinho.evento_id)).toMatchObject({
        status: 'erro',
        erro_codigo: 'REFERENCIA_INEXISTENTE',
        erro: 'Item da v1 sem correspondente na v2.',
      });
      // Sem payload convertido, sem entidades.
      expect(await entidadesDoEvento(sozinho.evento_id)).toEqual([]);
    } finally {
      upcasterLigado.atual = upcastLigadoCerto;
    }
  });

  it('o transitório lançado pelo upcaster continua transitório: nada gravado, e o reenvio aplica', async () => {
    upcasterLigado.atual = () => {
      throw new ErroTransitorioEvento('SCHEMA_DESCONHECIDO', 'Conversão da v1 ainda indisponível.');
    };
    const item = uuidv7();
    const e = evento('teste.ligado', 1, { item_id: item, depende_de: null });
    try {
      const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
      expect(r.resultados[0]).toMatchObject({
        status: 'erro_temporario',
        erro: { codigo: 'SCHEMA_DESCONHECIDO', mensagem: 'Conversão da v1 ainda indisponível.' },
      });
      expect(
        await consultar(emp.nomeBanco, 'select 1 from eventos_recebidos where evento_id = $1', [e.evento_id]),
      ).toEqual([]);
    } finally {
      upcasterLigado.atual = upcastLigadoCerto;
    }
    // O caixa reenvia o mesmo evento (a sequência não avançou): agora aplica.
    const r2 = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r2.resultados[0]).toMatchObject({ status: 'aplicado', resultado: { item } });
    expect(await entidadesDoEvento(e.evento_id)).toEqual([
      { entidade_tipo: 'item_teste', entidade_id: item },
    ]);
  });
});

describe('auditoria com ação desconhecida (SYNC 9.22; F3-B4)', () => {
  const registro = (acao: string, descricao: string | null = 'Preço do item trocado pelo operador') => ({
    id: uuidv7(),
    ocorrido_em: new Date().toISOString(),
    acao,
    entidade: 'itens_venda',
    descricao,
    depois: { preco: '9.90' },
  });
  const alertasAbertos = () =>
    consultar<{ titulo: string; dados: Record<string, unknown>; severidade: string; registro_id: string }>(
      emp.nomeBanco,
      `select titulo, dados, severidade, registro_id from alertas
        where tipo = $1 and resolvido_em is null order by criado_em`,
      [ALERTA_AUDITORIA_ACAO_DESCONHECIDA],
    );

  it('o lote com uma ação desconhecida é aplicado: a linha vira acao_desconhecida com o texto original e o alerta', async () => {
    const original = 'acao_de_uma_versao_futura_do_caixa';
    const conhecido = registro('gaveta_aberta', 'Gaveta aberta');
    const novos = [registro(original), registro(original, null)];
    const e = evento('auditoria.registros', 1, { registros: [conhecido, ...novos], logins: [] });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({
      status: 'aplicado',
      resultado: { registros: 3, logins: 0, acoes_desconhecidas: [original] },
    });
    const linhas = await consultar<{ id: string; acao: string; descricao: string; depois: unknown }>(
      emp.nomeBanco,
      'select id, acao, descricao, depois from auditoria where evento_id = $1 order by id',
      [e.evento_id],
    );
    expect(linhas).toEqual([
      { id: conhecido.id, acao: 'gaveta_aberta', descricao: 'Gaveta aberta', depois: { preco: '9.90' } },
      {
        id: novos[0]!.id,
        acao: ACAO_AUDITORIA_DESCONHECIDA,
        descricao: `[Ação do caixa desconhecida nesta versão da nuvem: "${original}"] Preço do item trocado pelo operador`,
        depois: { preco: '9.90' },
      },
      {
        id: novos[1]!.id,
        acao: ACAO_AUDITORIA_DESCONHECIDA,
        descricao: `[Ação do caixa desconhecida nesta versão da nuvem: "${original}"]`,
        depois: { preco: '9.90' },
      },
    ]);
    const [alerta] = await alertasAbertos();
    expect(alerta).toMatchObject({
      severidade: 'aviso',
      registro_id: terminalId,
      dados: { terminal_id: terminalId, acao: original, evento_id: e.evento_id, ocorrencias: 2 },
    });
    expect(alerta!.titulo).toContain(original);

    // O mesmo lote de novo (outro evento, mesmos ids de registro): idempotente, nem a auditoria nem o alerta somam.
    const repetido = evento('auditoria.registros', 1, { registros: novos, logins: [] });
    const r2 = await naEmpresa(() => pushTeste.receber(terminal(), lote([repetido])));
    expect(r2.resultados[0]).toMatchObject({ status: 'aplicado', resultado: { registros: 0 } });
    // Outro registro com a mesma ação soma as ocorrências no alerta aberto.
    const mais = evento('auditoria.registros', 1, { registros: [registro(original)], logins: [] });
    await naEmpresa(() => pushTeste.receber(terminal(), lote([mais])));
    const abertos = await alertasAbertos();
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.dados).toMatchObject({ ocorrencias: 3, ultimo_evento_id: mais.evento_id });
  });

  it('o "Ciente" no terminal fecha o alerta (ERP 12.4)', async () => {
    const det = await amb
      .http()
      .get(`/api/terminais/${terminalId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    expect(det.status).toBe(200);
    const alerta = (det.body.alertas as Array<{ id: string; tipo: string }>).find(
      (a) => a.tipo === ALERTA_AUDITORIA_ACAO_DESCONHECIDA,
    );
    expect(alerta).toBeDefined();
    const r = await amb
      .http()
      .post(`/api/terminais/${terminalId}/alertas/${alerta!.id}/resolver`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ resolucao: 'API atualizada para a versão do caixa' });
    expect(r.status).toBe(200);
    expect(await alertasAbertos()).toEqual([]);
  });

  it('a ação de 41 a 64 caracteres passa pelo banco, e só as primeiras 20 ações diferentes do lote abrem alerta', async () => {
    const longa = `acao_${'x'.repeat(59)}`; // 64: maior que a coluna `acao` (40), no limite do lote
    expect(longa).toHaveLength(64);
    const acoes = [
      longa,
      ...Array.from({ length: 20 }, (_, i) => `acao_futura_${String(i).padStart(2, '0')}`),
    ];
    const e = evento('auditoria.registros', 1, { registros: acoes.map((a) => registro(a)), logins: [] });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'aplicado', resultado: { registros: 21 } });
    const listadas = r.resultados[0]!.resultado?.acoes_desconhecidas as string[];
    expect([...listadas].sort()).toEqual([...acoes].sort());
    const linhas = await consultar<{ acao: string; descricao: string }>(
      emp.nomeBanco,
      'select acao, descricao from auditoria where evento_id = $1',
      [e.evento_id],
    );
    expect(linhas).toHaveLength(21);
    expect(linhas.every((l) => l.acao === ACAO_AUDITORIA_DESCONHECIDA)).toBe(true);
    expect(linhas.map((l) => l.descricao)).toContain(
      `[Ação do caixa desconhecida nesta versão da nuvem: "${longa}"] Preço do item trocado pelo operador`,
    );
    expect(ALERTAS_ACAO_DESCONHECIDA_POR_LOTE).toBe(20);
    const abertos = await consultar<{ acao: string; chave: string }>(
      emp.nomeBanco,
      `select dados ->> 'acao' as acao, chave_deduplicacao as chave from alertas
        where tipo = $1 and resolvido_em is null`,
      [ALERTA_AUDITORIA_ACAO_DESCONHECIDA],
    );
    expect(abertos).toHaveLength(ALERTAS_ACAO_DESCONHECIDA_POR_LOTE);
    // As 20 primeiras, na ordem do lote: a longa entra, com a chave inteira (cabe nos 150); a 21ª fica sem alerta.
    expect(abertos.map((a) => a.acao).sort()).toEqual(acoes.slice(0, 20).sort());
    expect(abertos.find((a) => a.acao === longa)?.chave).toBe(chaveAcaoDesconhecida(terminalId, longa));
  });

  it('a ação reservada ao servidor continua recusando o lote inteiro', async () => {
    const e = evento('auditoria.registros', 1, {
      registros: [
        registro('gaveta_aberta'),
        registro('terminal_revogado'),
        registro(ACAO_AUDITORIA_DESCONHECIDA),
      ],
      logins: [],
    });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e])));
    expect(r.resultados[0]).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(await linhaDoEvento(e.evento_id)).toMatchObject({
      erro: 'Ação de auditoria reservada ao servidor.',
      detalhes: { acoes: ['terminal_revogado', ACAO_AUDITORIA_DESCONHECIDA] },
    });
    expect(
      await consultar(emp.nomeBanco, 'select 1 from auditoria where evento_id = $1', [e.evento_id]),
    ).toEqual([]);
  });
});

describe('versão acima da maior conhecida', () => {
  // Por último: o evento fica no outbox do caixa esperando a API ser atualizada, e a sequência não avança.
  it('v3 é erro temporário SCHEMA_DESCONHECIDO (o PDV mais novo que a API) e não grava nada', async () => {
    const e3 = evento('teste.versionado', 3, { quantidade: 3, unidade: 'un', novo: true });
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([e3])));
    expect(r.resultados[0]).toMatchObject({
      status: 'erro_temporario',
      erro: { codigo: 'SCHEMA_DESCONHECIDO' },
    });
    expect(await consultar(emp.nomeBanco, 'select 1 from caixas where numero = 63')).toEqual([]);
    expect(
      await consultar(
        emp.nomeBanco,
        "select 1 from eventos_recebidos where evento_id = $1 and status = 'aplicado'",
        [e3.evento_id],
      ),
    ).toEqual([]);
  });
});
