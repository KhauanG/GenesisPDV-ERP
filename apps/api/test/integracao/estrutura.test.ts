/** Empresa, lojas (assistente de primeira configuração), caixas e locais de estoque (ERP 10.1, 10.3, 13.2; MD 7.13). */
import { completarCnpj } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const endereco = {
  cep: '80010-000',
  logradouro: 'Rua XV de Novembro',
  numero: '100',
  bairro: 'Centro',
  uf: 'PR',
  municipioIbge: 4106902,
};

const novaLoja = (nome: string, extra: Record<string, unknown> = {}) => ({
  nome,
  razaoSocial: `${nome} Ltda`,
  nomeFantasia: nome,
  cnpj: completarCnpj(`${Math.floor(Math.random() * 1e12)}`.padStart(12, '1')),
  ...endereco,
  ...extra,
});

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  // Plano de teste com 3 lojas ativas.
  await consultar(amb.bancoControle, 'update empresas set limite_lojas = 3 where codigo = $1', [emp.codigo]);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('Empresa (ERP 10.1)', () => {
  it('altera com versão, replica razão social/fantasia/CNPJ para o controle e devolve 409 com versão velha', async () => {
    const atual = await amb.http().get('/api/empresa').set(bearer(admin));
    expect(atual.status).toBe(200);
    const corpo = {
      versao: atual.body.versao,
      razaoSocial: 'Ice Beer Comércio de Bebidas Ltda',
      nomeFantasia: 'Ice Beer',
      cnpj: atual.body.cnpj,
      ...endereco,
      emailContador: 'contador@exemplo.com; fiscal@exemplo.com',
    };
    const r = await amb.http().put('/api/empresa').set(bearer(admin)).send(corpo);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      nomeFantasia: 'Ice Beer',
      municipioNome: 'Curitiba',
      emailContador: 'contador@exemplo.com, fiscal@exemplo.com',
    });
    const [ctl] = await consultar(
      amb.bancoControle,
      'select razao_social, nome_fantasia from empresas where codigo = $1',
      [emp.codigo],
    );
    expect(ctl).toEqual({ razao_social: 'Ice Beer Comércio de Bebidas Ltda', nome_fantasia: 'Ice Beer' });

    const velho = await amb.http().put('/api/empresa').set(bearer(admin)).send(corpo);
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
    expect(velho.body.detalhes.alteradoPorNome).toBe('ADMINISTRADOR');
  });

  it('valida CNPJ, cidade x UF e e-mails (422)', async () => {
    const atual = await amb.http().get('/api/empresa').set(bearer(admin));
    const r = await amb
      .http()
      .put('/api/empresa')
      .set(bearer(admin))
      .send({
        versao: atual.body.versao,
        razaoSocial: 'X',
        nomeFantasia: 'X',
        cnpj: '11.111.111/1111-11',
        ...endereco,
        emailContador: 'a@b.com, nao-email',
      });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual(['cnpj', 'emailContador']);
    const uf = await amb
      .http()
      .put('/api/empresa')
      .set(bearer(admin))
      .send({
        versao: atual.body.versao,
        razaoSocial: 'X',
        nomeFantasia: 'X',
        cnpj: atual.body.cnpj,
        ...endereco,
        uf: 'SP',
      });
    expect(uf.status).toBe(422);
    expect(uf.body.campos.municipioIbge).toEqual(['A cidade não é da UF SP']);
  });
});

