/**
 * Produtos (ERP 8.1, 8.2, 8.9, 8.10; MD 3.6.3–3.6.5, 3.6.7, 3.6.9, 3.6.12, 3.6.13): listagem, formulário em acordeão
 * (cabeçalho, preços complementares, códigos de barras e embalagens, combo/ficha técnica, lojas, preço por
 * quantidade, grupo de preço, vasilhame, tributação e flags do PDV), grupos de preço por quantidade (mix) e
 * restrições de horário de venda. Decimais trafegam como string (ERP 1.5).
 */
import { z } from 'zod';
import {
  dataOpcionalValida,
  decimal,
  textoObrigatorio,
  textoOpcional,
  uuidOpcional,
  vazioParaNulo,
  type MetadadosRegistro,
} from './campos.js';
import { paginacaoQuerySchema } from './paginacao.js';
import type { PessoaOpcao } from './pessoas.js';
import { validarGtin } from './precos.js';

export const TIPOS_PRODUTO = [
  'simples',
  'com_variacoes',
  'kit',
  'com_complementos',
  'materia_prima',
  'servico',
  'produzido',
  'vasilhame',
] as const;
export type TipoProduto = (typeof TIPOS_PRODUTO)[number];

export const ROTULOS_TIPO_PRODUTO: Record<TipoProduto, string> = {
  simples: 'Simples',
  com_variacoes: 'Com variações',
  kit: 'Combo / kit',
  com_complementos: 'Com complementos',
  materia_prima: 'Matéria-prima',
  servico: 'Serviço',
  produzido: 'Produzido (ficha técnica)',
  vasilhame: 'Vasilhame (casco)',
};

/** Componente (padrão ou alternativa) de combo não pode ser destes tipos (MD 3.6.7: sem combo dentro de combo). */
export const TIPOS_PROIBIDOS_NO_COMBO: readonly TipoProduto[] = [
  'kit',
  'materia_prima',
  'servico',
  'com_complementos',
];
/** Insumo de ficha técnica (ERP 8.2.4). */
export const TIPOS_INSUMO_FICHA: readonly TipoProduto[] = ['materia_prima', 'simples'];
/** Membros de grupo de preço por quantidade (`ck_produtos_grupo_preco_tipo`). */
export const TIPOS_GRUPO_PRECO: readonly TipoProduto[] = ['simples', 'com_variacoes', 'produzido'];
/**
 * Mudança de tipo depois de haver movimento de estoque (ERP 8.2.1): só entre Simples ↔ Matéria-prima ↔ Serviço
 * (Serviço só sem saldo).
 */
export const TIPOS_TROCA_COM_MOVIMENTO: readonly TipoProduto[] = ['simples', 'materia_prima', 'servico'];

/**
 * Tipos cujo módulo ainda não foi entregue (Fase 2, F2-B1; D43, decidida pelo dono: complementos sim, variações
 * não) e a chave de configuração que os libera. Com a chave desligada o tipo não pode ser **escolhido** (criar o produto ou trocar o tipo
 * para ele); o produto já gravado com ele (legado do Nuvem3) continua editável e importável, e o filtro "Tipo sem
 * suporte" o lista.
 */
export const CHAVES_TIPO_PRODUTO: Readonly<Partial<Record<TipoProduto, string>>> = {
  com_variacoes: 'produtos.variacoes_habilitadas',
  com_complementos: 'produtos.complementos_habilitados',
};

/**
 * Guarda das variações no caixa (Fase 2, F2-B34; F2-Q2 = D44, decidida pelo dono em 05/11/2026): ligada, o PDV recusa o
 * código de uma variação e o produto pai "Com variações" com variação ativa ("Produto com variações: venda disponível
 * na próxima versão"); desligada, vende o pai como antes. A chave está no catálogo (`configuracoes.ts`), por loja.
 */
export const CHAVE_RECUSA_PRODUTO_COM_VARIACOES = 'pdv.recusa_produto_com_variacoes';

/**
 * Primeira versão do PDV com a guarda das variações (a release R1 do PDV, fechamento do PR-8 da Fase 2). Ligar
 * `produtos.variacoes_habilitadas` avisa dos terminais ativos abaixo dela (ou sem versão conhecida): eles vendem o
 * produto com variações com o preço e o saldo do pai. Se a R1 sair com outro número, é só trocar aqui.
 */
export const VERSAO_PDV_GUARDA_VARIACOES = '0.11.0';

/** Terminal ativo com o PDV anterior à guarda das variações (`GET /configuracoes/terminais-sem-guarda-variacoes`). */
export interface TerminalSemGuardaVariacoes {
  id: string;
  lojaNome: string | null;
  numeroCaixa: number;
  descricao: string | null;
  /** `null` = o terminal ainda não informou a versão (nunca mandou o handshake). */
  versaoApp: string | null;
}

export interface RespostaTerminaisSemGuardaVariacoes {
  versaoMinima: string;
  /** Só os das lojas permitidas ao usuário (ERP 2.1). */
  terminais: TerminalSemGuardaVariacoes[];
  /** Quantos terminais antigos ficam nas lojas fora do acesso do usuário (só a contagem: a chave vale na empresa). */
  outrasLojas: number;
}

/** Tipos liberados pelas chaves (`ligada(chave)` = valor efetivo da chave), na ordem de `TIPOS_PRODUTO`. */
export function tiposProdutoHabilitados(ligada: (chave: string) => boolean): TipoProduto[] {
  return TIPOS_PRODUTO.filter((t) => {
    const chave = CHAVES_TIPO_PRODUTO[t];
    return !chave || ligada(chave);
  });
}

/**
 * Motivo da recusa do tipo (`null` = aceito): tipo travado só passa quando já é o tipo gravado (`tipoAtual`; `null` na
 * criação). Mesma mensagem no formulário, na API e na importação.
 */
export function motivoTipoProdutoBloqueado(
  tipo: TipoProduto,
  tipoAtual: TipoProduto | null,
  habilitados: readonly TipoProduto[],
): string | null {
  if (habilitados.includes(tipo) || tipo === tipoAtual) return null;
  return `Tipo disponível em breve: "${ROTULOS_TIPO_PRODUTO[tipo]}" ainda não tem suporte nesta versão`;
}

export interface AvisoComboComponente {
  produtoId: string;
  codigo: number;
  nome: string;
  motivo: string;
  fiscal: boolean;
}

/** CST/CSOSN de substituição tributária: exigem CEST (MD 3.6.3). */
export const CST_COM_ST = ['10', '30', '60', '70', '201', '202', '203', '500'] as const;
/** CST/CSOSN do ICMS cobrado anteriormente por ST: CFOP 5405. */
export const CST_ST_RETIDO = ['60', '500'] as const;

/** Unidades que nascem com "Permite fração" (ERP 8.2.1). */
export const UNIDADES_FRACIONADAS = ['KG', 'G', 'L', 'ML', 'M', 'M2', 'M3'] as const;

/**
 * Origem de uma linha do histórico de preços (MD 3.6.10; `ck_produtos_historico_precos_origem`): o formulário do
 * produto (`cadastro`), a importação de planilha (`importacao`), o cadastro em massa (`cadastro_massa`, F2-B39), o
 * recebimento manual (`recebimento`, F2-B15), a NF-e de entrada (`nota_entrada`, F2-B21) e a API de integração
 * (`api`). Até o F2-B15 o formulário e a importação gravavam todos como `cadastro`.
 */
export const ORIGENS_HISTORICO_PRECO = [
  'cadastro',
  'importacao',
  'cadastro_massa',
  'recebimento',
  'nota_entrada',
  'api',
] as const;
export type OrigemHistoricoPreco = (typeof ORIGENS_HISTORICO_PRECO)[number];

// ---------------------------------------------------------------- Campos

