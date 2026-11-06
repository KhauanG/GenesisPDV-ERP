/** Dados iniciais de toda empresa nova (MD 7.4, 7.6, 7.7, 7.10–7.12). */

export const TIPOS_ESTOQUE_PADRAO = [
  { nome: 'Disponível', vendavel: true, padrao: true, chaveSistema: 'disponivel' },
  { nome: 'Avaria', vendavel: false, padrao: false, chaveSistema: 'avaria' },
  { nome: 'Vencido', vendavel: false, padrao: false, chaveSistema: 'vencido' },
  { nome: 'Uso e consumo', vendavel: false, padrao: false, chaveSistema: 'uso_consumo' },
  { nome: 'Vasilhame vazio', vendavel: false, padrao: false, chaveSistema: 'vasilhame_vazio' },
] as const;

/** MD 7.12. */
export const ATRIBUTOS_VARIACAO_PADRAO = ['Tamanho', 'Sabor', 'Cor', 'Volume'] as const;

export const CONTA_CAIXA_INTERNO = {
  descricao: 'Caixa interno',
  tipo: 'caixa',
  chaveSistema: 'caixa_interno',
} as const;

export interface FormaPagamentoSeed {
  ordem: number;
  descricao: string;
  tipoForma: string;
  meioPagamentoFiscal: string;
  integracao: string;
  descricaoFiscal?: string;
  /** Chave do plano de contas de destino; padrão `vendas_pdv` (MD 7.7). */
  planoContas?: string;
  flags: Partial<
    Record<
      | 'lancaQuitada'
      | 'permiteTroco'
      | 'abrirGaveta'
      | 'sempreZeradoPdv'
      | 'ativa'
      | 'usaPdv'
      | 'geraQrcodePix'
      | 'exigeDadosPos'
      | 'permiteParcelar'
      | 'restringeIdadeMinima'
      | 'exigePessoa'
      | 'aPrazo'
      | 'creditoFuncionario'
      | 'valeCompra'
      | 'eBoleto',
      true
    >
  >;
  parcelasMaximo?: number;
  diasRecebimento?: number;
}

/**
 * "Flags ligadas (as demais desligadas)": tudo que não está em `flags` é gravado como `false`. Vale Alimentação e Vale
 * Refeição nascem inativas (O9a, dono, 1C: a Ice Beer não aceita VA/VR no piloto; ativar na tela se passar a aceitar).
 */
