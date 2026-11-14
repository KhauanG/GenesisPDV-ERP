/**
 * Limites do processo (README da API › decisão 164, F2-B19): o `Semaforo` com a vaga segura fora de um `executar` (o
 * interceptor do upload de NF-e a libera quando a resposta termina), o `comVaga` dos interceptors de envio (decisão
 * 202: a vaga solta no fim, também quando a resposta é cancelada na fila) e o limite por minuto.
 */
import { NEVER, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { comVaga, garantirLimitePorMinuto, Semaforo } from './limites-processo.js';

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

describe('comVaga (decisão 202)', () => {
  const ticks = () => new Promise((r) => setImmediate(r));
  /** Pede uma vaga e diz, depois de alguns ticks, se ela já chegou (`soltar` a devolve quando chegar). */
  function pedirVaga(s: Semaforo) {
    let chegou = false;
    const vaga = s.adquirir().then((l) => {
      chegou = true;
      return l;
    });
    return { chegou: () => chegou, soltar: async () => (await vaga)() };
  }

  it('solta a vaga quando a resposta termina', async () => {
    const s = new Semaforo(1);
    await new Promise<void>((ok) => comVaga(s, () => of(1)).subscribe({ complete: ok }));
    const outra = pedirVaga(s);
    await ticks();
    expect(outra.chegou()).toBe(true);
    await outra.soltar();
  });

  it('cancelada enquanto espera na fila, a vaga que chega depois é devolvida (não fica presa)', async () => {
    const s = new Semaforo(1);
    const ocupada = await s.adquirir();
    const inscricao = comVaga(s, () => NEVER).subscribe();
    await ticks();
    inscricao.unsubscribe();
    ocupada();
    await ticks();
    const outra = pedirVaga(s);
    await ticks();
    expect(outra.chegou()).toBe(true);
    await outra.soltar();
  });

  it('cancelada com a vaga na mão (a resposta encerrada no meio), a vaga volta', async () => {
    const s = new Semaforo(1);
    const inscricao = comVaga(s, () => NEVER).subscribe();
    await ticks();
    const outra = pedirVaga(s);
    await ticks();
    expect(outra.chegou()).toBe(false);
    inscricao.unsubscribe();
    await ticks();
    expect(outra.chegou()).toBe(true);
    await outra.soltar();
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
