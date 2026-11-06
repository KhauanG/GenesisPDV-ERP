/** Pessoas (ERP 7.1, 7.2), consulta de CEP, marcas (ERP 8.7) e categorias em árvore (ERP 8.4). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
let vendedor: string;
let estoquista: string;
let servidorCep: Server;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const endereco = (extra: Record<string, unknown> = {}) => ({
  tipo: 'principal',
  cep: '80010-000',
  logradouro: 'Rua XV de Novembro',
  numero: '100',
  bairro: 'Centro',
  uf: 'PR',
  municipioIbge: 4106902,
  ...extra,
});

beforeAll(async () => {
  // ViaCEP falso: 80010000 existe, 99999999 não existe, 11111111 demora mais que o limite.
  servidorCep = createServer((req, res) => {
    const cep = req.url?.split('/')[2];
    if (cep === '11111111') return void setTimeout(() => res.end('{}'), 5000);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        cep === '80010000'
          ? {
              cep: '80010-000',
              logradouro: 'Rua XV de Novembro',
              bairro: 'Centro',
              uf: 'PR',
              ibge: '4106902',
            }
          : { erro: true },
      ),
    );
  });
  await new Promise<void>((ok) => servidorCep.listen(0, '127.0.0.1', ok));
  const porta = (servidorCep.address() as AddressInfo).port;
  amb = await criarAmbiente({ env: { CEP_CONSULTA_URL: `http://127.0.0.1:${porta}/ws/{cep}/json/` } });
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor' });
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
});

afterAll(async () => {
  await amb?.fechar();
  servidorCep?.closeAllConnections();
  servidorCep?.close();
});

describe('Pessoas (ERP 7.1, 7.2)', () => {
  let pessoaId: string;

  it('cria PF com endereços, telefones, e-mails e categorias; senha do crediário com hash', async () => {
    const r = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({
        nome: 'José da Silva',
        apelido: 'Zé',
        cpfCnpj: '529.982.247-25',
        categorias: ['cliente', 'funcionario'],
        enderecos: [endereco(), endereco({ tipo: 'entrega', numero: '200' })],
        telefones: [
          { numero: '(41) 99999-1234', principal: true },
          { tipo: 'comercial', ddd: '41', numero: '33334444' },
        ],
        emails: [{ email: 'Jose@Exemplo.com', principal: true }],
        senha: '480297',
        limiteCompras: '500,00',
      });
    expect(r.status).toBe(201);
    pessoaId = r.body.id;
    expect(r.body).toMatchObject({
      tipo: 'PF',
      cpfCnpj: '52998224725',
      categorias: ['cliente', 'funcionario'],
      senhaDefinida: true,
      limiteCompras: '500.00',
      origem: 'erp',
    });
    expect(r.body.enderecos[0]).toMatchObject({
      tipo: 'principal',
      municipioNome: 'Curitiba',
      cep: '80010000',
    });
    expect(r.body.telefones[0]).toMatchObject({ ddd: '41', numero: '999991234', principal: true });
    expect(r.body.emails[0].email).toBe('jose@exemplo.com');
    const [{ busca }] = (await consultar<{ busca: string }>(
      emp.nomeBanco,
      'select busca from pessoas where id = $1',
      [pessoaId],
    )) as [{ busca: string }];
    expect(busca).toBe('jose da silva ze 52998224725');
  });

  it('valida CPF/CNPJ, um endereço principal, fornecedor PJ sem CNPJ, senha fraca (422)', async () => {
    const r = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({
        tipo: 'PJ',
        nome: 'Distribuidora',
        categorias: ['fornecedor'],
        enderecos: [endereco(), endereco()],
        senha: '123456',
        emails: [{ email: 'x' }],
      });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual(['cpfCnpj', 'emails.0.email', 'enderecos', 'senha']);
    const cpf = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({ nome: 'Fulano', cpfCnpj: '111.111.111-11' });
    expect(cpf.body.campos.cpfCnpj).toEqual(['CPF inválido']);
    const cidade = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({ nome: 'Fulano', enderecos: [endereco({ uf: 'SP' })] });
    expect(cidade.status).toBe(422);
    expect(cidade.body.campos['enderecos.0.municipioIbge']).toEqual(['A cidade não é da UF SP']);
  });

  it('CPF repetido → 409 com o cadastro existente', async () => {
    const r = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({ nome: 'Outro José', cpfCnpj: '52998224725' });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('CONFLITO');
    expect(r.body.detalhes).toMatchObject({ pessoaId, nome: 'José da Silva' });
  });

  it('lista com filtros (nome sem acento, documento, CEP, cidade, categoria, UF) e colunas do ERP 7.1', async () => {
    await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({
        tipo: 'PJ',
        nome: 'Cervejaria Paulista',
        cpfCnpj: '11.222.333/0001-81',
        categorias: ['fornecedor'],
      });
    const porNome = await amb.http().get('/api/pessoas?nome=jose').set(bearer(admin));
    expect(porNome.body.itens).toHaveLength(1);
    expect(porNome.body.itens[0]).toMatchObject({
      nome: 'José da Silva',
      telefone: '(41) 999991234',
      email: 'jose@exemplo.com',
      categorias: ['cliente', 'funcionario'],
      cidade: 'Curitiba',
      uf: 'PR',
    });
    expect((await amb.http().get('/api/pessoas?cpfCnpj=529.982').set(bearer(admin))).body.total).toBe(1);
    expect((await amb.http().get('/api/pessoas?cep=80010').set(bearer(admin))).body.total).toBe(1);
    expect((await amb.http().get('/api/pessoas?cidade=curitiba').set(bearer(admin))).body.total).toBe(1);
    expect(
      (await amb.http().get('/api/pessoas?categorias=fornecedor').set(bearer(admin))).body.itens[0].nome,
    ).toBe('Cervejaria Paulista');
    expect((await amb.http().get('/api/pessoas?uf=SP').set(bearer(admin))).body.total).toBe(0);
    const ordem = await amb.http().get('/api/pessoas?ordenar=nome:desc').set(bearer(admin));
    expect(ordem.body.itens.map((p: { nome: string }) => p.nome)).toEqual([
      'José da Silva',
      'Cervejaria Paulista',
    ]);
  });

  it('altera trocando filhas (principal entre linhas), versão velha → 409, limite exige editar_credito', async () => {
    const d = await amb.http().get(`/api/pessoas/${pessoaId}`).set(bearer(admin));
    const {
      id: _i,
      codigo: _c,
      origem: _o,
      senhaDefinida: _s,
      criadoEm: _cr,
      atualizadoEm: _a,
      atualizadoPorNome: _n,
      ...corpo
    } = d.body;
    const enderecos = d.body.enderecos.map((e: { tipo: string; municipioNome?: string }) => {
      const { municipioNome: _m, ...resto } = e;
      return { ...resto, tipo: e.tipo === 'principal' ? 'entrega' : 'principal' };
    });
    const r = await amb
      .http()
      .put(`/api/pessoas/${pessoaId}`)
      .set(bearer(admin))
      .send({ ...corpo, enderecos, telefones: [d.body.telefones[1]], emails: [] });
    expect(r.status).toBe(200);
    expect(r.body.enderecos[0].numero).toBe('200');
    expect(r.body.telefones).toHaveLength(1);
    expect(r.body.emails).toEqual([]);
    const velho = await amb
      .http()
      .put(`/api/pessoas/${pessoaId}`)
      .set(bearer(admin))
      .send({ ...corpo, enderecos });
    expect(velho.status).toBe(409);
    // Vendedor consulta pessoas (ERP 11.3); operador de caixa (só PDV) não.
    expect((await amb.http().get('/api/pessoas').set(bearer(vendedor))).status).toBe(200);
    await criarUsuario(emp.nomeBanco, { login: 'operador', perfil: 'operador_caixa' });
    const operador = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'operador', senha: SENHA_TESTE });
    expect(operador.status).toBe(403);
    // Editar sem `pessoas.editar_credito` não muda o limite de compras.
    const perfil = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({ nome: 'Cadastro', permissoes: ['pessoas.ver', 'pessoas.editar'] });
    const uid = await criarUsuario(emp.nomeBanco, { login: 'cadastro', perfil: 'vendedor' });
    await consultar(emp.nomeBanco, 'update usuarios set perfil_id = $1 where id = $2', [perfil.body.id, uid]);
    const tok = await amb.entrar(emp.codigo, 'cadastro', SENHA_TESTE);
    const atual = await amb.http().get(`/api/pessoas/${pessoaId}`).set(bearer(tok));
    const {
      id: _i2,
      codigo: _c2,
      origem: _o2,
      senhaDefinida: _s2,
      criadoEm: _cr2,
      atualizadoEm: _a2,
      atualizadoPorNome: _n2,
      ...corpo2
    } = atual.body;
    const limpar = (l: Array<Record<string, unknown>>) => l.map(({ municipioNome: _m, ...x }) => x);
    const credito = await amb
      .http()
      .put(`/api/pessoas/${pessoaId}`)
      .set(bearer(tok))
      .send({ ...corpo2, enderecos: limpar(corpo2.enderecos), limiteCompras: '9999' });
    expect(credito.status).toBe(403);
    const semCredito = await amb
      .http()
      .put(`/api/pessoas/${pessoaId}`)
      .set(bearer(tok))
      .send({ ...corpo2, enderecos: limpar(corpo2.enderecos), observacaoPdv: 'Cliente VIP' });
    expect(semCredito.status).toBe(200);
  });

  it('exportar CSV com os filtros; excluir é lógico e some da listagem', async () => {
    const csv = await amb.http().get('/api/pessoas/exportar?formato=csv&nome=jose').set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('José da Silva');
    expect(csv.text).not.toContain('Cervejaria');
    expect((await amb.http().delete(`/api/pessoas/${pessoaId}`).set(bearer(admin))).status).toBe(204);
    expect((await amb.http().get(`/api/pessoas/${pessoaId}`).set(bearer(admin))).status).toBe(404);
    // CPF liberado depois da exclusão.
    const de_novo = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(admin))
      .send({ nome: 'José Novo', cpfCnpj: '52998224725' });
    expect(de_novo.status).toBe(201);
  });

  it('CEP: preenche pelo serviço com o município local; inexistente ou lento → 404 sem travar', async () => {
    const ok = await amb.http().get('/api/utilitarios/cep/80010-000').set(bearer(vendedor));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      cep: '80010000',
      logradouro: 'Rua XV de Novembro',
      complemento: null,
      bairro: 'Centro',
      uf: 'PR',
      municipioIbge: 4106902,
      municipioNome: 'Curitiba',
    });
    expect((await amb.http().get('/api/utilitarios/cep/99999999').set(bearer(admin))).status).toBe(404);
    const inicio = Date.now();
    expect((await amb.http().get('/api/utilitarios/cep/11111111').set(bearer(admin))).status).toBe(404);
    expect(Date.now() - inicio).toBeLessThan(4500);
    expect((await amb.http().get('/api/utilitarios/cep/123').set(bearer(admin))).status).toBe(422);
    const municipios = await amb
      .http()
      .get('/api/referencias/municipios?uf=PR&nome=curit')
      .set(bearer(admin));
    expect(municipios.body).toEqual([{ codigoIbge: 4106902, nome: 'Curitiba', uf: 'PR' }]);
  });
});

describe('Marcas (ERP 8.7)', () => {
  it('descrição única sem acento/caixa, SEM MARCA única, 409 de versão, mesclar e excluir', async () => {
    const lista = await amb.http().get('/api/marcas').set(bearer(admin));
    expect(lista.body.itens.map((m: { descricao: string }) => m.descricao)).toEqual(['SEM MARCA']);
    const a = await amb.http().post('/api/marcas').set(bearer(admin)).send({ descricao: 'Heineken' });
    expect(a.status).toBe(201);
    const dup = await amb.http().post('/api/marcas').set(bearer(admin)).send({ descricao: 'HEINÉKEN' });
    expect(dup.status).toBe(409);
    const sem = await amb
      .http()
      .post('/api/marcas')
      .set(bearer(admin))
      .send({ descricao: 'Genérica', semMarca: true });
    expect(sem.status).toBe(409);
    expect(sem.body.campos.semMarca[0]).toContain('SEM MARCA');
    const b = await amb.http().post('/api/marcas').set(bearer(admin)).send({ descricao: 'Heineken Ltda' });
    const velho = await amb
      .http()
      .put(`/api/marcas/${a.body.id}`)
      .set(bearer(admin))
      .send({ descricao: 'X', versao: a.body.versao - 1 });
    expect(velho.status).toBe(409);
    expect((await amb.http().post('/api/marcas').set(bearer(vendedor)).send({ descricao: 'Y' })).status).toBe(
      403,
    );
    const m = await amb
      .http()
      .post('/api/marcas/mesclar')
      .set(bearer(admin))
      .send({ destinoId: a.body.id, origens: [b.body.id] });
    expect(m.status).toBe(200);
    expect((await amb.http().get(`/api/marcas/${b.body.id}`).set(bearer(admin))).status).toBe(404);
    expect((await amb.http().delete(`/api/marcas/${a.body.id}`).set(bearer(admin))).status).toBe(204);
  });
});

describe('Categorias em árvore (ERP 8.4)', () => {
  it('cria raiz e filhas com caminho/nível, nome único entre irmãs, até 5 níveis, mover sem ciclo, renomear propaga', async () => {
    const criar = (nome: string, categoriaPaiId?: string) =>
      amb.http().post('/api/categorias').set(bearer(admin)).send({ nome, categoriaPaiId });
    const bebidas = await criar('Bebidas');
    expect(bebidas.status).toBe(201);
    const cerveja = await criar('Cerveja', bebidas.body.id);
    const lata = await criar('Lata', cerveja.body.id);
    expect(lata.body).toMatchObject({ caminhoNomes: 'Bebidas > Cerveja > Lata', nivel: 3 });
    const [{ caminho }] = (await consultar<{ caminho: string }>(
      emp.nomeBanco,
      'select caminho from categorias where id = $1',
      [lata.body.id],
    )) as [{ caminho: string }];
    expect(caminho).toBe(`${bebidas.body.id}/${cerveja.body.id}/${lata.body.id}`);
    expect((await criar('LATA', cerveja.body.id)).status).toBe(409);
    expect((await criar('Lata', bebidas.body.id)).status).toBe(201);
    const n4 = await criar('350 ml', lata.body.id);
    const n5 = await criar('Pack', n4.body.id);
    expect(n5.body.nivel).toBe(5);
    expect((await criar('Demais', n5.body.id)).status).toBe(422);

    // Mover Bebidas para dentro da própria subárvore → 422; mover "Lata" (altura 2) para a raiz → ok.
    const ciclo = await amb
      .http()
      .post(`/api/categorias/${bebidas.body.id}/mover`)
      .set(bearer(admin))
      .send({ versao: bebidas.body.versao, categoriaPaiId: lata.body.id });
    expect(ciclo.status).toBe(422);
    const mover = await amb
      .http()
      .post(`/api/categorias/${lata.body.id}/mover`)
      .set(bearer(admin))
      .send({ versao: lata.body.versao, categoriaPaiId: null });
    expect(mover.status).toBe(200);
    expect(mover.body).toMatchObject({ caminhoNomes: 'Lata', nivel: 1 });
    const arvore = await amb.http().get('/api/categorias/arvore').set(bearer(estoquista));
    expect(arvore.body.find((c: { id: string }) => c.id === n5.body.id)).toMatchObject({
      caminhoNomes: 'Lata > 350 ml > Pack',
      nivel: 3,
    });

    const ren = await amb
      .http()
      .put(`/api/categorias/${mover.body.id}`)
      .set(bearer(admin))
      .send({ nome: 'Latas', versao: mover.body.versao });
    expect(ren.status).toBe(200);
    const depois = await amb.http().get('/api/categorias/arvore').set(bearer(admin));
    expect(depois.body.find((c: { id: string }) => c.id === n5.body.id).caminhoNomes).toBe(
      'Latas > 350 ml > Pack',
    );
    const velho = await amb
      .http()
      .put(`/api/categorias/${mover.body.id}`)
      .set(bearer(admin))
      .send({ nome: 'X', versao: mover.body.versao });
    expect(velho.status).toBe(409);

    // Excluir com filhas é bloqueado; folha sai.
    expect((await amb.http().delete(`/api/categorias/${mover.body.id}`).set(bearer(admin))).status).toBe(422);
    expect((await amb.http().delete(`/api/categorias/${n5.body.id}`).set(bearer(admin))).status).toBe(204);
    expect((await amb.http().post('/api/categorias').set(bearer(vendedor)).send({ nome: 'Z' })).status).toBe(
      403,
    );
  });
});
