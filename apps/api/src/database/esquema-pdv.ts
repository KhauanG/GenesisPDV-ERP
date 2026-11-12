/**
 * Gerador do `apps/pdv/src/GenesisPDV.Data/Esquema.g.cs` (MD 4.1): descreve, para o PDV, as colunas das tabelas da
 * nuvem que o SQLite local espelha (tabelas lidas por algum fluxo do /sync/pull e tabelas de movimento que nascem no
 * PDV), com nome, tipo, escala do `numeric(p,s)`, nulidade e CHECKs. O modelo EF Core do PDV é conferido contra este
 * arquivo por teste (`EsquemaNuvemTests`), o que impede que os dois lados divirjam.
 *
 * Cada coluna de espelho diz também como desce no pull (MD 6.2), lido do registro de fluxos (`sync/fluxos.ts`):
 * `omitida` nunca desce (e não pode existir no espelho), `projetada` desce com outra expressão (condicional ou sempre
 * nula, como os segredos `bytea`). Assim o teste do PDV não mantém à mão a lista de colunas que não descem. Os campos
 * calculados do pull (`calculadas`, F2-B45: `foto_url`, `foto_sha256`…) entram no fim da tabela como projetados.
 *
 * Cada tabela leva também a chave primária (o aplicador do pull faz `on conflict(<chave>)`; as referências têm chave
 * natural, como `ufs.sigla`) e o fluxo que a lê (ordem da carga inicial e `ressincronizar_fluxo`, SYNC 6.1).
 */
