/**
 * Tarefa interrompida (decisão 150; incidente de 04/11/2026: a importação parou em 903 de 1590 linhas quando o
 * processo da API reiniciou e o ERP mostrou "executando" para sempre). Com a fila pg-boss de verdade no banco de
 * controle do teste: a varredura no início da instância com trabalhador marca a órfã e não toca na viva nem na
 * `na_fila`; a retentativa de uma órfã marca `falhou` com a mensagem; a retentativa no mesmo processo (o pg-boss segura
 * o job enquanto o handler não volta) e a de uma tarefa com sinal recente não marcam nada; o sinal periódico mantém viva
 * a tarefa de outra instância que passa mais de 3 min sem progresso; a fila que já existia com 15 min passa a 1 h
 * no `iniciar` (`updateQueue`); a tarefa normal conclui.
 */
import { setTimeout as esperar } from 'node:timers/promises';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILAS, FilaTrabalhos, OPCOES_FILAS } from '../../src/infra/fila.js';
import { TAREFA_IMPORTACAO } from '../../src/importacao/importacao.js';
import {
  COMPLEMENTO_INTERROMPIDA_PADRAO,
  LIMITE_SINAL_TAREFA_MS,
  MENSAGEM_TAREFA_INTERROMPIDA,
  TarefasSegundoPlano,
} from '../../src/tarefas/tarefas.js';
import { consultar, criarAmbiente, urlDoBanco, type Ambiente, type EmpresaTeste } from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let usuarioId: string;
let boss: PgBoss;

interface LinhaTarefa {
  status: string;
  erro: string | null;
  resultado: unknown;
}

async function aguardar<T>(fn: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const fim = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > fim) throw new Error('tempo esgotado');
    await esperar(100);
  }
}

const contexto = async () =>
  amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);

/** Cria a tarefa (`na_fila`) pelo caminho normal, sem agendar. */
async function criarTarefa(tipo: string): Promise<string> {
  return amb.servicos.tenancy.executarNaEmpresa(await contexto(), () =>
    amb.servicos.tenancy.cx().transacao((tx) => amb.servicos.tarefas.criar(tx, { tipo, usuarioId })),
  );
}

/** Põe a tarefa em `executando`, com o último sinal há `minutos` (o processo que a executava morreu, ou não). */
async function executandoComSinal(tarefaId: string, minutos: number): Promise<void> {
  await consultar(
    emp.nomeBanco,
    `update tarefas set status = 'executando', progresso_pct = 57, mensagem = 'Linha 900 de 1590',
            iniciada_em = now() - make_interval(mins => $2 + 5), atualizado_em = now() - make_interval(mins => $2)
      where id = $1`,
    [tarefaId, minutos],
  );
}

async function tarefa(id: string): Promise<LinhaTarefa> {
  const [t] = await consultar<LinhaTarefa>(
    emp.nomeBanco,
    'select status, erro, resultado from tarefas where id = $1',
    [id],
  );
  return t!;
}

const terminada = (id: string) =>
  aguardar(async () => {
    const t = await tarefa(id);
    return t.status !== 'na_fila' && t.status !== 'executando' ? t : null;
  });

const mensagemImportacao = () => amb.servicos.tarefas.mensagemInterrompida(TAREFA_IMPORTACAO.produtos);

