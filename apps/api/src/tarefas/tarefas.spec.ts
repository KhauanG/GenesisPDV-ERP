import { describe, expect, it } from 'vitest';
import {
  COMPLEMENTO_INTERROMPIDA_PADRAO,
  LIMITE_SINAL_TAREFA_MS,
  MENSAGEM_TAREFA_INTERROMPIDA,
  SINAL_TAREFA_MS,
  TarefasSegundoPlano,
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