const LIMITE_PRECO = 99_999_999_999;
export const precoCampo = decimal({ min: 0, max: LIMITE_PRECO, casas: 4, mensagem: 'Preço inválido' });
const opcional = <T extends z.ZodType>(campo: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), campo.nullable().default(null));
export const precoOpcional = opcional(precoCampo);
export const quantidadePositiva = decimal({
  min: 0.001,
  max: 999_999_999_999,
  casas: 3,
  mensagem: 'Informe uma quantidade maior que zero',
});
const quantidadeOpcional = opcional(quantidadePositiva);
const quantidadeNaoNegativaOpcional = opcional(
  decimal({ min: 0, max: 999_999_999_999, casas: 3, mensagem: 'Quantidade inválida' }),
);
const percentualOpcional = opcional(
  decimal({ min: 0, max: 100, casas: 4, mensagem: 'Informe um percentual entre 0 e 100' }),
);
const medidaOpcional = (casas: number) =>
  opcional(decimal({ min: 0, max: 99_999_999, casas, mensagem: 'Valor inválido' }));

const digitos = (n: number | [number, number], mensagem: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\D/g, '') || null : v),
    z
      .string()
      .regex(
        typeof n === 'number' ? new RegExp(`^\\d{${n}}$`) : new RegExp(`^\\d{${n[0]},${n[1]}}$`),
        mensagem,
      )
      .nullable()
      .default(null),
  );

const dataHoraOpcional = z.preprocess(
  vazioParaNulo,
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Data/hora inválida')
    .transform((v) => new Date(v).toISOString())
    .nullable()
    .default(null),
);

const idFilha = z.preprocess(vazioParaNulo, z.uuid().nullable().default(null));

// ---------------------------------------------------------------- Filhas do produto

export const codigoBarrasSchema = z
  .object({
    id: idFilha,
    codigo: z
      .string()
      .trim()
      .min(1, 'Informe o código')
      .max(30)
      .transform((v) => v.replace(/\s/g, '')),
    tipo: z.enum(['gtin', 'interno']).default('gtin'),
    principal: z.boolean().default(false),
    descricao: textoOpcional(40),
    unidadeId: uuidOpcional,
    fator: quantidadePositiva.default('1.000'),
    preco: precoOpcional,
    usaVenda: z.boolean().default(true),
    usaCompra: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    if (c.tipo === 'gtin' && !validarGtin(c.codigo)) {
      ctx.addIssue({
        code: 'custom',
        path: ['codigo'],
        message: /^(\d{8}|\d{12,14})$/.test(c.codigo)
          ? 'Dígito verificador do GTIN inválido'
          : 'GTIN deve ter 8, 12, 13 ou 14 dígitos',
      });
    }
    if (c.principal && Number(c.fator) !== 1) {
      ctx.addIssue({ code: 'custom', path: ['fator'], message: 'O código principal é da unidade (fator 1)' });
    }
  });
export type CodigoBarrasEntrada = z.input<typeof codigoBarrasSchema>;

export const produtoLojaSchema = z
  .object({
    lojaId: z.uuid(),
    estoqueMinimo: quantidadeNaoNegativaOpcional,
    estoqueMaximo: quantidadeNaoNegativaOpcional,
    precoVenda: precoOpcional,
    ativoNaLoja: z.boolean().default(true),
    acrescimoGelada: precoOpcional,
  })
  .superRefine((l, ctx) => {
    if (
      l.estoqueMinimo !== null &&
      l.estoqueMaximo !== null &&
      Number(l.estoqueMaximo) < Number(l.estoqueMinimo)
    ) {
      ctx.addIssue({ code: 'custom', path: ['estoqueMaximo'], message: 'Máximo menor que o mínimo' });
    }
  });

export const faixaPrecoSchema = z
  .object({
    id: idFilha,
    lojaId: uuidOpcional,
    quantidadeInicial: quantidadePositiva,
    quantidadeFinal: quantidadeOpcional,
    preco: precoCampo,
  })
  .superRefine((f, ctx) => {
    if (f.quantidadeFinal !== null && Number(f.quantidadeFinal) <= Number(f.quantidadeInicial)) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantidadeFinal'],
        message: 'Qtd final deve ser maior que a inicial',
      });
    }
  });
export type FaixaPrecoEntrada = z.input<typeof faixaPrecoSchema>;

/** Faixas da mesma loja (nula = todas) não se sobrepõem: intervalos `[inicial, final)`. */
export function faixasSobrepostas(
  faixas: ReadonlyArray<{ lojaId: string | null; quantidadeInicial: string; quantidadeFinal: string | null }>,
): number[] {
  const ruins = new Set<number>();
  faixas.forEach((a, i) =>
    faixas.forEach((b, j) => {
      if (j <= i || a.lojaId !== b.lojaId) return;
      const fimA = a.quantidadeFinal === null ? Infinity : Number(a.quantidadeFinal);
      const fimB = b.quantidadeFinal === null ? Infinity : Number(b.quantidadeFinal);
      if (Number(a.quantidadeInicial) < fimB && Number(b.quantidadeInicial) < fimA) ruins.add(j);
    }),
  );
  return [...ruins];
}

export const alternativaComboSchema = z.object({
  id: idFilha,
  produtoId: z.uuid('Escolha o produto'),
  variacaoId: uuidOpcional,
  acrescimo: precoCampo.default('0'),
  ordem: z.coerce.number().int().min(0).max(9999).default(0),
  ativo: z.boolean().default(true),
});

export const componenteSchema = z.object({
  id: idFilha,
  tipo: z.enum(['kit', 'ficha_tecnica']),
  componenteId: z.uuid('Escolha o produto'),
  componenteVariacaoId: uuidOpcional,
  quantidade: quantidadePositiva,
  perdaPct: percentualOpcional.transform((v) => v ?? '0.0000'),
  rotuloPosicao: textoOpcional(40),
  permiteSubstituicao: z.boolean().default(false),
  ordem: z.coerce.number().int().min(0).max(9999).default(0),
  alternativas: z.array(alternativaComboSchema).max(30).default([]),
});
export type ComponenteEntrada = z.input<typeof componenteSchema>;

/** Tipo da relação (ERP 8.2.8; MD 3.6.9 `ck_produtos_relacionados_tipo`). */
export const TIPOS_RELACAO_PRODUTO = ['sugestao', 'substituto', 'acessorio'] as const;
export type TipoRelacaoProduto = (typeof TIPOS_RELACAO_PRODUTO)[number];
export const ROTULOS_TIPO_RELACAO: Record<TipoRelacaoProduto, string> = {
  sugestao: 'Sugestão',
  substituto: 'Substituto',
  acessorio: 'Acessório',
};

/**
 * Teto de relacionados vivos de um produto (ERP 8.2.8): vale para a lista do corpo e também para a inversa gravada no
 * outro produto (a API recusa a inversa que o levaria além dele; senão o outro não grava mais pelo formulário, que
 * manda a lista inteira).
 */
export const MAXIMO_RELACIONADOS = 50;

/**
 * Produto relacionado (ERP 8.2.8; F2-B12): a relação vale só neste sentido; `criarInversa` grava também a do outro
 * produto para este (mesmo tipo), quando ela ainda não existe. Remover daqui não remove a inversa: cada sentido é
 * uma linha do outro produto, que ele edita no próprio cadastro.
 */
export const relacionadoSchema = z.object({
  id: idFilha,
  relacionadoId: z.uuid('Escolha o produto'),
  tipo: z.enum(TIPOS_RELACAO_PRODUTO).default('sugestao'),
  ordem: z.coerce.number().int().min(0).max(9999).default(0),
  criarInversa: z.boolean().default(false),
});
export type RelacionadoEntrada = z.input<typeof relacionadoSchema>;

