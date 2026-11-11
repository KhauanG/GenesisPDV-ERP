/**
 * Envio e leitura de arquivos e imagens pelo ERP (Fase 2, F2-B43; MD 3.1.6; SYNC 6.12; README da API › decisão 189):
 * a foto do produto, a imagem da categoria, o logotipo da marca e os Anexos da loja (logotipo e foto).
 *
 * - O **tipo** vem do conteúdo (`detectarTipoArquivo`, magic bytes) e a imagem é decodificada de verdade
 *   (`processarImagem`); a extensão e o `Content-Type` do cliente são ignorados. O tipo gravado em `arquivos.tipo_mime`
 *   é o detectado, e é com ele que o arquivo é servido.
 * - A **chave** do objeto é gerada pelo servidor (`emp/<codigo>/<categoria>/<aaaa>/<mm>/<uuid>.<ext>`, a variante ao
 *   lado): o nome do arquivo do cliente só vai para `nome_original`, nunca para o caminho nem para o cabeçalho.
 * - O **sha256** do original vai em `arquivos.sha256` e nos metadados do objeto (`ArmazenamentoObjetos.gravar`); o
 *   da variante, em `arquivos.variantes` (o `foto_sha256` da SYNC 6.12 sai dele no F2-B45).
 * - **Quem vê**: a empresa é a do banco (o arquivo de outra empresa não existe aqui: 404), e o arquivo só aparece a
 *   quem vê o cadastro dono (`produtos.ver`, `categorias.ver`, `marcas.ver`, `lojas.ver` com a loja permitida); as
 *   outras categorias (XML, planilhas) têm as rotas delas e aqui são 404.
 */
import {
  DESTINOS_ARQUIVO,
  detectarTipoArquivo,
  mensagemArquivoGrande,
  mensagemTipoRecusado,
  TIPOS_ARQUIVO,
  type ArquivoInfo,
  type DestinoArquivo,
  type EnvioArquivo,
  type TipoArquivo,
  type VarianteArquivo,
  type VarianteArquivoInfo,
} from '@genesis/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { arquivos, lojas } from '../database/empresa/schema/index.js';
import { chaveArquivo, chaveVariante, type ArmazenamentoObjetos } from '../infra/armazenamento.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { ImagemRecusada, processarImagem } from './imagens.js';

/** Quem envia para cada destino: basta uma das permissões (o produto novo ainda não existe quando a foto sobe). */
export const PERMISSOES_ENVIO: Record<DestinoArquivo, readonly string[]> = {
  produto_foto: ['produtos.criar', 'produtos.editar'],
  categoria_imagem: ['categorias.editar'],
  marca_logotipo: ['marcas.criar', 'marcas.editar'],
  loja_logotipo: ['lojas.editar'],
  loja_foto: ['lojas.editar'],
};

/** Quem vê o arquivo de cada cadastro dono (`arquivos.entidade`). */
const PERMISSAO_VER: Record<(typeof DESTINOS_ARQUIVO)[DestinoArquivo]['entidade'], string> = {
  produtos: 'produtos.ver',
  categorias: 'categorias.ver',
  marcas: 'marcas.ver',
  lojas: 'lojas.ver',
};

export const podeEnviar = (sessao: SessaoErp, destino: DestinoArquivo) =>
  PERMISSOES_ENVIO[destino].some((p) => sessao.permissoes.has(p));

/** O destino de um arquivo gravado (pela categoria e pela entidade), ou `null` se não for um arquivo de cadastro. */
function destinoDoArquivo(categoria: string, entidade: string | null): DestinoArquivo | null {
  for (const [nome, d] of Object.entries(DESTINOS_ARQUIVO))
    if (d.categoria === categoria && d.entidade === entidade) return nome as DestinoArquivo;
  return null;
}

type LinhaArquivo = typeof arquivos.$inferSelect;
type VariantesGravadas = Partial<Record<VarianteArquivo, VarianteArquivoInfo & { chave: string }>>;

/** Nome do arquivo para `nome_original`: só o último pedaço do caminho, sem caracteres de controle. */
export function nomeOriginalSeguro(bruto: string): string {
  const nome = bruto
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (nome || 'arquivo').slice(0, 255);
}

