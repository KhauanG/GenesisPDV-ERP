import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSOES } from '@genesis/shared';
import type pg from 'pg';
import { TIPOS_MOVIMENTO_ESTOQUE } from '../seed/dados/tabelas-md.js';
import { BANCOS_DESTAQUE, CFOPS_BASE, MEIOS_PAGAMENTO_FISCAIS, PAISES } from './dados.js';

/** Os arquivos de dados ficam em `src/database/referencias/` (também lidos a partir de `dist/`). */
const PASTA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'database',
  'referencias',
);

function lerUfs(): Array<{ sigla: string; codigo_ibge: number; nome: string }> {
  return JSON.parse(readFileSync(join(PASTA, 'ufs.json'), 'utf8')) as Array<{
    sigla: string;
    codigo_ibge: number;
    nome: string;
  }>;
}

function lerMunicipios(): Array<{ codigo: number; nome: string; uf: string }> {
  return readFileSync(join(PASTA, 'municipios.csv'), 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [codigo, nome, uf] = l.split(';');
      return { codigo: Number(codigo), nome: nome!, uf: uf! };
    });
}

/**
 * Data da Nomenclatura que o `ncms.csv` versionado traz ("vigente em", decisão 41). **Atualize junto com o arquivo**:
 * é o que decide, na carga das referências, se a tabela que a plataforma aplicou numa empresa (F2-B46, decisão 193)
 * é mais nova que o arquivo e fica como está.
 */
export const NCMS_CSV_VIGENTE_EM = '2026-10-30';

export interface LinhaNcm {
  /** 8 dígitos, sem pontos. */
  codigo: string;
  descricao: string;
  inicio: string | null;
  fim: string | null;
}

/** NCM vigente (Siscomex, `ncms.csv`: codigo;descricao;vigencia_inicio;vigencia_fim). */
export function lerNcms(): LinhaNcm[] {
  return readFileSync(join(PASTA, 'ncms.csv'), 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [codigo, descricao, inicio, fim] = l.split(';');
      return { codigo: codigo!, descricao: descricao!, inicio: inicio || null, fim: fim || null };
    });
}

/** Cabeçalho do `cests.csv` (F2-B41; README da API › decisão 187), conferido na leitura. */
export const CABECALHO_CESTS = 'codigo;descricao;segmento;ncms;vigencia_inicio;vigencia_fim';

export interface LinhaCest {
  codigo: string;
  descricao: string;
  segmento: string | null;
  /** NCMs do CEST como o convênio lista (capítulo, posição, subposição ou item: 2 a 8 dígitos), só os dígitos. */
  ncms: string[];
  inicio: string | null;
  fim: string | null;
}

/**
 * Campos de uma linha separada por `;` com aspas duplas opcionais (`"a;b"`, e `""` dentro delas é uma aspa): a
 * descrição do convênio tem ponto e vírgula.
 */
export function camposCsv(linha: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!;
    if (aspas) {
      if (c === '"' && linha[i + 1] === '"') {
        atual += '"';
        i++;
      } else if (c === '"') aspas = false;
      else atual += c;
    } else if (c === '"' && atual === '') aspas = true;
    else if (c === ';') {
      campos.push(atual);
      atual = '';
    } else atual += c;
  }
  if (aspas) throw new Error('aspas sem fechar');
  campos.push(atual);
  return campos;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CEST (Convênio ICMS 142/2018 e alterações; F2-B41, decisão 187): `cests.csv` com o cabeçalho `CABECALHO_CESTS`, a
 * lista de NCMs separada por vírgula (os pontos do convênio podem vir: são tirados). É tabela de referência pública,
 * não emissão fiscal: o relatório "NCMs inválidos" confere o CEST do produto com ela. O arquivo ausente, ou só com o
 * cabeçalho, é "sem carga" (lista vazia). Linha fora do formato derruba a carga com o número da linha (o arquivo é
 * versionado: o erro aparece no teste, não na produção).
 */