import { is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { REGISTRO_FLUXOS, type Fluxo, type TabelaFluxo } from '../sync/fluxos.js';
import { TABELAS_FN_VERSAO } from './empresa/versionamento.js';

/** Tabelas de movimento que nascem no PDV e sobem por evento (MD 4.3); entram assim que existirem no schema Drizzle. */
export const TABELAS_MOVIMENTO_PDV = [
  'sessoes_caixa',
  'movimentos_caixa',
  'fechamentos_caixa',
  'fechamentos_caixa_formas',
  'vendas',
  'itens_venda',
  'itens_venda_complementos',
  'pagamentos_venda',
  'parcelas_venda',
  'transacoes_tef',
  // Fase 1C: o PIX estático nasce no caixa e sobe na venda (MD 3.11.6); a devolução avulsa de cascos (MD 3.12.6).
  'cobrancas_pix',
  'movimentos_vasilhame',
] as const;

/** Como a coluna chega ao PDV pelo `/sync/pull` (igual a `consultaTabela`/`expressaoColuna` de `sync/pull.ts`). */
export type DescidaColuna = 'desce' | 'omitida' | 'projetada';

export interface ColunaPdv {
  nome: string;
  tipoNuvem: string;
  tipoClr: string;
  nulo: boolean;
  escala: number | null;
  descida: DescidaColuna;
  /**
   * Coluna gerada na nuvem (`generated always as (...) stored`, ex.: `fechamentos_caixa.diferenca`): o PDV a calcula
   * ou só a lê, e quem monta o INSERT na nuvem nunca a inclui (o PostgreSQL recusa com 428C9).
   */
  gerada: boolean;
}

export interface TabelaPdv {
  nome: string;
  papel: 'espelho' | 'movimento';
  /** Colunas da chave primária, na ordem da constraint. */
  chave: string[];
  /** Fluxo do pull que lê a tabela (só espelhos). */
  fluxo: Fluxo | null;
  colunas: ColunaPdv[];
  checks: { nome: string; expressao: string }[];
}

const dialeto = new PgDialect();

/** Tipo C# do MD 4.1 para o tipo PostgreSQL da coluna. */
export function tipoClr(tipoSql: string): { tipo: string; escala: number | null } {
  // Arrays (`text[]`, `smallint[]`): JSON em TEXT no SQLite, array no C# (MD 4.1 `text[]` → `string[]`).
  if (tipoSql.endsWith('[]')) {
    const base = tipoClr(tipoSql.slice(0, -2));
    if (base.escala !== null || base.tipo.endsWith('[]'))
      throw new Error(`Array sem mapeamento para o PDV: ${tipoSql}`);
    return { tipo: `${base.tipo}[]`, escala: null };
  }
  // `time` (hora local sem fuso, ex.: faixa de restrição de venda): TEXT `HH:MM:SS` no SQLite.
  if (tipoSql === 'time' || tipoSql.startsWith('time without')) return { tipo: 'TimeOnly', escala: null };
  const numerico = /^numeric\((\d+),\s*(\d+)\)$/.exec(tipoSql);
  if (numerico) return { tipo: 'decimal', escala: Number(numerico[2]) };
  if (tipoSql === 'numeric') throw new Error('numeric sem escala: o PDV precisa de numeric(p,s) (MD 4.1).');
  if (tipoSql === 'uuid') return { tipo: 'Guid', escala: null };
  if (tipoSql.startsWith('timestamp')) return { tipo: 'DateTimeOffset', escala: null };
  if (tipoSql === 'date') return { tipo: 'DateOnly', escala: null };
  if (tipoSql === 'boolean') return { tipo: 'bool', escala: null };
  if (tipoSql === 'smallint') return { tipo: 'short', escala: null };
  if (tipoSql === 'integer') return { tipo: 'int', escala: null };
  if (tipoSql === 'bigint') return { tipo: 'long', escala: null };
  if (tipoSql === 'bytea') return { tipo: 'byte[]', escala: null };
  if (/^(varchar|char|text|jsonb|inet)/.test(tipoSql)) return { tipo: 'string', escala: null };
  throw new Error(`Tipo sem mapeamento para o PDV (MD 4.1): ${tipoSql}`);
}

/** Definição do fluxo que lê a tabela (no máximo um: `test:sync-triggers` confere). */
function definicaoNoFluxo(nome: string): { fluxo: Fluxo; def: TabelaFluxo } | undefined {
  for (const [fluxo, defs] of Object.entries(REGISTRO_FLUXOS) as [Fluxo, readonly TabelaFluxo[]][]) {
    const def = defs.find((d) => getTableConfig(d.tabela).name === nome);
    if (def) return { fluxo, def };
  }
  return undefined;
}

/** Chave primária: a constraint nomeada (`pk_<tabela>`, MD 1.8) ou, sem ela, a coluna marcada `primaryKey()`. */
function chavePrimaria(tabela: PgTable): string[] {
  const config = getTableConfig(tabela);
  const pk =
    config.primaryKeys[0]?.columns.map((c) => c.name) ??
    config.columns.filter((c) => c.primary).map((c) => c.name);
  if (!pk.length) throw new Error(`Tabela sem chave primária: ${config.name}`);
  return pk;
}

export function descreverTabela(tabela: PgTable, papel: TabelaPdv['papel']): TabelaPdv {
  const config = getTableConfig(tabela);
  const noFluxo = papel === 'espelho' ? definicaoNoFluxo(config.name) : undefined;
  const def = noFluxo?.def;
  const omitidas = new Set(def?.omitir ?? []);
  for (const nome of [...omitidas, ...Object.keys(def?.projecao ?? {})]) {
    if (!config.columns.some((c) => c.name === nome))
      throw new Error(`Fluxo cita coluna inexistente: ${config.name}.${nome}`);
  }
  const chave = chavePrimaria(tabela);
  if (chave.some((c) => omitidas.has(c))) throw new Error(`Fluxo omite a chave primária: ${config.name}`);
  return {
    nome: config.name,
    papel,
    chave,
    fluxo: noFluxo?.fluxo ?? null,
    colunas: [
      ...config.columns.map((c) => {
        const tipoSql = c.getSQLType();
        const { tipo, escala } = tipoClr(tipoSql);
        // Mesma ordem de decisão do pull: omitir > projeção > `bytea` (PgCustomColumn) sempre nulo > valor da coluna.
        const descida: DescidaColuna = !def
          ? 'desce'
          : omitidas.has(c.name)
            ? 'omitida'
            : def.projecao?.[c.name] || c.columnType === 'PgCustomColumn'
              ? 'projetada'
              : 'desce';
        return {
          nome: c.name,
          tipoNuvem: tipoSql,
          tipoClr: tipo,
          nulo: !c.notNull,
          escala,
          descida,
          gerada: c.generated !== undefined,
        };
      }),
      // Campos calculados do pull (MD 6.2; F2-B45): descem depois das colunas, sempre anuláveis e projetados.
      ...Object.entries(def?.calculadas ?? {}).map(([nome, campo]): ColunaPdv => {
        if (config.columns.some((c) => c.name === nome))
          throw new Error(`Campo calculado com o nome de uma coluna: ${config.name}.${nome}`);
        const { tipo, escala } = tipoClr(campo.tipo);
        return {
          nome,
          tipoNuvem: campo.tipo,
          tipoClr: tipo,
          nulo: true,
          escala,
          descida: 'projetada',
          gerada: false,
        };
      }),
    ],
    checks: config.checks
      .map((k) => ({ nome: k.name, expressao: dialeto.sqlToQuery(k.value).sql }))
      .sort((a, b) => a.nome.localeCompare(b.nome)),
  };
}

/** Tabelas do PDV encontradas entre as exportações do schema Drizzle da empresa, em ordem alfabética. */
export function tabelasPdv(schema: Record<string, unknown>): TabelaPdv[] {
  const porNome = new Map<string, PgTable>();
  for (const valor of Object.values(schema)) {
    if (is(valor, PgTable)) porNome.set(getTableConfig(valor).name, valor);
  }

  const faltando = TABELAS_FN_VERSAO.filter((t) => !porNome.has(t));
  if (faltando.length > 0)
    throw new Error(`Tabelas de fluxo ausentes no schema Drizzle: ${faltando.join(', ')}`);

  const espelhos = TABELAS_FN_VERSAO.map((t) => descreverTabela(porNome.get(t)!, 'espelho'));
  const movimento = TABELAS_MOVIMENTO_PDV.filter((t) => porNome.has(t)).map((t) =>
    descreverTabela(porNome.get(t)!, 'movimento'),
  );
  return [...espelhos, ...movimento].sort((a, b) => a.nome.localeCompare(b.nome));
}

/** JSON.stringify gera literais válidos em C# (`\"`, `\\`, `\n`, `\uXXXX`). */
const literal = (texto: string) => JSON.stringify(texto);

export function gerarCsharp(tabelas: TabelaPdv[]): string {
  const linhas: string[] = [
    '// <auto-generated>',
    '// Gerado por `pnpm --filter api gerar:esquema-pdv` a partir do schema Drizzle (apps/api/src/database/empresa/schema).',
    '// Não edite à mão: rode o gerador. O CI falha se este arquivo estiver diferente do gerado (MD 4.1).',
    '// </auto-generated>',
    '#nullable enable',
    '',
    'namespace GenesisPDV.Data.Convencoes;',
    '',
    'public static partial class EsquemaNuvem',
    '{',
    '    public static IReadOnlyList<TabelaEsquema> Tabelas { get; } =',
    '    [',
  ];
  for (const t of tabelas) {
    linhas.push(
      `        new(${literal(t.nome)}, PapelTabela.${t.papel === 'espelho' ? 'Espelho' : 'Movimento'}, ${t.fluxo === null ? 'null' : literal(t.fluxo)}, [${t.chave.map(literal).join(', ')}],`,
    );
    linhas.push('        [');
    for (const c of t.colunas) {
      const escala = c.escala === null ? 'null' : String(c.escala);
      const descida =
        c.descida === 'desce'
          ? ''
          : `, Descida: DescidaColuna.${c.descida === 'omitida' ? 'Omitida' : 'Projetada'}`;
      const gerada = c.gerada ? ', Gerada: true' : '';
      linhas.push(
        `            new(${literal(c.nome)}, ${literal(c.tipoNuvem)}, typeof(${c.tipoClr}), Nulo: ${c.nulo}, Escala: ${escala}${descida}${gerada}),`,
      );
    }
    linhas.push('        ],');
    linhas.push('        [');
    for (const k of t.checks) linhas.push(`            new(${literal(k.nome)}, ${literal(k.expressao)}),`);
    linhas.push('        ]),');
  }
  linhas.push('    ];', '}', '');
  return linhas.join('\n');
}
