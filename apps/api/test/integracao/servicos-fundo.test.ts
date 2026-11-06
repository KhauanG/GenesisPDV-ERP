/**
 * E-mail transacional, "esqueci minha senha" (ERP 4.3), tarefas em segundo plano (ERP 3.6) e armazenamento de objetos
 * com URL assinada (MD 3.1.6), com a fila pg-boss de verdade no banco de controle do teste. O SMTP é um servidor
 * local de captura (o papel do Mailpit em desenvolvimento).
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as esperar } from 'node:timers/promises';
import { MENSAGEM_ESQUECI_SENHA } from '@genesis/shared';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arquivos } from '../../src/database/empresa/schema/index.js';
import { chaveArquivo } from '../../src/infra/armazenamento.js';
import { FILAS, FilaTrabalhos } from '../../src/infra/fila.js';
import {
  consultar,
  criarAmbiente,
  SENHA_TESTE,
  urlDoBanco,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let smtp: SMTPServer;
let s3: S3Falso | null = null;
const caixaDeEntrada: Array<{ para: string; texto: string }> = [];

async function aguardar<T>(fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const fim = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > fim) throw new Error('tempo esgotado');
    await esperar(100);
  }
}

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, sessao, pronto) {
      const partes: Buffer[] = [];
      stream.on('data', (p: Buffer) => partes.push(p));
      stream.on('end', () => {
        caixaDeEntrada.push({
          para: sessao.envelope.rcptTo.map((r) => r.address).join(','),
          texto: Buffer.concat(partes).toString('utf8'),
        });
        pronto();
      });
    },
  });
  await new Promise<void>((ok) => smtp.listen(0, '127.0.0.1', ok));
  const porta = (smtp.server.address() as AddressInfo).port;
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      SMTP_URL: `smtp://127.0.0.1:${porta}`,
      FILA_TRABALHADOR: 'true',
      ERP_URL: 'http://erp.teste',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  await amb.entrar(emp.codigo, 'admin', emp.senha);
  await consultar(emp.nomeBanco, "update usuarios set email = 'admin@empresa.teste' where login = 'admin'");
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await new Promise<void>((ok) => smtp?.close(() => ok()));
  await s3?.fechar();
});

describe('esqueci minha senha (ERP 4.3)', () => {
  it('resposta igual para usuário inexistente; e-mail com link de uso único que expira', async () => {
    const pedir = (login: string) =>
      amb.http().post('/api/auth/esqueci-senha').send({ codigoEmpresa: emp.codigo, login });
    const inexistente = await pedir('ninguem');
    expect(inexistente.status).toBe(200);
    const existente = await pedir('ADMIN');
    expect(existente.status).toBe(200);
    expect(existente.body).toEqual(inexistente.body);
    expect(existente.body.mensagem).toBe(MENSAGEM_ESQUECI_SENHA);

    const email = await aguardar(async () => caixaDeEntrada.find((m) => m.para === 'admin@empresa.teste'));
    // Corpo em quoted-printable: junta as linhas quebradas e decodifica os =XX.
    const corpo = email.texto
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const token = decodeURIComponent(/redefinir-senha\?token=(\S+)/.exec(corpo)![1]!);
    expect(token).toMatch(new RegExp(`^${emp.codigo}\\.[A-Za-z0-9_-]{43}$`));
    // O SMTP recebe a mensagem antes de o trabalhador gravar o status "enviada": espera a gravação.
    const msg = await aguardar(async () => {
      const [m] = await consultar<{ status: string; destino: string }>(
        emp.nomeBanco,
        "select status, destino from mensagens_enviadas where template_tipo = 'redefinicao_senha'",
      );
      return m?.status === 'pendente' ? null : m;
    });
    expect(msg).toEqual({ status: 'enviada', destino: 'admin@empresa.teste' });
    // O segredo do link nunca fica gravado em claro.
    const [hash] = await consultar<{ token_hash: string }>(
      emp.nomeBanco,
      'select token_hash from redefinicoes_senha',
    );
    expect(hash!.token_hash).not.toContain(token.split('.')[1]);

    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const redefinir = (t: string) =>
      amb.http().post('/api/auth/redefinir-senha').send({ token: t, novaSenha: 'Redefinida123' });
    expect((await redefinir(token)).status).toBe(200);
    expect((await redefinir(token)).status).toBe(422);
    // A senha antiga não entra mais e as sessões abertas caíram.
    expect(
      (
        await amb
          .http()
          .post('/api/auth/login')
          .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE })
      ).status,
    ).toBe(401);
    expect(
      (await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${login.body.tokenAcesso}`)).status,
    ).toBe(401);
    const nova = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: 'Redefinida123' });
    expect(nova.status).toBe(200);
    // Pedido repetido logo em seguida não gera outro e-mail.
    await pedir('admin');
    await esperar(1500);
    expect(caixaDeEntrada.filter((m) => m.para === 'admin@empresa.teste')).toHaveLength(1);
  });
});

describe('tarefas em segundo plano e armazenamento de objetos (ERP 3.6; MD 3.1.6)', () => {
  it('executa a tarefa fora da requisição, grava o arquivo no S3 e devolve link assinado', async () => {
    // Empresa própria: não depende da senha redefinida no teste anterior.
    const emp = await amb.criarEmpresa();
    const token = await amb.entrar(emp.codigo, 'admin', emp.senha);
    const tarefas = amb.servicos.tarefas;
    tarefas.registrarTipo('teste_exportar', async ({ tarefa, progresso }) => {
      await progresso(50, 'gerando');
      const conteudo = Buffer.from(
        `codigo;nome\n1;${String((tarefa.parametros as { nome?: string }).nome)}\n`,
        'utf8',
      );
      const chave = chaveArquivo(emp.codigo, 'planilha_exportacao', 'csv');
      const { sha256, tamanhoBytes } = await amb.servicos.armazenamento.gravar(chave, conteudo, 'text/csv');
      const [a] = await amb.servicos.tenancy.cx().consulta((db) =>
        db
          .insert(arquivos)
          .values({
            chaveArmazenamento: chave,
            nomeOriginal: 'exportacao.csv',
            tipoMime: 'text/csv',
            tamanhoBytes,
            sha256,
            categoria: 'planilha_exportacao',
          })
          .returning({ id: arquivos.id }),
      );
      return { resultado: { linhas: 1 }, arquivoId: a!.id };
    });
    const [admin] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    );
    const contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
    const tarefaId = await amb.servicos.tenancy.executarNaEmpresa(contexto, () =>
      amb.servicos.tenancy
        .cx()
        .transacao((tx) =>
          tarefas.criar(tx, { tipo: 'teste_exportar', parametros: { nome: 'ÁGUA' }, usuarioId: admin!.id }),
        ),
    );
    await tarefas.agendar(contexto.empresaId, tarefaId);
    const linha = await aguardar(async () => {
      const [t] = await consultar<{ status: string; resultado: unknown }>(
        emp.nomeBanco,
        'select status, resultado from tarefas where id = $1',
        [tarefaId],
      );
      return t && t.status !== 'na_fila' && t.status !== 'executando' ? t : null;
    });
    expect(linha).toEqual({ status: 'concluida', resultado: { linhas: 1 } });

    const lista = await amb.http().get('/api/tarefas').set('Authorization', `Bearer ${token}`);
    expect(lista.status).toBe(200);
    const item = lista.body.itens.find((i: { id: string }) => i.id === tarefaId);
    expect(item).toMatchObject({ status: 'concluida', progressoPct: 100 });
    const url = new URL(item.download);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(7 * 86_400));
    expect(url.pathname).toMatch(
      new RegExp(`/emp/${emp.codigo}/planilha_exportacao/\\d{4}/\\d{2}/[0-9a-f-]+\\.csv$`),
    );
    const baixado = await fetch(item.download);
    expect(baixado.status).toBe(200);
    expect(await baixado.text()).toBe('codigo;nome\n1;ÁGUA\n');
  });
});

describe('trabalhos recorrentes (pg-boss schedule)', () => {
  it('a instância com trabalhador agenda a manutenção dos terminais (5 min) e a expiração da relevância (diária)', async () => {
    await amb.servicos.fila.iniciar();
    const agendas = await consultar<{ name: string; cron: string }>(
      amb.bancoControle,
      `select name, cron from pgboss.schedule
        where name in ('genesis-manutencao-terminais', 'genesis-expiracao-relevancia') order by name`,
    );
    expect(agendas).toEqual([
      { name: 'genesis-expiracao-relevancia', cron: '17 7 * * *' },
      { name: 'genesis-manutencao-terminais', cron: '*/5 * * * *' },
    ]);
  });

  it('a verificação do razão desligada remove o agendamento gravado quando esteve ligada (F2-B3)', async () => {
    const agendada = async () =>
      (
        await consultar<{ cron: string }>(
          amb.bancoControle,
          'select cron from pgboss.schedule where name = $1',
          [FILAS.verificacaoRazao],
        )
      ).map((a) => a.cron);
    // O ambiente sobe com `VERIFICACAO_RAZAO_CRON` vazia: nada agendado.
    await amb.servicos.fila.iniciar();
    expect(await agendada()).toEqual([]);
    // Ligada numa instância com trabalhador: o cron fica no banco, e sobrevive à instância.
    const ligada = new FilaTrabalhos(urlDoBanco(amb.bancoControle));
    ligada.agendar(FILAS.verificacaoRazao, '41 6 * * *');
    await ligada.iniciar();
    await ligada.parar();
    expect(await agendada()).toEqual(['41 6 * * *']);
    // Reiniciada com a variável vazia (o `criarServicos` chama `desagendar`): o agendamento sai.
    const desligada = new FilaTrabalhos(urlDoBanco(amb.bancoControle));
    desligada.desagendar(FILAS.verificacaoRazao);
    await desligada.iniciar();
    await desligada.parar();
    expect(await agendada()).toEqual([]);
  });

  it('um agendamento recusado pelo pg-boss vai para o log e não derruba a fila (F2-B3)', async () => {
    // A configuração já recusa o cron inválido no boot; aqui, o reforço do `iniciar()` se algum escapar.
    const fila = new FilaTrabalhos(urlDoBanco(amb.bancoControle));
    fila.agendar(FILAS.verificacaoRazao, '41 6 * *');
    try {
      await expect(fila.iniciar()).resolves.toBeDefined();
      await expect(fila.enviar(FILAS.verificacaoRazao, { teste: 'cron recusado' })).resolves.toBeUndefined();
      expect(
        await consultar(amb.bancoControle, 'select 1 from pgboss.schedule where name = $1', [
          FILAS.verificacaoRazao,
        ]),
      ).toEqual([]);
    } finally {
      await fila.parar();
    }
  });
});
