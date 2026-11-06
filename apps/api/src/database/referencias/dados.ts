/**
 * Referências nacionais carregadas pelo provisionamento e por `db:referencias` (MD 3.4, 7.2).
 * Fase 0: UFs e municípios completos (IBGE, arquivos ao lado); CFOPs só os usados pelos grupos e conversões padrão
 * (a tabela oficial completa entra com a fase fiscal); meios de pagamento conforme a NT vigente; bancos em destaque.
 * Fase 1A: NCM completo (`ncms.csv`, Siscomex), `parametros_fiscais_uf` por UF (`uf/<UF>/parametros-fiscais.json`) e
 * países (só o Brasil até a tabela BACEN completa entrar com a NF-e).
 */

/** Tabela BACEN de países: só o Brasil por enquanto (README › Decisões de implementação). */
export const PAISES = [{ codigoBacen: '1058', nome: 'Brasil' }] as const;

export const MEIOS_PAGAMENTO_FISCAIS = [
  { codigo: '01', descricao: 'Dinheiro', exigeDescricao: false, ativo: true },
  { codigo: '02', descricao: 'Cheque', exigeDescricao: false, ativo: true },
  { codigo: '03', descricao: 'Cartão de Crédito', exigeDescricao: false, ativo: true },
  { codigo: '04', descricao: 'Cartão de Débito', exigeDescricao: false, ativo: true },
  { codigo: '05', descricao: 'Crédito Loja', exigeDescricao: false, ativo: true },
  { codigo: '10', descricao: 'Vale Alimentação', exigeDescricao: false, ativo: true },
  { codigo: '11', descricao: 'Vale Refeição', exigeDescricao: false, ativo: true },
  { codigo: '12', descricao: 'Vale Presente', exigeDescricao: false, ativo: true },
  { codigo: '13', descricao: 'Vale Combustível', exigeDescricao: false, ativo: true },
  { codigo: '14', descricao: 'Duplicata Mercantil', exigeDescricao: false, ativo: false },
  { codigo: '15', descricao: 'Boleto Bancário', exigeDescricao: false, ativo: true },
  { codigo: '16', descricao: 'Depósito Bancário', exigeDescricao: false, ativo: true },
  { codigo: '17', descricao: 'Pagamento Instantâneo (PIX) – Dinâmico', exigeDescricao: false, ativo: true },
  { codigo: '18', descricao: 'Transferência bancária, Carteira Digital', exigeDescricao: false, ativo: true },
  {
    codigo: '19',
    descricao: 'Programa de fidelidade, Cashback, Crédito Virtual',
    exigeDescricao: false,
    ativo: true,
  },
  { codigo: '20', descricao: 'Pagamento Instantâneo (PIX) – Estático', exigeDescricao: false, ativo: true },
  { codigo: '90', descricao: 'Sem pagamento', exigeDescricao: false, ativo: true },
  { codigo: '99', descricao: 'Outros', exigeDescricao: true, ativo: true },
] as const;

export const BANCOS_DESTAQUE = [
  {
    codigo: '001',
    ispb: '00000000',
    nome: 'Banco do Brasil S.A.',
    nomeCurto: 'Banco do Brasil',
    destaque: 1,
  },
  {
    codigo: '033',
    ispb: '90400888',
    nome: 'Banco Santander (Brasil) S.A.',
    nomeCurto: 'Santander',
    destaque: 2,
  },
  { codigo: '104', ispb: '00360305', nome: 'Caixa Econômica Federal', nomeCurto: 'Caixa', destaque: 3 },
  { codigo: '237', ispb: '60746948', nome: 'Banco Bradesco S.A.', nomeCurto: 'Bradesco', destaque: 4 },
  { codigo: '341', ispb: '60701190', nome: 'Itaú Unibanco S.A.', nomeCurto: 'Itaú', destaque: 5 },
  { codigo: '077', ispb: '00416968', nome: 'Banco Inter S.A.', nomeCurto: 'Inter', destaque: 6 },
  { codigo: '260', ispb: '18236120', nome: 'Nu Pagamentos S.A.', nomeCurto: 'Nubank', destaque: 7 },
  { codigo: '336', ispb: '31872495', nome: 'Banco C6 S.A.', nomeCurto: 'C6 Bank', destaque: 8 },
  {
    codigo: '748',
    ispb: '01181521',
    nome: 'Banco Cooperativo Sicredi S.A.',
    nomeCurto: 'Sicredi',
    destaque: 9,
  },
  {
    codigo: '756',
    ispb: '02038232',
    nome: 'Banco Cooperativo do Brasil S.A.',
    nomeCurto: 'Sicoob',
    destaque: 10,
  },
] as const;