describe('Lojas – assistente de primeira configuração (MD 7.13)', () => {
  let loja1: string;

  it('cria estoque homônimo, caixa 0, conta "Caixa – loja" e numerações na mesma transação', async () => {
    const r = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send(novaLoja('Loja 1 - Hermes', { nfeSerie: 1 }));
    expect(r.status).toBe(201);
    loja1 = r.body.id;
    expect(r.body).toMatchObject({
      codigo: 1,
      estoqueNome: 'Loja 1 - Hermes',
      municipioNome: 'Curitiba',
      nfeProximoNumero: 1,
    });
    expect(r.body.contaCaixaId).toBeTruthy();
    const caixas = await consultar(emp.nomeBanco, 'select numero, sistema from caixas where loja_id = $1', [
      loja1,
    ]);
    expect(caixas).toEqual([{ numero: 0, sistema: true }]);
    const [conta] = await consultar(
      emp.nomeBanco,
      'select descricao, tipo, chave_sistema from contas_correntes where id = $1',
      [r.body.contaCaixaId],
    );
    expect(conta).toEqual({
      descricao: 'Caixa – Loja 1 - Hermes',
      tipo: 'caixa',
      chave_sistema: `caixa_loja:${loja1}`,
    });
    const nums = await consultar(
      emp.nomeBanco,
      'select tipo, dono, serie, modelo from numeracoes where loja_id = $1 order by tipo',
      [loja1],
    );
    expect(nums).toEqual([
      { tipo: 'nfe', dono: 'nuvem', serie: 1, modelo: 55 },
      { tipo: 'venda', dono: 'nuvem', serie: null, modelo: null },
    ]);
    const [aud] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where entidade = 'lojas' and acao = 'criar' and registro_id = $1",
      [loja1],
    );
    expect(aud!.n).toBe(1);
  });

  it('cria o CD como loja depósito ligada a um estoque "deposito" já existente', async () => {
    const e = await amb
      .http()
      .post('/api/estoques')
      .set(bearer(admin))
      .send({ nome: 'CD - Estoque Ice Beer', tipo: 'deposito' });
    expect(e.status).toBe(201);
    const pdv = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send(novaLoja('CD Ice Beer', { tipo: 'deposito', estoqueId: e.body.id }));
    expect(pdv.status).toBe(422);
    expect(pdv.body.campos.usaPdv).toEqual(['Depósito/CD não usa PDV']);
    const cd = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send(novaLoja('CD Ice Beer', { tipo: 'deposito', usaPdv: false, estoqueId: e.body.id }));
    expect(cd.status).toBe(201);
    expect(cd.body).toMatchObject({ tipo: 'deposito', estoqueId: e.body.id, tipoEmissao: 'nao_fiscal' });
    const estoque = await amb.http().get(`/api/estoques/${e.body.id}`).set(bearer(admin));
    expect(estoque.body).toMatchObject({ lojaNome: 'CD Ice Beer', tipo: 'deposito' });
    // Estoque já vinculado não serve para outra loja.
    const outra = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send(novaLoja('Loja X', { estoqueId: e.body.id }));
    expect(outra.status).toBe(409);
    expect(outra.body.campos.estoqueId[0]).toContain('CD Ice Beer');
    const caixa = await amb
      .http()
      .post(`/api/lojas/${cd.body.id}/caixas`)
      .set(bearer(admin))
      .send({ numero: 1 });
    expect(caixa.status).toBe(422);
  });

  it('nome/CNPJ repetidos → 409 por campo; limite do plano → LIMITE_PLANO', async () => {
    const [l] = await consultar<{ cnpj: string }>(emp.nomeBanco, 'select cnpj from lojas where id = $1', [
      loja1,
    ]);
    const dup = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send({ ...novaLoja('LOJA 1 - HERMES'), cnpj: l!.cnpj });
    expect(dup.status).toBe(409);
    expect(Object.keys(dup.body.campos).sort()).toEqual(['cnpj', 'nome']);
    const terceira = await amb.http().post('/api/lojas').set(bearer(admin)).send(novaLoja('Loja 3'));
    expect(terceira.status).toBe(201);
    const quarta = await amb.http().post('/api/lojas').set(bearer(admin)).send(novaLoja('Loja 4'));
    expect(quarta.status).toBe(422);
    expect(quarta.body.codigo).toBe('LIMITE_PLANO');
    expect(quarta.body.mensagem).toContain('3 lojas ativas');
    const inativa = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(admin))
      .send(novaLoja('Loja 4', { ativa: false }));
    expect(inativa.status).toBe(201);
  });

  it('altera com versão (409 com versão velha) e lista com estoque e caixas ativos', async () => {
    const d = await amb.http().get(`/api/lojas/${loja1}`).set(bearer(admin));
    const {
      id: _i,
      codigo: _c,
      estoqueNome: _e,
      municipioNome: _m,
      contaCaixaId: _cc,
      nfeProximoNumero: _n,
      criadoEm: _cr,
      atualizadoEm: _a,
      atualizadoPorNome: _ap,
      logotipoArquivoId: _l,
      fotoArquivoId: _f,
      ...corpo
    } = d.body;
    const r = await amb
      .http()
      .put(`/api/lojas/${loja1}`)
      .set(bearer(admin))
      .send({ ...corpo, fraseRodapeCupom: 'Volte sempre!' });
    expect(r.status).toBe(200);
    expect(r.body.fraseRodapeCupom).toBe('Volte sempre!');
    const velho = await amb.http().put(`/api/lojas/${loja1}`).set(bearer(admin)).send(corpo);
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
    const lista = await amb.http().get('/api/lojas?nome=hermes').set(bearer(admin));
    expect(lista.body.itens).toHaveLength(1);
    expect(lista.body.itens[0]).toMatchObject({
      nome: 'Loja 1 - Hermes',
      estoqueNome: 'Loja 1 - Hermes',
      caixasAtivos: 0,
    });
  });

  describe('caixas (ERP 10.3.10)', () => {
    it('cria caixa com numerações venda/vale/nfce, série única na loja e nº inicial antes do terminal', async () => {
      const r = await amb
        .http()
        .post(`/api/lojas/${loja1}/caixas`)
        .set(bearer(admin))
        .send({ numero: 1, descricao: 'Caixa balcão', nfceSerie: 11, nfceNumeroInicial: 501 });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        numero: 1,
        nfceSerie: 11,
        nfceUltimoNumero: 500,
        jaTeveTerminal: false,
        sistema: false,
      });
      const nums = await consultar(
        emp.nomeBanco,
        'select tipo, dono, ambiente from numeracoes where caixa_id = $1 order by tipo',
        [r.body.id],
      );
      expect(nums).toEqual([
        { tipo: 'nfce', dono: 'terminal', ambiente: 2 },
        { tipo: 'vale', dono: 'terminal', ambiente: null },
        { tipo: 'venda', dono: 'terminal', ambiente: null },
      ]);
      const serie = await amb
        .http()
        .post(`/api/lojas/${loja1}/caixas`)
        .set(bearer(admin))
        .send({ numero: 2, nfceSerie: 11 });
      expect(serie.status).toBe(409);
      expect(serie.body.campos.nfceSerie[0]).toContain('caixa 1');
      const zero = await amb.http().post(`/api/lojas/${loja1}/caixas`).set(bearer(admin)).send({ numero: 0 });
      expect(zero.status).toBe(422);
      const lista = await amb.http().get(`/api/lojas/${loja1}/caixas`).set(bearer(admin));
      expect(lista.body.map((c: { numero: number }) => c.numero)).toEqual([0, 1]);
      const c0 = lista.body[0];
      const sistema = await amb
        .http()
        .put(`/api/lojas/${loja1}/caixas/${c0.id}`)
        .set(bearer(admin))
        .send({ versao: c0.versao });
      expect(sistema.status).toBe(422);
      const velho = await amb
        .http()
        .put(`/api/lojas/${loja1}/caixas/${r.body.id}`)
        .set(bearer(admin))
        .send({ versao: r.body.versao - 1 });
      expect(velho.status).toBe(409);
    });
  });
});

