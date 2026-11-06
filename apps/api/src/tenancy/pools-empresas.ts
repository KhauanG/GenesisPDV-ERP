import pg from 'pg';
import type { ServidoresBanco } from '../database/servidores.js';
import { chavePool, type ContextoEmpresa } from './contexto.js';

interface Entrada {
  pool: pg.Pool;
  contexto: ContextoEmpresa;
  ultimoUso: number;
  /** Requisições entre `obterEntrada` e o `release` da conexão: pool em uso nunca é fechado. */
  emUso: number;
  encerrado: boolean;
}

const ocioso = (e: Entrada) =>
  e.emUso === 0 && e.pool.totalCount === e.pool.idleCount && e.pool.waitingCount === 0;

export class BancoErradoErro extends Error {
  constructor(esperado: string, obtido: string) {
    super(`Conexão do pool aponta para ${obtido}, esperado ${esperado}`);
    this.name = 'BancoErradoErro';
  }
}

/**
 * Cache de pools por empresa (ADR-02; VG 4.3): chave = (empresa_id, servidor, nome_banco, geração), limite de
 * tamanho (descarta o menos usado) e fechamento dos ociosos. Toda conexão física é conferida com
 * `current_database()` antes do primeiro uso; divergência derruba a conexão.
 */
export class PoolsEmpresas {
  private readonly pools = new Map<string, Entrada>();
  private readonly criando = new Map<string, Promise<Entrada>>();
  private readonly verificadas = new WeakSet<pg.PoolClient>();
  private readonly temporizador: NodeJS.Timeout;

  constructor(
    private readonly servidores: Pick<ServidoresBanco, 'credenciaisEmpresa'>,
    private readonly opcoes: {
      maximo: number;
      ociosoMs: number;
      conexoesPorEmpresa: number;
      /** Só para testes: troca a criação do pool físico (ex.: simular roteamento errado de um pooler). */
      criarPool?: (config: pg.PoolConfig) => pg.Pool;
    },
  ) {
    this.temporizador = setInterval(() => void this.fecharOciosos(), Math.min(opcoes.ociosoMs, 60_000));
    this.temporizador.unref();
  }

  get tamanho(): number {
    return this.pools.size;
  }

  chaves(): string[] {
    return [...this.pools.keys()];
  }

  /** Conexão conferida do pool da empresa do contexto. Quem chama deve liberar (`release`). */
  async conectar(contexto: ContextoEmpresa): Promise<pg.PoolClient> {
    const entrada = await this.obterEntrada(contexto);
    let cliente: pg.PoolClient;
    try {
      cliente = await entrada.pool.connect();
    } catch (e) {
      entrada.emUso--;
      throw e;
    }
    const liberar = cliente.release.bind(cliente);
    let liberado = false;
    cliente.release = (erro?: Error | boolean) => {
      if (!liberado) {
        liberado = true;
        entrada.emUso--;
        entrada.ultimoUso = Date.now();
      }
      return liberar(erro);
    };
    if (!this.verificadas.has(cliente)) {
      try {
        const { rows } = await cliente.query<{ db: string }>('select current_database() as db');
        const obtido = rows[0]?.db ?? '?';
        if (obtido !== contexto.nomeBanco) throw new BancoErradoErro(contexto.nomeBanco, obtido);
        this.verificadas.add(cliente);
      } catch (e) {
        cliente.release(true);
        throw e;
      }
    }
    return cliente;
  }

  /** Fecha os pools de uma empresa (ex.: geração nova após mudança de servidor, banco descartado). */
  async descartarEmpresa(empresaId: string): Promise<void> {
    const alvo = [...this.pools.entries()].filter(([, e]) => e.contexto.empresaId === empresaId);
    for (const [chave] of alvo) this.pools.delete(chave);
    await Promise.all(alvo.map(([, e]) => this.encerrar(e)));
  }

  async fecharOciosos(agora = Date.now()): Promise<number> {
    const ociosos = [...this.pools.entries()].filter(
      ([, e]) => agora - e.ultimoUso >= this.opcoes.ociosoMs && ocioso(e),
    );
    for (const [chave] of ociosos) this.pools.delete(chave);
    await Promise.all(ociosos.map(([, e]) => this.encerrar(e)));
    return ociosos.length;
  }

  async fecharTodos(): Promise<void> {
    clearInterval(this.temporizador);
    const todos = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(todos.map((e) => this.encerrar(e)));
  }

  private async encerrar(e: Entrada): Promise<void> {
    if (e.encerrado) return;
    e.encerrado = true;
    await e.pool.end().catch(() => undefined);
  }

  private async obterEntrada(contexto: ContextoEmpresa): Promise<Entrada> {
    const chave = chavePool(contexto);
    const existente = this.pools.get(chave);
    if (existente && !existente.encerrado) {
      // Reinsere para manter a ordem de uso (Map preserva ordem de inserção = LRU simples).
      this.pools.delete(chave);
      this.pools.set(chave, existente);
      existente.emUso++;
      existente.ultimoUso = Date.now();
      if (this.pools.size > this.opcoes.maximo) await this.limitarTamanho();
      return existente;
    }
    let promessa = this.criando.get(chave);
    if (!promessa) {
      promessa = this.criarEntrada(contexto).finally(() => this.criando.delete(chave));
      this.criando.set(chave, promessa);
    }
    const entrada = await promessa;
    // Marca o uso antes de qualquer await: o descarte de excedentes nunca fecha um pool que alguém vai usar.
    entrada.emUso++;
    entrada.ultimoUso = Date.now();
    this.pools.set(chave, entrada);
    await this.limitarTamanho();
    return entrada;
  }

  private async criarEntrada(contexto: ContextoEmpresa): Promise<Entrada> {
    // Role de runtime da empresa (sem DELETE nas tabelas sincronizáveis, só ela conecta no banco), nunca a dona.
    const d = await this.servidores.credenciaisEmpresa(contexto.empresaId);
    const config: pg.PoolConfig = {
      host: d.host,
      port: d.porta,
      user: d.usuario,
      password: d.senha,
      database: contexto.nomeBanco,
      application_name: `emp_${contexto.codigo}`,
      max: this.opcoes.conexoesPorEmpresa,
      idleTimeoutMillis: Math.min(this.opcoes.ociosoMs, 30_000),
    };
    const pool = this.opcoes.criarPool ? this.opcoes.criarPool(config) : new pg.Pool(config);
    pool.on('error', () => {
      // Conexão ociosa derrubada pelo servidor: o pool descarta e reabre sob demanda.
    });
    return { pool, contexto, ultimoUso: Date.now(), emUso: 0, encerrado: false };
  }

  /**
   * Acima do máximo, fecha os menos usados entre os ociosos (sem conexão emprestada nem requisição a caminho).
   * Se todos estão em uso, o cache passa do máximo temporariamente; o próximo descarte ou `fecharOciosos` corrige.
   */
  private async limitarTamanho(): Promise<void> {
    const excedente = this.pools.size - this.opcoes.maximo;
    if (excedente <= 0) return;
    const descartar = [...this.pools.entries()].filter(([, e]) => ocioso(e)).slice(0, excedente);
    for (const [chave] of descartar) this.pools.delete(chave);
    await Promise.all(descartar.map(([, e]) => this.encerrar(e)));
  }
}