export const FORMAS_PAGAMENTO_PADRAO: readonly FormaPagamentoSeed[] = [
  {
    ordem: 1,
    descricao: 'Dinheiro',
    tipoForma: 'dinheiro',
    meioPagamentoFiscal: '01',
    integracao: 'nenhuma',
    flags: {
      lancaQuitada: true,
      permiteTroco: true,
      abrirGaveta: true,
      sempreZeradoPdv: true,
      ativa: true,
      usaPdv: true,
    },
  },
  {
    ordem: 2,
    descricao: 'PIX',
    tipoForma: 'pix',
    meioPagamentoFiscal: '20',
    integracao: 'pix_estatico',
    flags: { lancaQuitada: true, geraQrcodePix: true, ativa: true, usaPdv: true },
  },
  {
    ordem: 3,
    descricao: 'Cartão de Débito',
    tipoForma: 'cartao_debito',
    meioPagamentoFiscal: '04',
    integracao: 'pos_externo',
    flags: { exigeDadosPos: true, ativa: true, usaPdv: true },
    diasRecebimento: 1,
  },
  {
    ordem: 4,
    descricao: 'Cartão de Crédito',
    tipoForma: 'cartao_credito',
    meioPagamentoFiscal: '03',
    integracao: 'pos_externo',
    flags: { exigeDadosPos: true, ativa: true, usaPdv: true },
    diasRecebimento: 30,
  },
  {
    ordem: 5,
    descricao: 'Cartão de Crédito Parcelado',
    tipoForma: 'cartao_credito',
    meioPagamentoFiscal: '03',
    integracao: 'pos_externo',
    flags: { exigeDadosPos: true, permiteParcelar: true, ativa: true, usaPdv: true },
    parcelasMaximo: 12,
    diasRecebimento: 30,
  },
  {
    ordem: 6,
    descricao: 'Vale Alimentação',
    tipoForma: 'vale_alimentacao',
    meioPagamentoFiscal: '10',
    integracao: 'pos_externo',
    flags: { exigeDadosPos: true, restringeIdadeMinima: true, usaPdv: true },
    diasRecebimento: 30,
  },
  {
    ordem: 7,
    descricao: 'Vale Refeição',
    tipoForma: 'vale_refeicao',
    meioPagamentoFiscal: '11',
    integracao: 'pos_externo',
    flags: { exigeDadosPos: true, restringeIdadeMinima: true, usaPdv: true },
    diasRecebimento: 30,
  },
  {
    ordem: 8,
    descricao: 'Caderneta',
    tipoForma: 'crediario',
    meioPagamentoFiscal: '05',
    integracao: 'nenhuma',
    flags: { exigePessoa: true, aPrazo: true, permiteParcelar: true, ativa: true, usaPdv: true },
    parcelasMaximo: 3,
  },
  {
    ordem: 9,
    descricao: 'Crédito Funcionário',
    tipoForma: 'credito_funcionario',
    meioPagamentoFiscal: '05',
    integracao: 'nenhuma',
    flags: { exigePessoa: true, creditoFuncionario: true, ativa: true, usaPdv: true },
  },
  {
    ordem: 10,
    descricao: 'Vale Compra',
    tipoForma: 'vale',
    meioPagamentoFiscal: '99',
    integracao: 'nenhuma',
    descricaoFiscal: 'Vale-troca',
    flags: { valeCompra: true, lancaQuitada: true, ativa: true, usaPdv: true },
  },
  {
    ordem: 11,
    descricao: 'Boleto',
    tipoForma: 'boleto',
    meioPagamentoFiscal: '15',
    integracao: 'nenhuma',
    flags: { eBoleto: true, exigePessoa: true, permiteParcelar: true, ativa: true },
    parcelasMaximo: 12,
  },
  {
    ordem: 12,
    descricao: 'Avarias',
    tipoForma: 'consumo_interno',
    meioPagamentoFiscal: '90',
    integracao: 'nenhuma',
    planoContas: 'avarias_perdas',
    flags: { lancaQuitada: true, usaPdv: true },
  },
  {
    ordem: 13,
    descricao: 'Baixas de utilização em loja',
    tipoForma: 'consumo_interno',
    meioPagamentoFiscal: '90',
    integracao: 'nenhuma',
    planoContas: 'uso_consumo',
    flags: { lancaQuitada: true, usaPdv: true },
  },
];