/** Teto de vínculos de fornecedor vivos de um produto (ERP 8.2.14; F2-B13). */
export const MAXIMO_FORNECEDORES_PRODUTO = 30;

/**
 * Vínculo produto × fornecedor (ERP 8.2.14; MD 3.6.9; F2-B13). `codigoFornecedor` é o `cProd` da NF-e do fornecedor,
 * gravado como veio (só sem os espaços das pontas): a vinculação da nota (F2-B20) compara o texto exato, e
 * (fornecedor, código) é único entre os produtos (`uq_produtos_fornecedores_codigo`). `fator` = quantas unidades do
 * produto vêm numa unidade de compra (CX → 24). `custoFornecedor` (D49) é digitado, na unidade do produto (a de
 * `precoCusto`), e só é lido e gravado com `produtos.ver_custo`; o último custo e a última compra vêm da compra
 * (recebimento e NF-e) e não entram aqui. `moverVinculo` responde ao 409 do código já ligado a outro produto: tira o
 * vínculo de lá e grava neste.
 */
export const fornecedorProdutoSchema = z.object({
  id: idFilha,
  fornecedorId: z.uuid('Escolha o fornecedor'),
  codigoFornecedor: textoOpcional(60),
  eanFornecedor: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\s/g, '') || null : v),
    z
      .string()
      .superRefine((v, ctx) => {
        if (!validarGtin(v))
          ctx.addIssue({
            code: 'custom',
            message: /^(\d{8}|\d{12,14})$/.test(v)
              ? 'Dígito verificador do GTIN inválido'
              : 'GTIN deve ter 8, 12, 13 ou 14 dígitos',
          });
      })
      .nullable()
      .default(null),
  ),
  unidadeCompra: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() || null : v),
    z.string().max(6, 'Até 6 caracteres').nullable().default(null),
  ),
  fator: quantidadePositiva.default('1'),
  custoFornecedor: precoOpcional,
  principal: z.boolean().default(false),
  moverVinculo: z.boolean().default(false),
});
export type FornecedorProdutoEntrada = z.input<typeof fornecedorProdutoSchema>;
export type FornecedorProduto = z.output<typeof fornecedorProdutoSchema>;

/** Chave de um vínculo dentro do produto: (fornecedor, código no fornecedor; sem código = ''). */
export const chaveFornecedorProduto = (f: { fornecedorId: string; codigoFornecedor: string | null }) =>
  `${f.fornecedorId.toLowerCase()}:${f.codigoFornecedor ?? ''}`;

/**
 * Tipos sem saldo próprio: combo (a venda baixa os componentes), serviço, produzido (a venda baixa os insumos da ficha
 * técnica, decisão 91) e, enquanto as variações estão travadas (D43), "Com variações" (o saldo é por variação). Não
 * têm o "Ajustar" do bloco Estoque (8.2.13), não entram no recebimento (13.3) e não têm o bloco Validade (8.2.12): sem
 * estoque próprio, sem lote. Uma lista só para o ERP e a API.
 */
export const TIPOS_SEM_SALDO_PROPRIO: readonly TipoProduto[] = [
  'kit',
  'servico',
  'produzido',
  'com_variacoes',
];

/**
 * Teto de lotes **novos ou alterados** numa gravação do produto, e de lotes excluídos (ERP 8.2.12; F2-B17). Os lotes
 * gravados que não mudam não vão no corpo nem contam: o recebimento cria lotes sem teto, e o lote com histórico não se
 * exclui (D57), então a lista do produto só cresce.
 */
export const MAXIMO_LOTES_PRODUTO = 200;

/**
 * Lote do bloco **Validade (Loja, Data, Lote)** (ERP 8.2.12; MD 3.6.9; F2-B17). `estoqueId` = o estoque vinculado da
 * loja escolhida (`lojas.estoque_id`); `null` = todas as lojas (o lote vale em qualquer estoque, como os que o
 * recebimento cria). O estoque é **imutável** depois de gravado: trocar = excluir e criar outro (a API devolve 422, e o
 * trigger `tg_produtos_lotes_filtro_imutavel` repete a regra). `lote` é gravado como veio, só sem os espaços das
 * pontas: o recebimento acha o lote pelo texto exato. O saldo por lote não entra aqui: vem do razão (`saldos_lote`),
 * somente leitura, em `GET /produtos/:id/saldos`.
 */
export const loteProdutoSchema = z
  .object({
    id: idFilha,
    estoqueId: uuidOpcional,
    lote: textoObrigatorio(30, 'Informe o lote'),
    validade: dataOpcionalValida,
    fabricacao: dataOpcionalValida,
    fornecedorId: uuidOpcional,
    ativo: z.boolean().default(true),
  })
  .superRefine((l, ctx) => {
    // `ck_produtos_lotes_datas`.
    if (l.fabricacao !== null && l.validade !== null && l.fabricacao > l.validade)
      ctx.addIssue({
        code: 'custom',
        path: ['fabricacao'],
        message: 'A fabricação não pode ser depois da validade',
      });
  });
export type LoteProdutoEntrada = z.input<typeof loteProdutoSchema>;
export type LoteProduto = z.output<typeof loteProdutoSchema>;

/** Chave de um lote dentro do produto (`uq_produtos_lotes`, sem a variação): (estoque; sem estoque = '', lote). */
export const chaveLoteProduto = (l: { estoqueId: string | null; lote: string }) =>
  `${l.estoqueId?.toLowerCase() ?? ''}:${l.lote}`;

// ---------------------------------------------------------------- Produto

