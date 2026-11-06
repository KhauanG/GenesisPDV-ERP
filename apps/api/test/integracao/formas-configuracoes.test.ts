/** Formas de pagamento (ERP 10.2), Configurações › Geral/PDV e atalhos do PDV (ERP 9.1, 9.3.1, 9.9). */
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

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let loja1: string;
let loja2: string;
let gerente: string;
let vendedor: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2');
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'gerente', perfil: 'gerente', lojas: [loja1] });
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja1] });
  gerente = await amb.entrar(emp.codigo, 'gerente', SENHA_TESTE);
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('Formas de pagamento (ERP 10.2)', () => {
  it('lista o seed (13 formas, 9 ativas: VA/VR nascem inativas, O9a) e filtra por uso, situação e loja', async () => {
    const todas = await amb.http().get('/api/formas-pagamento?situacao=todos&tamanho=50').set(bearer(admin));
    expect(todas.status).toBe(200);
    expect(todas.body.total).toBe(13);
    const ativas = await amb.http().get('/api/formas-pagamento?tamanho=50').set(bearer(admin));
    expect(ativas.body.total).toBe(9);
    expect(ativas.body.itens[0]).toMatchObject({
      descricao: 'Dinheiro',
      ordem: 1,
      tipoForma: 'dinheiro',
      usaPdv: true,
      lojas: [],
    });
  });

  it('cria com senha de liberação (hash, nunca devolvido), valida as regras do MD 3.10.1 e o meio fiscal ativo', async () => {
    const opcoes = await amb.http().get('/api/formas-pagamento/opcoes').set(bearer(admin));
    expect(
      opcoes.body.meiosFiscais.some((m: { codigo: string; ativo: boolean }) => m.codigo === '14' && !m.ativo),
    ).toBe(true);
    const receita = opcoes.body.planosContas.find((p: { tipo: string }) => p.tipo === 'receita');
    const r = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({
        descricao: 'Ticket Loja 1',
        tipoForma: 'vale_refeicao',
        meioPagamentoFiscal: '11',
        integracao: 'pos_externo',
        exigeDadosPos: true,
        lojaIds: [loja1],
        taxaPct: '3,5',
        diasRecebimento: 30,
        planoContasId: receita.id,
        senhaLiberacao: 'segredo1',
        restringeIdadeMinima: true,
        lancaQuitada: false,
      });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ taxaPct: '3.5000', senhaLiberacaoDefinida: true, lojaIds: [loja1] });
    expect(JSON.stringify(r.body)).not.toMatch(/argon2|Hash/);
    const [h] = await consultar<{ h: string }>(
      emp.nomeBanco,
      'select senha_liberacao_hash as h from formas_pagamento where id = $1',
      [r.body.id],
    );
    expect(h!.h).toMatch(/^\$argon2id\$/);

    const invalida = await amb.http().post('/api/formas-pagamento').set(bearer(admin)).send({
      descricao: 'Errada',
      meioPagamentoFiscal: '99',
      integracao: 'tef',
      aPrazo: true,
      permiteParcelar: false,
      parcelasMaximo: 3,
    });
    expect(invalida.status).toBe(422);
    expect(Object.keys(invalida.body.campos).sort()).toEqual([
      'aPrazo',
      'descricaoFiscal',
      'parcelasMaximo',
      'tipoPinpad',
    ]);
    const inativo = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({ descricao: 'Duplicata', meioPagamentoFiscal: '14' });
    expect(inativo.status).toBe(422);
    expect(inativo.body.campos.meioPagamentoFiscal[0]).toContain('não vale mais');
    const dup = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({ descricao: 'DINHEIRO', meioPagamentoFiscal: '01' });
    expect(dup.status).toBe(409);
    // A descrição é única na empresa desde a 1C (C8b): a forma vale em várias lojas.
    const outraLoja = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({ descricao: 'Ticket Loja 1', meioPagamentoFiscal: '11', lojaIds: [loja2] });
    expect(outraLoja.status).toBe(409);
    const daLoja2 = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({ descricao: 'Ticket Loja 2', meioPagamentoFiscal: '11', lojaIds: [loja2] });
    expect(daLoja2.status).toBe(201);
  });

  it('filtro de loja: gerente da loja 1 não vê a forma da loja 2 (403 no detalhe) e não grava nela', async () => {
    const lista = await amb
      .http()
      .get('/api/formas-pagamento?situacao=todos&tamanho=50')
      .set(bearer(gerente));
    const nomes = lista.body.itens.map((f: { descricao: string; lojas: Array<{ id: string }> }) => [
      f.descricao,
      f.lojas.map((l) => l.id),
    ]);
    expect(nomes.filter(([, l]: [string, string[]]) => l.includes(loja2))).toEqual([]);
    expect(
      nomes.some(([d, l]: [string, string[]]) => d === 'Ticket Loja 1' && l.length === 1 && l[0] === loja1),
    ).toBe(true);
    const [daLoja2] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'select forma_pagamento_id as id from formas_pagamento_lojas where loja_id = $1',
      [loja2],
    );
    expect((await amb.http().get(`/api/formas-pagamento/${daLoja2!.id}`).set(bearer(gerente))).status).toBe(
      403,
    );
    const criar = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(gerente))
      .send({ descricao: 'X', meioPagamentoFiscal: '01', lojaIds: [loja2] });
    expect(criar.status).toBe(403);
    expect((await amb.http().get('/api/formas-pagamento').set(bearer(vendedor))).status).toBe(403);
  });

  it('altera com versão (409 com versão velha); consumo interno exige conta de despesa', async () => {
    const [f] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from formas_pagamento where descricao = 'Avarias'",
    );
    const d = await amb.http().get(`/api/formas-pagamento/${f!.id}`).set(bearer(admin));
    const {
      id: _i,
      criadoEm: _c,
      atualizadoEm: _a,
      atualizadoPorNome: _n,
      senhaLiberacaoDefinida: _s,
      ...corpo
    } = d.body;
    const receita = (
      await amb.http().get('/api/formas-pagamento/opcoes').set(bearer(admin))
    ).body.planosContas.find((p: { tipo: string }) => p.tipo === 'receita');
    const errada = await amb
      .http()
      .put(`/api/formas-pagamento/${f!.id}`)
      .set(bearer(admin))
      .send({ ...corpo, planoContasId: receita.id });
    expect(errada.status).toBe(422);
    expect(errada.body.campos.planoContasId).toEqual(['Consumo interno lança em conta de despesa']);
    const r = await amb
      .http()
      .put(`/api/formas-pagamento/${f!.id}`)
      .set(bearer(admin))
      .send({ ...corpo, ativa: true });
    expect(r.status).toBe(200);
    expect(r.body.ativa).toBe(true);
    const velho = await amb.http().put(`/api/formas-pagamento/${f!.id}`).set(bearer(admin)).send(corpo);
    expect(velho.status).toBe(409);
  });
});