export function lerCests(caminho = join(PASTA, 'cests.csv')): LinhaCest[] {
  if (!existsSync(caminho)) return [];
  const linhas = readFileSync(caminho, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  if (linhas[0]?.trim() !== CABECALHO_CESTS)
    throw new Error(`cests.csv: o cabeçalho tem de ser "${CABECALHO_CESTS}"`);
  const vistos = new Set<string>();
  const resultado: LinhaCest[] = [];
  linhas.slice(1).forEach((l, i) => {
    if (!l.trim()) return;
    const n = i + 2;
    let campos: string[];
    try {
      campos = camposCsv(l);
    } catch (e) {
      throw new Error(`cests.csv, linha ${n}: ${(e as Error).message}`, { cause: e });
    }
    if (campos.length !== 6) throw new Error(`cests.csv, linha ${n}: 6 colunas (veio ${campos.length})`);
    const [codigo, descricao, segmento, ncms, inicio, fim] = campos.map((c) => c.trim()) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^\d{7}$/.test(codigo)) throw new Error(`cests.csv, linha ${n}: CEST com 7 dígitos`);
    if (vistos.has(codigo)) throw new Error(`cests.csv, linha ${n}: CEST ${codigo} repetido`);
    vistos.add(codigo);
    if (!descricao) throw new Error(`cests.csv, linha ${n}: descrição vazia`);
    const lista = ncms
      .split(',')
      .map((x) => x.replace(/\./g, '').trim())
      .filter(Boolean);
    if (!lista.length || lista.some((x) => !/^\d{2,8}$/.test(x)))
      throw new Error(`cests.csv, linha ${n}: NCMs com 2 a 8 dígitos, separados por vírgula`);
    for (const d of [inicio, fim])
      if (d && !DATA_ISO.test(d)) throw new Error(`cests.csv, linha ${n}: data no formato AAAA-MM-DD`);
    resultado.push({
      codigo,
      descricao,
      segmento: segmento || null,
      ncms: [...new Set(lista)],
      inicio: inicio || null,
      fim: fim || null,
    });
  });
  return resultado;
}

/**
 * Upsert de `cests` (como o dos NCMs): só as linhas novas ou diferentes, e o CEST que saiu do arquivo excluído
 * logicamente. **Sem linhas, não mexe na tabela**: o arquivo vazio é "ainda sem a lista oficial", não "o convênio
 * revogou todos os CEST". Devolve as linhas alteradas.
 */
export async function carregarCests(cliente: pg.ClientBase, linhas: readonly LinhaCest[]): Promise<number> {
  if (!linhas.length) return 0;
  let alteradas = await upsert(
    cliente,
    'cests',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'descricao', tipo: 'text' },
      { nome: 'segmento', tipo: 'varchar' },
      { nome: 'ncms', tipo: 'text', expressao: "string_to_array(u.ncms, ',')" },
      { nome: 'vigencia_inicio', tipo: 'date' },
      { nome: 'vigencia_fim', tipo: 'date' },
    ],
    linhas.map((c) => [c.codigo, c.descricao, c.segmento, c.ncms.join(','), c.inicio, c.fim]),
  );
  const removidos = await cliente.query(
    'update cests set excluido_em = now() where excluido_em is null and not (codigo = any($1::varchar[]))',
    [linhas.map((c) => c.codigo)],
  );
  alteradas += removidos.rowCount ?? 0;
  return alteradas;
}

/** Linhas de `parametros_fiscais_uf` (snake_case, como no banco) das UFs pesquisadas (`uf/<UF>/`). */
export function lerParametrosFiscaisUf(): Array<Record<string, unknown>> {
  const pasta = join(PASTA, 'uf');
  return readdirSync(pasta)
    .sort()
    .flatMap(
      (uf) =>
        JSON.parse(readFileSync(join(pasta, uf, 'parametros-fiscais.json'), 'utf8')) as Array<
          Record<string, unknown>
        >,
    );
}