const camposProduto = z.object({
  // Cabeçalho (8.2.1)
  nome: textoObrigatorio(120, 'Informe o nome').min(2, 'Mínimo de 2 caracteres'),
  tipo: z.enum(TIPOS_PRODUTO).default('simples'),
  ativo: z.boolean().default(true),
  codigoInterno: textoOpcional(30),
  unidadeId: z.uuid('Escolha a unidade'),
  permiteFracao: z.boolean().default(false),
  ncm: digitos(8, 'NCM com 8 dígitos'),
  cest: digitos(7, 'CEST com 7 dígitos'),
  precoCusto: precoCampo.default('0'),
  markupPct: decimal({ min: -100, max: 99_999, casas: 4, mensagem: 'Markup inválido' }).default('0'),
  precoVenda: precoCampo.default('0'),
  // Preços complementares (8.2.2)
  precoAtacado: precoOpcional,
  qtdMinimaAtacado: quantidadeOpcional,
  precoPromocional: precoOpcional,
  promocaoInicio: dataHoraOpcional,
  promocaoFim: dataHoraOpcional,
  precoMenuDigital: precoOpcional,
  precoIfood: precoOpcional,
  precoParcelado: precoOpcional,
  grupoPrecoQuantidadeId: uuidOpcional,
  // Ficha técnica (8.2.4)
  usaFichaTecnica: z.boolean().default(false),
  // Dimensões e peso (8.2.5)
  larguraCm: medidaOpcional(2),
  alturaCm: medidaOpcional(2),
  profundidadeCm: medidaOpcional(2),
  pesoG: medidaOpcional(3),
  pesoAbatimentoG: medidaOpcional(3),
  pesoPacoteKg: medidaOpcional(3),
  // Outras informações (8.2.6)
  localizacao: textoOpcional(40),
  qtdMinimaVenda: quantidadeOpcional,
  material: textoOpcional(60),
  comissaoPct: percentualOpcional,
  marcaId: uuidOpcional,
  categoriaPrincipalId: uuidOpcional,
  categorias: z.array(z.uuid()).max(50).default([]),
  solicitaPrecoPdv: z.boolean().default(false),
  solicitaLotePdv: z.boolean().default(false),
  generico: z.boolean().default(false),
  usaMenuDigital: z.boolean().default(false),
  insumo: z.boolean().default(false),
  reposicaoRodizio: z.boolean().default(false),
  usaTotem: z.boolean().default(false),
  maisVendido: z.boolean().default(false),
  descricaoCurta: textoOpcional(250),
  descricaoLonga: textoOpcional(20_000),
  controlaEstoque: z.boolean().default(true),
  idadeMinima: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1, 'Entre 1 e 99').max(99, 'Entre 1 e 99').nullable().default(null),
  ),
  vasilhameProdutoId: uuidOpcional,
  vasilhameQuantidade: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1, 'Ao menos 1').max(999).nullable().default(null),
  ),
  // Balança (8.2.13)
  balancaTipo: z.enum(['nao_usa', 'peso', 'unidade']).default('nao_usa'),
  balancaPlu: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1).max(999_999, 'PLU de 1 a 999999').nullable().default(null),
  ),
  balancaValidadeDias: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(0).max(3650).nullable().default(null),
  ),
  // Tributação (8.2.15)
  cfopVendaEstado: digitos(4, 'CFOP com 4 dígitos'),
  cfopVendaForaEstado: digitos(4, 'CFOP com 4 dígitos'),
  icmsSituacao: digitos([2, 3], 'CST (2 dígitos) ou CSOSN (3 dígitos)'),
  icmsOrigem: z.preprocess(
    vazioParaNulo,
    z
      .string()
      .regex(/^[0-8]$/, 'Origem de 0 a 8')
      .nullable()
      .default(null),
  ),
  icmsModalidadeBc: z.preprocess(
    vazioParaNulo,
    z
      .string()
      .regex(/^[0-3]$/, 'Modalidade de 0 a 3')
      .nullable()
      .default(null),
  ),
  icmsModalidadeBcst: z.preprocess(
    vazioParaNulo,
    z
      .string()
      .regex(/^[0-6]$/, 'Modalidade de 0 a 6')
      .nullable()
      .default(null),
  ),
  icmsAliquota: percentualOpcional,
  icmsReducaoBcPct: percentualOpcional,
  icmsMvaPct: opcional(decimal({ min: 0, max: 999, casas: 4, mensagem: 'MVA inválida' })),
  icmsAliquotaSt: percentualOpcional,
  fcpAliquota: percentualOpcional,
  fcpStAliquota: percentualOpcional,
  beneficioFiscalCodigo: textoOpcional(10),
  pisSituacao: digitos(2, 'CST com 2 dígitos'),
  cofinsSituacao: digitos(2, 'CST com 2 dígitos'),
  ipiSituacao: digitos(2, 'CST com 2 dígitos'),
  pisAliquota: percentualOpcional,
  cofinsAliquota: percentualOpcional,
  ipiAliquota: percentualOpcional,
  ipiEnquadramento: digitos(3, 'cEnq com 3 dígitos'),
  ibsCbsCst: digitos(3, 'CST com 3 dígitos'),
  ibsCbsClassificacao: digitos(6, 'cClassTrib com 6 dígitos'),
  servicoCodigoLc116: textoOpcional(5),
  // Filhas
  codigosBarras: z.array(codigoBarrasSchema).max(50).default([]),
  lojas: z.array(produtoLojaSchema).max(200).default([]),
  precosQuantidade: z.array(faixaPrecoSchema).max(100).default([]),
  componentes: z.array(componenteSchema).max(60).default([]),
  /**
   * Produtos relacionados (8.2.8; F2-B12). **Ausente = mantém os gravados**: a importação de planilha e o ERP de antes
   * do F2-B12 (aba aberta durante o deploy) não os conhecem e não podem apagá-los; o formulário novo manda sempre a
   * lista inteira (vazia = remove todos).
   */
  relacionados: z
    .array(relacionadoSchema)
    .max(MAXIMO_RELACIONADOS, `No máximo ${MAXIMO_RELACIONADOS} produtos relacionados`)
    .optional(),
  /**
   * Fornecedores (8.2.14; F2-B13). **Ausente = mantém os gravados**, como `relacionados`: a importação de planilha, o
   * ERP de antes desta versão e o formulário com o bloco escondido (`geral.produto_usa_fornecedores` desligada) não os
   * mandam e não podem apagar o vínculo aprendido na NF-e; o bloco visível manda a lista inteira.
   */
  fornecedores: z
    .array(fornecedorProdutoSchema)
    .max(MAXIMO_FORNECEDORES_PRODUTO, `No máximo ${MAXIMO_FORNECEDORES_PRODUTO} fornecedores`)
    .optional(),
  /**
   * Lotes do bloco Validade (8.2.12; F2-B17), **só os novos e os alterados**: a linha com `id` altera o lote gravado; a
   * sem `id` é nova ou, com a mesma (loja, lote) de um gravado, reaproveita-o. **O lote gravado que não vem fica como
   * está**, e ausente = nada muda: a importação de planilha e o ERP de antes desta versão não conhecem a lista, e os
   * lotes que o recebimento criou não podem sumir. Excluir é explícito, em `lotesExcluidos`. Assim o teto vale para o
   * que muda numa gravação, não para os lotes do produto, que só crescem (o recebimento cria lotes, e o lote com
   * histórico não se exclui, D57).
   */
  lotes: z
    .array(loteProdutoSchema)
    .max(MAXIMO_LOTES_PRODUTO, `No máximo ${MAXIMO_LOTES_PRODUTO} lotes alterados numa gravação`)
    .optional(),
  /**
   * Ids dos lotes gravados a excluir (8.2.12; F2-B17; exclusão lógica). O id que já não está entre os lotes vivos do
   * produto que o usuário vê (excluído por outro, de um estoque fora dos permitidos) é ignorado. O lote com saldo, com
   * movimento ou num acerto em rascunho é recusado (422 em `lotes`): inativa-se.
   */
  lotesExcluidos: z
    .array(z.uuid())
    .max(MAXIMO_LOTES_PRODUTO, `No máximo ${MAXIMO_LOTES_PRODUTO} lotes excluídos numa gravação`)
    .optional(),
  /** `geral.ean_duplicado = 'avisar'`: o ERP confirma e reenvia com `true` (ERP 8.2, "EAN duplicado"). */
  confirmarEanDuplicado: z.boolean().default(false),
});

type Produto = z.output<typeof camposProduto>;

