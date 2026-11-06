import { describe, expect, it } from 'vitest';
import {
  comPendencias,
  confirmarHardwareSchema,
  DISCO_LIVRE_AVISO_MB,
  DISCO_LIVRE_CRITICO_MB,
  duracaoLegivel,
  filtroTerminaisSchema,
  LIMIARES_CONEXAO,
  nivelDesvioRelogio,
  nivelDiscoLivre,
  nivelFilaImpressao,
  ressincronizarTerminalSchema,
  revogarTerminalSchema,
  statusConexao,
} from './terminais.js';

const AGORA = Date.parse('2026-10-30T12:00:00.000Z');
const ha = (ms: number) => new Date(AGORA - ms).toISOString();

describe('statusConexao (ERP 12.1)', () => {
  it('online abaixo de 2 min, offline até 24 h, sem contato a partir de 24 h', () => {
    expect(statusConexao(ha(0), AGORA)).toBe('online');
    expect(statusConexao(ha(LIMIARES_CONEXAO.onlineMs - 1), AGORA)).toBe('online');
    expect(statusConexao(ha(LIMIARES_CONEXAO.onlineMs), AGORA)).toBe('offline');
    expect(statusConexao(ha(LIMIARES_CONEXAO.semContatoMs - 1), AGORA)).toBe('offline');
    expect(statusConexao(ha(LIMIARES_CONEXAO.semContatoMs), AGORA)).toBe('sem_contato');
  });

  it('nunca contatou (ou data inválida) = sem contato; aceita Date', () => {
    expect(statusConexao(null, AGORA)).toBe('sem_contato');
    expect(statusConexao(undefined, AGORA)).toBe('sem_contato');
    expect(statusConexao('não é data', AGORA)).toBe('sem_contato');
    expect(statusConexao(new Date(AGORA - 30_000), new Date(AGORA))).toBe('online');
  });
});

describe('comPendencias (ERP 12.1)', () => {
  it('só com eventos pendentes e mais de 1 h sem contato', () => {
    const umaHora = LIMIARES_CONEXAO.pendenciasMs;
    expect(comPendencias({ ultimoContatoEm: ha(umaHora + 1), eventosPendentes: 3 }, AGORA)).toBe(true);
    expect(comPendencias({ ultimoContatoEm: ha(umaHora), eventosPendentes: 3 }, AGORA)).toBe(false);
    expect(comPendencias({ ultimoContatoEm: ha(5 * 60_000), eventosPendentes: 3 }, AGORA)).toBe(false);
    expect(comPendencias({ ultimoContatoEm: ha(2 * umaHora), eventosPendentes: 0 }, AGORA)).toBe(false);
    expect(comPendencias({ ultimoContatoEm: null, eventosPendentes: 1 }, AGORA)).toBe(true);
  });
});

describe('entradas das ações de terminal', () => {
  it('revogar imediato e perdido exigem o nº do caixa; aceitar pendências não', () => {
    expect(revogarTerminalSchema.safeParse({ modo: 'aceitar_pendencias' }).success).toBe(true);
    const sem = revogarTerminalSchema.safeParse({ modo: 'imediato' });
    expect(sem.success).toBe(false);
    expect(sem.error?.issues[0]?.path).toEqual(['confirmacaoCaixa']);
    expect(revogarTerminalSchema.parse({ modo: 'perdido', confirmacaoCaixa: '2' })).toMatchObject({
      modo: 'perdido',
      confirmacaoCaixa: 2,
    });
    expect(revogarTerminalSchema.safeParse({ modo: 'outro', confirmacaoCaixa: 1 }).success).toBe(false);
  });

  it('ressincronizar: fluxo opcional e só dos fluxos do sync', () => {
    expect(ressincronizarTerminalSchema.parse({})).toEqual({});
    expect(ressincronizarTerminalSchema.parse({ fluxo: '' })).toEqual({});
    expect(ressincronizarTerminalSchema.parse({ fluxo: 'catalogo' })).toEqual({ fluxo: 'catalogo' });
    expect(ressincronizarTerminalSchema.safeParse({ fluxo: 'vendas' }).success).toBe(false);
  });

  it('filtro da listagem: padrões e valores vazios da URL', () => {
    expect(filtroTerminaisSchema.parse({})).toEqual({ situacao: 'ativos', conexao: 'todos' });
    expect(filtroTerminaisSchema.parse({ lojaId: '', situacao: '', versaoApp: '' })).toEqual({
      situacao: 'ativos',
      conexao: 'todos',
    });
    expect(filtroTerminaisSchema.safeParse({ conexao: 'qualquer' }).success).toBe(false);
  });
});

