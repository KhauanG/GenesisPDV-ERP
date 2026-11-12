/** Marcas (ERP 8.7) e categorias em árvore (ERP 8.4; MD 3.6.1, 3.6.2). */
import { z } from 'zod';
import { idArquivoAnexo } from './arquivos.js';
import { textoObrigatorio, uuidOpcional, vazioParaNulo, type MetadadosRegistro } from './campos.js';
import { paginacaoQuerySchema } from './paginacao.js';

export const ORDENACOES_MARCAS = ['codigo', 'descricao', 'ordem', 'produtos'] as const;

export const filtroMarcasSchema = paginacaoQuerySchema.extend({
  descricao: z.string().trim().max(60).optional(),
});
export type FiltroMarcas = z.infer<typeof filtroMarcasSchema>;

const camposMarca = z.object({
  descricao: textoObrigatorio(60, 'Informe a descrição'),
  semMarca: z.boolean().default(false),
  exibeSite: z.boolean().default(false),
  ordem: z.coerce.number().int().min(0).max(999_999).default(0),
  /** Logotipo (ERP 8.7; F2-B44): um envio `marca_logotipo` (até 1 MB); `null` tira, ausente mantém. */
  logotipoArquivoId: idArquivoAnexo,
});

export const criarMarcaSchema = camposMarca;
export type CriarMarcaEntrada = z.input<typeof criarMarcaSchema>;
export const alterarMarcaSchema = camposMarca.extend({ versao: z.number().int() });
export type AlterarMarcaEntrada = z.input<typeof alterarMarcaSchema>;

/** Mesclar marcas duplicadas (ERP 8.7): move os produtos para `destinoId` e exclui as `origens`. */
export const mesclarMarcasSchema = z
  .object({ destinoId: z.uuid(), origens: z.array(z.uuid()).min(1).max(100) })
  .refine((v) => !v.origens.includes(v.destinoId), {
    path: ['origens'],
    message: 'O destino não pode estar entre as origens',
  });

export interface MarcaResumo {
  id: string;
  codigo: number;
  descricao: string;
  semMarca: boolean;
  exibeSite: boolean;
  ordem: number;
  produtos: number;
  versao: number;
}

export interface MarcaDetalhe extends MarcaResumo, MetadadosRegistro {
  logotipoArquivoId: string | null;
}

/** Teto de produtos na ficha impressa da marca (o resto é contado em `totalProdutos`). */
export const LIMITE_PRODUTOS_FICHA_MARCA = 5000;

export interface ProdutoFichaMarca {
  id: string;
  codigo: number;
  nome: string;
  ean: string | null;
  unidadeSigla: string;
  precoVenda: string;
  ativo: boolean;
}

/**
 * Ficha da marca para o botão Imprimir (ERP 8.7; F2-B44; `GET /marcas/:id/ficha`): a marca e os produtos dela
 * (ativos e inativos, não excluídos), pelo nome. Nada de custo.
 */
export interface FichaMarca {
  marca: MarcaDetalhe;
  produtos: ProdutoFichaMarca[];
  /** Todos os produtos da marca; acima de `LIMITE_PRODUTOS_FICHA_MARCA`, a lista vem cortada. */
  totalProdutos: number;
  geradoEm: string;
}

export const PROFUNDIDADE_MAXIMA_CATEGORIAS = 5;

const cor = z.preprocess(
  vazioParaNulo,
  z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Cor no formato #RRGGBB')
    .nullable()
    .default(null),
);

const camposCategoria = z.object({
  nome: textoObrigatorio(60, 'Informe o nome'),
  categoriaPaiId: uuidOpcional,
  ordem: z.coerce.number().int().min(0).max(999_999).default(0),
  ativa: z.boolean().default(true),
  exibePdv: z.boolean().default(true),
  exibeMenuDigital: z.boolean().default(false),
  exibeTotem: z.boolean().default(false),
  exibeSite: z.boolean().default(false),
  cor,
  /** Imagem (ERP 8.4; F2-B44): um envio `categoria_imagem`; `null` tira, ausente mantém. */
  imagemArquivoId: idArquivoAnexo,
});

