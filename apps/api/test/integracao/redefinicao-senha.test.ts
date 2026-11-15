/**
 * Link de redefinição de senha preso à credencial e ao e-mail atuais (ERP 4.3; MD 3.3.6; README da API › decisão
 * 206): toda troca de senha (própria, pelo administrador, pelo próprio link) e toda troca de e-mail, inativação ou
 * exclusão do usuário invalidam os links pendentes; o resgate recusa o link criado antes da última troca de senha; o
 * envio (trabalhador da fila) relê o usuário e não manda o link para um e-mail que não é mais o dele.
 *
 * O envio roda aqui direto (`enviarRedefinicao`) com um enviador de e-mail falso: o teste decide quando ele falha e
 * pode mexer no banco no meio do envio (gancho por endereço).
 */
import { setTimeout as esperar } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedefinicaoSenha } from '../../src/auth/redefinicao-senha.js';
import type { Email, EnviadorEmail } from '../../src/infra/email.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { gerarHashSenha } from '../../src/seguranca/senhas.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
let envio: RedefinicaoSenha;
const caixa: Email[] = [];
/** Endereços que recusam a próxima entrega (falha temporária do SMTP). */
const recusar = new Set<string>();
/** Gancho de uma vez por endereço, chamado no envio antes da entrega ou da recusa (ex.: cancelar a mensagem). */
const ganchos = new Map<string, (e: Email) => Promise<void>>();

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const email = {
    async enviar(e: Email) {
      const gancho = ganchos.get(e.para);
      ganchos.delete(e.para);
      await gancho?.(e);
      if (recusar.delete(e.para)) throw new Error('450 caixa temporariamente indisponível');
      caixa.push(e);
    },
  } as unknown as EnviadorEmail;
  const s = amb.servicos;
  envio = new RedefinicaoSenha(amb.config, s.tenancy, s.resolvedor, s.auditoria, s.fila, email);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

async function novoAlvo(login: string, email: string): Promise<string> {
  const id = await criarUsuario(emp.nomeBanco, { login, master: true });
  await consultar(emp.nomeBanco, 'update usuarios set email = $2, senha_provisoria = false where id = $1', [
    id,
    email,
  ]);
  return id;
}

/** Último link mandado para o endereço (o segredo só existe no e-mail). */
function linkPara(para: string): string | undefined {
  const m = [...caixa].reverse().find((e) => e.para === para);
  const t = m && /redefinir-senha\?token=(\S+)/.exec(m.texto)?.[1];
  return t ? decodeURIComponent(t) : undefined;
}

/** "Esqueci minha senha" + o envio pelo trabalhador; devolve o id da mensagem. */
async function pedir(login: string, usuarioId: string): Promise<string> {
  // Sai da janela anti-spam (2 min) dos pedidos anteriores do mesmo usuário.
  await consultar(
    emp.nomeBanco,
    "update mensagens_enviadas set criado_em = criado_em - interval '5 minutes' where registro_id = $1",
    [usuarioId],
  );
  const r = await amb.http().post('/api/auth/esqueci-senha').send({ codigoEmpresa: emp.codigo, login });
  expect(r.status).toBe(200);
  const [m] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `select id from mensagens_enviadas
      where registro_id = $1 and template_tipo = 'redefinicao_senha' and status = 'pendente'
      order by criado_em desc limit 1`,
    [usuarioId],
  );
  return m!.id;
}

async function enviar(mensagemId: string): Promise<void> {
  await envio.enviarRedefinicao(emp.empresaId, mensagemId);
}

async function pedirLink(login: string, usuarioId: string, email: string): Promise<string> {
  await enviar(await pedir(login, usuarioId));
  return linkPara(email)!;
}

const resgatar = (token: string, novaSenha = 'OutraSenha123') =>
  amb.http().post('/api/auth/redefinir-senha').send({ token, novaSenha });

async function detalhe(id: string) {
  const r = await amb.http().get(`/api/usuarios/${id}`).set(bearer(tokenAdmin));
  expect(r.status).toBe(200);
  const { id: _id, versao, ...corpo } = r.body as Record<string, unknown> & { versao: number };
  return { corpo, versao };
}

async function statusDaMensagem(id: string): Promise<string> {
  const [m] = await consultar<{ status: string }>(
    emp.nomeBanco,
    'select status from mensagens_enviadas where id = $1',
    [id],
  );
  return m!.status;
}

/** Espera `n` conexões do banco paradas numa trava (a mesma espera do `auth.test.ts`). */
async function aguardarEspera(n: number): Promise<void> {
  const fim = Date.now() + 10_000;
  for (;;) {
    const [r] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (r!.n >= n) return;
    if (Date.now() > fim) throw new Error(`esperava ${n} requisições na trava`);
    await esperar(20);
  }
}

