/**
 * Perfis criados no seed de toda empresa (MD 7.9, ERP 11.3). As permissões `pdv.*` seguem as colunas da matriz do
 * PDV 31.2 (Operador, Supervisor, Gerente; o Encarregado tem a coluna do Supervisor e o cancelamento da venda paga);
 * as marcadas "L" ficam de fora e pedem liberação no caixa. Perfil novo aqui chega às empresas já criadas pelo
 * pós-migração (`aplicarSeedEmpresa`), que acrescenta só o que falta e incrementa `permissoes_versao` de quem o usa.
 */
import { PERMISSOES } from './permissoes.js';

export interface PerfilPadrao {
  chaveSistema: string;
  nome: string;
  descricao: string;
  permissoes: readonly string[];
  /**
   * Descrições que este perfil já teve no seed. O pós-migração troca pela atual a descrição do perfil de sistema que
   * ainda está igual a uma delas (a empresa não mexeu); a que a empresa reescreveu fica como está.
   */
  descricoesAnteriores?: readonly string[];
}

const todas = PERMISSOES.map((p) => p.chave);
const pdv = todas.filter((c) => c.startsWith('pdv.'));
const comPrefixo = (...prefixos: string[]) => todas.filter((c) => prefixos.some((p) => c.startsWith(p)));

/**
 * Só Master/suporte no seed (ERP 11.4); a empresa pode concedê-la depois. `estoques.todos` (decisão 149 do README da
 * API): os perfis veem só os estoques permitidos de cada usuário, e a virada (migração 0019) já os preencheu.
 */
const SOMENTE_MASTER = new Set(['pdv.config.fiscal', 'estoques.todos']);

const PDV_OPERADOR = [
  'pdv.acesso.entrar',
  'pdv.caixa.abrir',
  'pdv.caixa.fechar',
  'pdv.caixa.sangria',
  'pdv.caixa.reforco',
  'pdv.venda.vender',
  'pdv.venda.cancelar_item',
  'pdv.venda.desconto_item',
  'pdv.venda.desconto_total',
  'pdv.venda.acrescimo',
  'pdv.venda.consultar',
  'pdv.crediario.receber',
  'pdv.documento.reimprimir',
  'pdv.cliente.cadastro_rapido',
  'pdv.orcamento.importar',
  'pdv.orcamento.criar',
  'pdv.comanda.operar',
  'pdv.pedido.operar',
  'pdv.fiscal.retransmitir',
  'pdv.relatorio.resumo_diario',
];

const PDV_SUPERVISOR = [
  ...PDV_OPERADOR,
  'pdv.supervisor',
  'pdv.aplicativo.sair',
  'pdv.usuario.desbloquear',
  'pdv.caixa.ver_calculado_fechamento',
  'pdv.caixa.cancelar_movimento',
  'pdv.caixa.ignorar_limite_sangria',
  'pdv.caixa.operar_de_outro',
  'pdv.gaveta.abrir_avulsa',
  'pdv.venda.cancelar_venda_aberta',
  'pdv.venda.alterar_preco',
  'pdv.venda.tipo_preco_atacado',
  'pdv.venda.vender_sem_estoque',
  'pdv.venda.peso_manual',
  'pdv.venda.abaixo_qtd_minima',
  'pdv.venda.exceder_limite_valor',
  'pdv.pagamento.forma_com_senha',
  'pdv.pagamento.confirmar_pix_manual',
  'pdv.crediario.desconto_juros',
  'pdv.troca.realizar',
  'pdv.vale.emitir',
  'pdv.comanda.cancelar',
  'pdv.pedido.cancelar',
  'pdv.taxa_servico.remover',
  'pdv.tef.cancelar',
  // Central do PDV (decisão 66 do README do PDV): consulta e diagnóstico do próprio caixa, sem configurar nada.
  'pdv.venda.consultar_historico',
  'pdv.caixa.consultar_fechamentos',
  'pdv.diagnostico.ver',
  'pdv.diagnostico.pacote_suporte',
];

/**
 * PC-8 do dono (04/11/2026): "Supervisor + vendas/caixas antigos + diagnóstico + pacote de suporte; sem histórico de uso
 * e sem parâmetros". Como o Supervisor já tem as 4 consultas da Central, o Encarregado parte do Supervisor: libera item,
 * venda em andamento, sangria acima do limite, cancelamento de sangria/reforço, PIX manual, fechar o caixa de outro. Na
 * resposta de 05/11/2026 o dono acrescentou o **cancelamento da venda paga** (diferente do Supervisor; decisão 78 do
 * README do PDV): `pdv.venda.cancelar_venda_finalizada`, que o caixa só usa na sessão de caixa aberta — venda de caixa
 * FECHADO continua sem cancelamento no PDV (D23, PC-1), e essa permissão não existe. O desconto acima do limite vem do
 * "Limite de desconto %" do usuário (PDV 12.3), não do perfil. Sem acesso ao ERP.
 */
const PDV_ENCARREGADO = [...PDV_SUPERVISOR, 'pdv.venda.cancelar_venda_finalizada'];

const PDV_GERENTE = pdv.filter((c) => !SOMENTE_MASTER.has(c));