const C = (codigo: string, descricao: string) => {
  const primeiro = Number(codigo[0]);
  return {
    codigo,
    descricao,
    tipo: primeiro <= 3 ? 'entrada' : 'saida',
    abrangencia: [1, 5].includes(primeiro)
      ? 'estadual'
      : [2, 6].includes(primeiro)
        ? 'interestadual'
        : 'exterior',
  } as const;
};

const COMPRA = 'Compra para comercialização';
const COMPRA_ST =
  'Compra para comercialização em operação com mercadoria sujeita ao regime de substituição tributária';
const DEV_VENDA = 'Devolução de venda de mercadoria adquirida ou recebida de terceiros';
const DEV_VENDA_ST = `${DEV_VENDA}, em operação com mercadoria sujeita ao regime de substituição tributária`;
const TRANSF = 'Transferência para comercialização';
const TRANSF_ST =
  'Transferência para comercialização em operação com mercadoria sujeita ao regime de substituição tributária';
const VENDA = 'Venda de mercadoria adquirida ou recebida de terceiros';
const VENDA_ST_SUBST = `${VENDA} em operação com mercadoria sujeita ao regime de substituição tributária, na condição de contribuinte substituto`;
const VENDA_ST_SUBSTITUIDO = `${VENDA} em operação com mercadoria sujeita ao regime de substituição tributária, na condição de contribuinte substituído`;
const TRANSF_SAIDA = 'Transferência de mercadoria adquirida ou recebida de terceiros';
const TRANSF_SAIDA_ST = `${TRANSF_SAIDA} em operação com mercadoria sujeita ao regime de substituição tributária`;
const DEV_COMPRA = 'Devolução de compra para comercialização';
const DEV_COMPRA_ST = `${DEV_COMPRA} em operação com mercadoria sujeita ao regime de substituição tributária`;

export const CFOPS_BASE = [
  C('1102', COMPRA),
  C('1152', TRANSF),
  C('1202', DEV_VENDA),
  C('1403', COMPRA_ST),
  C('1409', TRANSF_ST),
  C('1411', DEV_VENDA_ST),
  C('1556', 'Compra de material para uso ou consumo'),
  C('1910', 'Entrada de bonificação, doação ou brinde'),
  C('1949', 'Outra entrada de mercadoria ou prestação de serviço não especificada'),
  C('2102', COMPRA),
  C('2152', TRANSF),
  C('2202', DEV_VENDA),
  C('2403', COMPRA_ST),
  C('2409', TRANSF_ST),
  C('2411', DEV_VENDA_ST),
  C('2910', 'Entrada de bonificação, doação ou brinde'),
  C('5101', 'Venda de produção do estabelecimento'),
  C('5102', VENDA),
  C('5152', TRANSF_SAIDA),
  C('5202', DEV_COMPRA),
  C('5403', VENDA_ST_SUBST),
  C('5405', VENDA_ST_SUBSTITUIDO),
  C('5409', TRANSF_SAIDA_ST),
  C('5411', DEV_COMPRA_ST),
  C('5904', 'Remessa para venda fora do estabelecimento'),
  C('5910', 'Remessa em bonificação, doação ou brinde'),
  C('5927', 'Lançamento efetuado a título de baixa de estoque decorrente de perda, roubo ou deterioração'),
  C(
    '5929',
    'Lançamento efetuado em decorrência de emissão de documento fiscal relativo a operação ou prestação também registrada em equipamento Emissor de Cupom Fiscal – ECF',
  ),
  C('5949', 'Outra saída de mercadoria ou prestação de serviço não especificado'),
  C('6102', VENDA),
  C('6108', `${VENDA}, destinada a não contribuinte`),
  C('6152', TRANSF_SAIDA),
  C('6202', DEV_COMPRA),
  C('6403', VENDA_ST_SUBST),
  C(
    '6404',
    'Venda de mercadoria sujeita ao regime de substituição tributária, cujo imposto já tenha sido retido anteriormente',
  ),
  C('6409', TRANSF_SAIDA_ST),
  C('6411', DEV_COMPRA_ST),
  C('6904', 'Remessa para venda fora do estabelecimento'),
  C('6910', 'Remessa em bonificação, doação ou brinde'),
  C('6949', 'Outra saída de mercadoria ou prestação de serviço não especificado'),
] as const;
