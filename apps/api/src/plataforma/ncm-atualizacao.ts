/**
 * Atualização da tabela NCM pela plataforma (Fase 2, F2-B46; ERP 18.13; README da API › decisão 193). Referência do
 * cadastro, **sem uso fiscal**: o que muda é o que o cadastro, o relatório NCMs inválidos e o PDV leem de `ncms`.
 *
 * 1. **Baixa e valida antes de tocar em qualquer empresa.** O JSON do Portal Único Siscomex (`SISCOMEX_NCM_URL`, ou
 *    o arquivo baixado no navegador) é entrada externa: tamanho limitado (no download e na leitura), UTF-8 estrito,
 *    o formato conferido campo a campo (código, descrição, datas, código repetido) e um mínimo de NCMs. Qualquer
 *    diferença aborta a execução inteira **sem aplicar nada** (o formato mudou: alguém precisa olhar). O mesmo vale
 *    para um arquivo que encerraria mais de `LIMITE_ENCERRADOS_FRACAO` dos NCMs do `ncms.csv` versionado (download
 *    pela metade ou formato trocado), salvo `permitirEncerramentoEmMassa` (a revisão da Nomenclatura do SH).
 * 2. **A descrição como no `ncms.csv`** (decisão 41): a do item de 8 dígitos precedida das subposições e itens acima
 *    dele (sem os travessões, os dois pontos e o HTML), com a posição na frente quando o primeiro nível é genérico
 *    ("Outros", "Com…", "De peso…"). Conferido com o download real de 12/11/2026: os 10.516 NCMs saem iguais ao
 *    arquivo versionado (descrição e vigência), então a primeira execução não muda nada.
 * 3. **Uma transação por empresa**, com a role dona do banco (a das migrações e da carga das referências, MD 1.4) e a
 *    trava 7300001 (`fn_trava_versao`): a diferença (incluídos, alterados, encerrados), o upsert de `ncms`, a carga
 *    do `cests.csv` versionado (F2-B41) e o `ressincronizar_fluxo referencia` para os terminais da empresa quando a
 *    tabela que desce mudou (SYNC 6.13: comando que os PDVs 0.11.0 e 0.12.0 já executam). O NCM que sumiu do
 *    arquivo **não é excluído**: ganha o fim de vigência na véspera da data da tabela (o Siscomex não publica a data
 *    do encerramento na tabela vigente), e o produto que o usa vira "fora de vigência" no relatório. Falha numa
 *    empresa desfaz só ela; as outras seguem.
 * 4. **Relatório e registro** em `auditoria_plataforma`: `ncm_atualizada` por empresa (o que mudou e os produtos que
 *    ficam com NCM inválido), gravado **antes** do commit, e `ncm_atualizacao_executada` com o resumo. O
 *    `ncm_atualizada` é também o que a carga das referências das migrações consulta (`vigenciaNcmAplicada`): com uma
 *    tabela da plataforma mais nova que o `ncms.csv`, o arquivo não é recarregado por cima dela.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { BancoControle } from '../database/controle/conexao.js';
import { auditoriaPlataforma, empresas } from '../database/controle/schema.js';
import { garantirNomeBancoEmpresa } from '../database/nomes-bancos.js';
import {
  carregarCests,
  carregarNcms,
  lerCests,
  lerNcms,
  NCMS_CSV_VIGENTE_EM,
  type LinhaCest,
  type LinhaNcm,
} from '../database/referencias/carregar.js';
import type { ServidoresBanco } from '../database/servidores.js';
import { ressincronizarFluxos } from '../sync/comandos.js';
import { registrarAuditoriaPlataforma } from './auditoria-plataforma.js';

/** Endereço oficial (o padrão de `SISCOMEX_NCM_URL`): sem o `perfil`, o portal responde 307 para a página. */
export const URL_SISCOMEX_NCM_PADRAO =
  'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO';
