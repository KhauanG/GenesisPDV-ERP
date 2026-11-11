/**
 * `GET /sync/pull` (SYNC 6.3–6.4; MD 6.1): uma transação `repeatable read read only` por página, teto calculado no
 * mesmo snapshot (maior `versao` de cada tabela do fluxo, sem filtro de loja, e maior `versao_nuvem_fim` dos eventos
 * aplicados), merge por `versao` e corte em `limite` linhas ou 4 MiB. Página não cortada → `novo_cursor =
 * cursor_teto`, mesmo que as últimas versões sejam de outra loja: é o que deixa a carga inicial terminar.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgColumn } from 'drizzle-orm/pg-core';
import type { ClienteEmpresa, Tenancy } from '../tenancy/tenancy.js';
import type { RespostaPull } from './contratos.js';
import { ErroSync } from './erros.js';
import {
  FLUXOS_DESATIVANDO,
  REGISTRO_FLUXOS,
  type EscopoTerminal,
  type Fluxo,
  type TabelaFluxo,
} from './fluxos.js';
import type { TerminalAutenticado } from './terminal.js';

const LIMITE_BYTES_PAGINA = 4 * 1024 * 1024;
const dialeto = new PgDialect();

export interface Alteracao {
  tabela: string;
  versao: number;
  linha: Record<string, unknown>;
}

export type PaginaPull = RespostaPull;

/** Expressão de cada coluna no formato do protocolo (SYNC 2.3): datas ISO UTC com ms e `Z`, decimais em texto. */
function expressaoColuna(c: PgColumn): SQL {
  const nome = sql.identifier(c.name);
  switch (c.columnType) {
    case 'PgTimestamp':
      return sql`to_char(t.${nome} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'PgDateString':
    case 'PgDate':
      return sql`to_char(t.${nome}, 'YYYY-MM-DD')`;
    case 'PgNumeric':
      return sql`t.${nome}::text`;
    case 'PgBigInt53':
    case 'PgBigInt64':
      return sql`t.${nome}::float8`;
    case 'PgCustomColumn':
      // bytea (segredos): nunca em claro.
      return sql`null`;
    default:
      return sql`t.${nome}`;
  }
}

function consultaTabela(
  def: TabelaFluxo,
  escopo: EscopoTerminal,
  desde: number,
  teto: number,
  limite: number,
): SQL {
  const cfg = getTableConfig(def.tabela);
  const omitir = new Set(def.omitir ?? []);
  const colunas = cfg.columns
    .filter((c) => !omitir.has(c.name))
    .map((c) => {
      const proj = def.projecao?.[c.name];
      return sql`${proj ? proj(escopo) : expressaoColuna(c)} as ${sql.identifier(c.name)}`;
    });
  for (const [nome, campo] of Object.entries(def.calculadas ?? {}))
    colunas.push(sql`${campo.expressao()} as ${sql.identifier(nome)}`);
  const filtro = def.filtro ? sql` and (${def.filtro(escopo)})` : sql``;
  return sql`select ${sql.join(colunas, sql`, `)} from ${sql.identifier(cfg.name)} t
    where t.versao > ${desde} and t.versao <= ${teto}${filtro}
    order by t.versao limit ${limite + 1}`;
}

export class PullSync {
  constructor(private readonly tenancy: Tenancy) {}

  async puxar(
    terminal: TerminalAutenticado,
    q: { fluxo: Fluxo; desde: number; limite: number; teto?: number | undefined },
  ): Promise<PaginaPull> {
    if (terminal.status === 'desativando' && !FLUXOS_DESATIVANDO.includes(q.fluxo)) {
      throw ErroSync.escopo('Terminal em desativação recebe só os fluxos acesso e configuracao.');
    }
    const tabelas = REGISTRO_FLUXOS[q.fluxo];
    return this.tenancy.cx().consulta(async (_db, cliente) => {
      await cliente.query('begin isolation level repeatable read read only');
      try {
        const escopo = await this.escopo(cliente, terminal);
        const teto = await this.teto(cliente, tabelas, q.teto);
        const pagina = await this.ler(cliente, tabelas, escopo, q, teto);
        await cliente.query('commit');
        // Fora da transação de leitura e no máximo 1×/min (SYNC 6.4 passo 7).
        await cliente.query(
          `update terminais set ultimo_pull_em = now()
           where id = $1 and (ultimo_pull_em is null or ultimo_pull_em < now() - interval '1 minute')`,
          [terminal.terminalId],
        );
        return pagina;
      } catch (e) {
        await cliente.query('rollback').catch(() => undefined);
        throw e;
      }
    });
  }

  private async escopo(cliente: ClienteEmpresa, terminal: TerminalAutenticado): Promise<EscopoTerminal> {
    const { rows } = await cliente.query<{ estoque_id: string }>(
      'select estoque_id from lojas where id = $1',
      [terminal.lojaId],
    );
    if (!rows[0]) throw new ErroSync('LOJA_INATIVA', 'Loja do terminal não encontrada.');
    return { terminalId: terminal.terminalId, lojaId: terminal.lojaId, estoqueId: rows[0].estoque_id };
  }

  /** Teto no snapshot (SYNC 6.4 passo 3): `max` sem filtro de loja (descida no índice `ix_<tabela>_versao`). */
  private async teto(
    cliente: ClienteEmpresa,
    tabelas: readonly TabelaFluxo[],
    tetoPdv?: number,
  ): Promise<number> {
    const maximos = [
      ...tabelas.map(
        (t) => `(select coalesce(max(versao), 0) from ${JSON.stringify(getTableConfig(t.tabela).name)})`,
      ),
      '(select coalesce(max(versao_nuvem_fim), 0) from eventos_recebidos where versao_nuvem_fim is not null)',
    ];
    const { rows } = await cliente.query<{ teto: string }>(
      `select greatest(${maximos.join(', ')})::text as teto`,
    );
    const teto = Number(rows[0]!.teto);
    return tetoPdv !== undefined ? Math.min(teto, tetoPdv) : teto;
  }

  private async ler(
    cliente: ClienteEmpresa,
    tabelas: readonly TabelaFluxo[],
    escopo: EscopoTerminal,
    q: { fluxo: Fluxo; desde: number; limite: number },
    teto: number,
  ): Promise<PaginaPull> {
    const agora = new Date().toISOString();
    if (teto < q.desde) {
      // Banco da nuvem voltou no tempo (SYNC 22.5): o cursor fica onde está e o PDV ressincroniza o fluxo.
      return {
        fluxo: q.fluxo,
        desde: q.desde,
        novo_cursor: q.desde,
        tem_mais: false,
        cursor_teto: teto,
        agora_servidor: agora,
        alteracoes: [],
      };
    }
    const listas: Alteracao[][] = [];
    for (const def of tabelas) {
      const consulta = dialeto.sqlToQuery(consultaTabela(def, escopo, q.desde, teto, q.limite));
      const { rows } = await cliente.query<Record<string, unknown>>(consulta.sql, consulta.params);
      const tabela = getTableConfig(def.tabela).name;
      listas.push(rows.map((linha) => ({ tabela, versao: Number(linha.versao), linha })));
    }
    // Merge das listas já ordenadas: não há empate de `versao` (um nextval por linha).
    const todas = listas.flat().sort((a, b) => a.versao - b.versao);
    const alteracoes: Alteracao[] = [];
    let bytes = 0;
    let cortada = false;
    for (const alt of todas) {
      if (alteracoes.length >= q.limite) {
        cortada = true;
        break;
      }
      const tamanho = Buffer.byteLength(JSON.stringify(alt));
      if (alteracoes.length > 0 && bytes + tamanho > LIMITE_BYTES_PAGINA) {
        cortada = true;
        break;
      }
      bytes += tamanho;
      alteracoes.push(alt);
    }
    return {
      fluxo: q.fluxo,
      desde: q.desde,
      novo_cursor: cortada ? alteracoes.at(-1)!.versao : teto,
      tem_mais: cortada,
      cursor_teto: teto,
      agora_servidor: agora,
      alteracoes,
    };
  }
}