const ERP_GERENTE = [
  ...comPrefixo(
    'dashboard.',
    'pessoas.',
    'produtos.',
    'categorias.',
    'marcas.',
    'restricoes_horario.',
    'grupos_preco.',
    'formas_pagamento.',
    'terminais.',
    'estoques.',
    'estoque_saldos.',
    'estoque_acertos.',
    'recebimentos.',
    'notas_entrada.',
    'tipos_estoque.',
    'transferencias.',
    'orcamentos.',
    'movimentos_caixa.',
    'vendas.',
    'relatorios.',
    'fechamentos_caixa.',
  ),
  'configuracoes.ver',
  'configuracoes.editar',
  'empresa.ver',
  'lojas.ver',
  'lojas.criar',
  'lojas.editar',
];

const ERP_FINANCEIRO = [
  ...comPrefixo(
    'contas_pagar.',
    'contas_receber.',
    'contas_correntes.',
    'plano_contas.',
    'fechamentos_caixa.',
  ),
  'dashboard.ver',
  'dashboard.ver_financeiro',
  'pessoas.ver',
  'formas_pagamento.ver',
  'movimentos_caixa.ver',
  'vendas.ver',
  'fiscal.download_xml',
  'relatorios.financeiro_geral',
  'relatorios.fechamento_caixa',
  'relatorios.sangria_reforco',
  'relatorios.vendas_forma_pagamento',
  'relatorios.recibos_cupons',
  'relatorios.exportar',
];

const ERP_ESTOQUISTA = [
  ...comPrefixo('estoque_acertos.', 'recebimentos.', 'notas_entrada.', 'transferencias.'),
  'dashboard.ver',
  'pessoas.ver',
  // Decisões do dono (05/11/2026): o Estoquista cadastra o fornecedor no recebimento (cadastro rápido) e também faz o
  // cadastro completo de pessoas (`POST /pessoas`). Sem `pessoas.editar`, `pessoas.excluir`, `pessoas.importar` nem
  // `pessoas.editar_credito`: o cadastro completo é criar. Nas empresas já criadas, o seed idempotente do pós-migração
  // (`db:migrate:empresas`) acrescenta as duas ao perfil (README da API › 165 e 168).
  'pessoas.criar',
  'pessoas.criar_fornecedor',
  'produtos.ver',
  'produtos.criar',
  'produtos.editar',
  'produtos.exportar',
  'produtos.importar',
  'categorias.ver',
  'marcas.ver',
  'grupos_preco.ver',
  'restricoes_horario.ver',
  'estoques.ver',
  'estoque_saldos.ver',
  'tipos_estoque.ver',
  'relatorios.estoque_atual',
  'relatorios.movimentacao_estoque',
  'relatorios.produtos_geral',
];

const ERP_VENDEDOR = [
  'dashboard.ver',
  'produtos.ver',
  'pessoas.ver',
  'orcamentos.ver',
  'orcamentos.criar',
  'orcamentos.editar',
  'orcamentos.converter',
  'vendas.ver',
  'vendas.criar',
  'relatorios.comissao',
];

export const PERFIS_PADRAO: readonly PerfilPadrao[] = Object.freeze([
  {
    chaveSistema: 'administrador',
    nome: 'Administrador',
    descricao: 'Tudo, exceto ser Master',
    permissoes: todas.filter((c) => !SOMENTE_MASTER.has(c)),
  },
  {
    chaveSistema: 'gerente',
    nome: 'Gerente',
    descricao:
      'Cadastros (sem usuários e configurações fiscais), estoque, vendas, relatórios e conferência de caixa',
    permissoes: [...new Set([...ERP_GERENTE, ...PDV_GERENTE])].filter((c) => !SOMENTE_MASTER.has(c)),
  },
  {
    chaveSistema: 'financeiro',
    nome: 'Financeiro',
    descricao: 'Financeiro completo, relatórios financeiros, download de XML e consulta de vendas',
    permissoes: [...new Set(ERP_FINANCEIRO)],
  },
  {
    chaveSistema: 'estoquista',
    nome: 'Estoquista',
    descricao:
      'Produtos (sem preço), acertos, recebimentos, NF-e de entrada, transferências e relatórios de estoque',
    permissoes: [...new Set(ERP_ESTOQUISTA)],
  },
  {
    chaveSistema: 'vendedor',
    nome: 'Vendedor',
    descricao: 'Orçamentos, vendas no ERP, consulta de produtos e pessoas, comissão própria',
    permissoes: ERP_VENDEDOR,
  },
  {
    chaveSistema: 'operador_caixa',
    nome: 'Operador de caixa',
    descricao: 'Só PDV: coluna "Operador" da matriz de permissões do PDV',
    permissoes: PDV_OPERADOR,
  },
  {
    chaveSistema: 'supervisor_caixa',
    nome: 'Supervisor de caixa',
    descricao: 'Operador + coluna "Supervisor" da matriz do PDV, incluindo liberar ações',
    permissoes: [...new Set(PDV_SUPERVISOR)],
  },
  {
    chaveSistema: 'encarregado',
    nome: 'Encarregado',
    descricao:
      'Perfil do sistema, só PDV: Supervisor de caixa + cancelar a venda paga do caixa aberto (libera ações no caixa); para quem libera na loja sem gerente',
    permissoes: [...new Set(PDV_ENCARREGADO)],
    // A do G1, antes da resposta do dono de 05/11/2026 (decisão 78 do README do PDV).
    descricoesAnteriores: [
      'Perfil do sistema, só PDV: as mesmas permissões do Supervisor de caixa (libera ações no caixa); para quem libera na loja sem gerente',
    ],
  },
]);
