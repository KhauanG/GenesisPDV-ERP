/**
 * Imagens dos cadastros para o caixa (Fase 2, F2-B45; SYNC 6.12; MD 6.2; README da API › decisão 192).
 *
 * - **Campos calculados do pull** (`camposImagemPdv`): `foto_url`/`foto_sha256` nos produtos, `imagem_url`/
 *   `imagem_sha256` nas categorias e `logotipo_url`/`logotipo_sha256` nas marcas. A URL é o caminho **estável**
 *   `/sync/arquivos/{arquivo_id}?variante=pdv_256` (nunca uma URL assinada, que expiraria e mudaria a linha) e o sha256 é
 *   o da variante (`arquivos.variantes`). A variante é gerada no envio e o arquivo não muda depois: trocar a imagem é
 *   trocar o id na linha do cadastro, que ganha versão nova e desce. Sem a variante (ou com o arquivo excluído), os dois
 *   descem nulos.
 * - **`GET /sync/arquivos/{id}?variante=pdv_256`** (`ArquivosSync.variante`): o token do terminal, só a variante do
 *   caixa e só o arquivo ligado a um cadastro vivo que desce ao terminal (a mesma regra dos campos calculados). A
 *   empresa é a do banco do terminal: o arquivo de outra empresa, de outra categoria (XML, planilha, anexo, logotipo e
 *   foto da loja) ou solto (envio que nenhum cadastro usa) não existe aqui e dá `404`. O conteúdo sai pela API, não pelo
 *   `302` da SYNC 6.12: a variante tem 10–20 KB e assim o `Content-Type` é o fixo do caixa (`image/webp`), com `nosniff`
 *   e o `ETag` com o sha256 (o `If-None-Match` igual responde `304`).
 */
import { DESTINOS_ARQUIVO, type DestinoArquivo } from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { garantirLimitePorMinuto, limiteDoAmbiente } from '../comum/limites-processo.js';
import { ErroApi } from '../comum/erros.js';
import type { ArmazenamentoObjetos } from '../infra/armazenamento.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { ErroSync } from './erros.js';
import type { TerminalAutenticado } from './terminal.js';

/** A única variante que o caixa baixa (SYNC 6.12). */
export const VARIANTE_PDV = 'pdv_256';
/** `Content-Type` fixo da variante do caixa: o `processarImagem` sempre a grava em WebP. */
export const TIPO_VARIANTE_PDV = 'image/webp';
/**
 * Teto do que o endpoint entrega: a `pdv_256` tem 10–20 KB; acima disso é variante gravada errada. O PDV tem o mesmo
 * limite no download (`CacheImagens`).
 */
export const LIMITE_BYTES_VARIANTE_PDV = 512 * 1024;
/** Downloads por minuto de um terminal (`SYNC_ARQUIVOS_POR_MINUTO`): o caixa baixa sob demanda, 2 por vez. */
export const ARQUIVOS_POR_MINUTO_PADRAO = 120;

/** Caminho estável que desce no `*_url` e que o PDV reconstrói pelo id (nunca segue uma URL qualquer). */
export const caminhoArquivoPdv = (id: string) => `/sync/arquivos/${id}?variante=${VARIANTE_PDV}`;

/** Cadastros cujas imagens descem ao caixa: a tabela, a coluna com o id do arquivo, o destino do envio e o prefixo do campo. */
export const IMAGENS_PDV = [
  { tabela: 'produtos', coluna: 'foto_principal_arquivo_id', destino: 'produto_foto', campo: 'foto' },
  { tabela: 'categorias', coluna: 'imagem_arquivo_id', destino: 'categoria_imagem', campo: 'imagem' },
  { tabela: 'marcas', coluna: 'logotipo_arquivo_id', destino: 'marca_logotipo', campo: 'logotipo' },
] as const satisfies readonly { tabela: string; coluna: string; destino: DestinoArquivo; campo: string }[];

type ImagemPdv = (typeof IMAGENS_PDV)[number];

/** Campo que desce no pull sem existir na tabela (MD 6.2): o tipo (para o `Esquema.g.cs`) e a expressão sobre `t`. */
export interface CampoCalculado {
  tipo: string;
  expressao: () => SQL;
}

/** O arquivo (alias `a`) é um envio vivo do destino, com a variante do caixa. */
const arquivoDoDestino = (destino: DestinoArquivo) => {
  const d = DESTINOS_ARQUIVO[destino];
  return sql`a.excluido_em is null and a.categoria = ${d.categoria} and a.entidade = ${d.entidade}
    and a.variantes -> ${VARIANTE_PDV} ->> 'sha256' is not null`;
};