/** Tipo SQL de cada coluna de `parametros_fiscais_uf` (fora `uf` e `vigencia_inicio`, a chave). */
const COLUNAS_PARAMETROS_FISCAIS: Record<string, string> = {
  vigencia_fim: 'date',
  tipos_emissao_permitidos: 'text[]',
  regimes_dispensados_nfce: 'text[]',
  autorizador: 'varchar',
  versao_leiaute: 'varchar',
  webservices: 'jsonb',
  url_qrcode_producao: 'text',
  url_qrcode_homologacao: 'text',
  url_consulta_producao: 'text',
  url_consulta_homologacao: 'text',
  qrcode_versoes_aceitas: 'smallint[]',
  qrcode_versao_padrao: 'smallint',
  csc_max_ativos_por_ambiente: 'smallint',
  csc_por_cnpj_base: 'boolean',
  prazo_cancelamento_min: 'smallint',
  prazo_cancelamento_substituicao_h: 'smallint',
  aceita_cancelamento_extemporaneo: 'boolean',
  prazo_transmissao_contingencia_h: 'smallint',
  modalidades_contingencia_nfce: 'smallint[]',
  contingencia_vias_danfe: 'smallint',
  inutilizacao_prazo_dia: 'smallint',
  identificacao_obrigatoria_valor: 'numeric',
  identificacao_obrigatoria_nao_presencial: 'boolean',
  nfce_valor_maximo: 'numeric',
  danfe_modos_permitidos: 'text[]',
  danfe_resumido_exige_concordancia: 'boolean',
  programa_cidadania: 'varchar',
  programa_cidadania_substitui_danfe: 'boolean',
  intervalo_minimo_status_s: 'integer',
  atraso_max_emissao_min: 'smallint',
  fcp_nome: 'varchar',
  exige_st_retido_nfce: 'boolean',
  exige_vinculacao_pagamento: 'boolean',
  exige_cbenef: 'boolean',
  exige_cest_bem_listado: 'boolean',
  exige_resp_tec: 'boolean',
  exige_csrt_nfce: 'boolean',
  fundamento: 'text',
  pendencias: 'text',
  conferido_em: 'date',
};

/**
 * Upsert de `parametros_fiscais_uf` por (uf, vigencia_inicio), uma linha por vez: os arrays e o jsonb não passam bem
 * por `unnest`. Linha idêntica não é regravada (não ganha `versao` nova nem desce de novo ao PDV).
 */
async function upsertParametrosFiscais(
  cliente: pg.ClientBase,
): Promise<{ linhas: number; alteradas: number }> {
  const linhas = lerParametrosFiscaisUf();
  const nomes = Object.keys(COLUNAS_PARAMETROS_FISCAIS);
  let alteradas = 0;
  for (const l of linhas) {
    const desconhecidas = Object.keys(l).filter(
      (k) => k !== 'uf' && k !== 'vigencia_inicio' && !(k in COLUNAS_PARAMETROS_FISCAIS),
    );
    if (desconhecidas.length)
      throw new Error(`parametros-fiscais.json: colunas desconhecidas ${desconhecidas}`);
    const valores = nomes.map((n) => {
      const v = l[n] ?? null;
      return COLUNAS_PARAMETROS_FISCAIS[n] === 'jsonb' && v !== null ? JSON.stringify(v) : v;
    });
    const params = nomes.map((n, i) => `$${i + 3}::${COLUNAS_PARAMETROS_FISCAIS[n]}`);
    const r = await cliente.query(
      `insert into parametros_fiscais_uf (uf, vigencia_inicio, ${nomes.join(', ')})
       select $1::char(2), $2::date, ${params.join(', ')}
       where not exists (
         select 1 from parametros_fiscais_uf t where t.uf = $1 and t.vigencia_inicio = $2::date and t.excluido_em is null
           and (${nomes.map((n) => `t.${n}`).join(', ')}) is not distinct from (${params.join(', ')}))
       on conflict (uf, vigencia_inicio) do update set
         ${nomes.map((n) => `${n} = excluded.${n}`).join(', ')}, excluido_em = null`,
      [l.uf, l.vigencia_inicio, ...valores],
    );
    alteradas += r.rowCount ?? 0;
  }
  return { linhas: linhas.length, alteradas };
}

interface Coluna {
  nome: string;
  tipo: string;
  /**
   * Expressão sobre `u.<nome>` quando o valor chega num formato e é gravado em outro: o `unnest` de um array de
   * arrays achata tudo, então a lista de NCMs do CEST chega em texto (`a,b,c`) e vira `text[]` aqui.
   */
  expressao?: string;
}

/**
 * Upsert de tabela de referência (chave natural). Só envia as linhas novas ou diferentes: o trigger `fn_versao`
 * roda em todo INSERT (inclusive o que cai no ON CONFLICT), e linha idêntica não pode ganhar `versao` nova nem
 * disputar a trava de ordenação à toa.
 */