async function pendentes(usuarioId: string): Promise<number> {
  const [n] = await consultar<{ n: number }>(
    emp.nomeBanco,
    'select count(*)::int as n from redefinicoes_senha where usuario_id = $1 and usado_em is null',
    [usuarioId],
  );
  return n!.n;
}

describe('link de redefinição preso à credencial e ao e-mail atuais', () => {
  it('controle: o link vale uma vez e troca a senha', async () => {
    const id = await novoAlvo('controle', 'controle@exemplo.test');
    const t = await pedirLink('controle', id, 'controle@exemplo.test');
    expect((await resgatar(t)).status).toBe(200);
    expect((await resgatar(t)).status).toBe(422);
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'controle', senha: 'OutraSenha123' });
    expect(login.status).toBe(200);
  });

  it('troca de e-mail pelo administrador invalida o link mandado ao e-mail anterior', async () => {
    const id = await novoAlvo('alvo-email', 'antigo@exemplo.test');
    const t = await pedirLink('alvo-email', id, 'antigo@exemplo.test');
    const { corpo, versao } = await detalhe(id);
    const put = await amb
      .http()
      .put(`/api/usuarios/${id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, email: 'novo@exemplo.test' });
    expect(put.status).toBe(200);
    expect(await pendentes(id)).toBe(0);
    const r = await resgatar(t);
    expect(r.status).toBe(422);
    expect(r.body.campos.token).toBeDefined();
    // A senha continua a de antes.
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'alvo-email', senha: SENHA_TESTE });
    expect(login.status).toBe(200);
  });

  it('alterar outro campo do usuário (sem mexer no e-mail) mantém o link', async () => {
    const id = await novoAlvo('alvo-telefone', 'telefone@exemplo.test');
    const t = await pedirLink('alvo-telefone', id, 'telefone@exemplo.test');
    const { corpo, versao } = await detalhe(id);
    const put = await amb
      .http()
      .put(`/api/usuarios/${id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, telefone: '11999990000' });
    expect(put.status).toBe(200);
    expect((await resgatar(t)).status).toBe(200);
  });

  it('a senha provisória gerada pelo administrador invalida o link e conta como troca de senha', async () => {
    const id = await novoAlvo('alvo-admin', 'admin-reset@exemplo.test');
    const t = await pedirLink('alvo-admin', id, 'admin-reset@exemplo.test');
    const reset = await amb.http().post(`/api/usuarios/${id}/redefinir-senha`).set(bearer(tokenAdmin));
    expect(reset.status).toBe(200);
    const provisoria = reset.body.senhaProvisoria as string;
    expect(await pendentes(id)).toBe(0);
    const [u] = await consultar<{ alterada: boolean }>(
      emp.nomeBanco,
      'select senha_alterada_em is not null as alterada from usuarios where id = $1',
      [id],
    );
    expect(u!.alterada).toBe(true);
    expect((await resgatar(t)).status).toBe(422);
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'alvo-admin', senha: provisoria });
    expect(login.status).toBe(200);
  });

  it('a troca da própria senha invalida o link pendente', async () => {
    const id = await novoAlvo('alvo-troca', 'troca@exemplo.test');
    const t = await pedirLink('alvo-troca', id, 'troca@exemplo.test');
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'alvo-troca', senha: SENHA_TESTE });
    const troca = await amb
      .http()
      .post('/api/auth/trocar-senha')
      .set(bearer(login.body.tokenAcesso as string))
      .send({ senhaAtual: SENHA_TESTE, novaSenha: 'PropriaNova123' });
    expect(troca.status).toBe(200);
    expect(await pendentes(id)).toBe(0);
    expect((await resgatar(t)).status).toBe(422);
  });

  it('usar um link invalida os outros pendentes do mesmo usuário', async () => {
    const id = await novoAlvo('alvo-irmao', 'irmao@exemplo.test');
    // Dois pedidos: a mensagem do primeiro só é mandada depois do segundo pedido (fila atrasada).
    const m1 = await pedir('alvo-irmao', id);
    const m2 = await pedir('alvo-irmao', id);
    await enviar(m1);
    const t1 = linkPara('irmao@exemplo.test')!;
    await enviar(m2);
    const t2 = linkPara('irmao@exemplo.test')!;
    expect(t2).not.toBe(t1);
    // Vale só o link mais novo: o envio do segundo invalidou o primeiro.
    expect((await resgatar(t1)).status).toBe(422);
    expect((await resgatar(t2)).status).toBe(200);
    expect(await pendentes(id)).toBe(0);
  });

  it('o resgate de um link invalida os irmãos ainda pendentes', async () => {
    const id = await novoAlvo('alvo-irmao2', 'irmao2@exemplo.test');
    const t1 = await pedirLink('alvo-irmao2', id, 'irmao2@exemplo.test');
    // Um segundo link pendente gravado fora do envio normal (ex.: corrida com outro trabalhador).
    await consultar(
      emp.nomeBanco,
      `insert into redefinicoes_senha (usuario_id, token_hash, expira_em)
       values ($1, md5(random()::text) || md5(random()::text), now() + interval '1 hour')`,
      [id],
    );
    expect(await pendentes(id)).toBe(2);
    expect((await resgatar(t1)).status).toBe(200);
    expect(await pendentes(id)).toBe(0);
  });

  it('link criado antes da última troca de senha é recusado mesmo sem ter sido marcado', async () => {
    const id = await novoAlvo('alvo-antes', 'antes@exemplo.test');
    const t = await pedirLink('alvo-antes', id, 'antes@exemplo.test');
    // Troca de senha que não passou pela invalidação (gravação concorrente, rotina antiga).
    await consultar(
      emp.nomeBanco,
      "update usuarios set senha_alterada_em = now() + interval '1 second' where id = $1",
      [id],
    );
    expect(await pendentes(id)).toBe(1);
    expect((await resgatar(t)).status).toBe(422);
  });

  it('inativar ou excluir o usuário invalida o link; usuário inativo não resgata', async () => {
    const id = await novoAlvo('alvo-inativo', 'inativo@exemplo.test');
    const t = await pedirLink('alvo-inativo', id, 'inativo@exemplo.test');
    const { corpo, versao } = await detalhe(id);
    const put = await amb
      .http()
      .put(`/api/usuarios/${id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, ativo: false });
    expect(put.status).toBe(200);
    expect(await pendentes(id)).toBe(0);
    expect((await resgatar(t)).status).toBe(422);

    const id2 = await novoAlvo('alvo-excluido', 'excluido@exemplo.test');
    const t2 = await pedirLink('alvo-excluido', id2, 'excluido@exemplo.test');
    expect((await amb.http().delete(`/api/usuarios/${id2}`).set(bearer(tokenAdmin))).status).toBe(204);
    expect(await pendentes(id2)).toBe(0);
    expect((await resgatar(t2)).status).toBe(422);

    // Inativado direto no banco (sem a invalidação): o resgate confere o usuário.
    const id3 = await novoAlvo('alvo-inativo2', 'inativo2@exemplo.test');
    const t3 = await pedirLink('alvo-inativo2', id3, 'inativo2@exemplo.test');
    await consultar(emp.nomeBanco, 'update usuarios set ativo = false where id = $1', [id3]);
    expect((await resgatar(t3)).status).toBe(422);
  });

  it('nova tentativa do envio depois da troca de e-mail não manda o link ao e-mail anterior', async () => {
    const id = await novoAlvo('alvo-fila', 'fila-antigo@exemplo.test');
    const m = await pedir('alvo-fila', id);
    recusar.add('fila-antigo@exemplo.test');
    await expect(enviar(m)).rejects.toThrow(/450/);
    const { corpo, versao } = await detalhe(id);
    const put = await amb
      .http()
      .put(`/api/usuarios/${id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, email: 'fila-novo@exemplo.test' });
    expect(put.status).toBe(200);
    // A fila tenta de novo: nada sai, a mensagem fica cancelada e nenhum link fica pendente.
    await enviar(m);
    expect(caixa.some((e) => e.para === 'fila-antigo@exemplo.test')).toBe(false);
    expect(caixa.some((e) => e.para === 'fila-novo@exemplo.test')).toBe(false);
    expect(await statusDaMensagem(m)).toBe('cancelada');
    expect(await pendentes(id)).toBe(0);
  });

  it('nova tentativa do envio sem mudança vale só com o link da última tentativa', async () => {
    const id = await novoAlvo('alvo-fila2', 'fila2@exemplo.test');
    const m = await pedir('alvo-fila2', id);
    recusar.add('fila2@exemplo.test');
    await expect(enviar(m)).rejects.toThrow(/450/);
    expect(await pendentes(id)).toBe(1);
    await enviar(m);
    expect(await pendentes(id)).toBe(1);
    const t = linkPara('fila2@exemplo.test')!;
    expect((await resgatar(t)).status).toBe(200);
  });

  it('troca de senha que termina durante o argon2 do resgate: a comparação no update de uso único recusa', async () => {
    const id = await novoAlvo('alvo-corrida', 'corrida@exemplo.test');
    const t = await pedirLink('alvo-corrida', id, 'corrida@exemplo.test');
    // Outra conexão segura a linha do usuário: o resgate passa da conferência em memória (a senha ainda não mudou),
    // faz o argon2 e para no `for update`; a troca de senha (sem a invalidação) é gravada antes de soltar.
    const trava = await conectar(emp.nomeBanco);
    try {
      await trava.query('begin');
      await trava.query('select id from usuarios where id = $1 for update', [id]);
      const resgate = resgatar(t).then((r) => r);
      await aguardarEspera(1);
      await trava.query('update usuarios set senha_alterada_em = clock_timestamp() where id = $1', [id]);
      await trava.query('commit');
      const r = await resgate;
      expect(r.status).toBe(422);
      expect(r.body.campos.token).toBeDefined();
    } finally {
      await trava.end();
    }
    // A senha continua a de antes.
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'alvo-corrida', senha: SENHA_TESTE });
    expect(login.status).toBe(200);
  });

  it('a mensagem cancelada durante o envio continua cancelada', async () => {
    const id = await novoAlvo('alvo-durante', 'durante@exemplo.test');
    const m = await pedir('alvo-durante', id);
    // Cancelada enquanto o SMTP entrega (a troca de senha ou de e-mail que acontece nesse meio-tempo).
    ganchos.set('durante@exemplo.test', async () => {
      await consultar(emp.nomeBanco, "update mensagens_enviadas set status = 'cancelada' where id = $1", [m]);
    });
    await enviar(m);
    expect(caixa.some((e) => e.para === 'durante@exemplo.test')).toBe(true);
    expect(await statusDaMensagem(m)).toBe('cancelada');
  });

  it.each([
    [
      'o e-mail trocado',
      'reler-email',
      "update usuarios set email = 'reler-outro@exemplo.test' where id = $1",
    ],
    ['o usuário inativado', 'reler-inativo', 'update usuarios set ativo = false where id = $1'],
    [
      'a senha trocada',
      'reler-senha',
      "update usuarios set senha_alterada_em = now() + interval '1 second' where id = $1",
    ],
  ])(
    'a nova tentativa do envio relê o usuário no banco (%s sem passar pela invalidação)',
    async (_caso, login, mudanca) => {
      const destino = `${login}@exemplo.test`;
      const id = await novoAlvo(login, destino);
      const m = await pedir(login, id);
      // A primeira tentativa entrega o e-mail, mas o SMTP responde com erro: a fila vai tentar de novo.
      ganchos.set(destino, async (e) => {
        caixa.push(e);
      });
      recusar.add(destino);
      await expect(enviar(m)).rejects.toThrow(/450/);
      const t = linkPara(destino)!;
      expect(t).toBeDefined();
      expect(await pendentes(id)).toBe(1);
      expect(await statusDaMensagem(m)).toBe('pendente');
      // A mudança não passa pela invalidação (gravação concorrente, rotina antiga, importação).
      await consultar(emp.nomeBanco, mudanca, [id]);
      const antes = caixa.length;
      await enviar(m);
      // O próprio envio cancela: nada sai, e o link da tentativa anterior deixa de valer.
      expect(caixa.length).toBe(antes);
      expect(await statusDaMensagem(m)).toBe('cancelada');
      expect(await pendentes(id)).toBe(0);
      expect((await resgatar(t)).status).toBe(422);
    },
  );

  it('pedido feito antes de uma troca de senha não gera link quando a fila o processa depois', async () => {
    const id = await novoAlvo('alvo-fila3', 'fila3@exemplo.test');
    const m = await pedir('alvo-fila3', id);
    const reset = await amb.http().post(`/api/usuarios/${id}/redefinir-senha`).set(bearer(tokenAdmin));
    expect(reset.status).toBe(200);
    await enviar(m);
    expect(caixa.some((e) => e.para === 'fila3@exemplo.test')).toBe(false);
    expect(await pendentes(id)).toBe(0);
  });

  it('o "tentar novamente" do provisionamento, que gera outra senha provisória, invalida o link do administrador', async () => {
    const [admin] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    );
    await consultar(emp.nomeBanco, "update usuarios set email = 'adm@exemplo.test' where id = $1", [
      admin!.id,
    ]);
    const t = await pedirLink('admin', admin!.id, 'adm@exemplo.test');
    // A senha provisória anterior nunca foi exibida: o seed gera outra (README da API › provisionamento).
    await consultar(emp.nomeBanco, 'update usuarios set senha_provisoria = true where id = $1', [admin!.id]);
    const c = await conectar(emp.nomeBanco);
    try {
      const r = await posMigracaoEmpresa(
        c,
        {
          codigo: emp.codigo,
          razaoSocial: 'Empresa Teste Ltda',
          nomeFantasia: null,
          cnpj: '11222333000181',
          email: null,
          regime: 'simples_nacional',
        },
        {
          nome: 'ADMINISTRADOR',
          login: 'admin',
          email: 'adm@exemplo.test',
          senhaHash: await gerarHashSenha('Prov12345678'),
        },
      );
      expect(r.admin).toBe('senha_provisoria_redefinida');
    } finally {
      await c.end();
    }
    expect(await pendentes(admin!.id)).toBe(0);
    expect((await resgatar(t)).status).toBe(422);
  });
});