beforeAll(async () => {
  // Sem app: a fila só sobe no primeiro teste, depois das tarefas órfãs já gravadas (o "processo anterior").
  amb = await criarAmbiente({ comApp: false, env: { FILA_TRABALHADOR: 'true' } });
  emp = await amb.criarEmpresa();
  const [admin] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  );
  usuarioId = admin!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('varredura no início da instância com trabalhador', () => {
  it('marca a órfã com a mensagem do tipo e não toca na viva nem na `na_fila`', async () => {
    const orfa = await criarTarefa(TAREFA_IMPORTACAO.produtos);
    await executandoComSinal(orfa, 20);
    const viva = await criarTarefa(TAREFA_IMPORTACAO.produtos);
    await executandoComSinal(viva, 0);
    const naFila = await criarTarefa(TAREFA_IMPORTACAO.produtos);
    await consultar(
      emp.nomeBanco,
      "update tarefas set criado_em = now() - interval '1 hour', atualizado_em = now() - interval '1 hour' where id = $1",
      [naFila],
    );

    boss = await amb.servicos.fila.iniciar();
    const marcada = await terminada(orfa);
    expect(marcada).toEqual({ status: 'falhou', erro: mensagemImportacao(), resultado: null });
    expect(marcada.erro).toContain(MENSAGEM_TAREFA_INTERROMPIDA);
    expect(marcada.erro).toContain('Importe a mesma planilha de novo');
    // A varredura do início já rodou (o job está concluído): a viva e a da fila continuam como estavam. Só o job do
    // início conta: o do agendamento (`*/2`) também pode cair aqui, mas leva a chave da ocorrência (`singleton_key`).
    await aguardar(async () => {
      const [j] = await consultar<{ n: number }>(
        amb.bancoControle,
        "select count(*)::int as n from pgboss.job where name = $1 and singleton_key is null and state = 'completed'",
        [FILAS.tarefasInterrompidas],
      );
      return j!.n > 0;
    });
    expect((await tarefa(viva)).status).toBe('executando');
    expect((await tarefa(naFila)).status).toBe('na_fila');
    const [r] = await consultar<{ concluida: boolean }>(
      emp.nomeBanco,
      'select concluida_em is not null as concluida from tarefas where id = $1',
      [orfa],
    );
    expect(r!.concluida).toBe(true);
    // O mesmo critério roda a cada 2 min (pg-boss schedule) e a fila das tarefas expira em 1 h (updateQueue).
    const [agenda] = await consultar<{ cron: string }>(
      amb.bancoControle,
      'select cron from pgboss.schedule where name = $1',
      [FILAS.tarefasInterrompidas],
    );
    expect(agenda?.cron).toBe('*/2 * * * *');
    const [fila] = await consultar<{ expire_seconds: number }>(
      amb.bancoControle,
      'select expire_seconds from pgboss.queue where name = $1',
      [FILAS.tarefa],
    );
    expect(fila!.expire_seconds).toBe(3600);
  });

  it('a varredura direta: só a sem sinal há mais de 3 min; a de 2 min ainda é viva', async () => {
    const velha = await criarTarefa('importacao_clientes');
    await executandoComSinal(velha, 4);
    const recente = await criarTarefa('importacao_clientes');
    await executandoComSinal(recente, 2);
    const resumo = await amb.servicos.tarefasInterrompidas.executar();
    expect(resumo.falhas).toEqual([]);
    expect(resumo.empresas).toBeGreaterThanOrEqual(1);
    expect(await tarefa(velha)).toMatchObject({
      status: 'falhou',
      erro: amb.servicos.tarefas.mensagemInterrompida('importacao_clientes'),
    });
    expect((await tarefa(recente)).status).toBe('executando');
  });
});

describe('retentativa (Tarefas.executar com a tarefa já executando)', () => {
  it('órfã: o job repetido pela fila marca `falhou` com a mensagem', async () => {
    const id = await criarTarefa(TAREFA_IMPORTACAO.produtos);
    await executandoComSinal(id, 16);
    // Quem marca tem de ser a retentativa (com o id), não a varredura agendada (`*/2`) que caísse na espera.
    const tarefas = amb.servicos.tarefas;
    const original = tarefas.marcarInterrompidas.bind(tarefas);
    const pelaRetentativa: string[] = [];
    tarefas.marcarInterrompidas = async (cx, ids) => {
      const marcadas = await original(cx, ids);
      if (ids) pelaRetentativa.push(...marcadas.map((t) => t.id));
      return marcadas;
    };
    try {
      // O job do processo que morreu, expirado e repetido pelo pg-boss.
      await tarefas.agendar(emp.empresaId, id);
      expect(await terminada(id)).toEqual({ status: 'falhou', erro: mensagemImportacao(), resultado: null });
      expect(pelaRetentativa).toEqual([id]);
    } finally {
      Reflect.deleteProperty(tarefas, 'marcarInterrompidas');
    }
  });

  it('sinal recente (executando em outra instância): não marca', async () => {
    const id = await criarTarefa(TAREFA_IMPORTACAO.produtos);
    await executandoComSinal(id, 0);
    await amb.servicos.tarefas.executar(emp.empresaId, id, 1);
    expect((await tarefa(id)).status).toBe('executando');
  });

  it('tipo sem complemento próprio: mensagem genérica, sem prometer repetição segura', async () => {
    amb.servicos.tarefas.registrarTipo('teste_sem_complemento', () => Promise.resolve());
    const id = await criarTarefa('teste_sem_complemento');
    await executandoComSinal(id, 10);
    await amb.servicos.tarefas.executar(emp.empresaId, id, 2);
    expect((await tarefa(id)).erro).toBe(
      `${MENSAGEM_TAREFA_INTERROMPIDA} ${COMPLEMENTO_INTERROMPIDA_PADRAO}`,
    );
  });

  it('handler ainda rodando neste processo: nem a retentativa nem a varredura marcam, e ela conclui', async () => {
    let liberar!: () => void;
    const solta = new Promise<void>((ok) => (liberar = ok));
    amb.servicos.tarefas.registrarTipo('teste_preso', async ({ progresso }) => {
      await progresso(10, 'trabalhando');
      await solta;
      return { resultado: { ok: true } };
    });
    const id = await criarTarefa('teste_preso');
    const rodando = amb.servicos.tarefas.executar(emp.empresaId, id);
    await aguardar(async () => (await tarefa(id)).status === 'executando');
    // Mesmo com o sinal parado (laço de eventos travado, banco lento), a tarefa deste processo não é órfã.
    await consultar(
      emp.nomeBanco,
      "update tarefas set atualizado_em = now() - interval '30 minutes' where id = $1",
      [id],
    );
    await amb.servicos.tarefas.executar(emp.empresaId, id, 1);
    expect((await amb.servicos.tarefasInterrompidas.executar()).falhas).toEqual([]);
    expect((await tarefa(id)).status).toBe('executando');
    expect(amb.servicos.tarefas.emExecucaoLocal()).toContain(id);
    liberar();
    await rodando;
    expect(await tarefa(id)).toEqual({ status: 'concluida', erro: null, resultado: { ok: true } });
    expect(amb.servicos.tarefas.emExecucaoLocal()).not.toContain(id);
  });

  it('o pg-boss segura a retentativa do job expirado até o handler voltar (handler overrun): ela só roda depois e não marca nada', async () => {
    const avisos: Array<{ message: string; data: { type?: string; queue?: string } }> = [];
    const ouvir = (a: { message: string; data: object }) => avisos.push(a as (typeof avisos)[number]);
    boss.on('warning', ouvir);
    // Expira em 2 s só para este teste; o executor leva 4 s.
    await boss.updateQueue(FILAS.tarefa, { expireInSeconds: 2 });
    let execucoes = 0;
    let fimExecutor: number | null = null;
    let inicioRetentativa: number | null = null;
    amb.servicos.tarefas.registrarTipo('teste_lento', async () => {
      execucoes++;
      await esperar(4_000);
      fimExecutor = Date.now();
      return { resultado: { lento: true } };
    });
    // O instante em que a fila entrega a retentativa (`job.retryCount` ≥ 1) ao `executar`.
    const tarefas = amb.servicos.tarefas;
    const original = tarefas.executar.bind(tarefas);
    tarefas.executar = (empresaId, tarefaId, tentativa = 0) => {
      if (tentativa >= 1) inicioRetentativa ??= Date.now();
      return original(empresaId, tarefaId, tentativa);
    };
    try {
      const id = await criarTarefa('teste_lento');
      await amb.servicos.tarefas.agendar(emp.empresaId, id);
      // O job expirou (2 s) e voltou como retentativa; quando ela roda, a tarefa já concluiu.
      const job = await aguardar(async () => {
        const [j] = await consultar<{ state: string; retry_count: number }>(
          amb.bancoControle,
          "select state, retry_count from pgboss.job where name = $1 and data->>'tarefaId' = $2",
          [FILAS.tarefa, id],
        );
        return j && j.retry_count >= 1 && j.state === 'completed' ? j : null;
      }, 90_000);
      expect(job.retry_count).toBeGreaterThanOrEqual(1);
      expect(await tarefa(id)).toEqual({ status: 'concluida', erro: null, resultado: { lento: true } });
      expect(execucoes).toBe(1);
      // A retentativa chegou ao `executar` só depois que o executor do job original terminou.
      expect(fimExecutor).not.toBeNull();
      expect(inicioRetentativa).not.toBeNull();
      expect(inicioRetentativa!).toBeGreaterThanOrEqual(fimExecutor!);
      expect(avisos.some((a) => a.data.type === 'handler_overrun' && a.data.queue === FILAS.tarefa)).toBe(
        true,
      );
    } finally {
      Reflect.deleteProperty(tarefas, 'executar');
      boss.off('warning', ouvir);
      await boss.updateQueue(FILAS.tarefa, OPCOES_FILAS[FILAS.tarefa]);
    }
  }, 120_000);
});

describe('último sinal periódico', () => {
  it('a tarefa de outra instância, sem progresso por mais de 3 min, segue com sinal recente e a varredura não a marca', async () => {
    // A "outra instância": a mesma fila e o mesmo banco, a lista local à parte e o sinal a cada 200 ms.
    const outra = new TarefasSegundoPlano(
      amb.servicos.tenancy,
      amb.servicos.resolvedor,
      amb.servicos.fila,
      amb.servicos.armazenamento,
      { sinalMs: 200 },
    );
    let liberar!: () => void;
    const solta = new Promise<void>((ok) => (liberar = ok));
    // Preso sem chamar `progresso` (leitura da planilha, acerto final, linha esperando a trava…).
    const executor = async () => {
      await solta;
      return { resultado: { ok: true } };
    };
    outra.registrarTipo('teste_sem_progresso', executor);
    // `criar` confere o tipo na instância que cria; quem executa (sem passar pela fila) é a outra.
    amb.servicos.tarefas.registrarTipo('teste_sem_progresso', executor);
    const id = await criarTarefa('teste_sem_progresso');
    const rodando = outra.executar(emp.empresaId, id);
    await aguardar(async () => (await tarefa(id)).status === 'executando');
    expect(outra.emExecucaoLocal()).toContain(id);
    expect(amb.servicos.tarefas.emExecucaoLocal()).not.toContain(id);
    // Último sinal meio segundo antes do limite: sem a renovação, ela já seria órfã quando a varredura rodar abaixo
    // (e nenhuma varredura agendada a pega antes do sinal chegar).
    await consultar(
      emp.nomeBanco,
      'update tarefas set atualizado_em = now() - make_interval(secs => $2) where id = $1',
      [id, LIMITE_SINAL_TAREFA_MS / 1000 - 0.5],
    );
    const sinal = async () => {
      const [t] = await consultar<{ ms: number }>(
        emp.nomeBanco,
        'select (extract(epoch from now() - atualizado_em) * 1000)::int as ms from tarefas where id = $1',
        [id],
      );
      return t!.ms;
    };
    await aguardar(async () => (await sinal()) < 5_000, 10_000);
    const [antes] = await consultar<{ em: string }>(
      emp.nomeBanco,
      'select atualizado_em::text as em from tarefas where id = $1',
      [id],
    );
    await esperar(1_000);
    // Continua renovando (não foi um sinal só).
    const [depois] = await consultar<{ em: string }>(
      emp.nomeBanco,
      'select atualizado_em::text as em from tarefas where id = $1',
      [id],
    );
    expect(depois!.em).not.toBe(antes!.em);
    expect(await sinal()).toBeLessThan(5_000);
    // A varredura desta instância (a tarefa não é dela) não marca, nem a retentativa que chegasse aqui.
    expect((await amb.servicos.tarefasInterrompidas.executar()).falhas).toEqual([]);
    await amb.servicos.tarefas.executar(emp.empresaId, id, 1);
    expect((await tarefa(id)).status).toBe('executando');
    liberar();
    await rodando;
    expect(await tarefa(id)).toEqual({ status: 'concluida', erro: null, resultado: { ok: true } });
    expect(outra.emExecucaoLocal()).not.toContain(id);
  });
});

describe('fila que já existia (produção)', () => {
  it('o `iniciar` aplica as opções do código à fila criada antes com 15 min (o `createQueue` não a altera)', async () => {
    const expiracao = async () => {
      const [f] = await consultar<{ expire_seconds: number }>(
        amb.bancoControle,
        'select expire_seconds from pgboss.queue where name = $1',
        [FILAS.tarefa],
      );
      return f!.expire_seconds;
    };
    // Como a fila ficou no banco de produção, criada pela versão anterior.
    await boss.updateQueue(FILAS.tarefa, { expireInSeconds: 15 * 60 });
    expect(await expiracao()).toBe(900);
    const outra = new FilaTrabalhos(urlDoBanco(amb.bancoControle), { trabalhador: false });
    try {
      await outra.iniciar();
      expect(await expiracao()).toBe(OPCOES_FILAS[FILAS.tarefa].expireInSeconds);
    } finally {
      await outra.parar();
      await boss.updateQueue(FILAS.tarefa, OPCOES_FILAS[FILAS.tarefa]);
    }
  });
});

describe('tarefa normal', () => {
  it('conclui pela fila, e o progresso renova o último sinal', async () => {
    let renovadoNoProgresso: boolean | null = null;
    amb.servicos.tarefas.registrarTipo('teste_normal', async ({ tarefa: t, progresso }) => {
      // Sinal velho já durante a execução (o início também grava o sinal): só o `progresso` o renova aqui.
      await consultar(
        emp.nomeBanco,
        "update tarefas set atualizado_em = now() - interval '1 hour' where id = $1",
        [t.id],
      );
      await progresso(50, 'metade');
      const [r] = await consultar<{ recente: boolean }>(
        emp.nomeBanco,
        "select atualizado_em > now() - interval '10 seconds' as recente from tarefas where id = $1",
        [t.id],
      );
      renovadoNoProgresso = r!.recente;
      return { resultado: { linhas: 3 } };
    });
    const id = await criarTarefa('teste_normal');
    await amb.servicos.tarefas.agendar(emp.empresaId, id);
    expect(await terminada(id)).toEqual({ status: 'concluida', erro: null, resultado: { linhas: 3 } });
    expect(renovadoNoProgresso).toBe(true);
  });
});