/** `<campo>_url` e `<campo>_sha256` de um cadastro (subconsulta pelo índice da PK de `arquivos`). */
export function camposImagemPdv(tabela: ImagemPdv['tabela']): Record<string, CampoCalculado> {
  const img = IMAGENS_PDV.find((i) => i.tabela === tabela)!;
  const doArquivo = (valor: SQL) => () =>
    sql`(select ${valor} from arquivos a where a.id = ${sql.raw(`t.${img.coluna}`)} and ${arquivoDoDestino(img.destino)})`;
  return {
    [`${img.campo}_url`]: {
      tipo: 'text',
      expressao: doArquivo(sql`'/sync/arquivos/' || a.id::text || ${`?variante=${VARIANTE_PDV}`}::text`),
    },
    [`${img.campo}_sha256`]: {
      tipo: 'varchar(64)',
      expressao: doArquivo(sql`a.variantes -> ${VARIANTE_PDV} ->> 'sha256'`),
    },
  };
}

/** O cadastro vivo (alias do cadastro `c`) que usa o arquivo `a`: o que o torna visível ao terminal. */
const usadoPorCadastroVivo = sql.join(
  IMAGENS_PDV.map(
    (i) =>
      sql`(${arquivoDoDestino(i.destino)} and exists (select 1 from ${sql.identifier(i.tabela)} c
        where c.${sql.identifier(i.coluna)} = a.id and c.excluido_em is null))`,
  ),
  sql` or `,
);

export interface VarianteArquivoPdv {
  conteudo: Buffer;
  sha256: string;
}

interface LinhaVariante extends Record<string, unknown> {
  chave: string;
  sha256: string;
  tipo_mime: string;
  tamanho: number;
}

export class ArquivosSync {
  constructor(private readonly d: { tenancy: Tenancy; armazenamento: ArmazenamentoObjetos }) {}

  /**
   * A variante `pdv_256` do arquivo, ou `null` quando o `If-None-Match` já é o sha256 dela (`304`, sem ler o objeto).
   * Fora do escopo, sem a variante ou com a variante fora do tipo e do tamanho do caixa: `404`.
   */
  async variante(
    terminal: TerminalAutenticado,
    id: string,
    seNaoCorresponder: string | undefined,
  ): Promise<VarianteArquivoPdv | { naoModificado: true; sha256: string }> {
    // SYNC 3.8: em desativação o terminal recebe só o acesso e a configuração; as imagens são do catálogo.
    if (terminal.status === 'desativando') {
      throw ErroSync.escopo('Terminal em desativação não baixa as imagens do catálogo.');
    }
    limitarPorTerminal(terminal);
    const [v] = await this.d.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<LinhaVariante>(sql`
        select a.variantes -> ${VARIANTE_PDV} ->> 'chave' as chave,
               a.variantes -> ${VARIANTE_PDV} ->> 'sha256' as sha256,
               a.variantes -> ${VARIANTE_PDV} ->> 'tipoMime' as tipo_mime,
               (a.variantes -> ${VARIANTE_PDV} ->> 'tamanhoBytes')::int as tamanho
          from arquivos a
         where a.id = ${id} and (${usadoPorCadastroVivo})`);
      return rows;
    });
    if (
      !v?.chave ||
      !/^[0-9a-f]{64}$/.test(v.sha256) ||
      v.tipo_mime !== TIPO_VARIANTE_PDV ||
      !(v.tamanho > 0 && v.tamanho <= LIMITE_BYTES_VARIANTE_PDV)
    ) {
      throw new ErroSync('NAO_ENCONTRADO', 'Imagem não encontrada.');
    }
    const etags = seNaoCorresponder ? etagsDoCabecalho(seNaoCorresponder) : [];
    if (etags.includes(v.sha256) || etags.includes('*')) {
      return { naoModificado: true, sha256: v.sha256 };
    }
    const conteudo = await this.d.armazenamento.ler(v.chave);
    if (conteudo.length > LIMITE_BYTES_VARIANTE_PDV)
      throw new ErroSync('NAO_ENCONTRADO', 'Imagem não encontrada.');
    return { conteudo, sha256: v.sha256 };
  }
}

/** Os valores de um `If-None-Match` (`"a", W/"b"` ou `*`), sem aspas nem o `W/`. */
export function etagsDoCabecalho(valor: string): string[] {
  return valor
    .split(',')
    .map((e) =>
      e
        .trim()
        .replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1'),
    )
    .filter(Boolean);
}

/** Limite por terminal na memória da instância, como o da consulta de saldos (`429` com `Retry-After`). */
function limitarPorTerminal(terminal: TerminalAutenticado): void {
  try {
    garantirLimitePorMinuto(
      `sync-arquivos:${terminal.terminalId}`,
      limiteDoAmbiente('SYNC_ARQUIVOS_POR_MINUTO', ARQUIVOS_POR_MINUTO_PADRAO),
    );
  } catch (e) {
    if (e instanceof ErroApi && e.codigo === 'LIMITE_TAXA') {
      throw new ErroSync(
        'LIMITE_TAXA',
        'Muitos downloads de imagem seguidos deste caixa. Aguarde um minuto.',
        {},
        { 'Retry-After': '60' },
      );
    }
    throw e;
  }
}
