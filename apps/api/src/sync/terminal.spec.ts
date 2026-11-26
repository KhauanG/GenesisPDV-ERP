import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErroSync } from './erros.js';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import {
  AutenticacaoTerminal,
  JANELA_PROTOCOLO,
  lerCabecalhos,
  MESES_PROTOCOLO_ANTERIOR,
  MESES_PROTOCOLO_PUSH,
  PROTOCOLO_ATUAL,
  protocoloAceito,
  protocoloMinimo,
  type JanelaProtocolo,
} from './terminal.js';

/** Cabeçalhos válidos do protocolo (SYNC 2.2), com o protocolo trocável. */
function cabecalhos(protocolo: string | undefined) {
  return {
    ...(protocolo === undefined ? {} : { 'x-genesis-protocolo': protocolo }),
    'x-genesis-app-versao': '0.10.0',
    'x-genesis-plataforma': 'windows_x64',
    'x-requisicao-id': '0193a3c1-7b2e-7c00-8000-000000000001',
    'x-genesis-hora-local': '2026-11-26T10:00:00-03:00',
    'x-genesis-id-hardware': 'ABCDEF0123456789',
  };
}

function erro(f: () => unknown): ErroSync {
  try {
    f();
  } catch (e) {
    if (e instanceof ErroSync) return e;
    throw e;
  }
  throw new Error('não lançou');
}