/** Teto do arquivo (o de 12/11/2026 tem 3,1 MB): acima disso não é a tabela. */
export const LIMITE_BYTES_TABELA_NCM = 32 * 1024 * 1024;
export const TEMPO_LIMITE_DOWNLOAD_NCM_MS = 120_000;
/** Mínimo de NCMs de 8 dígitos (a tabela tem ~10,5 mil): menos que isso é arquivo incompleto. */
export const MINIMO_NCMS_TABELA = 5_000;
/** Fração dos NCMs do `ncms.csv` que um arquivo pode encerrar sem `permitirEncerramentoEmMassa`. */
export const LIMITE_ENCERRADOS_FRACAO = 0.2;
/** Teto de cada lista do relatório (códigos e produtos): o total sempre vai junto. */
export const LIMITE_LISTA_RELATORIO = 200;
/** Descrição acima disso não é da Nomenclatura (a maior tem ~600 caracteres). */
const LIMITE_DESCRICAO = 4_000;
/** Itens da lista (a tabela tem ~15 mil, de todos os níveis): acima disso, a leitura nem monta o mapa. */
const LIMITE_ITENS = 100_000;

/** Ações em `auditoria_plataforma`. */
export const ACAO_NCM_ATUALIZADA = 'ncm_atualizada';
export const ACAO_NCM_EXECUTADA = 'ncm_atualizacao_executada';

/** Trava das migrações da empresa (`MigradorEmpresas`): migração e atualização da NCM nunca correm juntas. */
const TRAVA_EMPRESA = "hashtext('genesis:migracao_empresa')";

/** Arquivo fora do formato esperado ou download que falhou: nada é aplicado. */
export class ErroTabelaNcm extends Error {
  override readonly name = 'ErroTabelaNcm';
}

export interface TabelaNcm {
  /** Data da tabela (`Data_Ultima_Atualizacao_NCM`, "Vigente em DD/MM/AAAA"), AAAA-MM-DD. */
  vigenteEm: string;
  ato: string | null;
  /** sha256 do arquivo como chegou. */
  sha256: string;
  bytes: number;
  /** Os NCMs de 8 dígitos, na ordem do código. */
  ncms: LinhaNcm[];
}

// ---------------------------------------------------------------------------------------------------------------
// Leitura e validação do arquivo
// ---------------------------------------------------------------------------------------------------------------

/** Os níveis da Nomenclatura como o Siscomex escreve: capítulo, posição, subposições e itens. */
const CODIGO_SISCOMEX = /^(\d{2}|\d{2}\.\d{2}|\d{4}\.\d{1,2}|\d{4}\.\d{2}\.\d{1,2})$/;
const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001f\u007f]/g;
/** Primeiro nível que não se explica sozinho: a descrição leva a posição na frente (como no `ncms.csv`). */
const NIVEL_GENERICO = /^(Outr[oa]s?\b|Com |Sem |Em |De peso |De capacidade )/;
const ENTIDADES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': '\u00a0',
  '&amp;': '&',
};

function dataIso(valor: unknown, campo: string, onde: string): string {
  const m = typeof valor === 'string' ? DATA_BR.exec(valor.trim()) : null;
  if (!m) throw new ErroTabelaNcm(`${onde}: ${campo} fora do formato DD/MM/AAAA`);
  const [, d, mes, a] = m as unknown as [string, string, string, string];
  const data = new Date(Date.UTC(Number(a), Number(mes) - 1, Number(d)));
  if (
    data.getUTCFullYear() !== Number(a) ||
    data.getUTCMonth() !== Number(mes) - 1 ||
    data.getUTCDate() !== Number(d)
  )
    throw new ErroTabelaNcm(`${onde}: ${campo} com data inexistente (${visivel(valor)})`);
  return `${a}-${mes}-${d}`;
}

/** O texto de um nível sem HTML, sem controle e sem o `;` (separador do `ncms.csv`), sem os travessões da frente. */
function textoNivel(descricao: string): string {
  return descricao
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (e) => ENTIDADES[e] ?? e)
    .replace(CONTROLE, ' ')
    .replace(/;/g, ',')
    .replace(/^[-\s–]+/, '')
    .trim();
}

