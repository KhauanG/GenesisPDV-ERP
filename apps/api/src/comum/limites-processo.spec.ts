/**
 * Limites do processo (README da API › decisão 164, F2-B19): o `Semaforo` com a vaga segura fora de um `executar` (o
 * interceptor do upload de NF-e a libera quando a resposta termina), o `comVaga` dos interceptors de envio (decisão
 * 202: a vaga solta no fim, também quando a resposta é cancelada na fila), o limite por minuto e (decisão 204) a fila
 * do semáforo com tamanho máximo e prazo de espera e a admissão por chave (`entrarEmAndamento`).
 */
import { NEVER, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErroApi } from './erros.js';
import { comVaga, entrarEmAndamento, garantirLimitePorMinuto, Semaforo } from './limites-processo.js';

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

describe('Semaforo com fila limitada (decisão 204)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** O erro com que a promessa rejeitou (falha o teste se ela resolver). */
  async function erroDe(p: Promise<unknown>): Promise<ErroApi> {
    const e = await p.then(
      () => null,
      (erro: unknown) => erro,
    );
    expect(e).toBeInstanceOf(ErroApi);
    return e as ErroApi;
  }

  it('fila cheia: quem chega recebe SISTEMA_OCUPADO (503, Retry-After) na hora, e quem já esperava segue', async () => {
    const s = new Semaforo(1, { filaMaxima: 1, mensagemOcupado: 'Ocupado.' });
    const primeira = await s.adquirir();
    const segunda = s.adquirir();
    expect(s.esperando).toBe(1);
    const e = await erroDe(s.adquirir());
    expect(e).toMatchObject({ codigo: 'SISTEMA_OCUPADO', status: 503, message: 'Ocupado.' });
    expect(e.extras.cabecalhos).toEqual({ 'Retry-After': '5' });
    expect(s.esperando).toBe(1);
    primeira();
    const liberarSegunda = await segunda;
    expect(s.esperando).toBe(0);
    // A recusa não pegou vaga: com a segunda solta, a próxima entra sem esperar.
    liberarSegunda();
    (await s.adquirir())();
  });

  it('espera vencida: sai da fila com SISTEMA_OCUPADO sem levar vaga, e a vaga continua de quem a tinha', async () => {
    vi.useFakeTimers();
    const s = new Semaforo(1, { esperaMaximaMs: 1000 });
    const primeira = await s.adquirir();
    const atrasada = erroDe(s.adquirir());
    let terceiraChegou = false;
    await vi.advanceTimersByTimeAsync(500);
    const terceira = s.adquirir().then((l) => {
      terceiraChegou = true;
      return l;
    });
    expect(s.esperando).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await atrasada).toMatchObject({ codigo: 'SISTEMA_OCUPADO', status: 503 });
    expect(s.esperando).toBe(1);
    // Quem foi acordado antes do prazo não é recusado depois dele.
    primeira();
    const liberarTerceira = await terceira;
    expect(terceiraChegou).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    liberarTerceira();
    expect(s.esperando).toBe(0);
    (await s.adquirir())();
  });

  it('sem opções, a fila não tem limite nem prazo (os semáforos limitados por quem entra neles)', async () => {
    vi.useFakeTimers();
    const s = new Semaforo(1);
    const primeira = await s.adquirir();
    const esperando = Array.from({ length: 200 }, () => s.adquirir());
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.esperando).toBe(200);
    primeira();
    for (const p of esperando) (await p)();
    expect(s.esperando).toBe(0);
  });
});

describe('entrarEmAndamento (decisão 204)', () => {
  const erro = () => new ErroApi('LIMITE_TAXA', 'Aguarde.');

  it('até o limite por chave; acima lança na hora, tirar duas vezes não abre uma vaga a mais', () => {
    const tirar1 = entrarEmAndamento('teste:andamento:a', 2, erro);
    const tirar2 = entrarEmAndamento('teste:andamento:a', 2, erro);
    expect(() => entrarEmAndamento('teste:andamento:a', 2, erro)).toThrow('Aguarde.');
    // Outra chave tem o próprio limite.
    const outra = entrarEmAndamento('teste:andamento:b', 2, erro);
    tirar1();
    tirar1();
    const tirar3 = entrarEmAndamento('teste:andamento:a', 2, erro);
    expect(() => entrarEmAndamento('teste:andamento:a', 2, erro)).toThrow('Aguarde.');
    tirar2();
    tirar3();
    outra();
    entrarEmAndamento('teste:andamento:a', 1, erro)();
  });
});