describe('janela do protocolo (SYNC 17.2)', () => {
  it('hoje só existe o protocolo 1: o atual e o mínimo de todo endpoint', () => {
    expect(PROTOCOLO_ATUAL).toBe(1);
    expect(JANELA_PROTOCOLO.substituidoEm).toEqual({});
    for (const e of ['pull', 'push', 'heartbeat', 'ativar'] as const) expect(protocoloMinimo(e)).toBe(1);
  });

  it('X-Genesis-Protocolo: 0 é 426 PROTOCOLO_NAO_SUPORTADO em pull, heartbeat, push e na ativação', () => {
    for (const e of ['pull', 'heartbeat', 'push', 'ativar', 'estado', 'recuperar'] as const) {
      const r = erro(() => lerCabecalhos(cabecalhos('0'), e));
      expect(r).toMatchObject({
        codigo: 'PROTOCOLO_NAO_SUPORTADO',
        status: 426,
        detalhes: { protocolo_minimo: 1 },
      });
    }
  });

  it('o protocolo 1 passa; acima do atual é atendido como o atual (a API é implantada antes do PDV)', () => {
    expect(lerCabecalhos(cabecalhos('1'), 'push').protocolo).toBe(1);
    expect(lerCabecalhos(cabecalhos(' 1 '), 'pull').protocolo).toBe(1);
    expect(lerCabecalhos(cabecalhos('2'), 'pull').protocolo).toBe(2);
  });

  it('ausente, vazio, negativo ou não inteiro continua cabeçalho inválido (400), nunca vira o 0', () => {
    for (const p of [undefined, '', '   ', '-1', '1.5', 'um']) {
      const r = erro(() => lerCabecalhos(cabecalhos(p), 'pull'));
      expect(r).toMatchObject({ codigo: 'REQUISICAO_INVALIDA', status: 400 });
      expect(r.detalhes).toEqual({ cabecalhos: ['X-Genesis-Protocolo'] });
    }
  });

  it('mudança do F3-B5: o inteiro acima de Number.MAX_SAFE_INTEGER passou a ser 400 (antes, atendido como o atual)', () => {
    for (const p of ['9007199254740993', '1e21']) {
      const r = erro(() => lerCabecalhos(cabecalhos(p), 'pull'));
      expect(r).toMatchObject({ codigo: 'REQUISICAO_INVALIDA', status: 400 });
      expect(r.detalhes).toEqual({ cabecalhos: ['X-Genesis-Protocolo'] });
    }
  });

  // Uma janela futura: o 3 é o atual desde 01/01/2028; o 2 foi o atual de 01/01/2027 a 01/01/2028; o 1, até 01/01/2027.
  const futura: JanelaProtocolo = {
    atual: 3,
    substituidoEm: { 1: '2027-01-01T00:00:00Z', 2: '2028-01-01T00:00:00Z' },
  };
  const em = (iso: string) => new Date(iso);

  it('o anterior é atendido em todos os endpoints por 12 meses depois de deixar de ser o atual', () => {
    expect(MESES_PROTOCOLO_ANTERIOR).toBe(12);
    expect(protocoloAceito(2, 'pull', em('2028-12-31T23:59:59Z'), futura)).toBe(true);
    expect(protocoloAceito(2, 'heartbeat', em('2028-12-31T23:59:59Z'), futura)).toBe(true);
    expect(protocoloAceito(2, 'pull', em('2029-01-01T00:00:00Z'), futura)).toBe(false);
    expect(protocoloAceito(2, 'ativar', em('2029-01-01T00:00:00Z'), futura)).toBe(false);
    expect(protocoloMinimo('pull', em('2028-06-01T00:00:00Z'), futura)).toBe(2);
    expect(protocoloMinimo('pull', em('2029-06-01T00:00:00Z'), futura)).toBe(3);
  });

  it('o anterior ao anterior só no push, e até 18 meses depois de deixar de ser o atual', () => {
    expect(MESES_PROTOCOLO_PUSH).toBe(18);
    // O 1 deixou de ser o atual em 01/01/2027: push até 01/07/2028; pull nunca (já é o anterior ao anterior).
    expect(protocoloAceito(1, 'push', em('2028-06-30T23:59:59Z'), futura)).toBe(true);
    expect(protocoloAceito(1, 'push', em('2028-07-01T00:00:00Z'), futura)).toBe(false);
    expect(protocoloAceito(1, 'pull', em('2028-01-02T00:00:00Z'), futura)).toBe(false);
    expect(protocoloAceito(1, 'heartbeat', em('2028-01-02T00:00:00Z'), futura)).toBe(false);
    // O 2 no push: os mesmos 18 meses (vale além dos 12 do pull).
    expect(protocoloAceito(2, 'push', em('2029-06-30T23:59:59Z'), futura)).toBe(true);
    expect(protocoloAceito(2, 'push', em('2029-07-01T00:00:00Z'), futura)).toBe(false);
    expect(protocoloMinimo('push', em('2028-06-01T00:00:00Z'), futura)).toBe(1);
    expect(protocoloMinimo('push', em('2029-01-15T00:00:00Z'), futura)).toBe(2);
  });

  it('três atrás nunca, nem no push dentro do prazo; e o protocolo que nunca foi o atual (o 0) nunca', () => {
    const quatro: JanelaProtocolo = {
      atual: 4,
      substituidoEm: { ...futura.substituidoEm, 3: '2028-02-01T00:00:00Z' },
    };
    expect(protocoloAceito(1, 'push', em('2028-03-01T00:00:00Z'), quatro)).toBe(false);
    expect(protocoloAceito(2, 'push', em('2028-03-01T00:00:00Z'), quatro)).toBe(true);
    expect(protocoloAceito(0, 'push', em('2026-11-26T00:00:00Z'), futura)).toBe(false);
    expect(protocoloAceito(0, 'push', em('2026-11-26T00:00:00Z'))).toBe(false);
  });

  it('o leitor de cabeçalhos aplica a janela do endpoint informado (o push com o anterior ao anterior)', () => {
    const agora = em('2028-06-01T00:00:00Z');
    expect(lerCabecalhos(cabecalhos('1'), 'push', agora, futura).protocolo).toBe(1);
    for (const e of ['pull', 'heartbeat', 'estado', 'ativar'] as const) {
      expect(erro(() => lerCabecalhos(cabecalhos('1'), e, agora, futura))).toMatchObject({
        codigo: 'PROTOCOLO_NAO_SUPORTADO',
        status: 426,
        detalhes: { protocolo_minimo: 2 },
      });
    }
    expect(
      erro(() => lerCabecalhos(cabecalhos('1'), 'push', em('2028-07-01T00:00:00Z'), futura)),
    ).toMatchObject({
      codigo: 'PROTOCOLO_NAO_SUPORTADO',
      detalhes: { protocolo_minimo: 2 },
    });
  });

  describe('AutenticacaoTerminal.autenticar repassa o endpoint da rota à janela', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // A janela é conferida antes do token: sem `Authorization`, quem passa da janela para no 401 do token, sem banco.
    const auth = new AutenticacaoTerminal({} as never, {} as never, futura);
    const req = (protocolo: string) => ({ headers: cabecalhos(protocolo) }) as unknown as RequisicaoGenesis;

    it('o protocolo 1 em 06/2028: o push passa da janela; o pull e o heartbeat dão 426', async () => {
      vi.useFakeTimers({ now: em('2028-06-01T00:00:00Z'), toFake: ['Date'] });
      await expect(auth.autenticar(req('1'), 'push')).rejects.toMatchObject({ codigo: 'TOKEN_INVALIDO' });
      for (const e of ['pull', 'heartbeat'] as const) {
        await expect(auth.autenticar(req('1'), e)).rejects.toMatchObject({
          codigo: 'PROTOCOLO_NAO_SUPORTADO',
          detalhes: { protocolo_minimo: 2 },
        });
      }
    });
  });
});