/** Regras do formulário que não dependem do banco (as demais ficam na API). */
function regrasProduto(p: Produto, ctx: z.RefinementCtx) {
  const erro = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const kit = p.tipo === 'kit';

  // Preço de venda > 0 para vendáveis (matéria-prima não é vendida no PDV).
  if (p.tipo !== 'materia_prima' && !(Number(p.precoVenda) > 0)) {
    erro(['precoVenda'], 'Informe o preço de venda');
  }
  if (p.promocaoInicio && p.promocaoFim && Date.parse(p.promocaoFim) <= Date.parse(p.promocaoInicio)) {
    erro(['promocaoFim'], 'O fim deve ser depois do início');
  }
  if (p.qtdMinimaAtacado !== null && p.precoAtacado === null) {
    erro(['precoAtacado'], 'Informe o preço de atacado da quantidade mínima');
  }
  if (p.tipo === 'servico' && p.controlaEstoque) erro(['controlaEstoque'], 'Serviço não controla estoque');
  if (p.tipo === 'produzido' && !p.usaFichaTecnica)
    erro(['usaFichaTecnica'], 'Produzido exige a ficha técnica');

  // Códigos de barras (8.2.1, 8.2.3).
  const principais = p.codigosBarras.filter((c) => c.principal);
  if (principais.length > 1) erro(['codigosBarras'], 'Só um código principal');
  const vistos = new Map<string, number>();
  p.codigosBarras.forEach((c, i) => {
    if (vistos.has(c.codigo)) erro(['codigosBarras', i, 'codigo'], 'Código repetido neste produto');
    vistos.set(c.codigo, i);
  });

  // Lojas e faixas (8.2.9, 8.2.10).
  const lojas = new Set<string>();
  p.lojas.forEach((l, i) => {
    if (lojas.has(l.lojaId)) erro(['lojas', i, 'lojaId'], 'Loja repetida');
    lojas.add(l.lojaId);
  });
  for (const i of faixasSobrepostas(p.precosQuantidade)) {
    erro(['precosQuantidade', i, 'quantidadeInicial'], 'Faixa sobreposta a outra da mesma loja');
  }

  // Combo (8.2.17) e ficha técnica (8.2.4).
  const posicoes = p.componentes.filter((c) => c.tipo === 'kit');
  const insumos = p.componentes.filter((c) => c.tipo === 'ficha_tecnica');
  // Combo inativo pode ficar sem posições (importação do Nuvem3 sem a composição, decisão 95 da API); ativo não.
  if (kit && posicoes.length === 0 && p.ativo)
    erro(['componentes'], 'O combo precisa de ao menos uma posição (ou fique inativo até cadastrá-las)');
  // Combo é vendido inteiro: meio combo baixaria meia posição de cada componente.
  if (kit && p.permiteFracao) erro(['permiteFracao'], 'Combo não permite fração');
  if (!kit && posicoes.length) erro(['componentes'], 'Só o tipo Combo / kit tem posições');
  if (insumos.length && !p.usaFichaTecnica)
    erro(['usaFichaTecnica'], 'Ligue a ficha técnica para ter insumos');
  if (p.usaFichaTecnica && insumos.length === 0)
    erro(['componentes'], 'A ficha técnica precisa de ao menos um insumo');
  if (kit && p.usaFichaTecnica) erro(['usaFichaTecnica'], 'Combo não usa ficha técnica');
  const insumosVistos = new Set<string>();
  p.componentes.forEach((c, i) => {
    if (c.tipo === 'ficha_tecnica') {
      const chave = `${c.componenteId}:${c.componenteVariacaoId ?? ''}`;
      if (insumosVistos.has(chave)) erro(['componentes', i, 'componenteId'], 'Insumo repetido');
      insumosVistos.add(chave);
      if (c.alternativas.length)
        erro(['componentes', i, 'alternativas'], 'Ficha técnica não tem alternativas');
      if (c.permiteSubstituicao || c.rotuloPosicao)
        erro(['componentes', i, 'permiteSubstituicao'], 'Só posições de combo');
      return;
    }
    if (Number(c.perdaPct) !== 0) erro(['componentes', i, 'perdaPct'], 'Perda só na ficha técnica');
    if (c.permiteSubstituicao && c.alternativas.length === 0) {
      erro(['componentes', i, 'alternativas'], 'Inclua ao menos uma alternativa ou desligue "Permite troca"');
    }
    if (!c.permiteSubstituicao && c.alternativas.length) {
      erro(['componentes', i, 'permiteSubstituicao'], 'Ligue "Permite troca" para ter alternativas');
    }
    const alt = new Set<string>();
    c.alternativas.forEach((a, j) => {
      const chave = `${a.produtoId}:${a.variacaoId ?? ''}`;
      if (a.produtoId === c.componenteId && (a.variacaoId ?? null) === (c.componenteVariacaoId ?? null)) {
        erro(
          ['componentes', i, 'alternativas', j, 'produtoId'],
          'A alternativa não pode ser o produto padrão',
        );
      }
      if (alt.has(chave)) erro(['componentes', i, 'alternativas', j, 'produtoId'], 'Alternativa repetida');
      alt.add(chave);
    });
  });

  // Vasilhame (8.2.6).
  if ((p.vasilhameProdutoId === null) !== (p.vasilhameQuantidade === null)) {
    erro(
      [p.vasilhameProdutoId ? 'vasilhameQuantidade' : 'vasilhameProdutoId'],
      'Informe o casco e a quantidade',
    );
  }
  if (p.tipo === 'vasilhame' && p.vasilhameProdutoId) {
    erro(['vasilhameProdutoId'], 'O próprio casco não tem vasilhame vinculado');
  }

  // Grupo de preço (8.2.9, 8.10).
  if (p.grupoPrecoQuantidadeId) {
    if (!TIPOS_GRUPO_PRECO.includes(p.tipo))
      erro(['grupoPrecoQuantidadeId'], 'Só Simples, Com variações ou Produzido');
    else if (p.permiteFracao)
      erro(['grupoPrecoQuantidadeId'], 'Produto fracionado não entra em grupo de preço');
  }

  // Relacionados (8.2.8): um por produto e tipo (`uq_produtos_relacionados`).
  const relacoes = new Map<string, number>();
  p.relacionados?.forEach((r, i) => {
    const chave = `${r.relacionadoId.toLowerCase()}:${r.tipo}`;
    const anterior = relacoes.get(chave);
    if (anterior !== undefined)
      erro(['relacionados', i, 'relacionadoId'], `Produto repetido com o mesmo tipo (linha ${anterior + 1})`);
    else relacoes.set(chave, i);
  });

  // Fornecedores (8.2.14): um vínculo por (fornecedor, código) e um principal só.
  const vinculos = new Map<string, number>();
  p.fornecedores?.forEach((f, i) => {
    const chave = chaveFornecedorProduto(f);
    const anterior = vinculos.get(chave);
    if (anterior !== undefined)
      erro(
        ['fornecedores', i, f.codigoFornecedor === null ? 'fornecedorId' : 'codigoFornecedor'],
        f.codigoFornecedor === null
          ? `Fornecedor repetido sem código (linha ${anterior + 1}): informe o código no fornecedor`
          : `Código repetido para o mesmo fornecedor (linha ${anterior + 1})`,
      );
    else vinculos.set(chave, i);
  });
  if ((p.fornecedores?.filter((f) => f.principal).length ?? 0) > 1)
    erro(['fornecedores'], 'Marque um fornecedor principal só');

  // Lotes (8.2.12): um por (loja, lote) (`uq_produtos_lotes`) e uma linha por lote gravado; o excluído não vem
  // alterado; os tipos sem saldo próprio não têm lote. A colisão com um gravado que não veio é da API.
  const lotes = new Map<string, number>();
  const idsLote = new Map<string, number>();
  p.lotes?.forEach((l, i) => {
    const chave = chaveLoteProduto(l);
    const anterior = lotes.get(chave);
    if (anterior !== undefined)
      erro(['lotes', i, 'lote'], `Lote repetido na mesma loja (linha ${anterior + 1})`);
    else lotes.set(chave, i);
    if (l.id === null) return;
    const mesmoId = idsLote.get(l.id.toLowerCase());
    if (mesmoId !== undefined) erro(['lotes', i, 'id'], `Lote repetido (linha ${mesmoId + 1})`);
    else idsLote.set(l.id.toLowerCase(), i);
  });
  p.lotesExcluidos?.forEach((id, i) => {
    const linha = idsLote.get(id.toLowerCase());
    if (linha !== undefined)
      erro(
        ['lotesExcluidos', i],
        `O lote da linha ${linha + 1} não pode ser alterado e excluído na mesma gravação`,
      );
  });
  if (TIPOS_SEM_SALDO_PROPRIO.includes(p.tipo) && p.lotes?.length)
    erro(['lotes'], `${ROTULOS_TIPO_PRODUTO[p.tipo]} não tem estoque próprio: não tem lote`);

  // Categorias.
  if (p.categoriaPrincipalId && p.categorias.length && !p.categorias.includes(p.categoriaPrincipalId)) {
    erro(['categoriaPrincipalId'], 'A principal precisa estar entre as categorias marcadas');
  }

  // Tributação (MD 3.6.3, regras de emissão) — não exigida no combo (os componentes saem na NFC-e).
  if (p.cfopVendaEstado && !p.cfopVendaEstado.startsWith('5'))
    erro(['cfopVendaEstado'], 'CFOP dentro do estado começa com 5');
  if (p.cfopVendaForaEstado && !p.cfopVendaForaEstado.startsWith('6'))
    erro(['cfopVendaForaEstado'], 'CFOP fora do estado começa com 6');
  const cst = p.icmsSituacao;
  if (p.cfopVendaEstado === '5405' && cst && !(CST_ST_RETIDO as readonly string[]).includes(cst)) {
    erro(['icmsSituacao'], 'CFOP 5405 exige CST 60 ou CSOSN 500');
  }
  if (
    (p.cfopVendaEstado === '5101' || p.cfopVendaEstado === '5102') &&
    cst &&
    (CST_ST_RETIDO as readonly string[]).includes(cst)
  ) {
    erro(['cfopVendaEstado'], 'CST 60/CSOSN 500 usa o CFOP 5405');
  }
  if (!kit && cst && (CST_COM_ST as readonly string[]).includes(cst) && !p.cest) {
    erro(['cest'], 'CEST obrigatório com substituição tributária');
  }
}

