import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { carregarConfiguracao } from './configuracao.js';

const producao = {
  AMBIENTE: 'producao',
  JWT_SEGREDO: 'a'.repeat(40),
  JWT_SEGREDO_PLATAFORMA: 'b'.repeat(40),
  CHAVE_MESTRA: Buffer.alloc(32, 1).toString('base64'),
  TRUST_PROXY: '1',
};

describe('carregarConfiguracao', () => {
  it('desenvolvimento funciona sem segredos (padrões locais)', () => {
    const c = carregarConfiguracao({});
    expect(c.ambiente).toBe('desenvolvimento');
    expect(c.bancoControleUrl).toBe('postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control');
    expect(c.jwt.acessoMinutos).toBe(15);
    expect(c.cookieSeguro).toBe(false);
    expect(c.trustProxy).toBe(false);
    expect(c.empresas.servidorUrl).toBe(c.bancoControleUrl);
    expect(c.jwt.segredo).not.toBe(c.jwt.segredoPlataforma);
  });

  it('produção exige JWT_SEGREDO, JWT_SEGREDO_PLATAFORMA, CHAVE_MESTRA e TRUST_PROXY', () => {
    expect(() => carregarConfiguracao({ AMBIENTE: 'producao' })).toThrow(
      /JWT_SEGREDO.*CHAVE_MESTRA.*TRUST_PROXY/s,
    );
    const c = carregarConfiguracao({
      ...producao,
      CHAVE_MESTRA_VERSAO: '2',
      CHAVES_MESTRAS_ANTERIORES: `1:${Buffer.alloc(32, 9).toString('base64')}`,
    });
    expect(c.cookieSeguro).toBe(true);
    expect(c.trustProxy).toBe(1);
    expect([...c.cifra.chaves.keys()].sort()).toEqual([1, 2]);
    expect(c.cifra.versaoAtual).toBe(2);
  });

  it('fora de dev/teste recusa os valores públicos de desenvolvimento', () => {
    const dev = carregarConfiguracao({});
    expect(() =>
      carregarConfiguracao({ ...producao, AMBIENTE: 'homologacao', JWT_SEGREDO: dev.jwt.segredo }),
    ).toThrow(/JWT_SEGREDO: valor de desenvolvimento/);
    expect(() =>
      carregarConfiguracao({ ...producao, CHAVE_MESTRA: Buffer.alloc(32, 7).toString('base64') }),
    ).toThrow(/CHAVE_MESTRA: valor de desenvolvimento/);
  });

  it('segredos JWT do ERP e da plataforma precisam ser diferentes', () => {
    expect(() => carregarConfiguracao({ ...producao, JWT_SEGREDO_PLATAFORMA: producao.JWT_SEGREDO })).toThrow(
      /JWT_SEGREDO_PLATAFORMA: deve ser diferente/,
    );
  });

  it('NODE_ENV=production com AMBIENTE de desenvolvimento (ou esquecido) não sobe', () => {
    expect(() => carregarConfiguracao({ NODE_ENV: 'production' })).toThrow(/AMBIENTE/);
    expect(() => carregarConfiguracao({ NODE_ENV: 'production', AMBIENTE: 'teste' })).toThrow(/AMBIENTE/);
    expect(carregarConfiguracao({ ...producao, NODE_ENV: 'production' }).ambiente).toBe('producao');
  });

  it('TRUST_PROXY aceita saltos, false ou lista de IPs/CIDRs', () => {
    expect(carregarConfiguracao({ ...producao, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(carregarConfiguracao({ ...producao, TRUST_PROXY: '10.0.0.0/8, loopback' }).trustProxy).toEqual([
      '10.0.0.0/8',
      'loopback',
    ]);
    expect(() => carregarConfiguracao({ ...producao, TRUST_PROXY: 'qualquer coisa' })).toThrow(/TRUST_PROXY/);
  });

  it('variável vazia vale como ausente (linha "CHAVE=" no .env)', () => {
    const c = carregarConfiguracao({ JWT_SEGREDO: '', CHAVE_MESTRA: '', PORTA: '' });
    expect(c.porta).toBe(3000);
    expect(c.cifra.chaves.get(1)).toHaveLength(32);
  });

  it('o .env.example carrega como está', () => {
    const exemplo = parse(readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url))));
    const c = carregarConfiguracao(exemplo);
    expect(c.ambiente).toBe('desenvolvimento');
    expect(c.login.limitePorContaMinuto).toBe(10);
  });

  it('recusa valores inválidos com mensagem por variável', () => {
    expect(() => carregarConfiguracao({ PORTA: 'abc' })).toThrow(/PORTA/);
    expect(() => carregarConfiguracao({ CHAVE_MESTRA: 'curta' })).toThrow(/32 bytes/);
    expect(() => carregarConfiguracao({ JWT_SEGREDO: 'curto' })).toThrow(/JWT_SEGREDO/);
  });

  it('VERIFICACAO_RAZAO_CRON: vazia desliga, cron válido passa e cron inválido recusa a subida (F2-B3)', () => {
    expect(carregarConfiguracao({}).fila.verificacaoRazaoCron).toBeNull();
    expect(carregarConfiguracao({ VERIFICACAO_RAZAO_CRON: '  ' }).fila.verificacaoRazaoCron).toBeNull();
    expect(carregarConfiguracao({ VERIFICACAO_RAZAO_CRON: ' 41 6 * * * ' }).fila.verificacaoRazaoCron).toBe(
      '41 6 * * *',
    );
    // As que o `schedule` do pg-boss recusaria: faltou um campo, hora fora do intervalo, aspas coladas, lixo.
    for (const cron of ['41 6 * *', '41 25 * * *', '"41 6 * * *"', 'abc']) {
      expect(() => carregarConfiguracao({ VERIFICACAO_RAZAO_CRON: cron }), cron).toThrow(
        /VERIFICACAO_RAZAO_CRON.*cron inválido/s,
      );
    }
    // Vale também fora de dev/teste (a regra roda antes do retorno antecipado dos ambientes locais).
    expect(() => carregarConfiguracao({ ...producao, VERIFICACAO_RAZAO_CRON: '41 6 * *' })).toThrow(
      /VERIFICACAO_RAZAO_CRON/,
    );
  });
});
