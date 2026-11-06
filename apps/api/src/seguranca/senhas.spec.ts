import { readFileSync } from 'node:fs';
import { novaSenhaSchema } from '@genesis/shared';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { gerarHashSenha, gerarSenhaProvisoria, verificarSenha, gerarHashPin } from './senhas.js';
import { gerarCodigoTotp, gerarSegredoTotp, verificarTotp } from './totp.js';

describe('senhas e 2FA', () => {
  it('argon2id: verifica a certa, recusa a errada e hash ausente', async () => {
    const h = await gerarHashSenha('Segredo123');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verificarSenha(h, 'Segredo123')).toBe(true);
    expect(await verificarSenha(h, 'segredo123')).toBe(false);
    expect(await verificarSenha(null, 'x')).toBe(false);
    expect(await verificarSenha('lixo', 'x')).toBe(false);
  });

  it('senha provisória passa na política do ERP e não tem caracteres ambíguos', () => {
    for (let i = 0; i < 50; i++) {
      const s = gerarSenhaProvisoria();
      expect(novaSenhaSchema.safeParse(s).success).toBe(true);
      expect(s).not.toMatch(/[0O1lI]/);
    }
  });

  it('TOTP: aceita o código atual (devolve o passo) e recusa outro', async () => {
    const segredo = gerarSegredoTotp();
    const antes = Math.floor(Date.now() / 30_000);
    const codigo = await gerarCodigoTotp(segredo);
    const passo = await verificarTotp(segredo, codigo);
    expect([antes, antes + 1]).toContain(passo);
    expect(await verificarTotp(segredo, codigo === '000000' ? '111111' : '000000')).toBeNull();
  });

  it('TOTP: o mesmo passo (ou um anterior) não vale de novo', async () => {
    const segredo = gerarSegredoTotp();
    const codigo = await gerarCodigoTotp(segredo);
    const passo = (await verificarTotp(segredo, codigo))!;
    expect(await verificarTotp(segredo, codigo, passo)).toBeNull();
    expect(await verificarTotp(segredo, codigo, passo - 1)).toBe(passo);
    // O código do passo seguinte (relógio do celular adiantado) é aceito depois do atual.
    expect(await verificarTotp(segredo, await gerarCodigoTotp(segredo, 1), passo)).toBe(passo + 1);
  });

  it('PIN: string PHC na ordem canônica m,t,p (libsodium do PDV) e verificável pela API', async () => {
    const h = await gerarHashPin('480297');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verificarSenha(h, '480297')).toBe(true);
    expect(await verificarSenha(h, '480298')).toBe(false);
  });

  it('PIN do PDV sai na ordem canônica do PHC (m, t, p) com sal de 16 e hash de 32 bytes (SYNC 4.2)', async () => {
    const h = await gerarHashPin('482913');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('vetores de packages/shared/testes/sync/argon2 (os que o PDV verifica offline) conferem no node-argon2', async () => {
    // Os mesmos casos passam pelo verificador do PDV (GenesisPDV.Sync.Tests/LoginOfflineTests): compatibilidade
    // node-argon2 ↔ libsodium. "fora_dos_limites" confere aqui (o hash é válido), mas o PDV recusa pelos limites.
    const vetores = JSON.parse(
      readFileSync(
        new URL('../../../../packages/shared/testes/sync/argon2.vetores.json', import.meta.url),
        'utf8',
      ),
    ) as { casos: Array<{ senha: string; hash: string; valido: boolean; motivo?: string }> };
    expect(vetores.casos.length).toBeGreaterThan(5);
    for (const c of vetores.casos) {
      expect(await argon2.verify(c.hash, c.senha), c.hash).toBe(c.valido || c.motivo === 'fora_dos_limites');
    }
  });
});
