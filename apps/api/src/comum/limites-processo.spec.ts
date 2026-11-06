/**
 * Limites do processo (README da API › decisão 164, F2-B19): o `Semaforo` com a vaga segura fora de um `executar` (o
 * interceptor do upload de NF-e a libera quando a resposta termina) e o limite por minuto.
 */
import { describe, expect, it } from 'vitest';
import { garantirLimitePorMinuto, Semaforo } from './limites-processo.js';

describe('Semaforo', () => {
  it('adquirir espera a vaga quando cheio, e liberar duas vezes não abre uma vaga a mais', async () => {
    const s = new Semaforo(1);
    const primeira = await s.adquirir();
    let segundaChegou = false;
    const segunda = s.adquirir().then((liberar) => {
      segundaChegou = true;
      return liberar;
    });
    await Promise.resolve();
    expect(segundaChegou).toBe(false);
    primeira();
    primeira();
    const liberarSegunda = await segunda;
    expect(segundaChegou).toBe(true);
    // A vaga continua com a segunda: a terceira espera.
    let terceiraChegou = false;
    const terceira = s.adquirir().then((l) => {
      terceiraChegou = true;
      return l;
    });
    await Promise.resolve();
    expect(terceiraChegou).toBe(false);
    liberarSegunda();
    (await terceira)();
    expect(terceiraChegou).toBe(true);
  });

  it('executar libera a vaga mesmo com erro', async () => {
    const s = new Semaforo(1);
    await expect(s.executar(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(s.executar(() => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('garantirLimitePorMinuto', () => {
  it('acima do limite na janela de 1 minuto é 429, e a janela anda', () => {
    const agora = 1_000_000;
    garantirLimitePorMinuto('teste:a', 2, agora);
    garantirLimitePorMinuto('teste:a', 2, agora + 1);
    expect(() => garantirLimitePorMinuto('teste:a', 2, agora + 2)).toThrow('Muitas tentativas');
    expect(() => garantirLimitePorMinuto('teste:a', 2, agora + 60_001)).not.toThrow();
  });
});