export const criarProdutoSchema = camposProduto.superRefine(regrasProduto);
export type CriarProdutoEntrada = z.input<typeof criarProdutoSchema>;
export type CriarProduto = z.output<typeof criarProdutoSchema>;
export const alterarProdutoSchema = camposProduto
  .extend({ versao: z.number().int() })
  .superRefine((p, ctx) => regrasProduto(p, ctx));
export type AlterarProdutoEntrada = z.input<typeof alterarProdutoSchema>;

/** O que o cadastro rápido de produto pede (ERP 13.3 "Cadastrar novo produto"; Fase 2, F2-B16). */
export interface ValoresProdutoRapido {
  nome: string;
  /** EAN digitado (os espaços saem). */
  ean: string;
  unidadeId: string | null;
  /** O "Permite fração" da unidade escolhida (o produto nasce com ele). */
  unidadePermiteFracao: boolean;
  ncm: string | null;
  marcaId: string | null;
  categoriaId: string | null;
  precoVenda: string;
  /** O custo que quem abre já conhece (o item da NF-e, F2-B19); só vai com `produtos.ver_custo`. */
  precoCusto?: string | null;
  /** O CEST do item da NF-e (F2-B20), só gravado (nada fiscal na Fase 2). */
  cest?: string | null;
}

/**
 * Corpo do `POST /produtos` do cadastro rápido (`CadastroRapidoProduto` do ERP): um **Simples** com a tributação vazia
 * (nada fiscal na Fase 2). Função pura, para o modal e o teste de integração do critério de pronto do F2-B16 mandarem
 * o mesmo corpo.
 */
export function corpoProdutoRapido(
  v: ValoresProdutoRapido,
  confirmarEanDuplicado = false,
): CriarProdutoEntrada {
  const ean = v.ean.replace(/\s/g, '');
  return {
    nome: v.nome,
    tipo: 'simples',
    unidadeId: v.unidadeId ?? '',
    permiteFracao: v.unidadePermiteFracao,
    ncm: v.ncm,
    ...(v.cest ? { cest: v.cest } : {}),
    marcaId: v.marcaId,
    categoriaPrincipalId: v.categoriaId,
    categorias: v.categoriaId ? [v.categoriaId] : [],
    precoVenda: v.precoVenda,
    ...(v.precoCusto ? { precoCusto: v.precoCusto } : {}),
    codigosBarras: ean ? [{ codigo: ean, principal: true }] : [],
    confirmarEanDuplicado,
  };
}

// ---------------------------------------------------------------- Listagem (8.1)

export const SITUACOES_CADASTRO_PRODUTO = [
  'todos',
  'sem_preco',
  'sem_ncm',
  'sem_codigo_barras',
  'ean_duplicado',
  'tipo_sem_suporte',
] as const;
export const ROTULOS_SITUACAO_CADASTRO: Record<(typeof SITUACOES_CADASTRO_PRODUTO)[number], string> = {
  todos: 'Todos',
  sem_preco: 'Sem preço',
  sem_ncm: 'Sem NCM ou NCM inválido',
  sem_codigo_barras: 'Sem código de barras',
  ean_duplicado: 'EAN duplicado',
  // Legado dos tipos travados (`CHAVES_TIPO_PRODUTO` com a chave desligada; F2-B1).
  tipo_sem_suporte: 'Tipo sem suporte',
};

export const ORDENACOES_PRODUTOS = [
  'codigo',
  'nome',
  'codigo_interno',
  'ean',
  'marca',
  'localizacao',
  'preco_custo',
  'preco_venda',
] as const;

export const filtroProdutosSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(120).optional(),
  codigo: z.coerce.number().int().min(1).optional(),
  codigoInterno: z.string().trim().max(30).optional(),
  codigoBarras: z.string().trim().max(30).optional(),
  ncm: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(z.string().max(8))
    .optional(),
  marcaId: z.uuid().optional(),
  categoriaId: z.uuid().optional(),
  situacao: z.enum(['ativos', 'inativos', 'todos']).default('ativos'),
  local: z.enum(['todos', 'pdv', 'totem', 'menu_digital']).default('todos'),
  tipo: z.enum(TIPOS_PRODUTO).optional(),
  situacaoCadastro: z.enum(SITUACOES_CADASTRO_PRODUTO).default('todos'),
});
export type FiltroProdutos = z.infer<typeof filtroProdutosSchema>;

export interface ProdutoResumo {
  id: string;
  codigo: number;
  nome: string;
  tipo: TipoProduto;
  ativo: boolean;
  codigoInterno: string | null;
  ean: string | null;
  marcaNome: string | null;
  localizacao: string | null;
  unidadeSigla: string;
  /** `null` sem `produtos.ver_custo`. */
  precoCusto: string | null;
  precoVenda: string;
  versao: number;
}

/** Busca resumida para seletores (componente do combo, casco, membros do grupo). */
export const buscaProdutosSchema = z.object({
  termo: z.string().trim().max(120).default(''),
  tipos: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.enum(TIPOS_PRODUTO)).optional(),
  ),
  ids: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.uuid()).max(100).optional(),
  ),
  incluirInativos: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limite: z.coerce.number().int().min(1).max(50).default(20),
});

export interface ProdutoOpcao {
  id: string;
  codigo: number;
  nome: string;
  tipo: TipoProduto;
  ativo: boolean;
  unidadeId: string;
  unidadeSigla: string;
  permiteFracao: boolean;
  controlaEstoque: boolean;
  ean: string | null;
  precoVenda: string;
  precoAtacado: string | null;
  qtdMinimaAtacado: string | null;
  /** `null` sem `produtos.ver_custo`. */
  precoCusto: string | null;
  /** Custo médio do razão (MD 3.6.3); `null` sem `produtos.ver_custo`. */
  custoMedio?: string | null;
  grupoPrecoQuantidadeId: string | null;
}

// ---------------------------------------------------------------- Detalhe

export interface CodigoBarrasDetalhe {
  id: string;
  codigo: string;
  tipo: 'gtin' | 'interno';
  principal: boolean;
  descricao: string | null;
  unidadeId: string | null;
  fator: string;
  preco: string | null;
  usaVenda: boolean;
  usaCompra: boolean;
}

export interface AlternativaDetalhe {
  id: string;
  produtoId: string;
  variacaoId: string | null;
  acrescimo: string;
  ordem: number;
  ativo: boolean;
  produto: ProdutoOpcao;
}

