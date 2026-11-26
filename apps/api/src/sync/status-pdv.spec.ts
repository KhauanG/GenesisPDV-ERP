/**
 * Quando a projeção `vendas_status_pdv` é gravada (F3-B10; MD 3.11.9; SYNC 16.3): a mudança da nuvem ou de outro
 * terminal grava; a do próprio terminal da venda só mantém em dia a linha que já existe; a venda sem terminal (a do
 * ERP, no caixa 0) não tem caixa que a leia. A gravação no banco está em `test/integracao/sync-fluxos-fase3.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { acaoStatusPdv } from './status-pdv.js';

const TERMINAL = '0190a000-0000-7000-8000-0000000000aa';
const OUTRO = '0190a000-0000-7000-8000-0000000000bb';

describe('acaoStatusPdv', () => {
  it('a nuvem (ERP, tarefa) e outro terminal gravam a linha', () => {
    expect(acaoStatusPdv(TERMINAL, 'nuvem')).toBe('gravar');
    expect(acaoStatusPdv(TERMINAL, { terminalId: OUTRO })).toBe('gravar');
  });

  it('o próprio terminal da venda só atualiza a linha que já existe (o id comparado sem a caixa das letras)', () => {
    expect(acaoStatusPdv(TERMINAL, { terminalId: TERMINAL })).toBe('atualizar_existente');
    expect(acaoStatusPdv(TERMINAL, { terminalId: TERMINAL.toUpperCase() })).toBe('atualizar_existente');
  });

  it('venda sem terminal (do ERP, no caixa 0): nada', () => {
    expect(acaoStatusPdv(null, 'nuvem')).toBe('nada');
    expect(acaoStatusPdv(null, { terminalId: OUTRO })).toBe('nada');
  });
});