function info(a: LinhaArquivo): ArquivoInfo {
  const variantes: ArquivoInfo['variantes'] = {};
  for (const [nome, v] of Object.entries((a.variantes ?? {}) as VariantesGravadas)) {
    if (!v) continue;
    variantes[nome as VarianteArquivo] = {
      tipoMime: v.tipoMime,
      tamanhoBytes: v.tamanhoBytes,
      sha256: v.sha256,
      largura: v.largura,
      altura: v.altura,
    };
  }
  return {
    id: a.id,
    categoria: a.categoria,
    entidade: a.entidade,
    lojaId: a.lojaId,
    nomeOriginal: a.nomeOriginal,
    tipoMime: a.tipoMime,
    tamanhoBytes: a.tamanhoBytes,
    sha256: a.sha256,
    variantes,
    criadoEm: a.criadoEm.toISOString(),
  };
}

export interface ConteudoArquivo {
  conteudo: Buffer;
  tipoMime: string;
  extensao: string;
  sha256: string;
}

/** Extensão do tipo gravado (o nome do download é `<id>.<ext>`, nunca o do cliente). */
function extensaoDoTipo(tipoMime: string): string {
  return Object.values(TIPOS_ARQUIVO).find((t) => t.tipoMime === tipoMime)?.extensao ?? 'bin';
}

export class Arquivos {
  constructor(private readonly d: { tenancy: Tenancy; armazenamento: ArmazenamentoObjetos }) {}

  /**
   * Grava o arquivo enviado (o multipart já foi cortado no limite do destino, `LimiteEnvioArquivo`): confere o tipo
   * pelo conteúdo, decodifica a imagem e gera as variantes (uma imagem por vez no processo), grava os objetos no
   * armazenamento e depois a linha em `arquivos`. Falhou a linha → os objetos são apagados.
   */
  async enviar(sessao: SessaoErp, envio: EnvioArquivo, nome: string, conteudo: Buffer): Promise<ArquivoInfo> {
    const destino = DESTINOS_ARQUIVO[envio.destino];
    if (!conteudo.length)
      throw new ErroApi('VALIDACAO', 'O arquivo está vazio.', { campos: { arquivo: ['Arquivo vazio'] } });
    if (conteudo.length > destino.limiteBytes)
      throw new ErroApi('ARQUIVO_GRANDE', mensagemArquivoGrande(envio.destino), {
        campos: { arquivo: [mensagemArquivoGrande(envio.destino)] },
      });
    const tipo = detectarTipoArquivo(conteudo);
    if (!tipo || !(destino.tipos as readonly TipoArquivo[]).includes(tipo))
      throw new ErroApi('TIPO_NAO_SUPORTADO', mensagemTipoRecusado(envio.destino), {
        campos: { arquivo: ['Tipo de arquivo não aceito'] },
      });
    const cx = this.d.tenancy.cx();
    if (destino.daLoja) {
      const lojaId = envio.lojaId!;
      const [loja] = lojaPermitida(sessao, lojaId)
        ? await cx.consulta((db) =>
            db
              .select({ id: lojas.id })
              .from(lojas)
              .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm))),
          )
        : [];
      if (!loja) throw ErroApi.naoEncontrado('Loja não encontrada.');
    }
    let imagem: Awaited<ReturnType<typeof processarImagem>> | null = null;
    if (tipo !== 'pdf') {
      try {
        imagem = await processarImagem(conteudo, tipo, destino.variantes);
      } catch (e) {
        if (!(e instanceof ImagemRecusada)) throw e;
        throw new ErroApi(e.motivo === 'pixels' ? 'VALIDACAO' : 'TIPO_NAO_SUPORTADO', e.message, {
          campos: { arquivo: [e.message] },
        });
      }
    }
    const tipoArquivo = TIPOS_ARQUIVO[tipo];
    const chave = chaveArquivo(cx.contexto.codigo, destino.categoria, tipoArquivo.extensao);
    const gravados: string[] = [];
    try {
      const { sha256, tamanhoBytes } = await this.d.armazenamento.gravar(
        chave,
        conteudo,
        tipoArquivo.tipoMime,
      );
      gravados.push(chave);
      const variantes: VariantesGravadas = {};
      for (const [nomeVariante, v] of Object.entries(imagem?.variantes ?? {})) {
        if (!v) continue;
        const chaveV = chaveVariante(chave, nomeVariante, v.extensao);
        const r = await this.d.armazenamento.gravar(chaveV, v.conteudo, v.tipoMime);
        gravados.push(chaveV);
        variantes[nomeVariante as VarianteArquivo] = {
          chave: chaveV,
          tipoMime: v.tipoMime,
          tamanhoBytes: r.tamanhoBytes,
          sha256: r.sha256,
          largura: v.largura,
          altura: v.altura,
        };
      }
      const [linha] = await cx.consulta((db) =>
        db
          .insert(arquivos)
          .values({
            chaveArmazenamento: chave,
            nomeOriginal: nomeOriginalSeguro(nome),
            tipoMime: tipoArquivo.tipoMime,
            tamanhoBytes,
            sha256,
            categoria: destino.categoria,
            entidade: destino.entidade,
            lojaId: destino.daLoja ? envio.lojaId! : null,
            variantes,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning(),
      );
      return info(linha!);
    } catch (e) {
      await Promise.all(gravados.map((k) => this.d.armazenamento.excluir(k).catch(() => undefined)));
      throw e;
    }
  }

  /** A linha visível a quem pede (a empresa é a do banco; o cadastro dono pela permissão e pela loja), ou 404. */
  private async visivel(sessao: SessaoErp, id: string): Promise<LinhaArquivo> {
    const [a] = await this.d.tenancy.cx().consulta((db) =>
      db
        .select()
        .from(arquivos)
        .where(and(eq(arquivos.id, id), isNull(arquivos.excluidoEm))),
    );
    const destino = a ? destinoDoArquivo(a.categoria, a.entidade) : null;
    if (!a || !destino) throw ErroApi.naoEncontrado('Arquivo não encontrado.');
    const d = DESTINOS_ARQUIVO[destino];
    if (!sessao.permissoes.has(PERMISSAO_VER[d.entidade]))
      throw ErroApi.naoEncontrado('Arquivo não encontrado.');
    if (d.daLoja && !lojaPermitida(sessao, a.lojaId)) throw ErroApi.naoEncontrado('Arquivo não encontrado.');
    return a;
  }

  async obter(sessao: SessaoErp, id: string): Promise<ArquivoInfo> {
    return info(await this.visivel(sessao, id));
  }

  /** O conteúdo do original ou de uma variante, com o tipo gravado (o detectado no envio). */
  async conteudo(sessao: SessaoErp, id: string, variante?: VarianteArquivo): Promise<ConteudoArquivo> {
    const a = await this.visivel(sessao, id);
    if (variante) {
      const v = ((a.variantes ?? {}) as VariantesGravadas)[variante];
      if (!v) throw ErroApi.naoEncontrado('Variante não encontrada.');
      return {
        conteudo: await this.d.armazenamento.ler(v.chave),
        tipoMime: v.tipoMime,
        extensao: extensaoDoTipo(v.tipoMime),
        sha256: v.sha256,
      };
    }
    return {
      conteudo: await this.d.armazenamento.ler(a.chaveArmazenamento),
      tipoMime: a.tipoMime,
      extensao: extensaoDoTipo(a.tipoMime),
      sha256: a.sha256,
    };
  }
}

