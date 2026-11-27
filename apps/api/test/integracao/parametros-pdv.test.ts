/**
 * Parâmetros-PDV (Fase 3, F3-B12; ERP 9.3.1, 9.10, 10.3.9): os terminais abaixo da versão de cada chave, a trava dura
 * das chaves que mudam o preço ou o pagamento, o valor gravado fora da faixa nova e o "Nº da próxima venda" do caixa 0.
 */
import {
  CODIGO_TERMINAIS_DESATUALIZADOS,
  VERSAO_PDV_R4,
  type ChaveComTerminaisDesatualizados,
  type NumeracaoVendaErp,
  type RespostaTerminaisDesatualizados,
  type ValorConfiguracao,
} from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerConfiguracao } from '../../src/configuracoes/valores.js';
import type { DbEmpresa } from '../../src/tenancy/tenancy.js';
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

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let gerente: string;
let estoquista: string;
let soVer: string;
let loja1: string;
let loja2: string;
const terminal = { l1c1: '', l1c2: '', l2c1: '' };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const COMODATO = 'pdv.vasilhame_comodato';

async function criarCaixa(lojaId: string, numero: number, sistema = false): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, sistema) values ($1, $2, $3) returning id',
    [lojaId, numero, sistema],
  );
  return c!.id;
}

