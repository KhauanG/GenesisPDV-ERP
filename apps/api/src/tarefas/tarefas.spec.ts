import { describe, expect, it } from 'vitest';
import {
  COMPLEMENTO_INTERROMPIDA_PADRAO,
  LIMITE_SINAL_TAREFA_MS,
  MENSAGEM_TAREFA_INTERROMPIDA,
  SINAL_TAREFA_MS,
  TarefasSegundoPlano,
  VALIDADE_MAXIMA_DOWNLOAD_S,
  validadeDownloadS,
} from './tarefas.js';

/** Mensagem da tarefa interrompida (decisão 150): a genérica mais o complemento do tipo, que só o tipo sabe dar. */
describe('TarefasSegundoPlano.mensagemInterrompida', () => {
  const tarefas = () => new TarefasSegundoPlano({} as never, {} as never, {} as never, {} as never);
  const executor = () => Promise.resolve();

  it('tipo com complemento: a mensagem genérica e o complemento', () => {
    const t = tarefas();
    t.registrarTipo('importacao_produtos', executor, { seInterrompida: 'Importe a mesma planilha de novo.' });
    expect(t.mensagemInterrompida('importacao_produtos')).toBe(
      `${MENSAGEM_TAREFA_INTERROMPIDA} Importe a mesma planilha de novo.`,
    );
  });

  it('tipo sem complemento (ou desconhecido): a genérica, sem prometer que repetir é seguro', () => {
    const t = tarefas();
    t.registrarTipo('reprocessar_eventos', executor);
    for (const tipo of ['reprocessar_eventos', 'outro']) {
      expect(t.mensagemInterrompida(tipo)).toBe(
        `${MENSAGEM_TAREFA_INTERROMPIDA} ${COMPLEMENTO_INTERROMPIDA_PADRAO}`,
      );
      expect(t.mensagemInterrompida(tipo)).not.toMatch(/segur/);
    }
  });

  it('registrar de novo sem complemento tira o anterior', () => {
    const t = tarefas();
    t.registrarTipo('x', executor, { seInterrompida: 'Repita.' });
    t.registrarTipo('x', executor);
    expect(t.mensagemInterrompida('x')).toBe(
      `${MENSAGEM_TAREFA_INTERROMPIDA} ${COMPLEMENTO_INTERROMPIDA_PADRAO}`,
    );
  });

  it('o limite sem sinal cobre vários sinais perdidos', () => {
    expect(LIMITE_SINAL_TAREFA_MS / SINAL_TAREFA_MS).toBeGreaterThanOrEqual(4);
  });
});

/** Link do arquivo da tarefa (ERP 3.6): 7 dias, sem passar do fim do dia da retenção; vencida → sem link. */
describe('validadeDownloadS', () => {
  const agora = Date.parse('2026-11-07T21:30:00Z');

  it('arquivo novo (retenção de hoje + 7): os 7 dias inteiros', () => {
    expect(validadeDownloadS('2026-11-14', agora)).toBe(VALIDADE_MAXIMA_DOWNLOAD_S);
  });

  it('perto do fim da retenção: só até o fim do dia retencao_ate (UTC)', () => {
    expect(validadeDownloadS('2026-11-07', agora)).toBe(2.5 * 3600);
    expect(validadeDownloadS('2026-11-08', agora)).toBe(26.5 * 3600);
  });

  it('retenção vencida (até ontem, ou acabando agora) → null; sem retenção → 7 dias', () => {
    expect(validadeDownloadS('2026-11-06', agora)).toBeNull();
    expect(validadeDownloadS('2026-11-07', Date.parse('2026-11-08T00:00:00Z'))).toBeNull();
    expect(validadeDownloadS(null, agora)).toBe(VALIDADE_MAXIMA_DOWNLOAD_S);
  });
});