/**
 * Confere, na gravação do cadastro dono (os Anexos da loja; o produto, a categoria e a marca no F2-B44), que o
 * arquivo escolhido é um envio daquele destino: existe, não foi excluído, tem a categoria e a entidade do destino e,
 * no destino de loja, é da própria loja. Também liga o arquivo ao registro (`registro_id`), que fica para a limpeza dos
 * envios abandonados. Chame dentro da transação da gravação.
 */
export async function vincularArquivo(
  db: DbEmpresa,
  arquivoId: string,
  destino: DestinoArquivo,
  registroId: string,
  campo: string,
): Promise<void> {
  const d = DESTINOS_ARQUIVO[destino];
  const [a] = await db
    .select({ id: arquivos.id, lojaId: arquivos.lojaId, registroId: arquivos.registroId })
    .from(arquivos)
    .where(
      and(
        eq(arquivos.id, arquivoId),
        isNull(arquivos.excluidoEm),
        eq(arquivos.categoria, d.categoria),
        eq(arquivos.entidade, d.entidade),
      ),
    );
  const valido =
    a && (!d.daLoja || a.lojaId === registroId) && (a.registroId === null || a.registroId === registroId);
  if (!valido)
    throw new ErroApi('VALIDACAO', 'Envie a imagem de novo.', {
      campos: { [campo]: [`${d.rotulo}: arquivo inválido ou de outro cadastro`] },
    });
  if (a.registroId === null) await db.update(arquivos).set({ registroId }).where(eq(arquivos.id, arquivoId));
}
