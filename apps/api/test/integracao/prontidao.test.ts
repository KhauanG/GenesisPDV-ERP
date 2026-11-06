/**
 * Implantação › Prontidão da loja (implantação do piloto, I5; `GET /api/implantacao/prontidao`): cada regra sai de
 * `falta` (ou `aviso`) para `ok` quando o dono resolve o que ela aponta, a avaliação segue as permissões efetivas e
 * as lojas permitidas como o caixa, a rota exige `configuracoes.ver` e a loja permitida, e a resposta não leva dado
 * pessoal (nome nem login de ninguém).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Ativar, ItemProntidao, Prontidao, SituacaoProntidao } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILAS } from '../../src/infra/fila.js';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let adminId: string;
let loja: string;
let outraLoja: string;
let caixaId: string;
let terminalId: string;
let operadorId: string;
let gerenteId: string;
let produtoA: string;
let produtoB: string;
const EAN_A = '7891000315507';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

async function prontidao(token = admin, lojaId = loja): Promise<Prontidao> {
  const r = await amb.http().get(`/api/implantacao/prontidao?lojaId=${lojaId}`).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Prontidao;
}

async function item(codigo: string): Promise<ItemProntidao> {
  const p = await prontidao();
  const i = p.itens.find((x) => x.codigo === codigo);
  if (!i) throw new Error(`Item ${codigo} ausente: ${p.itens.map((x) => x.codigo).join(', ')}`);
  return i;
}

async function situacao(codigo: string): Promise<SituacaoProntidao> {
  return (await item(codigo)).situacao;
}

const sql = (texto: string, valores: unknown[] = []) => consultar(emp.nomeBanco, texto, valores);

async function definirPin(usuarioId: string, pin: string) {
  const r = await amb.http().put(`/api/usuarios/${usuarioId}/pin`).set(bearer(admin)).send({ pin });
  expect(r.status, JSON.stringify(r.body)).toBe(204);
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const [a] = await sql("select id from usuarios where login = 'admin'");
  adminId = a!.id as string;
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja Piloto');
  outraLoja = await criarLoja(emp.nomeBanco, 2, 'Loja Outra');
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('prontidão da loja (I5)', () => {
  it('a loja recém-criada: o que falta, um código por regra, links do ERP e nenhum dado pessoal', async () => {
    const p = await prontidao();
    expect(p).toMatchObject({ lojaId: loja, lojaCodigo: 1, lojaNome: 'Loja Piloto', pronta: false });
    const codigos = p.itens.map((i) => i.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const i of p.itens) expect(i.linkErp === null || i.linkErp.startsWith('/'), i.codigo).toBe(true);
    const por = Object.fromEntries(p.itens.map((i) => [i.codigo, i.situacao]));
    expect(por).toMatchObject({
      'empresa.ativa': 'ok',
      'loja.usa_pdv': 'ok',
      'loja.dia_operacional': 'ok',
      'loja.caixas': 'falta',
      'usuarios.operador': 'falta',
      'usuarios.liberacao.cancelar_venda_paga': 'falta',
      'usuarios.liberacao.cancelar_venda_aberta': 'falta',
      'usuarios.liberacao.cancelar_sangria': 'aviso',
      'usuarios.liberacao.desconto_cascos': 'aviso',
      'usuarios.liberacao.pix_manual': 'falta',
      'usuarios.liberacao.config_terminal': 'falta',
      'usuarios.liberacao.lacuna': 'aviso',
      'formas.dinheiro': 'ok',
      'formas.pix': 'falta',
      'formas.cartao': 'ok',
      'catalogo.produtos': 'falta',
      'terminais.ativo': 'falta',
      'operacao.backup': 'aviso',
      'operacao.tarefas': 'ok',
    });
    // Sem limite de gaveta nem forma "exige supervisor", as regras delas não entram.
    expect(codigos).not.toContain('usuarios.liberacao.limite_sangria');
    expect(codigos).not.toContain('usuarios.liberacao.forma_com_supervisor');
    expect(p.resumo.falta).toBe(p.itens.filter((i) => i.situacao === 'falta').length);
    // Dinheiro das configurações como o dono lê (D38: teto padrão de R$ 50,00).
    expect((await item('usuarios.liberacao.desconto_cascos')).mensagem).toContain('R$ 50,00');
    expect((await item('operacao.backup')).mensagem).toMatch(/Não verificável aqui/);
    expect((await item('loja.dia_operacional')).mensagem).toMatch(/vira às 05:00/);
  });

  it('empresa e loja: implantação, usa PDV e caixas', async () => {
    await sql("insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ativa', 'false')");
    expect(await item('empresa.ativa')).toMatchObject({
      situacao: 'falta',
      linkErp: '/cadastros/configuracoes/geral',
    });
    // O rótulo da tela (Configurações › Geral), não um nome que o dono não acha.
    expect((await item('empresa.ativa')).mensagem).toContain('"Ativa" em Não');
    await sql("delete from configuracoes where chave = 'geral.ativa'");
    expect(await situacao('empresa.ativa')).toBe('ok');

    await sql('update lojas set usa_pdv = false where id = $1', [loja]);
    expect(await item('loja.usa_pdv')).toMatchObject({
      situacao: 'falta',
      linkErp: `/cadastros/lojas/${loja}`,
    });
    await sql('update lojas set usa_pdv = true where id = $1', [loja]);
    expect(await situacao('loja.usa_pdv')).toBe('ok');

    // O caixa 0 (sistema) não conta.
    await sql("insert into caixas (loja_id, numero, descricao, sistema) values ($1, 0, 'Sistema', true)", [
      loja,
    ]);
    expect(await situacao('loja.caixas')).toBe('falta');
    const [c] = await sql(
      "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
      [loja],
    );
    caixaId = c!.id as string;
    expect(await item('loja.caixas')).toMatchObject({ situacao: 'ok', mensagem: '1 caixa ativo: 01.' });
  });

  it('operador com PIN e as liberações pelas permissões efetivas', async () => {
    // O totem do menu digital com perfil de operador e PIN não entra no caixa (`MotivoRecusa.Totem`): não conta.
    const totem = await criarUsuario(emp.nomeBanco, {
      login: 'totem1',
      perfil: 'operador_caixa',
      lojas: [loja],
    });
    await definirPin(totem, '147036');
    await sql('update usuarios set totem = true where id = $1', [totem]);
    expect(await situacao('usuarios.operador')).toBe('falta');

    operadorId = await criarUsuario(emp.nomeBanco, {
      login: 'operadora1',
      nome: 'OPERADORA SIGILOSA',
      perfil: 'operador_caixa',
      lojas: [loja],
    });
    const semPin = await item('usuarios.operador');
    expect(semPin.situacao).toBe('falta');
    expect(semPin.mensagem).toMatch(/1 usuário com o perfil ainda não tem PIN/);

    // O gerente de OUTRA loja não libera nada aqui.
    const deFora = await criarUsuario(emp.nomeBanco, {
      login: 'gerente2',
      perfil: 'gerente',
      lojas: [outraLoja],
    });
    await definirPin(deFora, '369147');
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('falta');

    // O Supervisor de caixa não cancela a venda paga; o Encarregado, sim (dono, 05/11/2026; decisão 78 do README do PDV).
    const supervisor = await criarUsuario(emp.nomeBanco, {
      login: 'supervisor1',
      perfil: 'supervisor_caixa',
      lojas: [loja],
    });
    await definirPin(supervisor, '582039');
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('falta');
    const encarregado = await criarUsuario(emp.nomeBanco, {
      login: 'encarregado1',
      perfil: 'encarregado',
      lojas: [loja],
    });
    await definirPin(encarregado, '693140');
    const cancelar = await item('usuarios.liberacao.cancelar_venda_paga');
    expect(cancelar.situacao).toBe('ok');
    expect(cancelar.mensagem).toMatch(/^1 pessoa pode liberar.*gerente ou o encarregado/);
    // Os dois saem para o resto do roteiro (o gerente é o único liberador daqui em diante).
    await sql('update usuarios set excluido_em = now() where id = any($1::uuid[])', [
      [supervisor, encarregado],
    ]);
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('falta');

    // Limite de gaveta e forma "exige supervisor" ligam as regras deles: sem quem libere, `falta`.
    await sql(
      "insert into configuracoes (escopo, chave, valor) values ('empresa', 'pdv.valor_limite_sangria', '\"800.00\"')",
    );
    await sql("update formas_pagamento set exige_supervisor = true where tipo_forma = 'cartao_credito'");
    expect(await item('usuarios.liberacao.limite_sangria')).toMatchObject({ situacao: 'falta' });
    expect((await item('usuarios.liberacao.limite_sangria')).mensagem).toContain('R$ 800,00');
    expect(await situacao('usuarios.liberacao.forma_com_supervisor')).toBe('falta');

    // `pdv.config.terminal` sem `pdv.supervisor` (ajuste no operador): o login (Ctrl+Alt+C) e o "Restaurar backup"
    // pedem o supervisor, então continua `falta`, dizendo que só serve no F11 › 8.
    await definirPin(operadorId, '258036');
    await sql(
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'pdv.config.terminal', 'conceder')",
      [operadorId],
    );
    const config = await item('usuarios.liberacao.config_terminal');
    expect(config.situacao).toBe('falta');
    expect(config.mensagem).toMatch(/1 pessoa tem a permissão sem "pdv.supervisor".*F11 › 8/);
    await sql('update usuarios_permissoes set excluido_em = now() where usuario_id = $1', [operadorId]);
    await sql('update usuarios set senha_pdv_hash = null where id = $1', [operadorId]);

    // O gerente é o único com PIN: opera, cancela sozinho (a própria permissão basta), mas o PIX manual e a forma
    // "exige supervisor" sempre pedem OUTRA pessoa (`MensagemLiberadorProprio`): `falta`.
    gerenteId = await criarUsuario(emp.nomeBanco, {
      login: 'gerente1',
      nome: 'GERENTE SIGILOSO',
      perfil: 'gerente',
      lojas: [loja],
    });
    await definirPin(gerenteId, '471582');
    expect(await situacao('usuarios.operador')).toBe('ok');
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('ok');
    expect(await situacao('usuarios.liberacao.limite_sangria')).toBe('ok');
    expect(await situacao('usuarios.liberacao.config_terminal')).toBe('ok');
    for (const c of ['pix_manual', 'forma_com_supervisor']) {
      const i = await item(`usuarios.liberacao.${c}`);
      expect(i.situacao, c).toBe('falta');
      expect(i.mensagem, c).toMatch(/também é quem opera o caixa/);
    }
    expect(await situacao('usuarios.liberacao.desconto_cascos')).toBe('aviso');

    // Com a operadora no caixa, o gerente libera (a ressalva fica na mensagem).
    await definirPin(operadorId, '258036');
    expect((await item('usuarios.operador')).mensagem).toMatch(/^2 usuários podem/);
    // A demissão vira no dia da empresa (o mesmo `hojeNaEmpresa` do fluxo `acesso`), não no `current_date` do servidor.
    await sql("update usuarios set demissao = (now() at time zone 'America/Sao_Paulo')::date where id = $1", [
      operadorId,
    ]);
    expect((await item('usuarios.operador')).mensagem).toMatch(/^1 usuário pode/);
    await sql(
      "update usuarios set demissao = (now() at time zone 'America/Sao_Paulo')::date + 1 where id = $1",
      [operadorId],
    );
    expect((await item('usuarios.operador')).mensagem).toMatch(/^2 usuários podem/);
    await sql('update usuarios set demissao = null where id = $1', [operadorId]);
    for (const c of [
      'cancelar_venda_paga',
      'cancelar_venda_aberta',
      'cancelar_sangria',
      'limite_sangria',
      'desconto_cascos',
      'pix_manual',
      'forma_com_supervisor',
      'config_terminal',
    ])
      expect(await situacao(`usuarios.liberacao.${c}`), c).toBe('ok');
    expect((await item('usuarios.liberacao.cancelar_venda_paga')).mensagem).toMatch(/^1 pessoa pode liberar/);
    expect((await item('usuarios.liberacao.pix_manual')).mensagem).toMatch(
      /quando ela mesma estiver no caixa/,
    );
    await sql("delete from configuracoes where chave = 'pdv.valor_limite_sangria'");
    await sql('update formas_pagamento set exige_supervisor = false');

    // A negação individual vence o perfil (MD 3.3.4), como no caixa.
    await sql(
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'pdv.venda.cancelar_venda_finalizada', 'negar')",
      [gerenteId],
    );
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('falta');
    await sql('update usuarios_permissoes set excluido_em = now() where usuario_id = $1', [gerenteId]);
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('ok');

    // Sem `pdv.acesso.entrar` o caixa recusa o login do liberador (`SemAcessoPdv`), mesmo com `pdv.supervisor`.
    await sql(
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'pdv.acesso.entrar', 'negar')",
      [gerenteId],
    );
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('falta');
    await sql('update usuarios_permissoes set excluido_em = now() where usuario_id = $1', [gerenteId]);
    expect(await situacao('usuarios.liberacao.cancelar_venda_paga')).toBe('ok');

    // Desligado o PIX manual com supervisor (D37), a regra fica enquanto houver operador sem "Confirmar PIX manual"
    // (o perfil padrão Operador de caixa): o caixa continua pedindo o supervisor para ele.
    await sql(
      "insert into configuracoes (escopo, loja_id, chave, valor) values ('loja', $1, 'pdv.pix_manual_exige_supervisor', 'false')",
      [loja],
    );
    expect(await item('usuarios.liberacao.pix_manual')).toMatchObject({ situacao: 'ok' });
    expect((await item('usuarios.liberacao.pix_manual')).mensagem).toMatch(/^1 pessoa pode liberar/);
    await sql(
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'pdv.pagamento.confirmar_pix_manual', 'negar')",
      [gerenteId],
    );
    expect(await situacao('usuarios.liberacao.pix_manual')).toBe('falta');
    // Todos os operadores com a permissão: ninguém precisa liberar.
    await sql('update usuarios_permissoes set excluido_em = now() where usuario_id = $1', [gerenteId]);
    await sql(
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'pdv.pagamento.confirmar_pix_manual', 'conceder')",
      [operadorId],
    );
    expect(await item('usuarios.liberacao.pix_manual')).toMatchObject({ situacao: 'ok' });
    expect((await item('usuarios.liberacao.pix_manual')).mensagem).toMatch(/todos os operadores/);
    await sql('update usuarios_permissoes set excluido_em = now() where usuario_id = $1', [operadorId]);
    await sql("delete from configuracoes where chave = 'pdv.pix_manual_exige_supervisor'");

    // A lacuna (pdv.config.fiscal) é só do Master no perfil padrão: com o PIN do admin, ok. Com dois liberadores, o
    // PIX manual perde a ressalva.
    expect(await situacao('usuarios.liberacao.lacuna')).toBe('aviso');
    await definirPin(adminId, '582914');
    expect(await situacao('usuarios.liberacao.lacuna')).toBe('ok');
    expect((await item('usuarios.liberacao.pix_manual')).mensagem).toMatch(
      /^2 pessoas podem liberar "[^"]+"\. /,
    );

    // Nenhum nome nem login na resposta.
    const texto = JSON.stringify(await prontidao());
    for (const pessoal of [
      'OPERADORA SIGILOSA',
      'operadora1',
      'GERENTE SIGILOSO',
      'gerente1',
      'gerente2',
      'totem1',
    ])
      expect(texto).not.toContain(pessoal);
  });

  it('formas: dinheiro, PIX com a chave da loja e cartão', async () => {
    await sql("update formas_pagamento set ativa = false where tipo_forma = 'dinheiro'");
    expect(await situacao('formas.dinheiro')).toBe('falta');
    await sql("update formas_pagamento set ativa = true where tipo_forma = 'dinheiro'");
    expect(await situacao('formas.dinheiro')).toBe('ok');

    expect(await item('formas.pix')).toMatchObject({
      situacao: 'falta',
      linkErp: `/cadastros/lojas/${loja}`,
    });
    const detalhe = (await amb.http().get(`/api/lojas/${loja}`).set(bearer(admin))).body as Record<
      string,
      unknown
    >;
    const invalida = await amb
      .http()
      .put(`/api/lojas/${loja}`)
      .set(bearer(admin))
      .send({ ...detalhe, chavePix: '123.456.789-00', pixNomeRecebedor: 'ICE BEER' });
    expect(invalida.status).toBe(422);
    expect(JSON.stringify(invalida.body)).toContain('chavePix');
    const semNome = await amb
      .http()
      .put(`/api/lojas/${loja}`)
      .set(bearer(admin))
      .send({ ...detalhe, chavePix: 'pix@icebeer.com.br' });
    expect(semNome.status).toBe(422);
    expect(JSON.stringify(semNome.body)).toContain('pixNomeRecebedor');
    const ok = await amb
      .http()
      .put(`/api/lojas/${loja}`)
      .set(bearer(admin))
      .send({
        ...detalhe,
        chavePix: '529.982.247-25',
        pixNomeRecebedor: 'ICE BEER',
        pixCidadeRecebedor: 'CURITIBA',
      });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const lida = (await amb.http().get(`/api/lojas/${loja}`).set(bearer(admin))).body as Record<
      string,
      unknown
    >;
    // CPF gravado só com os dígitos, como vai para o BR Code.
    expect(lida).toMatchObject({
      chavePix: '52998224725',
      pixNomeRecebedor: 'ICE BEER',
      pixCidadeRecebedor: 'CURITIBA',
    });
    expect(await item('formas.pix')).toMatchObject({ situacao: 'ok' });
    expect((await item('formas.pix')).mensagem).toMatch(/chave de cpf/);
    // Auditoria própria da troca do recebedor (os três campos), além do `editar` da loja.
    const [aud] = await sql(
      "select antes, depois from auditoria where acao = 'pix_recebedor_alterado' and registro_id = $1",
      [loja],
    );
    expect(aud).toMatchObject({
      antes: { chavePix: null, pixNomeRecebedor: null, pixCidadeRecebedor: null },
      depois: { chavePix: '52998224725', pixNomeRecebedor: 'ICE BEER', pixCidadeRecebedor: 'CURITIBA' },
    });

    // O Gerente padrão edita a loja (`lojas.editar`), mas não troca o recebedor do PIX (`lojas.editar_pix`, só o
    // Administrador): o dinheiro do QR iria para a conta de outra pessoa.
    const gerente = await amb.entrar(emp.codigo, 'gerente1', SENHA_TESTE);
    const atual = (await amb.http().get(`/api/lojas/${loja}`).set(bearer(gerente))).body as Record<
      string,
      unknown
    >;
    for (const troca of [
      { chavePix: 'gerente@exemplo.com.br' },
      { pixNomeRecebedor: 'OUTRO NOME' },
      { pixCidadeRecebedor: null },
    ]) {
      const r = await amb
        .http()
        .put(`/api/lojas/${loja}`)
        .set(bearer(gerente))
        .send({ ...atual, ...troca });
      expect(r.status, JSON.stringify(troca)).toBe(403);
      expect(r.body.mensagem).toMatch(/Alterar o recebedor do PIX/);
    }
    const outraEdicao = await amb
      .http()
      .put(`/api/lojas/${loja}`)
      .set(bearer(gerente))
      .send({ ...atual, fraseRodapeCupom: 'Volte sempre' });
    expect(outraEdicao.status, JSON.stringify(outraEdicao.body)).toBe(200);
    expect(outraEdicao.body).toMatchObject({ chavePix: '52998224725', fraseRodapeCupom: 'Volte sempre' });
    const criarComPix = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(gerente))
      .send({ ...atual, nome: 'Loja Nova', cnpj: '11.222.333/0001-81', chavePix: 'pix@exemplo.com.br' });
    expect(criarComPix.status, JSON.stringify(criarComPix.body)).toBe(403);
    expect(criarComPix.body.mensagem).toMatch(/Alterar o recebedor do PIX/);

    // A chave gravada fora do formato (antes da regra, ou à mão) e sem o nome: a Prontidão também acusa.
    await sql("update lojas set chave_pix = 'x' where id = $1", [loja]);
    expect(await item('formas.pix')).toMatchObject({
      situacao: 'falta',
      linkErp: `/cadastros/lojas/${loja}`,
    });
    expect((await item('formas.pix')).mensagem).toMatch(/não tem formato válido/);
    await sql("update lojas set chave_pix = '52998224725', pix_nome_recebedor = null where id = $1", [loja]);
    expect((await item('formas.pix')).mensagem).toMatch(/Falta o nome do recebedor/);
    await sql("update lojas set pix_nome_recebedor = 'ICE BEER' where id = $1", [loja]);
    expect(await situacao('formas.pix')).toBe('ok');

    await sql("update formas_pagamento set ativa = false where tipo_forma = 'cartao_debito'");
    expect(await item('formas.cartao')).toMatchObject({ situacao: 'aviso' });
    expect((await item('formas.cartao')).mensagem).toMatch(/Falta débito/);
    await sql("update formas_pagamento set ativa = true where tipo_forma = 'cartao_debito'");
    expect(await situacao('formas.cartao')).toBe('ok');

    // Forma que exige supervisor liga a regra de quem libera (o gerente libera).
    await sql("update formas_pagamento set exige_supervisor = true where tipo_forma = 'cartao_credito'");
    expect(await situacao('usuarios.liberacao.forma_com_supervisor')).toBe('ok');
    await sql('update formas_pagamento set exige_supervisor = false');
  });

  it('catálogo: produtos, preço, código, EAN, combo, NCM e estoque negativo', async () => {
    expect(await item('catalogo.produtos')).toMatchObject({
      situacao: 'falta',
      linkErp: '/produtos/importacao',
    });
    const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer(admin))).body as Array<{
      id: string;
      sigla: string;
    }>;
    const un = unidades.find((u) => u.sigla === 'UN')!.id;
    const criar = async (corpo: Record<string, unknown>) => {
      const r = await amb
        .http()
        .post('/api/produtos')
        .set(bearer(admin))
        .send({ unidadeId: un, precoCusto: '1', ...corpo });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    produtoA = await criar({
      nome: 'PRODUTO TESTE A',
      precoVenda: '4.99',
      ncm: '2203.00.00',
      codigosBarras: [{ codigo: EAN_A, principal: true }],
    });
    expect(await situacao('catalogo.produtos')).toBe('ok');
    for (const c of [
      'sem_preco',
      'sem_codigo',
      'ean_invalido',
      'ean_duplicado',
      'combos',
      'ncm',
      'estoque_negativo',
    ])
      expect(await situacao(`catalogo.${c}`), c).toBe('ok');

    // B: sem preço, sem código e sem NCM.
    produtoB = await criar({ nome: 'PRODUTO TESTE B', precoVenda: '1' });
    await sql('update produtos set preco_venda = 0 where id = $1', [produtoB]);
    expect(await situacao('catalogo.sem_preco')).toBe('aviso');
    expect(await situacao('catalogo.sem_codigo')).toBe('aviso');
    expect(await situacao('catalogo.ncm')).toBe('aviso');
    await sql("update produtos set preco_venda = 2, ncm = '22030000' where id = $1", [produtoB]);
    expect(await situacao('catalogo.sem_preco')).toBe('ok');
    expect(await situacao('catalogo.ncm')).toBe('ok');

    // Código numérico com o dígito errado (a importação grava como interno) e o EAN de A repetido em B.
    await sql(
      "insert into produtos_codigos_barras (produto_id, codigo, tipo, principal) values ($1, '7891000315508', 'interno', true)",
      [produtoB],
    );
    expect(await situacao('catalogo.sem_codigo')).toBe('ok');
    expect(await situacao('catalogo.ean_invalido')).toBe('aviso');
    // O duplicado só entra no período de migração (`geral.ean_duplicado = 'avisar'`) ou pela importação (MD 3.6.5).
    await sql(
      "insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '\"avisar\"')",
    );
    await sql("insert into produtos_codigos_barras (produto_id, codigo, tipo) values ($1, $2, 'gtin')", [
      produtoB,
      EAN_A,
    ]);
    await sql("delete from configuracoes where chave = 'geral.ean_duplicado'");
    expect(await item('catalogo.ean_duplicado')).toMatchObject({ situacao: 'aviso' });
    await sql(
      "update produtos_codigos_barras set excluido_em = now() where produto_id = $1 and codigo in ('7891000315508', $2)",
      [produtoB, EAN_A],
    );
    await sql(
      "insert into produtos_codigos_barras (produto_id, codigo, tipo, principal) values ($1, 'B-INTERNO', 'interno', true)",
      [produtoB],
    );
    expect(await situacao('catalogo.ean_invalido')).toBe('ok');
    expect(await situacao('catalogo.ean_duplicado')).toBe('ok');

    // Combo com A e B: ok; B inativo quebra o combo.
    const combo = await criar({
      nome: 'COMBO TESTE',
      tipo: 'kit',
      precoVenda: '9.90',
      componentes: [
        { tipo: 'kit', componenteId: produtoA, quantidade: '1' },
        { tipo: 'kit', componenteId: produtoB, quantidade: '2' },
      ],
    });
    expect(await item('catalogo.combos')).toMatchObject({
      situacao: 'ok',
      mensagem: '1 combo ativo com todos os componentes ativos.',
    });
    await sql('update produtos set ativo = false where id = $1', [produtoB]);
    expect(await situacao('catalogo.combos')).toBe('aviso');
    await sql('update produtos set ativo = true where id = $1', [produtoB]);
    expect(await situacao('catalogo.combos')).toBe('ok');
    // Componente desligado só nesta loja, e o combo sem nenhum componente: o caixa recusa os dois.
    await sql('insert into produtos_lojas (produto_id, loja_id, ativo_na_loja) values ($1, $2, false)', [
      produtoB,
      loja,
    ]);
    expect(await situacao('catalogo.combos')).toBe('aviso');
    await sql('update produtos_lojas set ativo_na_loja = true where produto_id = $1', [produtoB]);
    expect(await situacao('catalogo.combos')).toBe('ok');
    await sql('update produtos_componentes set excluido_em = now() where produto_id = $1', [combo]);
    expect(await item('catalogo.combos')).toMatchObject({ situacao: 'aviso' });
    await sql('update produtos_componentes set excluido_em = null where produto_id = $1', [combo]);
    expect(await situacao('catalogo.combos')).toBe('ok');

    // Saldo negativo no estoque vendável da loja.
    await sql(
      `insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio)
       values ((select estoque_id from lojas where id = $1), $2,
               (select id from tipos_estoque where chave_sistema = 'disponivel'), -3, 1)`,
      [loja, produtoA],
    );
    expect(await item('catalogo.estoque_negativo')).toMatchObject({
      situacao: 'aviso',
      linkErp: '/estoque/saldos',
    });
    await sql('update saldos_estoque set quantidade = 0 where produto_id = $1', [produtoA]);
    expect(await situacao('catalogo.estoque_negativo')).toBe('ok');
  });

  it('terminais: ativado, contato, versão mínima, relógio, fila de decisão e lacuna; a sessão esquecida', async () => {
    expect(await item('terminais.ativo')).toMatchObject({ situacao: 'falta', linkErp: '/cadastros/pdvs' });
    const g = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set(bearer(admin))
      .send({ lojaId: loja, caixaId, validadeHoras: 1 });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const r = await amb
      .http()
      .post('/sync/ativar')
      .set({
        'X-Genesis-Protocolo': '1',
        'X-Genesis-App-Versao': ATIVAR.maquina.versao_app,
        'X-Genesis-Plataforma': 'windows_x64',
        'X-Requisicao-Id': uuidv7(),
        'X-Genesis-Hora-Local': new Date().toISOString(),
        'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
      })
      .send({
        ...ATIVAR,
        codigo_empresa: emp.codigo,
        codigo_ativacao: g.body.codigo,
        requisicao_ativacao_id: uuidv7(),
        chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
        chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [t] = await sql('select id from terminais where caixa_id = $1', [caixaId]);
    terminalId = t!.id as string;
    await sql('update terminais set ultimo_contato_em = now() where id = $1', [terminalId]);
    expect(await item('terminais.ativo')).toMatchObject({
      situacao: 'ok',
      mensagem: '1 PDV ativo: caixa 01.',
    });
    expect(await situacao('terminais.contato')).toBe('ok');
    expect(await item('terminais.versao')).toMatchObject({
      situacao: 'ok',
      mensagem: `Versão: ${ATIVAR.maquina.versao_app}.`,
    });

    // Sem contato há 10 min (os dois "últimos contatos": o do controle e o do heartbeat).
    await sql("update terminais set ultimo_contato_em = now() - interval '10 minutes' where id = $1", [
      terminalId,
    ]);
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ultimo_contato_em = now() - interval '10 minutes' where id = $1",
      [terminalId],
    );
    expect(await item('terminais.contato')).toMatchObject({
      situacao: 'aviso',
      linkErp: `/cadastros/pdvs/${terminalId}`,
    });
    await sql('update terminais set ultimo_contato_em = now() where id = $1', [terminalId]);
    expect(await situacao('terminais.contato')).toBe('ok');

    // Versão mínima publicada acima da do caixa.
    const [v] = await consultar(
      amb.bancoControle,
      `insert into versoes_app_pdv (versao_app, plataforma, url_pacote, sha256, tamanho_bytes, versao_minima, publicada_em)
       values ('9.0.0', 'windows_x64', 'https://exemplo.invalid/pdv.exe', repeat('a', 64), 1, true, now()) returning id`,
    );
    const versao = await item('terminais.versao');
    expect(versao.situacao).toBe('falta');
    expect(versao.mensagem).toContain(`caixa 01 (${ATIVAR.maquina.versao_app} < 9.0.0)`);
    await consultar(amb.bancoControle, 'delete from versoes_app_pdv where id = $1', [v!.id]);
    expect(await situacao('terminais.versao')).toBe('ok');

    await sql('update terminais set relogio_confiavel = false where id = $1', [terminalId]);
    expect(await situacao('terminais.relogio')).toBe('aviso');
    await sql('update terminais set relogio_confiavel = true where id = $1', [terminalId]);
    expect(await situacao('terminais.relogio')).toBe('ok');
    // O alerta do heartbeat (C16) também acusa, com `relogio_confiavel` ainda verdadeiro.
    for (const tipo of ['RELOGIO_DESVIO', 'RELOGIO_SUSPEITO']) {
      const [a] = await sql(
        `insert into alertas (tipo, severidade, titulo, loja_id, entidade, registro_id)
         values ($1, 'aviso', 'Relógio', $2, 'terminais', $3) returning id`,
        [tipo, loja, terminalId],
      );
      expect(await item('terminais.relogio'), tipo).toMatchObject({
        situacao: 'aviso',
        linkErp: `/cadastros/pdvs/${terminalId}`,
      });
      await sql('update alertas set resolvido_em = now() where id = $1', [a!.id]);
      expect(await situacao('terminais.relogio'), tipo).toBe('ok');
    }

    const evento = uuidv7();
    await sql(
      `insert into eventos_recebidos (evento_id, terminal_id, loja_id, sequencia_terminal, tipo, versao_schema,
         agregado_tipo, agregado_id, ocorrido_em, payload_sha256, status)
       values ($1, $2, $3, 1, 'venda.finalizada', 1, 'venda', $1, now(), repeat('0', 64), 'erro')`,
      [evento, terminalId, loja],
    );
    expect(await item('terminais.fila_decisao')).toMatchObject({
      situacao: 'aviso',
      linkErp: `/cadastros/pdvs/${terminalId}?aba=eventos`,
    });
    await sql("update eventos_recebidos set status = 'descartado' where evento_id = $1", [evento]);
    expect(await situacao('terminais.fila_decisao')).toBe('ok');

    const [alerta] = await sql(
      `insert into alertas (tipo, severidade, titulo, loja_id, entidade, registro_id)
       values ('LACUNA_DECLARADA', 'critico', 'Lacuna declarada', $1, 'terminais', $2) returning id`,
      [loja, terminalId],
    );
    expect(await situacao('terminais.lacuna')).toBe('aviso');
    await sql('update alertas set resolvido_em = now() where id = $1', [alerta!.id]);
    expect(await situacao('terminais.lacuna')).toBe('ok');

    // Caixa de ontem esquecido aberto (O1b): passa de `pdv.horas_alerta_sessao` (24 h).
    const [s] = await sql(
      `insert into sessoes_caixa (loja_id, caixa_id, numero_caixa, terminal_id, operador_id, dia_operacional, aberta_em)
       values ($1, $2, 1, $3, $4, current_date - 2, now() - interval '30 hours') returning id`,
      [loja, caixaId, terminalId, operadorId],
    );
    expect(await item('loja.dia_operacional')).toMatchObject({
      situacao: 'aviso',
      linkErp: '/financeiro/fechamentos-caixa',
    });
    await sql("update sessoes_caixa set status = 'fechada', fechada_em = now() where id = $1", [s!.id]);
    expect(await situacao('loja.dia_operacional')).toBe('ok');
  });

  it('operação da nuvem: backup registrado no controle e tarefas atrasadas', async () => {
    const [b] = await consultar(
      amb.bancoControle,
      `insert into backups_empresas (empresa_id, chave_armazenamento, sha256, status, iniciado_em, concluido_em)
       values ($1, 'backups/x.dump', repeat('b', 64), 'concluido', now() - interval '2 hours', now() - interval '1 hour')
       returning id`,
      [emp.empresaId],
    );
    expect(await item('operacao.backup')).toMatchObject({
      situacao: 'ok',
      mensagem: 'Último backup concluído há 1 h.',
    });
    await consultar(
      amb.bancoControle,
      "update backups_empresas set concluido_em = now() - interval '30 hours' where id = $1",
      [b!.id],
    );
    expect(await situacao('operacao.backup')).toBe('aviso');
    await consultar(amb.bancoControle, 'update backups_empresas set concluido_em = now() where id = $1', [
      b!.id,
    ]);
    expect(await situacao('operacao.backup')).toBe('ok');
    // O último backup falhou (o anterior concluído não salva): aviso com o status.
    const [f] = await consultar(
      amb.bancoControle,
      `insert into backups_empresas (empresa_id, status, iniciado_em) values ($1, 'falhou', now()) returning id`,
      [emp.empresaId],
    );
    expect(await item('operacao.backup')).toMatchObject({ situacao: 'aviso' });
    expect((await item('operacao.backup')).mensagem).toMatch(/"falhou"/);
    await consultar(amb.bancoControle, 'delete from backups_empresas where id = $1', [f!.id]);
    expect(await situacao('operacao.backup')).toBe('ok');

    const [t] = await sql(
      `insert into tarefas (tipo, status, usuario_id, criado_em) values ('importacao_produtos', 'na_fila', $1, now() - interval '10 minutes')
       returning id`,
      [adminId],
    );
    expect(await situacao('operacao.tarefas')).toBe('aviso');
    await sql("update tarefas set status = 'concluida', concluida_em = now() where id = $1", [t!.id]);
    expect(await situacao('operacao.tarefas')).toBe('ok');

    // pg-boss (sem trabalhador neste ambiente): o banco de controle é um só, mas só contam os trabalhos desta empresa
    // e os recorrentes da plataforma; o `genesis-tarefa` já conta pela linha `tarefas`.
    await amb.servicos.fila.iniciar();
    await amb.servicos.fila.enviar(FILAS.mensagem, { empresaId: uuidv7(), mensagemId: uuidv7() });
    await amb.servicos.fila.enviar(FILAS.tarefa, { empresaId: emp.empresaId, tarefaId: uuidv7() });
    const atrasar = () =>
      consultar(amb.bancoControle, "update pgboss.job set start_after = now() - interval '10 minutes'");
    await atrasar();
    expect(await situacao('operacao.tarefas')).toBe('ok');
    await amb.servicos.fila.enviar(FILAS.mensagem, { empresaId: emp.empresaId, mensagemId: uuidv7() });
    await atrasar();
    expect(await item('operacao.tarefas')).toMatchObject({ situacao: 'aviso', linkErp: null });
    expect((await item('operacao.tarefas')).mensagem).toMatch(/^1 tarefa está na fila/);
    await consultar(amb.bancoControle, 'delete from pgboss.job');
    await amb.servicos.fila.enviar(FILAS.manutencaoTerminais, {});
    await atrasar();
    expect(await situacao('operacao.tarefas')).toBe('aviso');
    await consultar(amb.bancoControle, 'delete from pgboss.job');
    expect(await situacao('operacao.tarefas')).toBe('ok');
  });

  it('tudo resolvido: a loja fica pronta (os avisos restantes não impedem)', async () => {
    const p = await prontidao();
    expect(
      p.itens.filter((i) => i.situacao === 'falta'),
      JSON.stringify(p.itens.filter((i) => i.situacao !== 'ok')),
    ).toEqual([]);
    expect(p.pronta).toBe(true);
    expect(p.resumo.ok).toBe(p.itens.length - p.resumo.aviso);
  });

  it('sem terminais.ver, o estado dos PDVs fica de fora (um aviso só)', async () => {
    const [perfil] = await sql(
      "insert into perfis (nome, descricao, chave_sistema) values ('Só configurações', 'teste', 'teste_config') returning id",
    );
    await sql("insert into perfis_permissoes (perfil_id, permissao) values ($1, 'configuracoes.ver')", [
      perfil!.id,
    ]);
    await criarUsuario(emp.nomeBanco, { login: 'config1', perfil: 'teste_config', lojas: [loja] });
    const p = await prontidao(await amb.entrar(emp.codigo, 'config1', SENHA_TESTE));
    const terminais = p.itens.filter((i) => i.grupo === 'terminais');
    expect(terminais).toEqual([
      expect.objectContaining({ codigo: 'terminais.sem_permissao', situacao: 'aviso', linkErp: null }),
    ]);
    expect(JSON.stringify(p)).not.toMatch(/caixa 01|Versão:/);
  });

  it('permissão (configuracoes.ver), loja permitida e loja inexistente', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'estoquista1', perfil: 'estoquista', lojas: [loja] });
    const estoquista = await amb.entrar(emp.codigo, 'estoquista1', SENHA_TESTE);
    const r1 = await amb.http().get(`/api/implantacao/prontidao?lojaId=${loja}`).set(bearer(estoquista));
    expect(r1.status).toBe(403);

    await criarUsuario(emp.nomeBanco, { login: 'gerente3', perfil: 'gerente', lojas: [loja] });
    const gerente = await amb.entrar(emp.codigo, 'gerente3', SENHA_TESTE);
    expect((await prontidao(gerente)).lojaId).toBe(loja);
    const r2 = await amb.http().get(`/api/implantacao/prontidao?lojaId=${outraLoja}`).set(bearer(gerente));
    expect(r2.status).toBe(403);

    const r3 = await amb.http().get('/api/implantacao/prontidao').set(bearer(admin));
    expect(r3.status).toBe(422);
    const r4 = await amb.http().get(`/api/implantacao/prontidao?lojaId=${uuidv7()}`).set(bearer(admin));
    expect(r4.status).toBe(404);
  });
});
