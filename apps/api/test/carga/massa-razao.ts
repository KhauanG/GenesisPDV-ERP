/**
 * Massa de carga do razão e roteiro de planos de consulta (Fase 2, F2-B28; README da API › decisão 176). Fora do CI:
 * `pnpm --filter api carga:razao`. Cria um ambiente descartável no PostgreSQL de `DATABASE_URL` (o mesmo dos testes de
 * integração), gera um ano de movimentos de uma empresa como a Ice Beer (3 lojas, o CD e a Treino, 2.000 produtos) e
 * mede, com `EXPLAIN (ANALYZE, BUFFERS)`, as consultas que os relatórios do PR-7 vão fazer: a Movimentação analítica
 * com cursor, a sintética, o saldo numa data-base, a última compra, o detalhe do acerto, a exportação em streaming e o
 * replay do `db:recalcular-saldos` (tempo e pico de heap). Mede **antes** e **depois** dos índices da
 * `0026_indices_razao` (`INDICES_RAZAO`, criados pela mesma preparação da migração, com o tempo e o tamanho) e, à parte,
 * os candidatos que a medição descartou. No fim apaga os bancos (com `--manter`, deixa a empresa para outra medição).
 *
 * A massa vem pela regra do motor (`aplicarMovimentoNoSaldo`, a mesma do replay), em ordem de lançamento, e entra em
 * lotes por `unnest` (sem o COPY, que pediria outro pacote); a projeção (`saldos_estoque`) é a do fim de cada linha. A
 * verificação do recalcular no fim confere as duas: com a massa certa, nenhuma divergência. Determinística pela
 * `--semente`. Mistura: venda ≈ 90% (cupons de 1 a 4 itens, 1% offline tardia), cancelamento, acertos (Entrada, Saída,
 * Definir e o inventário inicial), compensação de venda tardia, reposição da loja por transferência do CD (75%) ou
 * compra (NF-e e manual) e compra do CD por NF-e.
 *
 * Opções: `--movimentos=4000000`, `--produtos=2000`, `--semente=28`, `--manter`, `--so-massa` (só gera e mantém),
 * `--saida=resultado.json`.
 *
 * A geração também serve a outros testes (`gerarMassa`): a carga da exportação em streaming (F2-B29,
 * `exportacao-razao.ts`) e a integração `exportacao-relatorio.test.ts`, com uma massa pequena. Importado, o arquivo não
 * roda o roteiro (só quando é o script chamado).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { aplicarMovimentoNoSaldo, movimentoGravadoNoSaldo, movimentoDeCompra } from '@genesis/shared';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { garantirIndicesRazao, INDICES_RAZAO } from '../../src/estoques/indices-razao.js';
import { verificarSaldos } from '../../src/estoques/recalcular.js';
import { conectar, criarAmbiente, criarLoja } from '../integracao/ambiente.js';

// ---------------------------------------------------------------- Opções

const argumentos = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.length ? v.join('=') : 'true'] as const;
  }),
);
const numero = (nome: string, padrao: number) => Number(argumentos.get(nome) ?? padrao);
// `let`: `gerarMassa` troca os três (outro teste com outra massa).
let TOTAL = numero('movimentos', 4_000_000);
let PRODUTOS = numero('produtos', 2000);
let SEMENTE = numero('semente', 28);
/** Só gera a massa e deixa os bancos (para medir à mão, por exemplo com o cache frio). */
const SO_MASSA = argumentos.has('so-massa');
const MANTER = SO_MASSA || argumentos.has('manter');
const SAIDA = argumentos.get('saida');

/** Um ano: 01/11/2025 00:00 a 01/11/2026 00:00 (horário de Brasília). */
const INICIO = Date.parse('2025-11-01T03:00:00Z');
const FIM = Date.parse('2026-11-01T03:00:00Z');
const POR_LOTE = 5000;

/**
 * Candidatos que a medição descartou (README da API › decisão 176): criados só para medir as consultas a que serviriam
 * e apagados logo depois. Ficam aqui para a medição poder ser repetida.
 */
const CANDIDATOS_DESCARTADOS = [
  {
    nome: 'ix_carga_movimentos_compra',
    definicao: `(estoque_id, produto_id, data_movimento desc) where tipo_movimento in ('RECEB_MANUAL','RECEB_NFE')`,
    consultas: ['ultima_compra_loja', 'ultima_compra_cd'],
  },
] as const;

// ---------------------------------------------------------------- Sorteio determinístico