async function upsert(
  cliente: pg.ClientBase,
  tabela: string,
  chave: Coluna,
  colunas: Coluna[],
  linhas: unknown[][],
): Promise<number> {
  const todas = [chave, ...colunas];
  const params = todas.map((_, i) => linhas.map((l) => l[i]));
  const unnest = todas.map((c, i) => `$${i + 1}::${c.tipo}[]`).join(', ');
  const nomes = todas.map((c) => c.nome).join(', ');
  const valor = (c: Coluna) => c.expressao ?? `u.${c.nome}`;
  const comparacao = `(${colunas.map((c) => `t.${c.nome}`).join(', ')}, t.excluido_em) is not distinct from (${colunas
    .map(valor)
    .join(', ')}, null)`;
  const r = await cliente.query(
    `insert into ${tabela} (${nomes})
     select ${todas.map(valor).join(', ')} from unnest(${unnest}) as u(${nomes})
     where not exists (select 1 from ${tabela} t where t.${chave.nome} = u.${chave.nome} and ${comparacao})
     on conflict (${chave.nome}) do update set ${colunas.map((c) => `${c.nome} = excluded.${c.nome}`).join(', ')}, excluido_em = null`,
    params,
  );
  return r.rowCount ?? 0;
}

/**
 * Upsert de `ncms` (chave `codigo`): só as linhas novas ou diferentes (a excluída que volta ao arquivo é reativada).
 * O NCM que **não está nas linhas**: `'excluir'` = exclusão lógica (a carga do `ncms.csv`, decisão 41); `{ encerrarEm }`
 * = fim de vigência nessa data, sem excluir, quando ainda não termina antes (a atualização da plataforma, F2-B46: o
 * produto que o usa passa a "fora de vigência" no relatório NCMs inválidos). Devolve as linhas alteradas.
 */
export async function carregarNcms(
  cliente: pg.ClientBase,
  linhas: readonly LinhaNcm[],
  ausentes: 'excluir' | { encerrarEm: string },
): Promise<number> {
  let alteradas = await upsert(
    cliente,
    'ncms',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'descricao', tipo: 'text' },
      { nome: 'vigencia_inicio', tipo: 'date' },
      { nome: 'vigencia_fim', tipo: 'date' },
    ],
    linhas.map((n) => [n.codigo, n.descricao, n.inicio, n.fim]),
  );
  const codigos = linhas.map((n) => n.codigo);
  const removidos =
    ausentes === 'excluir'
      ? await cliente.query(
          'update ncms set excluido_em = now() where excluido_em is null and not (codigo = any($1::varchar[]))',
          [codigos],
        )
      : await cliente.query(
          `update ncms set vigencia_fim = $2::date
            where excluido_em is null and not (codigo = any($1::varchar[]))
              and (vigencia_fim is null or vigencia_fim > $2::date)`,
          [codigos, ausentes.encerrarEm],
        );
  alteradas += removidos.rowCount ?? 0;
  return alteradas;
}

export interface OpcoesReferencias {
  /**
   * `false` = não mexe em `ncms`: a empresa já recebeu da plataforma uma tabela mais nova que o `ncms.csv`
   * (`NCMS_CSV_VIGENTE_EM`; F2-B46, decisão 193), e recarregar o arquivo desfaria as inclusões e os encerramentos.
   */
  ncms?: boolean;
}

export interface ResumoReferencias {
  ufs: number;
  municipios: number;
  cfops: number;
  meiosPagamento: number;
  bancos: number;
  tiposMovimento: number;
  permissoes: number;
  paises: number;
  /** Linhas do `ncms.csv` aplicadas (0 com `ncms: false`). */
  ncms: number;
  /** Linhas do `cests.csv` (0 = sem a lista oficial ainda: a tabela fica como está). */
  cests: number;
  parametrosFiscaisUf: number;
  alteradas: number;
}