async function criarTerminal(lojaId: string, numero: number, versao: string | null, status = 'ativo') {
  const caixa = await criarCaixa(lojaId, numero);
  const [t] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into terminais (loja_id, caixa_id, ativado_em, status, versao_app)
     values ($1, $2, now(), $3, $4) returning id`,
    [lojaId, caixa, status, versao],
  );
  return t!.id;
}

const versao = (id: string, v: string | null) =>
  consultar(emp.nomeBanco, 'update terminais set versao_app = $2 where id = $1', [id, v]);

function gravar(token: string, valores: Record<string, unknown>, lojaId: string | null = null) {
  return amb.http().put('/api/configuracoes').set(bearer(token)).send({ lojaId, valores });
}

async function linhaComodato(lojaId: string | null): Promise<unknown> {
  const [l] = await consultar<{ valor: unknown }>(
    emp.nomeBanco,
    `select valor from configuracoes where chave = $1 and excluido_em is null
       and ${lojaId ? 'loja_id = $2' : 'loja_id is null and $2::uuid is null'}`,
    [COMODATO, lojaId],
  );
  return l?.valor;
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'gerente_b12', perfil: 'gerente', lojas: [loja1] });
  await criarUsuario(emp.nomeBanco, { login: 'estoquista_b12', perfil: 'estoquista', lojas: [loja1] });
  gerente = await amb.entrar(emp.codigo, 'gerente_b12', SENHA_TESTE);
  estoquista = await amb.entrar(emp.codigo, 'estoquista_b12', SENHA_TESTE);
  // Perfil personalizado só com "Configurações: Ver", sem "PDVs/Terminais: Ver".
  const [perfil] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into perfis (nome, descricao, chave_sistema) values ('so_ver_b12', 'teste', 'so_ver_b12') returning id",
  );
  await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
    perfil!.id,
    'configuracoes.ver',
  ]);
  await criarUsuario(emp.nomeBanco, { login: 'so_ver_b12', perfil: 'so_ver_b12', lojas: [loja1] });
  soVer = await amb.entrar(emp.codigo, 'so_ver_b12', SENHA_TESTE);
  terminal.l1c1 = await criarTerminal(loja1, 1, '0.13.0');
  terminal.l1c2 = await criarTerminal(loja1, 2, '0.10.0', 'revogado');
  terminal.l2c1 = await criarTerminal(loja2, 1, null);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('GET /configuracoes/terminais-desatualizados (F3-B12)', () => {
  const consultarChaves = (token: string, chave: string, lojaId?: string) =>
    amb
      .http()
      .get(
        `/api/configuracoes/terminais-desatualizados?chave=${encodeURIComponent(chave)}${lojaId ? `&lojaId=${lojaId}` : ''}`,
      )
      .set(bearer(token));

  it('lista por chave os ativos abaixo da versão (o revogado não conta, sem versão conta), na ordem pedida', async () => {
    const r = await consultarChaves(admin, `${COMODATO},pdv.exibe_estoque_busca`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { chaves } = r.body as RespostaTerminaisDesatualizados;
    expect(chaves.map((c) => c.chave)).toEqual([COMODATO, 'pdv.exibe_estoque_busca']);
    expect(chaves[0]).toMatchObject({ versaoMinima: VERSAO_PDV_R4, trava: true, outrasLojas: 0 });
    expect(chaves[0]!.terminais).toEqual([
      {
        id: terminal.l1c1,
        lojaNome: 'Loja 1 - Centro',
        numeroCaixa: 1,
        descricao: null,
        versaoApp: '0.13.0',
      },
      { id: terminal.l2c1, lojaNome: 'Loja 2 - Bairro', numeroCaixa: 1, descricao: null, versaoApp: null },
    ]);
    // O 0.13.0 já lê o saldo na busca (desde o 0.11.0): só o sem versão fica.
    expect(chaves[1]).toMatchObject({ versaoMinima: '0.11.0', trava: false });
    expect(chaves[1]!.terminais.map((t) => t.id)).toEqual([terminal.l2c1]);
  });

  it('com a loja, só os dela; as lojas fora do acesso só na contagem; a loja não permitida é 403', async () => {
    const daLoja = (await consultarChaves(admin, COMODATO, loja1)).body as RespostaTerminaisDesatualizados;
    expect(daLoja.chaves[0]!.terminais.map((t) => t.id)).toEqual([terminal.l1c1]);
    const r = await consultarChaves(gerente, COMODATO);
    expect(r.status).toBe(200);
    const doGerente = (r.body as RespostaTerminaisDesatualizados).chaves[0]!;
    expect(doGerente.terminais.map((t) => t.id)).toEqual([terminal.l1c1]);
    expect(doGerente.outrasLojas).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain('Loja 2');
    expect((await consultarChaves(gerente, COMODATO, loja2)).status).toBe(403);
    expect((await consultarChaves(estoquista, COMODATO)).status).toBe(403);
    expect((await consultarChaves(admin, 'pdv.troco_maximo')).status).toBe(422);
    // O que vem do protótipo do objeto não é chave com versão: 422, não 500 na comparação de versões.
    for (const c of ['toString', 'constructor', '__proto__', `${COMODATO},hasOwnProperty`])
      expect((await consultarChaves(admin, c)).status, c).toBe(422);
  });

  it('só com "Configurações: Ver" (sem "PDVs/Terminais: Ver"): os caixas das lojas permitidas só na contagem', async () => {
    const r = await consultarChaves(soVer, COMODATO);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as RespostaTerminaisDesatualizados).chaves[0]).toEqual({
      chave: COMODATO,
      versaoMinima: VERSAO_PDV_R4,
      trava: true,
      terminais: [],
      outrasLojas: 1,
      semDetalhes: 1,
    });
    expect(JSON.stringify(r.body)).not.toContain(terminal.l1c1);
    // Quem tem a permissão dos terminais recebe os detalhes, sem `semDetalhes`.
    const g = (await consultarChaves(gerente, COMODATO)).body as RespostaTerminaisDesatualizados;
    expect(g.chaves[0]!.semDetalhes).toBeUndefined();
  });
});

describe('trava dura por versão (F3-B12; plano da Fase 3 › Padrões)', () => {
  it('na empresa: recusa ligar com terminal ativo abaixo, com a lista e sem gravar; desligar sempre pode', async () => {
    const r = await gravar(admin, { [COMODATO]: true });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.codigo).toBe('REGRA_NEGOCIO');
    expect(r.body.detalhes.codigo).toBe(CODIGO_TERMINAIS_DESATUALIZADOS);
    const [c] = r.body.detalhes.chaves as ChaveComTerminaisDesatualizados[];
    expect(c!.chave).toBe(COMODATO);
    expect(c!.terminais.map((t) => t.id).sort()).toEqual([terminal.l1c1, terminal.l2c1].sort());
    expect(r.body.campos[COMODATO][0]).toContain(VERSAO_PDV_R4);
    expect(await linhaComodato(null)).toBeUndefined();
    // Quem só vê a loja 1 é barrado também pela loja 2 (a chave da empresa vale nela), que fica só na contagem.
    const g = await gravar(gerente, { [COMODATO]: true });
    expect(g.status).toBe(422);
    const [cg] = g.body.detalhes.chaves as ChaveComTerminaisDesatualizados[];
    expect(cg!.terminais.map((t) => t.id)).toEqual([terminal.l1c1]);
    expect(cg!.outrasLojas).toBe(1);
    expect(JSON.stringify(g.body)).not.toContain('Loja 2');
    // Desligar (o padrão) passa com os caixas antigos no ar.
    expect((await gravar(admin, { [COMODATO]: false })).status).toBe(200);
  });

  it('a loja com valor próprio desligado não conta para a empresa; o "Herdar" que liga é conferido', async () => {
    expect((await gravar(admin, { [COMODATO]: false }, loja2)).status).toBe(200);
    expect(await linhaComodato(loja2)).toBe(false);
    // O revogado da loja 1 (0.10.0) não conta; o ativo da loja 1 atualizado libera a empresa.
    await versao(terminal.l1c1, VERSAO_PDV_R4);
    expect((await gravar(admin, { [COMODATO]: true })).status).toBe(200);
    expect(await linhaComodato(null)).toBe(true);
    // A loja 2 voltando a herdar passaria a ligada com o caixa sem versão: recusado.
    const herdar = await gravar(admin, { [COMODATO]: null }, loja2);
    expect(herdar.status).toBe(422);
    expect(
      (herdar.body.detalhes.chaves as ChaveComTerminaisDesatualizados[])[0]!.terminais.map((t) => t.id),
    ).toEqual([terminal.l2c1]);
    expect((await gravar(admin, { [COMODATO]: true }, loja2)).status).toBe(422);
    expect(await linhaComodato(loja2)).toBe(false);
    // Regravar a empresa já ligada não é "ligar": nenhuma loja passa de desligada a ligada.
    expect((await gravar(admin, { [COMODATO]: true })).status).toBe(200);
  });

  it('o caixa em substituição (desativando) conta, o revogado não; a loja fora do acesso é 403', async () => {
    expect((await gravar(gerente, { [COMODATO]: null }, loja2)).status).toBe(403);
    const status = (s: string) =>
      consultar(emp.nomeBanco, 'update terminais set status = $2 where id = $1', [terminal.l2c1, s]);
    // O `desativando` continua vendendo durante a substituição (SYNC 3.4): segura a trava e aparece no aviso.
    await status('desativando');
    const desativando = await gravar(admin, { [COMODATO]: null }, loja2);
    expect(desativando.status).toBe(422);
    expect(
      (desativando.body.detalhes.chaves as ChaveComTerminaisDesatualizados[])[0]!.terminais.map((t) => t.id),
    ).toEqual([terminal.l2c1]);
    const aviso = await amb
      .http()
      .get(`/api/configuracoes/terminais-desatualizados?chave=${COMODATO}&lojaId=${loja2}`)
      .set(bearer(admin));
    expect((aviso.body as RespostaTerminaisDesatualizados).chaves[0]!.terminais.map((t) => t.id)).toEqual([
      terminal.l2c1,
    ]);
    expect(await linhaComodato(loja2)).toBe(false);
    await status('revogado');
    expect((await gravar(admin, { [COMODATO]: null }, loja2)).status).toBe(200);
    expect(await linhaComodato(loja2)).toBeUndefined();
    await status('ativo');
    // A chave sem trava só avisa: grava com o caixa antigo.
    expect((await gravar(admin, { 'pdv.orcamento_pdv': true })).status).toBe(200);
    expect((await gravar(admin, { [COMODATO]: false, 'pdv.orcamento_pdv': false })).status).toBe(200);
  });
});

describe('faixas da ERP 9.3.1: o valor já gravado fora da faixa (F3-B12)', () => {
  it('não vale (cai no nível seguinte), volta à parte para o aviso, e a gravação usa a faixa nova', async () => {
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'pdv.fonte_total', '120'::jsonb)`,
    );
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor)
       values ('loja', $1, 'pdv.dias_validade_cupom_troca', '3650'::jsonb),
              ('empresa', null, 'pdv.dias_validade_cupom_troca', '45'::jsonb)`,
      [loja1],
    );
    const lista = await amb.http().get('/api/configuracoes?grupos=pdv').set(bearer(admin));
    expect(lista.status).toBe(200);
    const fonte = (lista.body as ValorConfiguracao[]).find((v) => v.chave === 'pdv.fonte_total')!;
    expect(fonte.valor).toBe(36);
    expect(fonte.valorEmpresa).toBeUndefined();
    expect(fonte.foraDaFaixa).toEqual({ empresa: 120 });
    const daLoja = await amb.http().get(`/api/configuracoes?grupos=pdv&lojaId=${loja1}`).set(bearer(admin));
    const cupom = (daLoja.body as ValorConfiguracao[]).find(
      (v) => v.chave === 'pdv.dias_validade_cupom_troca',
    )!;
    // A loja fora da faixa herda a empresa (45), e não o padrão.
    expect(cupom).toMatchObject({ valor: 45, valorEmpresa: 45, foraDaFaixa: { loja: 3650 } });
    expect(cupom.valorLoja).toBeUndefined();
    // A leitura do servidor (`lerConfiguracoes`, a que os blocos da nuvem usam) dá o mesmo efetivo da listagem.
    const c = await conectar(emp.nomeBanco);
    try {
      const db = drizzle(c) as unknown as DbEmpresa;
      expect(await lerConfiguracao(db, 'pdv.fonte_total')).toBe(36);
      expect(await lerConfiguracao(db, 'pdv.dias_validade_cupom_troca', loja1)).toBe(45);
      expect(await lerConfiguracao(db, 'pdv.dias_validade_cupom_troca')).toBe(45);
    } finally {
      await c.end();
    }
    const recusa = await gravar(admin, { 'pdv.fonte_total': 120 });
    expect(recusa.status).toBe(422);
    expect(recusa.body.campos['pdv.fonte_total']).toBeDefined();
    const ok = await gravar(admin, { 'pdv.fonte_total': 72 });
    expect(ok.status).toBe(200);
    const depois = (ok.body as ValorConfiguracao[]).find((v) => v.chave === 'pdv.fonte_total')!;
    expect(depois).toMatchObject({ valor: 72, valorEmpresa: 72 });
    expect(depois.foraDaFaixa).toBeUndefined();
  });
});

describe('Nº da próxima venda do ERP (ERP 9.10; F3-B12)', () => {
  const url = (lojaId: string) => `/api/lojas/${lojaId}/numeracao-venda-erp`;
  const ultimo = async (lojaId: string) =>
    Number(
      (
        await consultar<{ n: string }>(
          emp.nomeBanco,
          `select n.ultimo_numero::text as n from numeracoes n join caixas c on c.id = n.caixa_id
            where n.tipo = 'venda' and c.loja_id = $1 and c.sistema and n.excluido_em is null`,
          [lojaId],
        )
      )[0]?.n ?? -1,
    );
  const auditorias = async (proximo: number) =>
    (
      await consultar(
        emp.nomeBanco,
        `select 1 from auditoria where entidade = 'numeracoes' and acao = 'editar'
            and (depois->>'proximo_numero')::bigint = $1`,
        [proximo],
      )
    ).length;

  beforeAll(async () => {
    // O caixa 0 das duas lojas, sem a numeração (a loja de antes do assistente): a gravação cria a linha.
    await criarCaixa(loja1, 0, true);
    await criarCaixa(loja2, 0, true);
  });

  it('só com "Numeração própria"; recusa ≤ último usado; repetir o próximo não grava; auditado', async () => {
    const r0 = await amb.http().get(url(loja1)).set(bearer(admin));
    expect(r0.status, JSON.stringify(r0.body)).toBe(200);
    expect(r0.body as NumeracaoVendaErp).toEqual({
      lojaId: loja1,
      ultimoNumero: 0,
      proximoNumero: 1,
      numeracaoPropria: false,
    });
    const sem = await amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: 100 });
    expect(sem.status).toBe(422);
    expect(sem.body.codigo).toBe('REGRA_NEGOCIO');
    expect(await ultimo(loja1)).toBe(-1);
    expect((await gravar(admin, { 'vendas.numeracao_propria': true })).status).toBe(200);
    const ok = await amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: 100 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ lojaId: loja1, ultimoNumero: 99, proximoNumero: 100, numeracaoPropria: true });
    expect(await ultimo(loja1)).toBe(99);
    expect(await auditorias(100)).toBe(1);
    for (const v of [99, 50]) {
      const r = await amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: v });
      expect(r.status).toBe(422);
      expect(r.body.campos.proximoNumero[0]).toContain('99');
    }
    expect((await amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: 100 })).status).toBe(
      200,
    );
    expect(await auditorias(100)).toBe(1);
    expect((await amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: 0 })).status).toBe(422);
    expect(await ultimo(loja1)).toBe(99);
  });

  it('a corrida fica em fila pela linha do contador: o mesmo número grava uma vez, o menor perde', async () => {
    const iguais = await Promise.all(
      [1, 2].map(() => amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: 1000 })),
    );
    expect(iguais.map((r) => r.status)).toEqual([200, 200]);
    expect(await auditorias(1000)).toBe(1);
    const corrida = await Promise.all(
      [5000, 2000].map((v) => amb.http().put(url(loja1)).set(bearer(admin)).send({ proximoNumero: v })),
    );
    // Em qualquer ordem, o contador termina no maior: o 2000 depois do 5000 é recusado (≤ 4999).
    expect(await ultimo(loja1)).toBe(4999);
    expect(corrida[0]!.status).toBe(200);
    expect([200, 422]).toContain(corrida[1]!.status);
  });

  it('loja fora do acesso 403; sem permissão de configurações 403; a outra loja tem a própria sequência', async () => {
    expect((await amb.http().get(url(loja2)).set(bearer(gerente))).status).toBe(403);
    expect((await amb.http().put(url(loja2)).set(bearer(gerente)).send({ proximoNumero: 10 })).status).toBe(
      403,
    );
    expect((await amb.http().get(url(loja1)).set(bearer(estoquista))).status).toBe(403);
    const g = await amb.http().put(url(loja2)).set(bearer(admin)).send({ proximoNumero: 10 });
    expect(g.status).toBe(200);
    expect(await ultimo(loja2)).toBe(9);
    expect(await ultimo(loja1)).toBe(4999);
  });

  it('o contador atrás da maior venda do caixa 0: o último usado é a venda, e o próximo exibido regrava', async () => {
    // Uma venda do caixa 0 da loja 2 acima do contador (9): o contador ficou para trás.
    await consultar(
      emp.nomeBanco,
      `insert into vendas (numero, numero_exibicao, loja_id, caixa_id, numero_caixa, tipo, operador_id, iniciada_em)
       select 5000, '5000', $1, c.id, 0, 'venda', (select id from usuarios where login = 'admin'), now()
         from caixas c where c.loja_id = $1 and c.sistema`,
      [loja2],
    );
    const r = await amb.http().get(url(loja2)).set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body as NumeracaoVendaErp).toMatchObject({ ultimoNumero: 5000, proximoNumero: 5001 });
    for (const v of [5000, 10, 4000]) {
      const recusa = await amb.http().put(url(loja2)).set(bearer(admin)).send({ proximoNumero: v });
      expect(recusa.status, String(v)).toBe(422);
      expect(recusa.body.campos.proximoNumero[0]).toContain('5000');
    }
    expect(await ultimo(loja2)).toBe(9);
    // Gravar o próximo exibido (5001) acerta o contador, mesmo sem mudar o número que a tela mostrava, e audita.
    const ok = await amb.http().put(url(loja2)).set(bearer(admin)).send({ proximoNumero: 5001 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ultimoNumero: 5000, proximoNumero: 5001 });
    expect(await ultimo(loja2)).toBe(5000);
    expect(await auditorias(5001)).toBe(1);
    expect(await ultimo(loja1)).toBe(4999);
  });
});