const semDoisPontos = (texto: string) => texto.replace(/:$/, '').trim();

/** O que veio do arquivo e vai para a mensagem de erro (o terminal): só o ASCII visível, curto. */
const visivel = (valor: unknown) =>
  String(valor)
    .slice(0, 20)
    .replace(/[^\x20-\x7e]/g, '?');

export function vespera(dataIso: string): string {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Lê o JSON da tabela vigente do Siscomex (`{Data_Ultima_Atualizacao_NCM, Ato, Nomenclaturas: [{Codigo, Descricao,
 * Data_Inicio, Data_Fim, …}]}`). Campo a mais é ignorado; campo a menos, tipo trocado, código ou data fora do
 * formato, código repetido ou NCMs de menos derrubam a leitura com `ErroTabelaNcm` (o formato mudou).
 */
export function interpretarTabelaNcm(conteudo: Uint8Array, opcoes: { minimoNcms?: number } = {}): TabelaNcm {
  if (conteudo.byteLength > LIMITE_BYTES_TABELA_NCM)
    throw new ErroTabelaNcm(`arquivo com mais de ${LIMITE_BYTES_TABELA_NCM / 1024 / 1024} MB`);
  let texto: string;
  try {
    // `fatal`: byte fora do UTF-8 é erro (não vira "�" na descrição); o BOM do começo é descartado.
    texto = new TextDecoder('utf-8', { fatal: true }).decode(conteudo);
  } catch {
    throw new ErroTabelaNcm('o arquivo não está em UTF-8');
  }
  let raiz: unknown;
  try {
    raiz = JSON.parse(texto);
  } catch {
    throw new ErroTabelaNcm('o arquivo não é um JSON (a página de erro do portal, ou o formato mudou)');
  }
  if (typeof raiz !== 'object' || raiz === null || Array.isArray(raiz))
    throw new ErroTabelaNcm('o JSON não tem o objeto da tabela');
  const r = raiz as Record<string, unknown>;
  const cabecalho = typeof r.Data_Ultima_Atualizacao_NCM === 'string' ? r.Data_Ultima_Atualizacao_NCM : '';
  const dataTabela = /(\d{2}\/\d{2}\/\d{4})/.exec(cabecalho)?.[1];
  if (!dataTabela) throw new ErroTabelaNcm('sem a data da tabela (Data_Ultima_Atualizacao_NCM)');
  const vigenteEm = dataIso(dataTabela, 'Data_Ultima_Atualizacao_NCM', 'cabeçalho');
  if (r.Ato !== undefined && r.Ato !== null && typeof r.Ato !== 'string')
    throw new ErroTabelaNcm('o campo Ato não é texto');
  const ato = typeof r.Ato === 'string' ? r.Ato.replace(CONTROLE, ' ').trim().slice(0, 200) : '';
  if (!Array.isArray(r.Nomenclaturas)) throw new ErroTabelaNcm('sem a lista Nomenclaturas');
  if (r.Nomenclaturas.length > LIMITE_ITENS)
    throw new ErroTabelaNcm(`Nomenclaturas com mais de ${LIMITE_ITENS} itens`);

  interface Nivel {
    texto: string;
    inicio: string;
    fim: string | null;
  }
  const niveis = new Map<string, Nivel>();
  r.Nomenclaturas.forEach((item: unknown, i) => {
    const onde = `Nomenclaturas[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new ErroTabelaNcm(`${onde}: não é um objeto`);
    const n = item as Record<string, unknown>;
    if (typeof n.Codigo !== 'string' || !CODIGO_SISCOMEX.test(n.Codigo.trim()))
      throw new ErroTabelaNcm(`${onde}: Codigo fora do formato da Nomenclatura (${visivel(n.Codigo)})`);
    const digitos = n.Codigo.trim().replace(/\./g, '');
    if (niveis.has(digitos)) throw new ErroTabelaNcm(`${onde}: código ${visivel(n.Codigo)} repetido`);
    if (typeof n.Descricao !== 'string') throw new ErroTabelaNcm(`${onde}: Descricao não é texto`);
    if (n.Descricao.length > LIMITE_DESCRICAO)
      throw new ErroTabelaNcm(`${onde}: Descricao com mais de ${LIMITE_DESCRICAO} caracteres`);
    const t = textoNivel(n.Descricao);
    if (!semDoisPontos(t)) throw new ErroTabelaNcm(`${onde}: Descricao vazia`);
    const inicio = dataIso(n.Data_Inicio, 'Data_Inicio', onde);
    const fimIso = dataIso(n.Data_Fim, 'Data_Fim', onde);
    if (fimIso < inicio) throw new ErroTabelaNcm(`${onde}: Data_Fim antes da Data_Inicio`);
    niveis.set(digitos, { texto: t, inicio, fim: fimIso === '9999-12-31' ? null : fimIso });
  });

  const ncms: LinhaNcm[] = [];
  for (const [codigo, nivel] of niveis) {
    if (codigo.length !== 8) continue;
    // Subposições e itens acima do NCM (5 a 7 dígitos) e ele mesmo; o nível igual ao de cima (o item que só repete a
    // subposição, "-- Outros" / "Outros") entra uma vez.
    const partes: string[] = [];
    let anterior: string | null = null;
    for (let k = 5; k <= 8; k++) {
      const acima = niveis.get(codigo.slice(0, k));
      if (!acima || acima.texto === anterior) continue;
      anterior = acima.texto;
      partes.push(semDoisPontos(acima.texto));
    }
    const posicao = niveis.get(codigo.slice(0, 4));
    if (posicao && NIVEL_GENERICO.test(partes[0]!)) partes.unshift(semDoisPontos(posicao.texto));
    ncms.push({ codigo, descricao: partes.join(' - '), inicio: nivel.inicio, fim: nivel.fim });
  }
  const minimo = opcoes.minimoNcms ?? MINIMO_NCMS_TABELA;
  if (ncms.length < minimo)
    throw new ErroTabelaNcm(`só ${ncms.length} NCMs de 8 dígitos (mínimo ${minimo}): arquivo incompleto`);
  ncms.sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
  return {
    vigenteEm,
    ato: ato || null,
    sha256: createHash('sha256').update(conteudo).digest('hex'),
    bytes: conteudo.byteLength,
    ncms,
  };
}

/** Lê um fluxo de bytes até `limite` (acima disso, para e falha: nada de guardar o arquivo inteiro antes). */
export async function lerAteLimite(
  fluxo: AsyncIterable<Uint8Array>,
  limite = LIMITE_BYTES_TABELA_NCM,
): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  let total = 0;
  for await (const parte of fluxo) {
    total += parte.byteLength;
    if (total > limite) throw new ErroTabelaNcm(`arquivo com mais de ${limite / 1024 / 1024} MB`);
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

/**
 * Download da tabela: só `http(s)`, sem seguir redirecionamento (o endereço mudou → `SISCOMEX_NCM_URL`), tempo
 * limite, status 200, conteúdo JSON e o tamanho conferido no cabeçalho e na leitura.
 */
export async function baixarTabelaNcm(
  url: string,
  opcoes: { tempoLimiteMs?: number; limiteBytes?: number } = {},
): Promise<Uint8Array> {
  const limite = opcoes.limiteBytes ?? LIMITE_BYTES_TABELA_NCM;
  let endereco: URL;
  try {
    endereco = new URL(url);
  } catch {
    throw new ErroTabelaNcm('endereço da tabela inválido (SISCOMEX_NCM_URL)');
  }
  if (endereco.protocol !== 'https:' && endereco.protocol !== 'http:')
    throw new ErroTabelaNcm('o endereço da tabela tem de ser http(s)');
  let resposta: Response;
  try {
    resposta = await fetch(endereco, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opcoes.tempoLimiteMs ?? TEMPO_LIMITE_DOWNLOAD_NCM_MS),
    });
  } catch (e) {
    // O `fetch` do Node diz só "fetch failed"; o motivo (DNS, conexão recusada, certificado) vem na causa.
    const interna = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
    const causa =
      e instanceof Error
        ? e.name === 'TimeoutError'
          ? 'tempo esgotado'
          : `${e.message}${interna}`
        : String(e);
    throw new ErroTabelaNcm(`não foi possível baixar a tabela (${causa})`, { cause: e });
  }
  try {
    if (resposta.status !== 200) throw new ErroTabelaNcm(`o portal respondeu ${resposta.status}`);
    const tipo = resposta.headers.get('content-type') ?? '';
    if (!/json/i.test(tipo))
      throw new ErroTabelaNcm(`o portal não mandou JSON (${tipo ? visivel(tipo) : 'sem tipo'})`);
    const declarado = Number(resposta.headers.get('content-length') ?? NaN);
    if (declarado > limite) throw new ErroTabelaNcm(`arquivo com mais de ${limite / 1024 / 1024} MB`);
    if (!resposta.body) throw new ErroTabelaNcm('resposta sem conteúdo');
    return await lerAteLimite(resposta.body as unknown as AsyncIterable<Uint8Array>, limite);
  } catch (e) {
    await resposta.body?.cancel().catch(() => undefined);
    if (e instanceof ErroTabelaNcm) throw e;
    throw new ErroTabelaNcm(`download interrompido (${e instanceof Error ? e.message : String(e)})`, {
      cause: e,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Diferença e aplicação numa empresa
// ---------------------------------------------------------------------------------------------------------------

interface NcmNoBanco {
  descricao: string;
  inicio: string | null;
  fim: string | null;
  excluido: boolean;
}

export interface DiferencaNcm {
  /** Novos na tabela ou que voltaram (excluídos ou encerrados antes). */
  incluidos: string[];
  /** Descrição ou vigência diferente. */
  alterados: string[];
  /** Saíram do arquivo: ganham o fim de vigência `encerrarEm`. */
  encerrados: string[];
  /** Eram vigentes hoje e deixam de ser (encerrados, ou com o fim de vigência novo no passado). */
  invalidados: string[];
}

const vigente = (n: { excluido?: boolean; fim: string | null }, hoje: string) =>
  !n.excluido && (n.fim === null || n.fim >= hoje);

/** A diferença entre o que a empresa tem e o arquivo, com o que o `carregarNcms` vai gravar. */
export function diferencaNcm(
  atuais: ReadonlyMap<string, NcmNoBanco>,
  tabela: Pick<TabelaNcm, 'ncms' | 'vigenteEm'>,
  hoje: string,
): DiferencaNcm {
  const encerrarEm = vespera(tabela.vigenteEm);
  const d: DiferencaNcm = { incluidos: [], alterados: [], encerrados: [], invalidados: [] };
  const noArquivo = new Set<string>();
  for (const n of tabela.ncms) {
    noArquivo.add(n.codigo);
    const a = atuais.get(n.codigo);
    if (!a || a.excluido) d.incluidos.push(n.codigo);
    else if (a.descricao !== n.descricao || a.inicio !== n.inicio || a.fim !== n.fim)
      // O encerrado antes que volta vigente é inclusão; o resto, alteração.
      (!vigente(a, tabela.vigenteEm) && vigente(n, tabela.vigenteEm) ? d.incluidos : d.alterados).push(
        n.codigo,
      );
    if (a && vigente(a, hoje) && !vigente(n, hoje)) d.invalidados.push(n.codigo);
  }
  for (const [codigo, a] of atuais) {
    if (noArquivo.has(codigo) || a.excluido || (a.fim !== null && a.fim <= encerrarEm)) continue;
    d.encerrados.push(codigo);
    if (vigente(a, hoje) && !vigente({ fim: encerrarEm }, hoje)) d.invalidados.push(codigo);
  }
  for (const lista of Object.values(d)) lista.sort();
  return d;
}

export interface ProdutoNcmInvalidado {
  codigo: number;
  nome: string;
  ncm: string;
}

export interface ResultadoNcmEmpresa {
  empresaId: string;
  codigo: number;
  status: 'ok' | 'falhou' | 'ignorada';
  erro?: string;
  incluidos?: number;
  alterados?: number;
  encerrados?: number;
  /** Linhas de `cests` gravadas pela carga do `cests.csv`. */
  cests?: number;
  /** Terminais que receberam o `ressincronizar_fluxo referencia`. */
  terminais?: number;
  /** Produtos (sem kit e serviço, como o relatório) que ficam com NCM inválido por esta atualização. */
  produtosInvalidados?: number;
  produtos?: ProdutoNcmInvalidado[];
  diferenca?: DiferencaNcm;
}

/**
 * A atualização numa empresa, numa transação: a diferença, o upsert, o CEST, o comando aos terminais e os produtos
 * que ficam com NCM inválido. `simular` desfaz tudo no fim (o relatório sai igual). `antesDeConfirmar` roda antes
 * do commit (o registro na plataforma): falhou, nada fica.
 */
export async function aplicarTabelaNcmNaEmpresa(
  cliente: pg.Client,
  tabela: TabelaNcm,
  cests: readonly LinhaCest[],
  opcoes: {
    simular?: boolean;
    antesDeConfirmar?: (r: Omit<ResultadoNcmEmpresa, 'empresaId' | 'codigo' | 'status'>) => Promise<void>;
  } = {},
): Promise<Omit<ResultadoNcmEmpresa, 'empresaId' | 'codigo' | 'status'>> {
  await cliente.query('begin');
  try {
    await cliente.query('select fn_trava_versao()');
    const { rows: dia } = await cliente.query<{ hoje: string }>('select current_date::text as hoje');
    const { rows } = await cliente.query<{
      codigo: string;
      descricao: string;
      inicio: string | null;
      fim: string | null;
      excluido: boolean;
    }>(
      `select codigo, descricao, vigencia_inicio::text as inicio, vigencia_fim::text as fim,
              excluido_em is not null as excluido
         from ncms`,
    );
    const atuais = new Map(rows.map((r) => [r.codigo, r]));
    const diferenca = diferencaNcm(atuais, tabela, dia[0]!.hoje);
    const mudou = diferenca.incluidos.length + diferenca.alterados.length + diferenca.encerrados.length > 0;
    if (mudou) await carregarNcms(cliente, tabela.ncms, { encerrarEm: vespera(tabela.vigenteEm) });
    const cestsGravados = await carregarCests(cliente, cests);
    // SYNC 6.13: a tabela que desce mudou → o caixa baixa o fluxo de novo (o cursor volta a 0; os PDVs instalados
    // já tratam o comando). O CEST não desce (decisão 187): sozinho, não manda nada.
    const terminais = mudou ? await ressincronizarFluxos(drizzle(cliente), 'todas', ['referencia']) : 0;
    const { rows: produtos } = diferenca.invalidados.length
      ? await cliente.query<ProdutoNcmInvalidado & { total: number }>(
          `select p.codigo::int as codigo, p.nome, p.ncm, count(*) over ()::int as total
             from produtos p
            where p.excluido_em is null and p.tipo not in ('kit', 'servico') and p.ncm = any($1::varchar[])
            order by p.codigo
            limit ${LIMITE_LISTA_RELATORIO}`,
          [diferenca.invalidados],
        )
      : { rows: [] };
    const resultado = {
      incluidos: diferenca.incluidos.length,
      alterados: diferenca.alterados.length,
      encerrados: diferenca.encerrados.length,
      cests: cestsGravados,
      terminais,
      produtosInvalidados: produtos[0]?.total ?? 0,
      produtos: produtos.map(({ codigo, nome, ncm }) => ({ codigo, nome, ncm })),
      diferenca,
    };
    if (opcoes.simular) {
      await cliente.query('rollback');
      return resultado;
    }
    await opcoes.antesDeConfirmar?.(resultado);
    await cliente.query('commit');
    return resultado;
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Execução em todas as empresas
// ---------------------------------------------------------------------------------------------------------------

/**
 * A data da última tabela que a plataforma aplicou na empresa (`ncm_atualizada`), ou `null`. A carga das referências
 * das migrações compara com `NCMS_CSV_VIGENTE_EM` (decisão 193).
 */
export async function vigenciaNcmAplicada(
  controle: BancoControle,
  empresaId: string,
): Promise<string | null> {
  const [r] = await controle.db
    .select({ vigenteEm: sql<string | null>`max(${auditoriaPlataforma.depois} ->> 'vigente_em')` })
    .from(auditoriaPlataforma)
    .where(
      and(eq(auditoriaPlataforma.empresaId, empresaId), eq(auditoriaPlataforma.acao, ACAO_NCM_ATUALIZADA)),
    );
  return r?.vigenteEm ?? null;
}

export interface OpcoesAtualizacaoNcm {
  /**
   * Só estas empresas (código); sem a opção, todas as ativas e suspensas, como as migrações. A lista vazia é nenhuma
   * empresa (nunca "todas").
   */
  codigos?: number[];
  simular?: boolean;
  /** Aceita encerrar mais de `LIMITE_ENCERRADOS_FRACAO` dos NCMs do `ncms.csv` (revisão da Nomenclatura). */
  permitirEncerramentoEmMassa?: boolean;
  /** Origem do arquivo para o registro (o endereço ou "arquivo"). */
  origem?: string;
  adminId?: string | null;
}

export interface ResultadoAtualizacaoNcm {
  tabela: { vigenteEm: string; ato: string | null; sha256: string; bytes: number; ncms: number };
  simulacao: boolean;
  empresas: ResultadoNcmEmpresa[];
  falhas: number;
}

const ate = <T>(lista: readonly T[]) => lista.slice(0, LIMITE_LISTA_RELATORIO);

/** A tarefa da plataforma: confere o arquivo uma vez e aplica empresa por empresa (uma de cada vez). */
export class AtualizacaoNcm {
  constructor(
    private readonly controle: BancoControle,
    private readonly servidores: ServidoresBanco,
    private readonly executadoPor: string,
  ) {}

  async executar(tabela: TabelaNcm, opcoes: OpcoesAtualizacaoNcm = {}): Promise<ResultadoAtualizacaoNcm> {
    // Antes de qualquer empresa: o arquivo que encerraria boa parte da tabela versionada para tudo (e o `cests.csv`
    // versionado é lido uma vez: fora do formato, nada é aplicado).
    const noArquivo = new Set(tabela.ncms.map((n) => n.codigo));
    const base = lerNcms();
    const sairiam = base.filter((n) => !noArquivo.has(n.codigo)).length;
    if (
      !opcoes.permitirEncerramentoEmMassa &&
      base.length &&
      sairiam / base.length > LIMITE_ENCERRADOS_FRACAO
    )
      throw new ErroTabelaNcm(
        `o arquivo encerraria ${sairiam} dos ${base.length} NCMs da tabela versionada (mais de ${
          LIMITE_ENCERRADOS_FRACAO * 100
        }%): confira o arquivo; numa revisão da Nomenclatura, rode com --permitir-encerramento-em-massa`,
      );
    const cests = lerCests();

    const condicoes = [inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)];
    // `inArray` com a lista vazia é falso: `codigos: []` não alcança empresa nenhuma.
    if (opcoes.codigos) condicoes.push(inArray(empresas.codigo, opcoes.codigos));
    const alvos = await this.controle.db
      .select({
        id: empresas.id,
        codigo: empresas.codigo,
        nomeBanco: empresas.nomeBanco,
        servidorBancoId: empresas.servidorBancoId,
      })
      .from(empresas)
      .where(and(...condicoes))
      .orderBy(asc(empresas.codigo));

    const resultados: ResultadoNcmEmpresa[] = [];
    for (const alvo of alvos) resultados.push(await this.empresa(alvo, tabela, cests, opcoes));
    const resultado: ResultadoAtualizacaoNcm = {
      tabela: {
        vigenteEm: tabela.vigenteEm,
        ato: tabela.ato,
        sha256: tabela.sha256,
        bytes: tabela.bytes,
        ncms: tabela.ncms.length,
      },
      simulacao: !!opcoes.simular,
      empresas: resultados,
      falhas: resultados.filter((r) => r.status === 'falhou').length,
    };
    if (!opcoes.simular)
      await registrarAuditoriaPlataforma(this.controle.db, {
        adminId: opcoes.adminId,
        acao: ACAO_NCM_EXECUTADA,
        entidade: 'ncms',
        depois: {
          executado_por: this.executadoPor,
          origem: opcoes.origem ?? null,
          ...this.cabecalho(tabela),
          falhas: resultado.falhas,
          empresas: resultados.map((r) => ({
            codigo: r.codigo,
            status: r.status,
            erro: r.erro,
            incluidos: r.incluidos,
            alterados: r.alterados,
            encerrados: r.encerrados,
            produtos_invalidados: r.produtosInvalidados,
          })),
        },
      });
    return resultado;
  }

  private cabecalho(tabela: TabelaNcm) {
    return { vigente_em: tabela.vigenteEm, ato: tabela.ato, sha256: tabela.sha256, ncms: tabela.ncms.length };
  }

  private async empresa(
    alvo: { id: string; codigo: number; nomeBanco: string; servidorBancoId: string },
    tabela: TabelaNcm,
    cests: readonly LinhaCest[],
    opcoes: OpcoesAtualizacaoNcm,
  ): Promise<ResultadoNcmEmpresa> {
    const base = { empresaId: alvo.id, codigo: alvo.codigo };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        `select pg_try_advisory_lock(${TRAVA_EMPRESA}, hashtext($1)) as ok`,
        [alvo.id],
      );
      if (!rows[0]?.ok)
        return { ...base, status: 'ignorada', erro: 'Migração ou atualização desta empresa em andamento' };
      let cliente: pg.Client | undefined;
      try {
        // A tabela mais velha que a da empresa (a aplicada antes ou a do `ncms.csv`) não volta a empresa no tempo.
        const aplicada = await vigenciaNcmAplicada(this.controle, alvo.id);
        const atual = aplicada && aplicada > NCMS_CSV_VIGENTE_EM ? aplicada : NCMS_CSV_VIGENTE_EM;
        if (tabela.vigenteEm < atual)
          return {
            ...base,
            status: 'ignorada',
            erro: `Tabela de ${tabela.vigenteEm} mais antiga que a da empresa (${atual})`,
          };
        garantirNomeBancoEmpresa(alvo.nomeBanco, alvo.codigo);
        cliente = await this.servidores.conectar(alvo.servidorBancoId, alvo.nomeBanco, 'genesis_ncm');
        const r = await aplicarTabelaNcmNaEmpresa(cliente, tabela, cests, {
          simular: opcoes.simular,
          antesDeConfirmar: (x) =>
            registrarAuditoriaPlataforma(this.controle.db, {
              adminId: opcoes.adminId,
              empresaId: alvo.id,
              acao: ACAO_NCM_ATUALIZADA,
              entidade: 'ncms',
              depois: {
                executado_por: this.executadoPor,
                origem: opcoes.origem ?? null,
                ...this.cabecalho(tabela),
                incluidos: x.incluidos,
                alterados: x.alterados,
                encerrados: x.encerrados,
                encerrar_em: vespera(tabela.vigenteEm),
                cests: x.cests,
                terminais: x.terminais,
                produtos_invalidados: x.produtosInvalidados,
                codigos: {
                  incluidos: ate(x.diferenca!.incluidos),
                  alterados: ate(x.diferenca!.alterados),
                  encerrados: ate(x.diferenca!.encerrados),
                },
                produtos: x.produtos,
              },
            }),
        });
        return { ...base, status: 'ok', ...r };
      } catch (e) {
        return { ...base, status: 'falhou', erro: e instanceof Error ? e.message : String(e) };
      } finally {
        await cliente?.end().catch(() => undefined);
        await trava
          .query(`select pg_advisory_unlock(${TRAVA_EMPRESA}, hashtext($1))`, [alvo.id])
          .catch(() => undefined);
      }
    } finally {
      trava.release();
    }
  }
}