export interface ComponenteDetalhe {
  id: string;
  tipo: 'kit' | 'ficha_tecnica';
  componenteId: string;
  componenteVariacaoId: string | null;
  quantidade: string;
  perdaPct: string;
  rotuloPosicao: string | null;
  permiteSubstituicao: boolean;
  ordem: number;
  componente: ProdutoOpcao;
  alternativas: AlternativaDetalhe[];
}

export interface RelacionadoDetalhe {
  id: string;
  relacionadoId: string;
  tipo: TipoRelacaoProduto;
  ordem: number;
  /** Há a relação no outro sentido (o relacionado aponta para este produto com o mesmo tipo). */
  inversa: boolean;
  produto: ProdutoOpcao;
}

/**
 * Vínculo com o fornecedor no detalhe (8.2.14; F2-B13). `custoFornecedor` e `ultimoCusto` são `null` sem
 * `produtos.ver_custo`. Os três custos ficam na unidade do produto. `fornecedor` vem sem o documento
 * (`cpfCnpj: null`) e com `excluida` quando a pessoa foi excluída depois do vínculo.
 */
export interface FornecedorProdutoDetalhe {
  id: string;
  fornecedorId: string;
  fornecedor: PessoaOpcao;
  codigoFornecedor: string | null;
  eanFornecedor: string | null;
  unidadeCompra: string | null;
  fator: string;
  custoFornecedor: string | null;
  ultimoCusto: string | null;
  /** `AAAA-MM-DD`. */
  ultimaCompraEm: string | null;
  principal: boolean;
}

/** Um código no fornecedor já ligado a outro produto (`uq_produtos_fornecedores_codigo`). */
export interface ConflitoVinculoFornecedor {
  /** Linha da lista `fornecedores` do corpo. */
  linha: number;
  fornecedorId: string;
  codigoFornecedor: string;
  produto: { id: string; codigo: number; nome: string };
}

/**
 * `detalhes` do 409 `CONFLITO` da gravação dos fornecedores do produto: o primeiro conflito (o da mensagem) e, em
 * `conflitos`, todos eles, na ordem das linhas do corpo.
 */
export interface DetalhesConflitoFornecedor extends ConflitoVinculoFornecedor {
  conflitos: ConflitoVinculoFornecedor[];
}

/**
 * Lote no detalhe (8.2.12; F2-B17): só os vivos da unidade (sem variação) e de estoque permitido ao usuário (ou sem
 * estoque). `lojaNome` = a loja cujo estoque vinculado é `estoqueId` (`null` sem estoque ou com um estoque sem loja,
 * como um depósito antigo: aí a grade mostra `estoqueNome`). `temMovimento` = há movimento de estoque com o lote (ou um
 * acerto em rascunho que o usa): o lote não pode ser excluído, só inativado.
 */
export interface LoteProdutoDetalhe {
  id: string;
  estoqueId: string | null;
  estoqueNome: string | null;
  lojaNome: string | null;
  lote: string;
  /** `AAAA-MM-DD`. */
  validade: string | null;
  /** `AAAA-MM-DD`. */
  fabricacao: string | null;
  fornecedorId: string | null;
  /** Sem o documento, como em `fornecedores`; `excluida` quando a pessoa foi excluída depois. */
  fornecedor: PessoaOpcao | null;
  ativo: boolean;
  temMovimento: boolean;
}

export interface GrupoPrecoVinculado {
  id: string;
  codigo: number;
  nome: string;
  modoPreco: 'produto' | 'grupo';
  ativo: boolean;
  faixas: Array<{
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }>;
}

export interface ProdutoDetalhe
  extends
    MetadadosRegistro,
    Omit<
      CriarProduto,
      | 'confirmarEanDuplicado'
      | 'codigosBarras'
      | 'componentes'
      | 'precosQuantidade'
      | 'relacionados'
      | 'fornecedores'
      | 'lotes'
      | 'lotesExcluidos'
      | 'precoCusto'
      | 'markupPct'
    > {
  codigo: number;
  /** `null` sem `produtos.ver_custo`. */
  precoCusto: string | null;
  custoMedio: string | null;
  markupPct: string | null;
  /** EAN principal (campo virtual, MD 3.6.3). */
  ean: string | null;
  unidadeSigla: string;
  codigosBarras: CodigoBarrasDetalhe[];
  precosQuantidade: Array<{
    id: string;
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }>;
  componentes: ComponenteDetalhe[];
  relacionados: RelacionadoDetalhe[];
  /** Sempre vem (mesmo com `geral.produto_usa_fornecedores` desligada): o ERP decide se mostra o bloco. */
  fornecedores: FornecedorProdutoDetalhe[];
  /** Lotes do bloco Validade (8.2.12; F2-B17), na ordem FEFO (validade, sem validade por último, lote). */
  lotes: LoteProdutoDetalhe[];
  grupoPreco: GrupoPrecoVinculado | null;
  vasilhame: ProdutoOpcao | null;
  /** Combos e fichas técnicas ativos que usam este produto (padrão ou alternativa) — bloqueiam a exclusão. */
  usadoEm: Array<{ id: string; codigo: number; nome: string; tipo: TipoProduto }>;
  /** Avisos que não impedem a gravação (componente do combo sem NCM etc.). */
  avisos: string[];
  /**
   * Avisos do combo por componente (ERP 8.2.17), para a tela juntar num só alerta: `fiscal` = impede a venda em
   * loja NFC-e; os demais deixam o combo invendável ou distorcem o rateio da NFC-e em qualquer loja.
   */
  avisosCombo: AvisoComboComponente[];
  temMovimento: boolean;
}

/** Saldo por estoque × tipo (8.2.11) ou, no combo, os combos montáveis por estoque das lojas (8.2.17). */
export interface SaldosProduto {
  combo: boolean;
  saldos: Array<{
    estoqueId: string;
    estoqueNome: string;
    tipoEstoqueId: string;
    tipoEstoqueNome: string;
    vendavel: boolean;
    quantidade: string;
    /**
     * "Em trânsito" (F2-B26): enviado para este estoque × tipo e ainda não recebido (as transferências `em_transito`).
     * Não está em nenhum saldo; a linha aparece mesmo sem saldo lançado no destino. `'0'` sem nada a caminho.
     */
    emTransito: string;
    /**
     * "Divergência a tratar" (F2-B26): a diferença recebida a menor e ainda não tratada das transferências que saíram
     * deste estoque × tipo (a origem: o retorno ou a perda são lançados nela). Pendência separada: não conta como em
     * trânsito nem como saldo. `'0'` sem pendência.
     */
    divergenciaATratar: string;
    /** `null` sem `produtos.ver_custo`. */
    custoMedio: string | null;
    ultimaEntradaEm: string | null;
    ultimaSaidaEm: string | null;
  }>;
  montaveis: Array<{
    estoqueId: string;
    estoqueNome: string;
    /** `null` = sem limite (nenhuma posição controla estoque). */
    quantidade: number | null;
    limitadoPor: string | null;
  }>;
  /**
   * Saldo de cada lote por estoque e tipo (8.2.12; F2-B17), somente leitura: `saldos_lote`, mantido pelo razão (o mesmo
   * que desce ao PDV, que recebe só o tipo vendável do estoque da loja). Só as linhas ≠ 0 e dos estoques permitidos.
   */
  lotes: Array<{
    loteId: string;
    estoqueId: string;
    estoqueNome: string;
    tipoEstoqueId: string;
    tipoEstoqueNome: string;
    vendavel: boolean;
    quantidade: string;
  }>;
}

export interface VerificacaoEan {
  codigo: string;
  valido: boolean;
  modo: 'bloquear' | 'avisar';
  duplicados: Array<{ id: string; codigo: number; nome: string }>;
}

