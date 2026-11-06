import { readdirSync, readFileSync } from 'node:fs';
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

/** NCM vigente (Siscomex, `ncms.csv`: codigo;descricao;vigencia_inicio;vigencia_fim). */
function lerNcms(): Array<{ codigo: string; descricao: string; inicio: string | null; fim: string | null }> {
  return readFileSync(join(PASTA, 'ncms.csv'), 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [codigo, descricao, inicio, fim] = l.split(';');
      return { codigo: codigo!, descricao: descricao!, inicio: inicio || null, fim: fim || null };
    });
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
  const comparacao = `(${colunas.map((c) => `t.${c.nome}`).join(', ')}, t.excluido_em) is not distinct from (${colunas
    .map((c) => `u.${c.nome}`)
    .join(', ')}, null)`;
  const r = await cliente.query(
    `insert into ${tabela} (${nomes})
     select ${todas.map((c) => `u.${c.nome}`).join(', ')} from unnest(${unnest}) as u(${nomes})
     where not exists (select 1 from ${tabela} t where t.${chave.nome} = u.${chave.nome} and ${comparacao})
     on conflict (${chave.nome}) do update set ${colunas.map((c) => `${c.nome} = excluded.${c.nome}`).join(', ')}, excluido_em = null`,
    params,
  );
  return r.rowCount ?? 0;
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
  ncms: number;
  parametrosFiscaisUf: number;
  alteradas: number;
}

/** Carga idempotente das referências nacionais e do catálogo de permissões (MD 3.4, 7.2, 3.3.3). */
export async function carregarReferencias(cliente: pg.ClientBase): Promise<ResumoReferencias> {
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
  const ncms = lerNcms();
  alteradas += await upsert(
    cliente,
    'ncms',
    { nome: 'codigo', tipo: 'varchar' },
    [
      { nome: 'descricao', tipo: 'text' },
      { nome: 'vigencia_inicio', tipo: 'date' },
      { nome: 'vigencia_fim', tipo: 'date' },
    ],
    ncms.map((n) => [n.codigo, n.descricao, n.inicio, n.fim]),
  );
  // NCM que saiu da tabela oficial é excluído logicamente (o produto que o usa deixa de ser vendável na loja NFC-e).
  const ncmsRemovidos = await cliente.query(
    'update ncms set excluido_em = now() where excluido_em is null and not (codigo = any($1::varchar[]))',
    [ncms.map((n) => n.codigo)],
  );
  alteradas += ncmsRemovidos.rowCount ?? 0;
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
    parametrosFiscaisUf: parametros.linhas,
    alteradas,
  };
}