let estadoSorteio = SEMENTE >>> 0;
/** mulberry32: rápido e reproduzível (a mesma semente dá a mesma massa). */
function sorteio(): number {
  estadoSorteio = (estadoSorteio + 0x6d2b79f5) >>> 0;
  let t = estadoSorteio;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const inteiro = (min: number, max: number) => min + Math.floor(sorteio() * (max - min + 1));
const escolher = <T>(lista: readonly T[]): T => lista[Math.floor(sorteio() * lista.length)]!;

/** Índice sorteado por pesos acumulados (busca binária). */
function porPeso(acumulado: readonly number[]): number {
  const alvo = sorteio() * acumulado[acumulado.length - 1]!;
  let a = 0;
  let b = acumulado.length - 1;
  while (a < b) {
    const m = (a + b) >> 1;
    if (acumulado[m]! < alvo) a = m + 1;
    else b = m;
  }
  return a;
}
const acumular = (pesos: readonly number[]) => {
  let s = 0;
  return pesos.map((p) => (s += p));
};

// ---------------------------------------------------------------- Cadastro

export interface Estoque {
  id: string;
  lojaId: string | null;
  nome: string;
  tipo: 'loja' | 'cd' | 'treino';
  operadores: string[];
}

export interface Cadastro {
  estoques: Estoque[];
  produtos: { id: string; custo: number; fornecedor: string }[];
  padrao: string;
  avaria: string;
  usuarios: string[];
}

async function cadastrar(banco: string, c: pg.Client): Promise<Cadastro> {
  const estoques: Estoque[] = [];
  for (const [codigo, nome] of [
    [1, 'Loja 1'],
    [2, 'Loja 2'],
    [3, 'Loja 3'],
    [9, 'Treino'],
  ] as const) {
    const lojaId = await criarLoja(banco, codigo, nome);
    if (nome === 'Treino') {
      await c.query("update lojas set treino = true, tipo_emissao = 'nao_fiscal' where id = $1", [lojaId]);
    }
    const { rows } = await c.query<{ id: string }>('select estoque_id as id from lojas where id = $1', [
      lojaId,
    ]);
    estoques.push({
      id: rows[0]!.id,
      lojaId,
      nome,
      tipo: nome === 'Treino' ? 'treino' : 'loja',
      operadores: [],
    });
  }
  const { rows: cd } = await c.query<{ id: string }>(
    "insert into estoques (nome, tipo) values ('CD - Estoque', 'deposito') returning id",
  );
  estoques.push({ id: cd[0]!.id, lojaId: null, nome: 'CD', tipo: 'cd', operadores: [] });

  const { rows: usuarios } = await c.query<{ id: string }>(
    `insert into usuarios (nome, login, senha_hash, master)
     select 'USUARIO CARGA ' || g, 'carga' || g, 'x', true from generate_series(1, 12) g returning id`,
  );
  const ids = usuarios.map((u) => u.id);
  estoques.forEach((e, i) => (e.operadores = ids.slice(i * 2, i * 2 + 2)));

  const { rows: fornecedores } = await c.query<{ id: string }>(
    `insert into pessoas (nome, tipo) select 'FORNECEDOR CARGA ' || g, 'PJ' from generate_series(1, 30) g
     returning id`,
  );
  const { rows: produtos } = await c.query<{ id: string }>(
    `insert into produtos (nome, unidade_id)
     select 'PRODUTO CARGA ' || g, (select id from unidades_medida where sigla = 'UN') from generate_series(1, $1) g
     returning id`,
    [PRODUTOS],
  );
  const { rows: tipos } = await c.query<{ padrao: string; avaria: string }>(
    `select (select id from tipos_estoque where padrao) as padrao,
            (select id from tipos_estoque where chave_sistema = 'avaria') as avaria`,
  );
  return {
    estoques,
    produtos: produtos.map((p) => ({
      id: p.id,
      custo: inteiro(150, 9000) / 100,
      fornecedor: escolher(fornecedores).id,
    })),
    padrao: tipos[0]!.padrao,
    avaria: tipos[0]!.avaria,
    usuarios: ids,
  };
}

// ---------------------------------------------------------------- Geração

interface Linha {
  estoque: Estoque;
  produto: number;
  tipoEstoqueId: string;
  quantidade: string;
  custoMedio: string;
  entradaEm: number | null;
  saidaEm: number | null;
  compraEm: number | null;
  custoCompra: string | null;
  ultimoId: string | null;
}

interface Movimento {
  id: string;
  linha: Linha;
  tipo: string;
  quantidade: string;
  saldoAnterior: string;
  saldoPosterior: string;
  custoUnitario: string;
  custoTotal: string;
  custoMedioPosterior: string;
  precoVenda: string | null;
  data: number;
  usuarioId: string | null;
  pessoaId: string | null;
  documentoTipo: string;
  documentoId: string;
  estornoDeId: string | null;
  compensaId: string | null;
  seq: number;
}

/** Uma venda recente que ainda pode ser cancelada (o estorno sai ao custo dela). */
interface VendaRecente {
  id: string;
  linha: Linha;
  quantidade: string;
  custo: string;
  documentoId: string;
}

class Gerador {
  readonly linhas = new Map<string, Linha>();
  readonly contagem = new Map<string, number>();
  private seq = 0;
  private lote: Movimento[] = [];
  private readonly vendas: (VendaRecente | null)[] = [];
  private readonly acertoAberto = new Map<string, { id: string; itens: number }>();
  private readonly pesosProduto: number[];
  private readonly lojasVenda: Estoque[];
  private readonly pesosLoja: number[];
  private readonly cd: Estoque;

  constructor(
    private readonly cad: Cadastro,
    private readonly gravar: (lote: Movimento[]) => Promise<void>,
  ) {
    // Popularidade de Zipf (as cervejas mais vendidas concentram as vendas), em ordem embaralhada.
    const pesos = cad.produtos.map((_, i) => 1 / Math.pow(i + 1, 0.9));
    for (let i = pesos.length - 1; i > 0; i--) {
      const j = Math.floor(sorteio() * (i + 1));
      [pesos[i], pesos[j]] = [pesos[j]!, pesos[i]!];
    }
    this.pesosProduto = acumular(pesos);
    this.lojasVenda = cad.estoques.filter((e) => e.tipo !== 'cd');
    this.pesosLoja = acumular(this.lojasVenda.map((e) => (e.tipo === 'treino' ? 1 : 40 - 7 * estoqueN(e))));
    this.cd = cad.estoques.find((e) => e.tipo === 'cd')!;
  }

  get total(): number {
    return this.seq;
  }

  /** O instante do movimento de número `n`: o ano distribuído por igual, com um pouco de ruído. */
  private agora(): number {
    return Math.min(FIM - 1, Math.floor(INICIO + ((FIM - INICIO) * this.seq) / TOTAL + sorteio() * 1000));
  }

  linha(estoque: Estoque, produto: number, tipoEstoqueId = this.cad.padrao): Linha {
    const k = `${estoque.id}|${produto}|${tipoEstoqueId}`;
    let l = this.linhas.get(k);
    if (!l) {
      l = {
        estoque,
        produto,
        tipoEstoqueId,
        quantidade: '0.000',
        custoMedio: '0.0000',
        entradaEm: null,
        saidaEm: null,
        compraEm: null,
        custoCompra: null,
        ultimoId: null,
      };
      this.linhas.set(k, l);
    }
    return l;
  }

  /** Lança um movimento na linha pela regra do motor e o põe no lote de gravação. */
  async lancar(
    linha: Linha,
    tipo: string,
    quantidade: number,
    extra: {
      custo?: string;
      data?: number;
      usuarioId?: string | null;
      pessoaId?: string | null;
      documentoTipo: string;
      documentoId: string;
      estornoDeId?: string | null;
      compensaId?: string | null;
    },
  ): Promise<Movimento> {
    const custoReferencia = extra.custo ?? this.cad.produtos[linha.produto]!.custo.toFixed(4);
    const r = aplicarMovimentoNoSaldo(
      linha.quantidade,
      linha.custoMedio,
      movimentoGravadoNoSaldo({
        quantidade: quantidade.toFixed(3),
        custoUnitario: custoReferencia,
        estornoDeId: extra.estornoDeId ?? null,
        tipoMovimento: tipo,
      }),
    );
    const data = extra.data ?? this.agora();
    const m: Movimento = {
      id: uuidv7(),
      linha,
      tipo,
      quantidade: r.quantidade,
      saldoAnterior: r.saldoAnterior,
      saldoPosterior: r.saldoPosterior,
      custoUnitario: r.custoUnitario,
      custoTotal: r.custoTotal,
      custoMedioPosterior: r.custoMedioPosterior,
      precoVenda: tipo === 'VENDA_PDV' ? (Number(r.custoUnitario) * 1.6 + 0.5).toFixed(4) : null,
      data,
      usuarioId: extra.usuarioId ?? null,
      pessoaId: extra.pessoaId ?? null,
      documentoTipo: extra.documentoTipo,
      documentoId: extra.documentoId,
      estornoDeId: extra.estornoDeId ?? null,
      compensaId: extra.compensaId ?? null,
      seq: ++this.seq,
    };
    // A projeção do fim da linha, pelas regras do replay (`ReplayLinha`).
    linha.quantidade = r.saldoPosterior;
    linha.custoMedio = r.custoMedioPosterior;
    if (quantidade > 0) linha.entradaEm = Math.max(linha.entradaEm ?? data, data);
    else linha.saidaEm = Math.max(linha.saidaEm ?? data, data);
    if (movimentoDeCompra({ tipoMovimento: tipo, quantidade: r.quantidade, estornoDeId: m.estornoDeId })) {
      linha.compraEm = data;
      linha.custoCompra = r.custoUnitario;
    }
    linha.ultimoId = m.id;
    this.contagem.set(tipo, (this.contagem.get(tipo) ?? 0) + 1);
    this.lote.push(m);
    if (this.lote.length >= POR_LOTE) await this.descarregar();
    return m;
  }

  async descarregar(): Promise<void> {
    if (!this.lote.length) return;
    const lote = this.lote;
    this.lote = [];
    await this.gravar(lote);
  }

  private acerto(estoque: Estoque): string {
    const a = this.acertoAberto.get(estoque.id);
    if (a && a.itens < 20) {
      a.itens++;
      return a.id;
    }
    const novo = { id: randomUUID(), itens: 1 };
    this.acertoAberto.set(estoque.id, novo);
    return novo.id;
  }

  /** Inventário inicial (F2-B9): um Definir por estoque, com todos os produtos. */
  async inventarioInicial(): Promise<void> {
    for (const e of this.cad.estoques) {
      const documentoId = randomUUID();
      for (let p = 0; p < this.cad.produtos.length; p++) {
        const q = e.tipo === 'cd' ? inteiro(500, 2000) : e.tipo === 'treino' ? 10 : inteiro(24, 120);
        await this.lancar(this.linha(e, p), 'ACERTO_DEFINIR', q, {
          data: INICIO + inteiro(0, 3_600_000),
          usuarioId: e.operadores[0],
          documentoTipo: 'acerto',
          documentoId,
        });
      }
    }
  }

  /** Reposição depois de uma saída: transferência do CD (75%) ou compra; o CD e a Treino se repõem sozinhos. */
  private async repor(linha: Linha): Promise<void> {
    if (linha.tipoEstoqueId !== this.cad.padrao) return;
    const e = linha.estoque;
    const saldo = Number(linha.quantidade);
    const produto = this.cad.produtos[linha.produto]!;
    if (e.tipo === 'cd') {
      if (saldo >= 200) return;
      await this.lancar(linha, 'RECEB_NFE', 480 * inteiro(1, 5), {
        custo: (produto.custo * (0.9 + 0.2 * sorteio())).toFixed(4),
        usuarioId: e.operadores[0],
        pessoaId: produto.fornecedor,
        documentoTipo: 'nota_entrada',
        documentoId: randomUUID(),
      });
      return;
    }
    if (saldo >= 12) return;
    const quantidade = 24 * inteiro(1, 5);
    if (e.tipo === 'treino') {
      await this.lancar(linha, 'ACERTO_ENTRADA', quantidade, {
        usuarioId: e.operadores[0],
        documentoTipo: 'acerto',
        documentoId: this.acerto(e),
      });
      return;
    }
    if (sorteio() < 0.75) {
      const documentoId = randomUUID();
      const origem = this.linha(this.cd, linha.produto);
      const saida = await this.lancar(origem, 'TRANSF_SAIDA', -quantidade, {
        usuarioId: this.cd.operadores[0],
        documentoTipo: 'transferencia',
        documentoId,
      });
      await this.lancar(linha, 'TRANSF_ENTRADA', quantidade, {
        custo: saida.custoUnitario,
        usuarioId: e.operadores[1],
        documentoTipo: 'transferencia',
        documentoId,
      });
      await this.repor(origem);
      return;
    }
    const nfe = sorteio() < 0.6;
    await this.lancar(linha, nfe ? 'RECEB_NFE' : 'RECEB_MANUAL', quantidade, {
      custo: (produto.custo * (0.9 + 0.2 * sorteio())).toFixed(4),
      usuarioId: e.operadores[1],
      pessoaId: produto.fornecedor,
      documentoTipo: nfe ? 'nota_entrada' : 'recebimento',
      documentoId: randomUUID(),
    });
  }

  private async venda(): Promise<void> {
    const e = this.lojasVenda[porPeso(this.pesosLoja)]!;
    const documentoId = randomUUID();
    const itens = 1 + Math.floor(Math.pow(sorteio(), 2) * 4);
    // Venda offline que chega tarde (até 48 h depois, SYNC 15.3): a data é a da venda; a ordem, a do lançamento.
    const tardia = sorteio() < 0.01 ? inteiro(3_600_000, 48 * 3_600_000) : 0;
    for (let i = 0; i < itens; i++) {
      const linha = this.linha(e, porPeso(this.pesosProduto));
      const q = 1 + Math.floor(Math.pow(sorteio(), 2) * 6);
      const m = await this.lancar(linha, 'VENDA_PDV', -q, {
        data: tardia ? Math.max(INICIO, this.agora() - tardia) : undefined,
        usuarioId: escolher(e.operadores),
        documentoTipo: 'venda',
        documentoId,
      });
      if (this.vendas.length < 2000) this.vendas.push(null);
      this.vendas[m.seq % 2000] = {
        id: m.id,
        linha,
        quantidade: m.quantidade,
        custo: m.custoUnitario,
        documentoId,
      };
      // A tardia que caiu depois de um Definir é compensada contra ele (ERP 13.1.5 regra 3), em parte delas.
      if (tardia && sorteio() < 0.3) {
        await this.lancar(linha, 'ACERTO_COMPENSACAO', q, {
          custo: m.custoUnitario,
          documentoTipo: 'acerto',
          documentoId: this.acerto(e),
          compensaId: m.id,
        });
      }
      await this.repor(linha);
    }
  }

  private async cancelamento(): Promise<void> {
    const i = Math.floor(sorteio() * this.vendas.length);
    const v = this.vendas[i];
    if (!v) return;
    this.vendas[i] = null;
    await this.lancar(v.linha, 'CANC_VENDA_PDV', -Number(v.quantidade), {
      custo: v.custo,
      usuarioId: escolher(v.linha.estoque.operadores),
      documentoTipo: 'venda',
      documentoId: v.documentoId,
      estornoDeId: v.id,
    });
  }

  private async acertoAvulso(): Promise<void> {
    const e = escolher(this.cad.estoques);
    const linha = this.linha(e, porPeso(this.pesosProduto));
    const documentoId = this.acerto(e);
    const extra = { usuarioId: e.operadores[0], documentoTipo: 'acerto', documentoId };
    const sorte = sorteio();
    if (sorte < 0.15) {
      // Avaria: sai do vendável e entra no tipo Avaria (dois acertos simples, sem a mudança de tipo).
      await this.lancar(linha, 'ACERTO_SAIDA', -1, extra);
      await this.lancar(this.linha(e, linha.produto, this.cad.avaria), 'ACERTO_ENTRADA', 1, extra);
    } else if (sorte < 0.55) {
      const saldo = Math.round(Number(linha.quantidade));
      const alvo = Math.max(0, saldo + inteiro(-4, 3));
      const q = alvo - Number(linha.quantidade);
      if (q !== 0) await this.lancar(linha, 'ACERTO_DEFINIR', q, extra);
    } else if (sorte < 0.75) {
      await this.lancar(linha, 'ACERTO_ENTRADA', inteiro(1, 5), extra);
    } else {
      await this.lancar(linha, 'ACERTO_SAIDA', -inteiro(1, 5), extra);
    }
    await this.repor(linha);
  }

  async gerar(aoProgredir: (n: number) => void): Promise<void> {
    await this.inventarioInicial();
    let ultimo = 0;
    while (this.seq < TOTAL) {
      const s = sorteio();
      if (s < 0.97) await this.venda();
      else if (s < 0.985) await this.cancelamento();
      else await this.acertoAvulso();
      if (this.seq - ultimo >= 250_000) {
        ultimo = this.seq;
        aoProgredir(this.seq);
      }
    }
    await this.descarregar();
  }
}

const estoqueN = (e: Estoque) => Number(e.nome.replace(/\D/g, '') || 0);

// ---------------------------------------------------------------- Gravação

const COLUNAS = [
  ['id', 'uuid'],
  ['estoque_id', 'uuid'],
  ['loja_id', 'uuid'],
  ['tipo_estoque_id', 'uuid'],
  ['produto_id', 'uuid'],
  ['tipo_movimento', 'text'],
  ['quantidade', 'numeric'],
  ['saldo_anterior', 'numeric'],
  ['saldo_posterior', 'numeric'],
  ['custo_unitario', 'numeric'],
  ['custo_total', 'numeric'],
  ['custo_medio_posterior', 'numeric'],
  ['preco_venda', 'numeric'],
  ['data_movimento', 'timestamptz'],
  ['usuario_id', 'uuid'],
  ['pessoa_id', 'uuid'],
  ['documento_tipo', 'text'],
  ['documento_id', 'uuid'],
  ['documento_item_id', 'uuid'],
  ['estorno_de_id', 'uuid'],
  ['compensa_movimento_id', 'uuid'],
  ['seq_lancamento', 'bigint'],
] as const;

const SQL_INSERIR = `insert into movimentos_estoque (${COLUNAS.map((c) => c[0]).join(', ')})
  select * from unnest(${COLUNAS.map((c, i) => `$${i + 1}::${c[1]}[]`).join(', ')})`;

function gravador(c: pg.Client, produtos: Cadastro['produtos']): (lote: Movimento[]) => Promise<void> {
  // Uma gravação em voo enquanto o próximo lote é gerado (a conexão é uma só: os estornos e as compensações citam
  // movimentos dos lotes anteriores, que já têm de estar gravados).
  let emVoo: Promise<unknown> = Promise.resolve();
  return async (lote) => {
    const valores = [
      lote.map((m) => m.id),
      lote.map((m) => m.linha.estoque.id),
      lote.map((m) => m.linha.estoque.lojaId),
      lote.map((m) => m.linha.tipoEstoqueId),
      lote.map((m) => produtos[m.linha.produto]!.id),
      lote.map((m) => m.tipo),
      lote.map((m) => m.quantidade),
      lote.map((m) => m.saldoAnterior),
      lote.map((m) => m.saldoPosterior),
      lote.map((m) => m.custoUnitario),
      lote.map((m) => m.custoTotal),
      lote.map((m) => m.custoMedioPosterior),
      lote.map((m) => m.precoVenda),
      lote.map((m) => new Date(m.data).toISOString()),
      lote.map((m) => m.usuarioId),
      lote.map((m) => m.pessoaId),
      lote.map((m) => m.documentoTipo),
      lote.map((m) => m.documentoId),
      lote.map(() => randomUUID()),
      lote.map((m) => m.estornoDeId),
      lote.map((m) => m.compensaId),
      lote.map((m) => m.seq),
    ];
    await emVoo;
    emVoo = c.query(SQL_INSERIR, valores);
    emVoo.catch(() => undefined);
    if (lote.length < POR_LOTE) await emVoo;
  };
}

async function gravarProjecao(c: pg.Client, g: Gerador, produtos: Cadastro['produtos']): Promise<void> {
  const linhas = [...g.linhas.values()];
  const data = (v: number | null) => (v === null ? null : new Date(v).toISOString());
  for (let i = 0; i < linhas.length; i += POR_LOTE) {
    const l = linhas.slice(i, i + POR_LOTE);
    await c.query(
      `insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio, ultima_entrada_em,
         ultima_saida_em, ultima_compra_em, ultimo_custo_compra, ultimo_movimento_id)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::numeric[], $5::numeric[], $6::timestamptz[],
         $7::timestamptz[], $8::timestamptz[], $9::numeric[], $10::uuid[])`,
      [
        l.map((x) => x.estoque.id),
        l.map((x) => produtos[x.produto]!.id),
        l.map((x) => x.tipoEstoqueId),
        l.map((x) => x.quantidade),
        l.map((x) => x.custoMedio),
        l.map((x) => data(x.entradaEm)),
        l.map((x) => data(x.saidaEm)),
        l.map((x) => data(x.compraEm)),
        l.map((x) => x.custoCompra),
        l.map((x) => x.ultimoId),
      ],
    );
  }
}

/**
 * Só a massa (cadastro, movimentos e a projeção, com o `vacuum analyze`) na empresa de `banco`, pela conexão `c`, para
 * outro teste: com a mesma semente e o mesmo total sai a mesma massa do roteiro.
 */
export async function gerarMassa(
  banco: string,
  c: pg.Client,
  opcoes: { movimentos: number; produtos?: number; semente?: number; aoProgredir?: (n: number) => void },
): Promise<{ cadastro: Cadastro; movimentos: number; linhasSaldo: number }> {
  TOTAL = opcoes.movimentos;
  PRODUTOS = opcoes.produtos ?? PRODUTOS;
  SEMENTE = opcoes.semente ?? SEMENTE;
  estadoSorteio = SEMENTE >>> 0;
  const cadastro = await cadastrar(banco, c);
  const g = new Gerador(cadastro, gravador(c, cadastro.produtos));
  await g.gerar(opcoes.aoProgredir ?? (() => undefined));
  await gravarProjecao(c, g, cadastro.produtos);
  await c.query('vacuum (analyze) movimentos_estoque');
  await c.query('vacuum (analyze) saldos_estoque');
  return { cadastro, movimentos: g.total, linhasSaldo: g.linhas.size };
}

// ---------------------------------------------------------------- Roteiro de EXPLAIN

interface Parametros {
  loja: string;
  cd: string;
  semTreino: string[];
  produto: string;
  meio: { data: string; id: string };
  ontem: string;
  seisMeses: string;
  acerto: string;
}

interface Consulta {
  chave: string;
  titulo: string;
  sql: string;
  params: (p: Parametros) => unknown[];
  /** Lida por um cursor do servidor (`declare` + `fetch`), como a exportação em streaming (F2-B29). */
  cursor?: true;
}

const PERIODO = [new Date(INICIO).toISOString(), new Date(FIM).toISOString()];
const COLUNAS_ANALITICA = `m.id, m.data_movimento, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.tipo_movimento,
  m.quantidade, m.custo_unitario, m.custo_total, m.documento_tipo, m.documento_id, m.usuario_id, m.pessoa_id`;

const ROTEIRO: Consulta[] = [
  {
    chave: 'analitica_primeira',
    titulo: 'Movimentação analítica, 12 meses de uma loja: 1ª página (101 linhas)',
    sql: `select ${COLUNAS_ANALITICA} from movimentos_estoque m
           where m.estoque_id = $1 and m.data_movimento >= $2 and m.data_movimento < $3
           order by m.data_movimento, m.id limit 101`,
    params: (p) => [p.loja, ...PERIODO],
  },
  {
    chave: 'analitica_cursor',
    titulo: 'Movimentação analítica: página do meio do ano pelo cursor (data_movimento, id)',
    sql: `select ${COLUNAS_ANALITICA} from movimentos_estoque m
           where m.estoque_id = $1 and m.data_movimento >= $2 and m.data_movimento < $3
             and (m.data_movimento, m.id) > ($4::timestamptz, $5::uuid)
           order by m.data_movimento, m.id limit 101`,
    params: (p) => [p.loja, ...PERIODO, p.meio.data, p.meio.id],
  },
  {
    chave: 'analitica_produto',
    titulo: 'Movimentação analítica: filtro de um produto',
    sql: `select ${COLUNAS_ANALITICA} from movimentos_estoque m
           where m.estoque_id = $1 and m.produto_id = $4 and m.data_movimento >= $2 and m.data_movimento < $3
           order by m.data_movimento, m.id limit 101`,
    params: (p) => [p.loja, ...PERIODO, p.produto],
  },
  {
    chave: 'analitica_tipos',
    titulo: 'Movimentação analítica: filtro de tipos (só as compras)',
    sql: `select ${COLUNAS_ANALITICA} from movimentos_estoque m
           where m.estoque_id = $1 and m.data_movimento >= $2 and m.data_movimento < $3
             and m.tipo_movimento = any($4::text[])
           order by m.data_movimento, m.id limit 101`,
    params: (p) => [p.loja, ...PERIODO, ['RECEB_MANUAL', 'RECEB_NFE']],
  },
  {
    chave: 'saldo_anterior_pagina',
    titulo: 'Movimentação analítica: saldo anterior de cada linha da página (soma antes do cursor)',
    sql: `with pagina as (
            select m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id from movimentos_estoque m
             where m.estoque_id = $1 and m.data_movimento >= $2 and m.data_movimento < $3
               and (m.data_movimento, m.id) > ($4::timestamptz, $5::uuid)
             order by m.data_movimento, m.id limit 101)
          select l.produto_id, l.tipo_estoque_id,
                 (select coalesce(sum(x.quantidade), 0) from movimentos_estoque x
                   where x.estoque_id = l.estoque_id and x.produto_id = l.produto_id
                     and x.variacao_id is not distinct from l.variacao_id and x.tipo_estoque_id = l.tipo_estoque_id
                     and (x.data_movimento, x.id) <= ($4::timestamptz, $5::uuid)) as saldo_anterior
            from (select distinct * from pagina) l`,
    params: (p) => [p.loja, ...PERIODO, p.meio.data, p.meio.id],
  },
  {
    chave: 'sintetica_loja',
    titulo: 'Movimentação sintética, 12 meses de uma loja (por produto e tipo de estoque)',
    sql: `select produto_id, variacao_id, tipo_estoque_id,
                 coalesce(sum(quantidade) filter (where data_movimento < $2), 0) as saldo_inicial,
                 coalesce(sum(quantidade) filter (where data_movimento >= $2 and quantidade > 0), 0) as entradas,
                 coalesce(sum(-quantidade) filter (where data_movimento >= $2 and quantidade < 0), 0) as saidas,
                 sum(quantidade) as saldo_final,
                 coalesce(sum(custo_total) filter (where data_movimento >= $2 and quantidade > 0), 0) as custo_entradas,
                 coalesce(sum(custo_total) filter (where data_movimento >= $2 and quantidade < 0), 0) as custo_saidas
            from movimentos_estoque
           where estoque_id = $1 and data_movimento < $3
           group by produto_id, variacao_id, tipo_estoque_id`,
    params: (p) => [p.loja, ...PERIODO],
  },
  {
    chave: 'saldo_data_base_soma',
    titulo: 'Saldo numa data-base (ontem), todas as lojas e o CD: soma do razão até a data',
    sql: `select estoque_id, produto_id, variacao_id, tipo_estoque_id, sum(quantidade) as saldo
            from movimentos_estoque
           where estoque_id = any($1::uuid[]) and data_movimento <= $2
           group by estoque_id, produto_id, variacao_id, tipo_estoque_id`,
    params: (p) => [p.semTreino, p.ontem],
  },
  {
    chave: 'saldo_data_base_projecao',
    titulo: 'Saldo numa data-base (ontem), todas as lojas e o CD: projeção menos o razão depois da data',
    sql: `select s.estoque_id, s.produto_id, s.variacao_id, s.tipo_estoque_id, s.quantidade - coalesce(d.q, 0) as saldo
            from saldos_estoque s
            left join (select estoque_id, produto_id, variacao_id, tipo_estoque_id, sum(quantidade) as q
                         from movimentos_estoque
                        where estoque_id = any($1::uuid[]) and data_movimento > $2
                        group by estoque_id, produto_id, variacao_id, tipo_estoque_id) d
              on d.estoque_id = s.estoque_id and d.produto_id = s.produto_id
             and d.variacao_id is not distinct from s.variacao_id and d.tipo_estoque_id = s.tipo_estoque_id
           where s.estoque_id = any($1::uuid[])`,
    params: (p) => [p.semTreino, p.ontem],
  },
  {
    chave: 'saldo_data_base_projecao_6m',
    titulo:
      'Saldo numa data-base (6 meses atrás), todas as lojas e o CD: projeção menos o razão depois da data',
    sql: '',
    params: (p) => [p.semTreino, p.seisMeses],
  },
  {
    chave: 'ultima_compra_loja',
    titulo: 'Última compra (RECEB_MANUAL/RECEB_NFE) até o fim do período, por produto: uma loja',
    sql: `select distinct on (produto_id, variacao_id) produto_id, variacao_id, data_movimento, custo_unitario
            from movimentos_estoque
           where estoque_id = $1 and tipo_movimento in ('RECEB_MANUAL', 'RECEB_NFE') and estorno_de_id is null
             and quantidade > 0 and data_movimento < $2
           order by produto_id, variacao_id, data_movimento desc`,
    params: (p) => [p.loja, PERIODO[1]],
  },
  {
    chave: 'ultima_compra_cd',
    titulo: 'Última compra até o fim do período, por produto: o CD',
    sql: '',
    params: (p) => [p.cd, PERIODO[1]],
  },
  {
    chave: 'detalhe_acerto',
    titulo: 'Detalhe do acerto (inventário inicial de uma loja, 2.000 itens)',
    sql: `select m.* from movimentos_estoque m
           where m.documento_tipo = 'acerto' and m.documento_id = $1 order by m.seq_lancamento`,
    params: (p) => [p.acerto],
  },
  {
    chave: 'exportacao_loja',
    titulo: 'Exportação: os 12 meses de uma loja inteiros, na ordem do cursor (streaming)',
    sql: `select ${COLUNAS_ANALITICA} from movimentos_estoque m
           where m.estoque_id = $1 and m.data_movimento >= $2 and m.data_movimento < $3
           order by m.data_movimento, m.id`,
    params: (p) => [p.loja, ...PERIODO],
    cursor: true,
  },
  {
    chave: 'replay_cursor',
    titulo: 'Replay do recalcular: cursor do razão inteiro na ordem da linha (1ª página de 10 mil)',
    sql: `select estoque_id, produto_id, variacao_id, tipo_estoque_id, id, seq_lancamento, quantidade
            from movimentos_estoque m
           order by m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.seq_lancamento, m.id
           limit 10000`,
    params: () => [],
  },
];
// As variantes repetem a consulta com outros parâmetros.
ROTEIRO.find((q) => q.chave === 'saldo_data_base_projecao_6m')!.sql = ROTEIRO.find(
  (q) => q.chave === 'saldo_data_base_projecao',
)!.sql;
ROTEIRO.find((q) => q.chave === 'ultima_compra_cd')!.sql = ROTEIRO.find(
  (q) => q.chave === 'ultima_compra_loja',
)!.sql;

interface NoPlano {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  'Sort Method'?: string;
  'Workers Launched'?: number;
  Plans?: NoPlano[];
}

interface Medida {
  chave: string;
  titulo: string;
  ms: number;
  primeiraMs: number;
  plano: string;
  linhas: number;
  paginas: number;
  temp: number;
}

/** O plano em uma linha: os nós de cima para baixo, com o índice e as linhas reais dos que importam. */
function resumir(no: NoPlano, profundidade = 0): string[] {
  const nome =
    no['Node Type'] +
    (no['Index Name'] ? ` ${no['Index Name']}` : no['Relation Name'] ? ` ${no['Relation Name']}` : '') +
    (no['Sort Method'] ? ` (${no['Sort Method']})` : '') +
    (no['Workers Launched'] ? ` (${no['Workers Launched']} workers)` : '');
  const linhas =
    no['Actual Rows'] !== undefined ? ` ${(no['Actual Rows'] * (no['Actual Loops'] ?? 1)).toFixed(0)}` : '';
  const filhos = (no.Plans ?? []).flatMap((f) => resumir(f, profundidade + 1));
  return [`${nome}${linhas}`, ...filhos].slice(0, 6);
}

/** Os parâmetros como literais (o `declare … cursor` é instrução utilitária; ver `paginasCursor` do recalcular). */
function comLiterais(sql: string, params: unknown[]): string {
  const literal = (v: unknown): string =>
    Array.isArray(v) ? `array[${v.map(literal).join(', ')}]` : `'${String(v).replace(/'/g, "''")}'`;
  return sql.replace(/\$(\d+)/g, (_, n: string) => literal(params[Number(n) - 1]));
}

/**
 * A leitura inteira por um cursor do servidor, em páginas de 10 mil (a exportação em streaming): o tempo até a
 * primeira página, o total e o plano que o cursor usa (o planejador otimiza o cursor para a primeira fração).
 */
async function porCursor(c: pg.Client, q: Consulta, p: Parametros): Promise<Medida> {
  const sql = comLiterais(q.sql, q.params(p));
  const { rows: plano } = await c.query<{ 'QUERY PLAN': [{ Plan: NoPlano }] }>(
    `explain (format json) declare carga no scroll cursor for ${sql}`,
  );
  const ler = async () => {
    await c.query('begin read only');
    try {
      const inicio = performance.now();
      await c.query(`declare carga no scroll cursor for ${sql}`);
      let primeira = 0;
      let linhas = 0;
      for (;;) {
        const { rows } = await c.query('fetch 10000 from carga');
        if (!primeira) primeira = performance.now() - inicio;
        linhas += rows.length;
        if (rows.length < 10000) break;
      }
      return { total: performance.now() - inicio, primeira, linhas };
    } finally {
      await c.query('rollback');
    }
  };
  const r1 = await ler();
  const r2 = await ler();
  const melhor = r2.total < r1.total ? r2 : r1;
  return {
    chave: q.chave,
    titulo: q.titulo,
    ms: Math.round(melhor.total),
    primeiraMs: Math.round(melhor.primeira),
    plano: `cursor: ${resumir(plano[0]!['QUERY PLAN'][0].Plan).join(' ← ')}`,
    linhas: melhor.linhas,
    paginas: 0,
    temp: 0,
  };
}

async function explicar(c: pg.Client, q: Consulta, p: Parametros): Promise<Medida> {
  if (q.cursor) return porCursor(c, q, p);
  const params = q.params(p);
  const rodar = async () => {
    const { rows } = await c.query<{ 'QUERY PLAN': [{ Plan: NoPlano; 'Execution Time': number }] }>(
      `explain (analyze, buffers, format json) ${q.sql}`,
      params,
    );
    return rows[0]!['QUERY PLAN'][0];
  };
  const primeira = await rodar();
  let melhor = primeira;
  for (let i = 0; i < 2; i++) {
    const r = await rodar();
    if (r['Execution Time'] < melhor['Execution Time']) melhor = r;
  }
  const raiz = melhor.Plan;
  return {
    chave: q.chave,
    titulo: q.titulo,
    ms: Math.round(melhor['Execution Time'] * 10) / 10,
    primeiraMs: Math.round(primeira['Execution Time'] * 10) / 10,
    plano: resumir(raiz).join(' ← '),
    linhas: raiz['Actual Rows'] ?? 0,
    // Páginas de 8 kB que a consulta tocou (cache + disco, com os filhos): o que ela leria com o cache frio.
    paginas: (raiz['Shared Hit Blocks'] ?? 0) + (raiz['Shared Read Blocks'] ?? 0),
    temp: raiz['Temp Written Blocks'] ?? 0,
  };
}

async function roteiro(c: pg.Client, p: Parametros, chaves?: readonly string[]): Promise<Medida[]> {
  const r: Medida[] = [];
  for (const q of ROTEIRO) {
    if (chaves && !chaves.includes(q.chave)) continue;
    r.push(await explicar(c, q, p));
  }
  return r;
}

function tabela(titulo: string, medidas: Medida[]): string {
  return [
    `\n### ${titulo}\n`,
    '| Consulta | ms (melhor de 3) | ms (1ª execução; no cursor, até a 1ª página) | linhas | páginas | plano |',
    '|---|---:|---:|---:|---:|---|',
    ...medidas.map(
      (m) => `| ${m.chave} | ${m.ms} | ${m.primeiraMs} | ${m.linhas} | ${m.paginas} | ${m.plano} |`,
    ),
  ].join('\n');
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

// ---------------------------------------------------------------- Principal

async function principal(): Promise<void> {
  const t0 = Date.now();
  const amb = await criarAmbiente({ comApp: false });
  const resultado: Record<string, unknown> = { movimentos: TOTAL, produtos: PRODUTOS, semente: SEMENTE };
  let c: pg.Client | null = null;
  try {
    const empresa = await amb.criarEmpresa();
    console.log(`Empresa de carga: ${empresa.nomeBanco}`);
    c = await conectar(empresa.nomeBanco);
    const cad = await cadastrar(empresa.nomeBanco, c);

    const tGeracao = Date.now();
    {
      // Num bloco: o gerador (as linhas e os lotes) sai de alcance antes da medição do heap do replay.
      const g = new Gerador(cad, gravador(c, cad.produtos));
      await g.gerar((n) =>
        console.log(
          `  ${n.toLocaleString('pt-BR')} movimentos (${((Date.now() - tGeracao) / 1000).toFixed(0)} s)`,
        ),
      );
      await gravarProjecao(c, g, cad.produtos);
      const geracaoS = (Date.now() - tGeracao) / 1000;
      console.log(`Massa gravada: ${g.total.toLocaleString('pt-BR')} movimentos em ${geracaoS.toFixed(0)} s`);
      const tVacuum = Date.now();
      await c.query('vacuum (analyze) movimentos_estoque');
      await c.query('vacuum (analyze) saldos_estoque');
      const { rows: porEstoque } = await c.query<{ estoque_id: string; n: string }>(
        'select estoque_id, count(*)::text as n from movimentos_estoque group by 1',
      );
      const { rows: tamanhos } = await c.query<{ tabela: string; indices: string }>(
        `select pg_relation_size('movimentos_estoque')::text as tabela,
                pg_indexes_size('movimentos_estoque')::text as indices`,
      );
      resultado.massa = {
        geracao_s: Math.round(geracaoS),
        vacuum_s: Math.round((Date.now() - tVacuum) / 1000),
        linhas_saldo: g.linhas.size,
        por_tipo: Object.fromEntries([...g.contagem].sort((a, b) => b[1] - a[1])),
        por_estoque: Object.fromEntries(
          porEstoque.map((r) => [cad.estoques.find((e) => e.id === r.estoque_id)!.nome, Number(r.n)]),
        ),
        tabela: mb(Number(tamanhos[0]!.tabela)),
        indices_existentes: mb(Number(tamanhos[0]!.indices)),
      };
      console.log(JSON.stringify(resultado.massa, null, 2));
    }

    const loja = cad.estoques.find((e) => e.nome === 'Loja 1')!;
    const { rows: meio } = await c.query<{ data: string; id: string }>(
      `select data_movimento::text as data, id from movimentos_estoque
        where estoque_id = $1 and data_movimento >= '2026-05-01T03:00:00Z' order by data_movimento, id limit 1`,
      [loja.id],
    );
    const { rows: acerto } = await c.query<{ id: string }>(
      `select documento_id as id from movimentos_estoque where estoque_id = $1 and tipo_movimento = 'ACERTO_DEFINIR'
        order by seq_lancamento limit 1`,
      [loja.id],
    );
    const p: Parametros = {
      loja: loja.id,
      cd: cad.estoques.find((e) => e.tipo === 'cd')!.id,
      semTreino: cad.estoques.filter((e) => e.tipo !== 'treino').map((e) => e.id),
      produto: cad.produtos[0]!.id,
      meio: meio[0]!,
      ontem: new Date(FIM - 86_400_000).toISOString(),
      seisMeses: new Date(FIM - 183 * 86_400_000).toISOString(),
      acerto: acerto[0]!.id,
    };
    if (SO_MASSA) return;

    // Antes: sem os índices da 0026 (a empresa nasceu com eles, pela migração).
    for (const i of INDICES_RAZAO) await c.query(`drop index if exists ${i.nome}`);
    const antes = await roteiro(c, p);
    console.log(tabela('Antes (sem os índices da 0026)', antes));

    // Os índices pela preparação da migração (concurrently), com o tempo e o tamanho na massa.
    const criados = await garantirIndicesRazao(c);
    const indices = [];
    for (const i of criados) {
      const { rows } = await c.query<{ b: string }>('select pg_relation_size($1)::text as b', [i.nome]);
      indices.push({ ...i, tamanho: mb(Number(rows[0]!.b)) });
    }
    console.log('\nÍndices criados:', JSON.stringify(indices));
    const depois = await roteiro(c, p);
    console.log(tabela('Depois (com os índices da 0026)', depois));

    // Candidatos descartados: criados só para medir as consultas a que serviriam.
    const descartados = [];
    for (const cand of CANDIDATOS_DESCARTADOS) {
      const inicio = Date.now();
      await c.query(`create index ${cand.nome} on movimentos_estoque ${cand.definicao}`);
      const criacaoMs = Date.now() - inicio;
      const { rows } = await c.query<{ b: string }>('select pg_relation_size($1)::text as b', [cand.nome]);
      const medidas = await roteiro(c, p, cand.consultas);
      await c.query(`drop index ${cand.nome}`);
      descartados.push({ ...cand, criacaoMs, tamanho: mb(Number(rows[0]!.b)), medidas });
      console.log(tabela(`Candidato ${cand.nome} (${mb(Number(rows[0]!.b))}, ${criacaoMs} ms)`, medidas));
    }

    // O replay do `db:recalcular-saldos` da empresa inteira: tempo e pico de heap.
    // Com `--expose-gc` (o `carga:razao` liga), o heap inicial é só o que está vivo.
    global.gc?.();
    const heapInicial = process.memoryUsage().heapUsed;
    let pico = heapInicial;
    const tReplay = Date.now();
    const r = await verificarSaldos(
      c,
      {},
      { aoPaginar: () => (pico = Math.max(pico, process.memoryUsage().heapUsed)) },
    );
    pico = Math.max(pico, process.memoryUsage().heapUsed);
    const replay = {
      segundos: Math.round((Date.now() - tReplay) / 1000),
      linhas: r.linhas,
      movimentos: r.movimentos,
      divergencias: r.divergencias.length,
      razao_inconsistente: r.razaoInconsistente.length,
      custo_produtos: r.custoProdutos.length,
      heap_inicial: mb(heapInicial),
      heap_pico: mb(pico),
      rss: mb(process.memoryUsage().rss),
    };
    console.log('\nReplay do recalcular:', JSON.stringify(replay));

    Object.assign(resultado, {
      antes,
      indices,
      depois,
      descartados,
      replay,
      total_s: Math.round((Date.now() - t0) / 1000),
    });
    if (SAIDA) writeFileSync(SAIDA, JSON.stringify(resultado, null, 2));
    if (r.divergencias.length || r.razaoInconsistente.length) {
      throw new Error('A massa não fecha com o replay do recalcular: confira o gerador');
    }
  } finally {
    await c?.end();
    if (MANTER) console.log('--manter: os bancos ficaram (apague com pnpm --filter api test:limpar)');
    else await amb.fechar();
  }
}

// Só quando é o script chamado (`pnpm --filter api carga:razao`); importado (`gerarMassa`), não roda nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await principal();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  // Com `--manter` o ambiente não é fechado (a trava da faixa e os pools ficariam segurando o processo).
  process.exit(process.exitCode ?? 0);
}