describe('Permissões e lojas permitidas', () => {
  let tokenGerente: string;
  let loja1: string;
  let loja3: string;

  beforeAll(async () => {
    const lojas = await consultar<{ id: string; nome: string }>(
      emp.nomeBanco,
      'select id, nome from lojas order by codigo',
    );
    loja1 = lojas.find((l) => l.nome === 'Loja 1 - Hermes')!.id;
    loja3 = lojas.find((l) => l.nome === 'Loja 3')!.id;
    await criarUsuario(emp.nomeBanco, { login: 'gerente1', perfil: 'gerente', lojas: [loja1] });
    await criarUsuario(emp.nomeBanco, { login: 'vendedor1', perfil: 'vendedor', lojas: [loja1] });
    tokenGerente = await amb.entrar(emp.codigo, 'gerente1', SENHA_TESTE);
  });

  it('lista só as lojas permitidas; loja fora → 403; caixas da loja fora → 403', async () => {
    const r = await amb.http().get('/api/lojas').set(bearer(tokenGerente));
    expect(r.body.itens.map((l: { id: string }) => l.id)).toEqual([loja1]);
    expect((await amb.http().get(`/api/lojas/${loja3}`).set(bearer(tokenGerente))).status).toBe(403);
    expect((await amb.http().get(`/api/lojas/${loja3}/caixas`).set(bearer(tokenGerente))).status).toBe(403);
    // O estoque da loja fora do acesso não aparece; o CD (sem loja permitida? vinculado ao CD) também some.
    const estoques = await amb.http().get('/api/estoques?situacao=todos').set(bearer(tokenGerente));
    expect(estoques.body.itens.map((e: { nome: string }) => e.nome)).toEqual(['Loja 1 - Hermes']);
  });

  it('sem a permissão → 403 (vendedor não vê lojas nem estoques; gerente não edita a empresa)', async () => {
    const vendedor = await amb.entrar(emp.codigo, 'vendedor1', SENHA_TESTE);
    expect((await amb.http().get('/api/lojas').set(bearer(vendedor))).status).toBe(403);
    expect((await amb.http().post('/api/estoques').set(bearer(vendedor)).send({ nome: 'X' })).status).toBe(
      403,
    );
    const emp1 = await amb.http().get('/api/empresa').set(bearer(admin));
    const r = await amb.http().put('/api/empresa').set(bearer(vendedor)).send({ versao: emp1.body.versao });
    expect(r.status).toBe(403);
  });
});