describe('confirmarHardwareSchema (ERP 12.4; SYNC 20.5)', () => {
  it('exige o id pendente que a tela mostrou, no formato do cabeçalho X-Genesis-Id-Hardware', () => {
    expect(confirmarHardwareSchema.safeParse({ idHardwarePendente: 'A'.repeat(64) }).success).toBe(true);
    expect(confirmarHardwareSchema.safeParse({}).success).toBe(false);
    expect(confirmarHardwareSchema.safeParse({ idHardwarePendente: 'curto' }).success).toBe(false);
    expect(confirmarHardwareSchema.safeParse({ idHardwarePendente: 'A'.repeat(63) + '!' }).success).toBe(
      false,
    );
  });
});

describe('saúde do computador do terminal (PDV 32.2; SYNC 21.2; Central do PDV G15)', () => {
  it('nivelDiscoLivre: abaixo de 1 GB aviso, abaixo de 200 MB crítico (os limites do Painel do PDV); sem valor, null', () => {
    expect(DISCO_LIVRE_AVISO_MB).toBe(1024);
    expect(DISCO_LIVRE_CRITICO_MB).toBe(200);
    expect(nivelDiscoLivre(null)).toBeNull();
    expect(nivelDiscoLivre(undefined)).toBeNull();
    expect(nivelDiscoLivre(48_210)).toBe('normal');
    // O heartbeat manda MB arredondado para baixo: 1023 MB é "menos de 1 GB" em bytes também.
    expect(nivelDiscoLivre(1024)).toBe('normal');
    expect(nivelDiscoLivre(1023)).toBe('aviso');
    expect(nivelDiscoLivre(200)).toBe('aviso');
    expect(nivelDiscoLivre(199)).toBe('critico');
    expect(nivelDiscoLivre(0)).toBe('critico');
  });

  it('nivelFilaImpressao: qualquer comprovante esperando é aviso; nunca crítico', () => {
    expect(nivelFilaImpressao(0)).toBe('normal');
    expect(nivelFilaImpressao(null)).toBe('normal');
    expect(nivelFilaImpressao(1)).toBe('aviso');
    expect(nivelFilaImpressao(250)).toBe('aviso');
  });
});

describe('relógio do terminal (SYNC 12.3, 12.4, 21.2; C16)', () => {
  const MIN = 60_000;
  it('nivelDesvioRelogio: > 2 min aviso, > 5 min crítico, nos dois sentidos; sem amostra, null', () => {
    expect(nivelDesvioRelogio(null)).toBeNull();
    expect(nivelDesvioRelogio(undefined)).toBeNull();
    expect(nivelDesvioRelogio(2 * MIN)).toBe('normal');
    expect(nivelDesvioRelogio(-2 * MIN - 1)).toBe('aviso');
    expect(nivelDesvioRelogio(5 * MIN)).toBe('aviso');
    expect(nivelDesvioRelogio(5 * MIN + 1)).toBe('critico');
    expect(nivelDesvioRelogio(-3 * 3_600_000)).toBe('critico');
  });

  it('duracaoLegivel: segundos, minutos, horas e, a partir de 48 h, dias (a mesma na API e no ERP)', () => {
    expect(duracaoLegivel(45_000)).toBe('45 s');
    expect(duracaoLegivel(-7 * MIN)).toBe('7 min');
    expect(duracaoLegivel(3 * 60 * MIN + 12 * MIN)).toBe('3 h 12 min');
    expect(duracaoLegivel(5 * 60 * MIN)).toBe('5 h');
    expect(duracaoLegivel(47 * 60 * MIN)).toBe('47 h');
    expect(duracaoLegivel(-72 * 60 * MIN)).toBe('3 dias');
    expect(duracaoLegivel(12 * 86_400_000)).toBe('12 dias');
  });
});