export const criarCategoriaSchema = camposCategoria;
export type CriarCategoriaEntrada = z.input<typeof criarCategoriaSchema>;
/** O pai muda pelo "mover" (`POST /categorias/:id/mover`); aqui só os dados da própria categoria. */
export const alterarCategoriaSchema = camposCategoria
  .omit({ categoriaPaiId: true })
  .extend({ versao: z.number().int() });
export type AlterarCategoriaEntrada = z.input<typeof alterarCategoriaSchema>;

export const moverCategoriaSchema = z.object({
  versao: z.number().int(),
  categoriaPaiId: uuidOpcional,
  ordem: z.coerce.number().int().min(0).max(999_999).optional(),
});
export type MoverCategoria = z.output<typeof moverCategoriaSchema>;

/** Distância entre as ordens gravadas pela reordenação (10, 20, 30…: sobra espaço para o campo Ordem). */
export const PASSO_ORDEM_CATEGORIAS = 10;
/** Teto de irmãs numa reordenação (um nível da árvore). */
export const MAXIMO_IRMAS_REORDENAR = 500;

/**
 * Reordenar as filhas de um pai (ERP 8.4 "reordena irmãos"; F2-B44; `POST /categorias/reordenar`): a lista **inteira**
 * das filhas vivas de `categoriaPaiId` (vazio = as raízes), na ordem nova, cada uma com a versão que a tela viu. A
 * API grava `ordem` = posição × `PASSO_ORDEM_CATEGORIAS` numa transação; versão diferente, ou a lista diferente das
 * filhas de agora (alguém criou, moveu ou excluiu uma no meio), é 409 e nada muda.
 */
export const reordenarCategoriasSchema = z
  .object({
    categoriaPaiId: uuidOpcional,
    itens: z
      .array(z.object({ id: z.uuid(), versao: z.number().int() }))
      .min(1, 'Informe as categorias')
      .max(MAXIMO_IRMAS_REORDENAR, `No máximo ${MAXIMO_IRMAS_REORDENAR} categorias num nível`),
  })
  .superRefine((v, ctx) => {
    const vistos = new Set<string>();
    v.itens.forEach((i, n) => {
      const id = i.id.toLowerCase();
      if (vistos.has(id))
        ctx.addIssue({ code: 'custom', path: ['itens', n, 'id'], message: 'Categoria repetida' });
      vistos.add(id);
    });
  });
export type ReordenarCategorias = z.output<typeof reordenarCategoriasSchema>;

export interface CategoriaNo {
  id: string;
  nome: string;
  categoriaPaiId: string | null;
  caminhoNomes: string;
  nivel: number;
  ordem: number;
  ativa: boolean;
  exibePdv: boolean;
  exibeMenuDigital: boolean;
  exibeTotem: boolean;
  exibeSite: boolean;
  cor: string | null;
  imagemArquivoId: string | null;
  produtos: number;
  versao: number;
}

export interface CategoriaArvore extends CategoriaNo {
  filhas: CategoriaArvore[];
}

/** Monta a árvore (ordem, depois nome) a partir da lista plana de `GET /categorias/arvore`. */
export function montarArvoreCategorias(nos: readonly CategoriaNo[]): CategoriaArvore[] {
  const porId = new Map<string, CategoriaArvore>(nos.map((n) => [n.id, { ...n, filhas: [] }]));
  const raizes: CategoriaArvore[] = [];
  for (const n of porId.values()) {
    const pai = n.categoriaPaiId ? porId.get(n.categoriaPaiId) : undefined;
    (pai ? pai.filhas : raizes).push(n);
  }
  const ordenar = (l: CategoriaArvore[]) => {
    l.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'));
    l.forEach((f) => ordenar(f.filhas));
  };
  ordenar(raizes);
  return raizes;
}

export const excluirCategoriaQuerySchema = z.object({
  /** Confirma a remoção dos vínculos com produtos (os produtos ficam, ERP 8.4). */
  confirmar: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