/** `GET /produtos/tipos-habilitados` (F2-B1): tipos que o formulário oferece na criação (`tiposProdutoHabilitados`). */
export interface TiposProdutoHabilitados {
  tipos: TipoProduto[];
  /**
   * `geral.produto_usa_fornecedores` (F2-B13): mostra o bloco Fornecedores no formulário. Vem na mesma consulta das
   * chaves do cadastro para o formulário não depender de `configuracoes.ver`; ausente (API antiga) = desligada.
   */
  usaFornecedores?: boolean;
}

// ---------------------------------------------------------------- Grupos de preço por quantidade (8.10)

export const MODOS_PRECO_GRUPO = ['produto', 'grupo'] as const;
export const ROTULOS_MODO_PRECO_GRUPO: Record<(typeof MODOS_PRECO_GRUPO)[number], string> = {
  produto: 'Atacado/faixas de cada produto',
  grupo: 'Faixas do grupo',
};

export const filtroGruposPrecoSchema = paginacaoQuerySchema.extend({
  nome: z.string().trim().max(60).optional(),
  modoPreco: z.enum(MODOS_PRECO_GRUPO).optional(),
  situacao: z.enum(['ativos', 'inativos', 'todos']).default('ativos'),
});

const camposGrupoPreco = z.object({
  nome: textoObrigatorio(60, 'Informe o nome'),
  modoPreco: z.enum(MODOS_PRECO_GRUPO).default('produto'),
  ativo: z.boolean().default(true),
  faixas: z.array(faixaPrecoSchema).max(50).default([]),
  /** Membros (grava `produtos.grupo_preco_quantidade_id`). */
  produtos: z.array(z.uuid()).max(2000).default([]),
  /** Confirma mover produtos que estão em outro grupo (ERP 8.10). */
  confirmarMover: z.boolean().default(false),
});

function regrasGrupoPreco(g: z.output<typeof camposGrupoPreco>, ctx: z.RefinementCtx) {
  if (g.modoPreco === 'grupo' && g.faixas.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['faixas'],
      message: 'O modo "Faixas do grupo" exige ao menos uma faixa',
    });
  }
  for (const i of faixasSobrepostas(g.faixas)) {
    ctx.addIssue({
      code: 'custom',
      path: ['faixas', i, 'quantidadeInicial'],
      message: 'Faixa sobreposta a outra da mesma loja',
    });
  }
  if (new Set(g.produtos).size !== g.produtos.length) {
    ctx.addIssue({ code: 'custom', path: ['produtos'], message: 'Produto repetido' });
  }
}

export const criarGrupoPrecoSchema = camposGrupoPreco.superRefine(regrasGrupoPreco);
export type CriarGrupoPrecoEntrada = z.input<typeof criarGrupoPrecoSchema>;
export const alterarGrupoPrecoSchema = camposGrupoPreco
  .extend({ versao: z.number().int() })
  .superRefine((g, ctx) => regrasGrupoPreco(g, ctx));

export interface GrupoPrecoResumo {
  id: string;
  codigo: number;
  nome: string;
  modoPreco: 'produto' | 'grupo';
  ativo: boolean;
  produtos: number;
  /** "12+ R$ 2,99; 24+ R$ 2,79" (faixas de loja nula primeiro). */
  faixasResumo: string;
  versao: number;
}

export interface GrupoPrecoDetalhe extends MetadadosRegistro {
  codigo: number;
  nome: string;
  modoPreco: 'produto' | 'grupo';
  ativo: boolean;
  faixas: Array<{
    id: string;
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }>;
  produtos: ProdutoOpcao[];
  /**
   * Preços próprios dos membros para o "Simular" (ERP 8.10) rodar a mesma regra do PDV (11.3, 11.3.1): preço por
   * loja, promoção e faixas por quantidade do próprio produto (só das lojas visíveis ao usuário).
   */
  precosMembros: PrecosMembroGrupo[];
}

export interface PrecosMembroGrupo {
  produtoId: string;
  precoPromocional: string | null;
  promocaoInicio: string | null;
  promocaoFim: string | null;
  lojas: Array<{ lojaId: string; precoVenda: string | null }>;
  faixas: Array<{
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }>;
}

/** Promoção vigente no instante (PDV `PromocaoVigenteEm`): preço > 0 e dentro de início/fim (vazios = sempre). */
export function promocaoVigente(
  p: { precoPromocional: string | null; promocaoInicio: string | null; promocaoFim: string | null },
  instante: Date = new Date(),
): boolean {
  if (!(Number(p.precoPromocional ?? 0) > 0)) return false;
  if (p.promocaoInicio && instante < new Date(p.promocaoInicio)) return false;
  if (p.promocaoFim && instante > new Date(p.promocaoFim)) return false;
  return true;
}

// ---------------------------------------------------------------- Restrições de horário de venda (8.9)

const hora = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Hora no formato HH:MM')
  .transform((v) => (v.length === 5 ? `${v}:00` : v));

export const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

export const filtroRestricoesHorarioSchema = paginacaoQuerySchema.extend({
  descricao: z.string().trim().max(100).optional(),
  lojaId: z.uuid().optional(),
  situacao: z.enum(['ativos', 'inativos', 'todos']).default('ativos'),
});

const camposRestricao = z.object({
  descricao: textoObrigatorio(100, 'Informe a descrição'),
  lojaId: uuidOpcional,
  categoriaId: uuidOpcional,
  idadeMinimaProduto: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(1).max(99).nullable().default(null),
  ),
  diasSemana: z.preprocess(
    (v) => (Array.isArray(v) && v.length === 0 ? null : v),
    z
      .array(z.coerce.number().int().min(0).max(6))
      .max(7)
      .transform((d) => [...new Set(d)].sort((a, b) => a - b))
      .nullable()
      .default(null),
  ),
  horaInicio: hora,
  horaFim: hora,
  dataEspecifica: z.preprocess(
    vazioParaNulo,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
      .nullable()
      .default(null),
  ),
  ativo: z.boolean().default(true),
});

function regrasRestricao(r: z.output<typeof camposRestricao>, ctx: z.RefinementCtx) {
  if (!r.categoriaId && r.idadeMinimaProduto === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['categoriaId'],
      message: 'Informe a categoria ou a idade mínima do produto',
    });
  }
  if (r.horaInicio === r.horaFim) {
    ctx.addIssue({ code: 'custom', path: ['horaFim'], message: 'O fim deve ser diferente do início' });
  }
}

export const criarRestricaoHorarioSchema = camposRestricao.superRefine(regrasRestricao);
export type CriarRestricaoHorarioEntrada = z.input<typeof criarRestricaoHorarioSchema>;
/** `loja_id` é imutável (MD 6.4 regra 2): a alteração não o recebe. */
export const alterarRestricaoHorarioSchema = camposRestricao
  .omit({ lojaId: true })
  .extend({ versao: z.number().int() })
  .superRefine((r, ctx) => regrasRestricao({ ...r, lojaId: null }, ctx));

export interface RestricaoHorarioResumo {
  id: string;
  descricao: string;
  lojaId: string | null;
  lojaNome: string | null;
  categoriaId: string | null;
  categoriaNome: string | null;
  idadeMinimaProduto: number | null;
  diasSemana: number[] | null;
  horaInicio: string;
  horaFim: string;
  dataEspecifica: string | null;
  ativo: boolean;
  versao: number;
}

export type RestricaoHorarioDetalhe = RestricaoHorarioResumo & MetadadosRegistro;

// ---------------------------------------------------------------- Referências usadas no formulário

export interface UnidadeMedida {
  id: string;
  sigla: string;
  descricao: string;
  permiteFracao: boolean;
}

export interface NcmOpcao {
  codigo: string;
  descricao: string;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
}

export interface CfopOpcao {
  codigo: string;
  descricao: string;
}