/** Carga idempotente das referências nacionais e do catálogo de permissões (MD 3.4, 7.2, 3.3.3). */
export async function carregarReferencias(
  cliente: pg.ClientBase,
  opcoes: OpcoesReferencias = {},
): Promise<ResumoReferencias> {
  const ufs = lerUfs();
  const municipios = lerMunicipios();
  let alteradas = 0;
  alteradas += await upsert(
    cliente,
    'ufs',
    { nome: 'sigla', tipo: 'char(2)' },
    [
      { nome: 'codigo_ibge', tipo: 'smallint' },
      { nome: 'nome', tipo: 'varchar' },
    ],
    ufs.map((u) => [u.sigla, u.codigo_ibge, u.nome]),
  );
  alteradas += await upsert(
    cliente,
    'municipios',
    { nome: 'codigo_ibge', tipo: 'integer' },
    [
      { nome: 'nome', tipo: 'varchar' },
      { nome: 'uf', tipo: 'char(2)' },
    ],
    municipios.map((m) => [m.codigo, m.nome, m.uf]),
  );
  alteradas += await upsert(
    cliente,
    'cfops',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'descricao', tipo: 'text' },
      { nome: 'tipo', tipo: 'varchar' },
      { nome: 'abrangencia', tipo: 'varchar' },
    ],
    CFOPS_BASE.map((c) => [c.codigo, c.descricao, c.tipo, c.abrangencia]),
  );
  alteradas += await upsert(
    cliente,
    'meios_pagamento_fiscais',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'descricao', tipo: 'varchar' },
      { nome: 'exige_descricao', tipo: 'boolean' },
      { nome: 'ativo', tipo: 'boolean' },
    ],
    MEIOS_PAGAMENTO_FISCAIS.map((m) => [m.codigo, m.descricao, m.exigeDescricao, m.ativo]),
  );
  alteradas += await upsert(
    cliente,
    'bancos',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'ispb', tipo: 'varchar' },
      { nome: 'nome', tipo: 'varchar' },
      { nome: 'nome_curto', tipo: 'varchar' },
      { nome: 'destaque', tipo: 'smallint' },
    ],
    BANCOS_DESTAQUE.map((b) => [b.codigo, b.ispb, b.nome, b.nomeCurto, b.destaque]),
  );
  alteradas += await upsert(
    cliente,
    'tipos_movimento_estoque',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'nome', tipo: 'varchar' },
      { nome: 'sinal', tipo: 'smallint' },
      { nome: 'documento_tipo', tipo: 'varchar' },
      { nome: 'nome_nuvem3', tipo: 'varchar' },
      { nome: 'id_nuvem3', tipo: 'smallint' },
    ],
    TIPOS_MOVIMENTO_ESTOQUE.map((t) => [
      t.codigo,
      t.nome,
      t.sinal,
      t.documentoTipo,
      t.nomeNuvem3,
      t.idNuvem3,
    ]),
  );
  alteradas += await upsert(
    cliente,
    'permissoes',
    { nome: 'chave', tipo: 'varchar' },
    [
      { nome: 'modulo', tipo: 'varchar' },
      { nome: 'grupo', tipo: 'varchar' },
      { nome: 'descricao', tipo: 'varchar' },
      { nome: 'ordem', tipo: 'integer' },
      { nome: 'permite_liberacao', tipo: 'boolean' },
    ],
    PERMISSOES.map((p) => [p.chave, p.modulo, p.grupo, p.descricao, p.ordem, p.permiteLiberacao]),
  );
  alteradas += await upsert(
    cliente,
    'paises',
    { nome: 'codigo_bacen', tipo: 'varchar' },
    [{ nome: 'nome', tipo: 'varchar' }],
    PAISES.map((p) => [p.codigoBacen, p.nome]),
  );
  // NCM que saiu da tabela oficial é excluído logicamente (o produto que o usa deixa de ser vendável na loja NFC-e).
  const ncms = opcoes.ncms === false ? [] : lerNcms();
  if (ncms.length) alteradas += await carregarNcms(cliente, ncms, 'excluir');
  const cests = lerCests();
  alteradas += await carregarCests(cliente, cests);
  const parametros = await upsertParametrosFiscais(cliente);
  alteradas += parametros.alteradas;

  // Chave que saiu do catálogo é excluída logicamente (desce ao PDV com excluido_em).
  const removidas = await cliente.query(
    'update permissoes set excluido_em = now() where excluido_em is null and not (chave = any($1::varchar[]))',
    [PERMISSOES.map((p) => p.chave)],
  );
  alteradas += removidas.rowCount ?? 0;

  return {
    ufs: ufs.length,
    municipios: municipios.length,
    cfops: CFOPS_BASE.length,
    meiosPagamento: MEIOS_PAGAMENTO_FISCAIS.length,
    bancos: BANCOS_DESTAQUE.length,
    tiposMovimento: TIPOS_MOVIMENTO_ESTOQUE.length,
    permissoes: PERMISSOES.length,
    paises: PAISES.length,
    ncms: ncms.length,
    cests: cests.length,
    parametrosFiscaisUf: parametros.linhas,
    alteradas,
  };
}