export const UNIDADES_MEDIDA_PADRAO = [
  { sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
  { sigla: 'PC', descricao: 'Peça', permiteFracao: false },
  { sigla: 'CX', descricao: 'Caixa', permiteFracao: false },
  { sigla: 'FD', descricao: 'Fardo', permiteFracao: false },
  { sigla: 'PCT', descricao: 'Pacote', permiteFracao: false },
  { sigla: 'DZ', descricao: 'Dúzia', permiteFracao: false },
  { sigla: 'KG', descricao: 'Quilograma', permiteFracao: true },
  { sigla: 'G', descricao: 'Grama', permiteFracao: true },
  { sigla: 'L', descricao: 'Litro', permiteFracao: true },
  { sigla: 'ML', descricao: 'Mililitro', permiteFracao: true },
  { sigla: 'M', descricao: 'Metro', permiteFracao: true },
  { sigla: 'CM', descricao: 'Centímetro', permiteFracao: true },
  { sigla: 'M2', descricao: 'Metro quadrado', permiteFracao: true },
  { sigla: 'M3', descricao: 'Metro cúbico', permiteFracao: true },
  { sigla: 'PAR', descricao: 'Par', permiteFracao: false },
  { sigla: 'CJ', descricao: 'Conjunto', permiteFracao: false },
  { sigla: 'KIT', descricao: 'Kit', permiteFracao: false },
] as const;

/** Grupos de CFOP pré-marcados (MD 7.11); o primeiro de cada grupo (exceto `global`) é o padrão. */
export const CFOPS_GRUPOS_PADRAO: ReadonlyArray<{ grupo: string; cfops: string[]; comPadrao: boolean }> = [
  { grupo: 'venda_estado', cfops: ['5102', '5101', '5405'], comPadrao: true },
  { grupo: 'venda_fora_estado', cfops: ['6102', '6108', '6404', '6403'], comPadrao: true },
  { grupo: 'remessa_vendedor_estado', cfops: ['5904'], comPadrao: true },
  { grupo: 'remessa_vendedor_fora_estado', cfops: ['6904'], comPadrao: true },
  {
    grupo: 'global',
    cfops: [
      '1102',
      '1202',
      '1403',
      '1411',
      '1152',
      '1409',
      '1556',
      '1910',
      '1949',
      '2102',
      '2202',
      '2403',
      '2411',
      '5152',
      '5403',
      '5409',
      '5202',
      '5411',
      '5910',
      '5927',
      '5929',
      '5949',
      '6152',
      '6409',
      '6202',
      '6411',
      '6910',
      '6949',
    ],
    comPadrao: false,
  },
];

const CUPOM_CABECALHO =
  '{{loja.nome_fantasia}}\n{{loja.razao_social}}\nCNPJ {{loja.cnpj}} IE {{loja.ie}}\n{{loja.endereco}}';
const CUPOM_RODAPE = '{{loja.frase_rodape_cupom}}\nObrigado pela preferência!';

/** Um template padrão de cada tipo (MD 7.12); o conteúdo é editável pela empresa em Configurações. */
export const TEMPLATES_PADRAO = [
  { tipo: 'cupom_cabecalho', nome: 'Cabeçalho do cupom', formato: 'texto', conteudo: CUPOM_CABECALHO },
  { tipo: 'cupom_rodape', nome: 'Rodapé do cupom', formato: 'texto', conteudo: CUPOM_RODAPE },
  {
    tipo: 'recibo_venda',
    nome: 'Recibo de venda',
    formato: 'texto',
    conteudo:
      '{{configuracao.vendas.titulo_recibo}}\nVenda {{venda.numero_exibicao}} – {{venda.finalizada_em}}\n{{venda.itens}}\nTotal: {{venda.total}}',
  },
  {
    tipo: 'orcamento_logado',
    nome: 'Orçamento padrão',
    formato: 'html',
    conteudo:
      '<h1>Orçamento {{orcamento.codigo}}</h1><p>Cliente: {{cliente.nome}}</p>{{orcamento.itens}}<p>Total: {{orcamento.total}}</p>',
  },
  {
    tipo: 'orcamento_nao_logado',
    nome: 'Orçamento (link público)',
    formato: 'html',
    conteudo: '<h1>Orçamento {{orcamento.codigo}}</h1>{{orcamento.itens}}<p>Total: {{orcamento.total}}</p>',
  },
  {
    tipo: 'email_cliente',
    nome: 'E-mail ao cliente',
    formato: 'html',
    assunto: '{{empresa.nome_fantasia}}',
    conteudo: '<p>Olá, {{cliente.nome}}.</p><p>{{mensagem}}</p>',
  },
  {
    tipo: 'recibo_receber',
    nome: 'Recibo de recebimento',
    formato: 'html',
    conteudo:
      '<p>Recebemos de {{pessoa.nome}} a quantia de {{baixa.valor}} referente a {{conta.descricao}}.</p>',
  },
  {
    tipo: 'recibo_pagar',
    nome: 'Recibo de pagamento',
    formato: 'html',
    conteudo:
      '<p>Pagamos a {{pessoa.nome}} a quantia de {{baixa.valor}} referente a {{conta.descricao}}.</p>',
  },
  {
    tipo: 'vale_compra',
    nome: 'Vale compra',
    formato: 'texto',
    conteudo:
      'VALE COMPRA {{vale.codigo}}\nValor: {{vale.valor}}\nValidade: {{vale.validade}}\n{{configuracao.vendas.vale_rodape}}',
  },
] as const;
