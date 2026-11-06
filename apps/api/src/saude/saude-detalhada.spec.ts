import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carregarConfiguracao } from '../config/configuracao.js';
import { hashTokenMonitor, tokenMonitorConfere } from './monitor-token.js';
import { memoriaDoContainer, statusTerminalMonitor } from './saude-detalhada.js';

describe('token de monitoramento (I1b)', () => {
  const token = 'token-de-teste-gerado-na-hora';
  const esperado = hashTokenMonitor(token);

  it('confere só o token certo, e nunca sem hash configurado', () => {
    expect(tokenMonitorConfere(token, esperado)).toBe(true);
    expect(tokenMonitorConfere(`${token}x`, esperado)).toBe(false);
    expect(tokenMonitorConfere('', esperado)).toBe(false);
    expect(tokenMonitorConfere(null, esperado)).toBe(false);
    expect(tokenMonitorConfere(token, null)).toBe(false);
    expect(tokenMonitorConfere(token, Buffer.alloc(16))).toBe(false);
  });

  it('MONITOR_TOKEN_SHA256: 64 hexadecimais (o hash do token, nunca o token)', () => {
    const hex = createHash('sha256').update(token).digest('hex');
    expect(carregarConfiguracao({ MONITOR_TOKEN_SHA256: hex.toUpperCase() }).monitor.tokenSha256).toEqual(
      esperado,
    );
    expect(carregarConfiguracao({}).monitor.tokenSha256).toBeNull();
    expect(() => carregarConfiguracao({ MONITOR_TOKEN_SHA256: token })).toThrow(/MONITOR_TOKEN_SHA256/);
  });
});

describe('statusTerminalMonitor', () => {
  const agora = Date.parse('2026-11-04T12:00:00Z');
  it('online com contato recente; offline sem; desativado para desativando/revogado', () => {
    expect(statusTerminalMonitor('ativo', new Date(agora - 30_000), agora)).toBe('online');
    expect(statusTerminalMonitor('ativo', new Date(agora - 3_600_000), agora)).toBe('offline');
    expect(statusTerminalMonitor('ativo', null, agora)).toBe('offline');
    expect(statusTerminalMonitor('provisionando', new Date(agora), agora)).toBe('offline');
    expect(statusTerminalMonitor('desativando', new Date(agora), agora)).toBe('desativado');
    expect(statusTerminalMonitor('revogado', null, agora)).toBe('desativado');
  });
});

describe('memoriaDoContainer', () => {
  let pasta: string | null = null;
  afterEach(() => {
    if (pasta) rmSync(pasta, { recursive: true, force: true });
    pasta = null;
  });

  it('cgroup v2: memory.current sem o inactive_file; memory.max', async () => {
    pasta = mkdtempSync(join(tmpdir(), 'cgroup-'));
    writeFileSync(join(pasta, 'memory.current'), '300000000\n');
    writeFileSync(join(pasta, 'memory.max'), '2147483648\n');
    writeFileSync(join(pasta, 'memory.stat'), 'anon 1\nactive_file 5\ninactive_file 100000000\n');
    expect(await memoriaDoContainer(pasta)).toEqual({ usada_bytes: 200000000, limite_bytes: 2147483648 });
    writeFileSync(join(pasta, 'memory.max'), 'max\n');
    expect((await memoriaDoContainer(pasta)).limite_bytes).toBeNull();
  });

  it('cgroup v1 e fora de container', async () => {
    pasta = mkdtempSync(join(tmpdir(), 'cgroup-'));
    mkdirSync(join(pasta, 'memory'));
    writeFileSync(join(pasta, 'memory/memory.usage_in_bytes'), '5000\n');
    writeFileSync(join(pasta, 'memory/memory.limit_in_bytes'), '9223372036854771712\n');
    writeFileSync(join(pasta, 'memory/memory.stat'), 'total_inactive_file 1000\n');
    expect(await memoriaDoContainer(pasta)).toEqual({ usada_bytes: 4000, limite_bytes: null });
    const fora = await memoriaDoContainer(join(pasta, 'nao-existe'));
    expect(fora.usada_bytes).toBeGreaterThan(0);
    expect(fora.limite_bytes).toBeNull();
  });
});