describe('Configurações (ERP 9.0, 9.1, 9.3.1, 9.9)', () => {
  it('lê padrões, grava só o que difere do padrão e audita antes/depois', async () => {
    const lidas = await amb.http().get('/api/configuracoes?grupos=geral,pdv').set(bearer(admin));
    expect(lidas.status).toBe(200);
    const margem = lidas.body.find((c: { chave: string }) => c.chave === 'geral.margem_lucro_pct');
    expect(margem).toMatchObject({ valor: '0', padrao: '0', loja: false });
    const r = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({
        valores: {
          'geral.margem_lucro_pct': '30',
          'pdv.fechamento_cego': true,
          'pdv.valor_limite_sangria': '1500.00',
        },
      });
    expect(r.status).toBe(200);
    const linhas = await consultar<{ chave: string; valor: unknown }>(
      emp.nomeBanco,
      "select chave, valor from configuracoes where escopo = 'empresa' and excluido_em is null and chave <> 'fiscal.regime' order by chave",
    );
    // `pdv.fechamento_cego = true` é o padrão: não vira linha.
    expect(linhas).toEqual([
      { chave: 'geral.margem_lucro_pct', valor: '30' },
      { chave: 'pdv.valor_limite_sangria', valor: '1500.00' },
    ]);
    const [aud] = await consultar(
      emp.nomeBanco,
      "select antes, depois from auditoria where entidade = 'configuracoes' order by ocorrido_em desc limit 1",
    );
    expect(aud).toEqual({
      antes: { 'geral.margem_lucro_pct': null, 'pdv.valor_limite_sangria': null },
      depois: { 'geral.margem_lucro_pct': '30', 'pdv.valor_limite_sangria': '1500.00' },
    });
    // Voltar ao padrão exclui a linha logicamente.
    await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ valores: { 'geral.margem_lucro_pct': '0' } });
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from configuracoes where chave = 'geral.margem_lucro_pct' and excluido_em is null",
    );
    expect(n!.n).toBe(0);
  });

  it('valida pelo catálogo (422 por chave), loja só nas chaves Loja = S, fiscal exige editar_fiscal', async () => {
    const r = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ valores: { 'pdv.dias_max_offline': 0, 'geral.tipo_balanca': 'kg', 'nao.existe': 1 } });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual([
      'geral.tipo_balanca',
      'nao.existe',
      'pdv.dias_max_offline',
    ]);
    const loja = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ lojaId: loja1, valores: { 'geral.margem_lucro_pct': '10' } });
    expect(loja.status).toBe(422);
    const fiscal = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(gerente))
      .send({ valores: { 'fiscal.nfe_serie': 2 } });
    expect(fiscal.status).toBe(403);
  });

  it('sobreposição por loja: valor da loja prevalece, outras lojas herdam; loja fora do acesso → 403', async () => {
    await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ valores: { 'pdv.valor_limite_sangria': '1500.00' } });
    const r = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ lojaId: loja1, valores: { 'pdv.valor_limite_sangria': '800.00' } });
    expect(r.status).toBe(200);
    const c = r.body.find((x: { chave: string }) => x.chave === 'pdv.valor_limite_sangria');
    expect(c).toMatchObject({
      valor: '800.00',
      valorEmpresa: '1500.00',
      valorLoja: '800.00',
      lojasSobrepondo: 1,
    });
    const l2 = await amb.http().get(`/api/configuracoes?grupos=pdv&lojaId=${loja2}`).set(bearer(admin));
    expect(l2.body.find((x: { chave: string }) => x.chave === 'pdv.valor_limite_sangria').valor).toBe(
      '1500.00',
    );
    expect(
      (await amb.http().get(`/api/configuracoes?grupos=pdv&lojaId=${loja2}`).set(bearer(gerente))).status,
    ).toBe(403);
    // Herdar = null.
    await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer(admin))
      .send({ lojaId: loja1, valores: { 'pdv.valor_limite_sangria': null } });
    const l1 = await amb.http().get(`/api/configuracoes?grupos=pdv&lojaId=${loja1}`).set(bearer(admin));
    expect(
      l1.body.find((x: { chave: string }) => x.chave === 'pdv.valor_limite_sangria').valorLoja,
    ).toBeUndefined();
  });

  it('atalhos: tecla única entre habilitados, troca de teclas numa gravação, teclas proibidas, restaurar padrão', async () => {
    const lista = await amb.http().get('/api/atalhos-pdv').set(bearer(admin));
    expect(lista.status).toBe(200);
    const itens = lista.body.map(({ acao, tecla, habilitado, ordem }: Record<string, unknown>) => ({
      acao,
      tecla,
      habilitado,
      ordem,
    }));
    const idx = (a: string) => itens.findIndex((i: { acao: string }) => i.acao === a);
    // Troca F2 ↔ F4 entre pesquisar_produto e remover_item na mesma gravação.
    itens[idx('pesquisar_produto')].tecla = 'f4';
    itens[idx('remover_item')].tecla = 'F2';
    const troca = await amb.http().put('/api/atalhos-pdv').set(bearer(admin)).send({ itens });
    expect(troca.status).toBe(200);
    expect(troca.body.find((a: { acao: string }) => a.acao === 'pesquisar_produto').tecla).toBe('F4');
    const repetida = itens.map((i: { acao: string }) =>
      i.acao === 'tabela_precos' ? { ...i, tecla: 'F4' } : i,
    );
    const r = await amb.http().put('/api/atalhos-pdv').set(bearer(admin)).send({ itens: repetida });
    expect(r.status).toBe(422);
    expect(Object.values(r.body.campos).flat()[0]).toContain('pesquisar_produto');
    const proibida = await amb
      .http()
      .put('/api/atalhos-pdv')
      .set(bearer(admin))
      .send({ itens: [{ ...itens[0], tecla: 'Alt+F4' }] });
    expect(proibida.status).toBe(422);
    const shift = await amb
      .http()
      .put('/api/atalhos-pdv')
      .set(bearer(admin))
      .send({ itens: [{ ...itens[0], tecla: 'Shift+A' }] });
    expect(shift.status).toBe(422);
    expect((await amb.http().put('/api/atalhos-pdv').set(bearer(vendedor)).send({ itens })).status).toBe(403);
    const padrao = await amb.http().post('/api/atalhos-pdv/restaurar-padrao').set(bearer(admin));
    expect(padrao.status).toBe(200);
    expect(padrao.body.find((a: { acao: string }) => a.acao === 'pesquisar_produto').tecla).toBe('F2');
  });
});