describe('Locais de estoque (ERP 13.2)', () => {
  it('nome único (409), inativar com loja ativa vinculada é recusado, exclusão lógica', async () => {
    const dup = await amb
      .http()
      .post('/api/estoques')
      .set(bearer(admin))
      .send({ nome: 'cd - estoque ice beer' });
    expect(dup.status).toBe(409);
    const [vinc] = await consultar<{ id: string; versao: string }>(
      emp.nomeBanco,
      "select e.id, e.versao from estoques e join lojas l on l.estoque_id = e.id where l.nome = 'Loja 3'",
    );
    const inativar = await amb
      .http()
      .put(`/api/estoques/${vinc!.id}`)
      .set(bearer(admin))
      .send({ nome: 'Loja 3', tipo: 'loja', ativo: false, versao: Number(vinc!.versao) });
    expect(inativar.status).toBe(422);
    expect(inativar.body.campos.ativo).toEqual(['Vinculado a loja ativa']);
    const livre = await amb
      .http()
      .post('/api/estoques')
      .set(bearer(admin))
      .send({ nome: 'Avarias', tipo: 'outro' });
    expect((await amb.http().delete(`/api/estoques/${livre.body.id}`).set(bearer(admin))).status).toBe(204);
    expect((await amb.http().get(`/api/estoques/${livre.body.id}`).set(bearer(admin))).status).toBe(404);
    expect((await amb.http().delete(`/api/estoques/${vinc!.id}`).set(bearer(admin))).status).toBe(422);
  });
});
