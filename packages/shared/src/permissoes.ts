/**
 * Catálogo único de permissões (ERP 11.4, PDV 31.2, MD 3.3.3). Fonte da tabela `permissoes` de cada empresa:
 * o seed faz upsert por `chave` e marca como excluída a chave que sair daqui.
 *
 * Formato: ERP `recurso.acao`; PDV `pdv.<area>.<acao>` (única exceção de dois segmentos: `pdv.supervisor`).
 */
import type { ModuloPermissao } from './enums.js';

export interface DefinicaoPermissao {
  chave: string;
  modulo: ModuloPermissao;
  grupo: string;
  descricao: string;
  ordem: number;
  /** `false` = ação "sem liberação": nem um supervisor presente pode liberar (PDV 31.2). */
  permiteLiberacao: boolean;
}

type Entrada = [chave: string, descricao: string, opcoes?: { semLiberacao?: boolean }];

const ROTULOS_ACAO: Record<string, string> = {
  ver: 'Ver',
  criar: 'Criar',
  editar: 'Editar',
  excluir: 'Excluir',
  exportar: 'Exportar',
};

/** Expande `recurso` + ações padrão (`ver/criar/editar/excluir/exportar`) em entradas do catálogo. */
function crud(recurso: string, nome: string, acoes: string[]): Entrada[] {
  return acoes.map((acao) => [`${recurso}.${acao}`, `${nome}: ${ROTULOS_ACAO[acao] ?? acao}`]);
}

const GRUPOS: Array<{ grupo: string; modulo: ModuloPermissao; itens: Entrada[] }> = [
  {
    grupo: 'Início',
    modulo: 'erp',
    itens: [
      ['dashboard.ver', 'Ver o dashboard'],
      ['dashboard.ver_financeiro', 'Ver os cards financeiros do dashboard'],
    ],
  },
  {
    grupo: 'Pessoas',
    modulo: 'erp',
    itens: [
      ...crud('pessoas', 'Pessoas', ['ver', 'criar', 'editar', 'excluir', 'exportar']),
      ['pessoas.importar', 'Pessoas: Importar'],
      ['pessoas.anonimizar', 'Pessoas: Anonimizar (LGPD)'],
      ['pessoas.editar_credito', 'Pessoas: Alterar limite de compras e bloqueio'],
      // Só o cadastro rápido de fornecedor (`POST /pessoas/fornecedor-rapido`: documento, nome, IE, telefone e endereço,
      // ou a categoria Fornecedor para quem já existe), sem o cadastro completo do `POST /pessoas` (categorias como
      // Funcionário, desconto, senha de compra a prazo) nem a importação de clientes (README da API › decisão 165).
      ['pessoas.criar_fornecedor', 'Pessoas: Cadastrar fornecedor (cadastro rápido)'],
    ],
  },
  {
    grupo: 'Produtos',
    modulo: 'erp',
    itens: [
      ...crud('produtos', 'Produtos', ['ver', 'criar', 'editar', 'excluir', 'exportar']),
      ['produtos.importar', 'Produtos: Importar'],
      ['produtos.cadastro_massa', 'Produtos: Cadastro em massa'],
      ['produtos.ver_custo', 'Produtos: Ver custo'],
      ['produtos.alterar_preco', 'Produtos: Alterar preço'],
      ['categorias.ver', 'Categorias: Ver'],
      ['categorias.editar', 'Categorias: Editar'],
      ...crud('marcas', 'Marcas', ['ver', 'criar', 'editar', 'excluir']),
      ['restricoes_horario.ver', 'Restrições de horário de venda: Ver'],
      ['restricoes_horario.editar', 'Restrições de horário de venda: Editar'],
      ['grupos_preco.ver', 'Grupos de preço por quantidade (mix): Ver'],
      ['grupos_preco.editar', 'Grupos de preço por quantidade (mix): Editar'],
    ],
  },
  {
    grupo: 'Cadastros',
    modulo: 'erp',
    itens: [
      ['configuracoes.ver', 'Configurações: Ver'],
      ['configuracoes.editar', 'Configurações: Editar'],
      ['configuracoes.editar_fiscal', 'Configurações: Editar fiscal e tributação'],
      ['configuracoes.editar_integracoes', 'Configurações: Editar integrações'],
      ['empresa.ver', 'Empresa: Ver'],
      ['empresa.editar', 'Empresa: Editar'],
      ...crud('formas_pagamento', 'Formas de pagamento', ['ver', 'criar', 'editar', 'excluir']),
      ...crud('lojas', 'Lojas', ['ver', 'criar', 'editar', 'excluir']),
      ['lojas.certificado', 'Lojas: Gerenciar certificado digital'],
      ['lojas.editar_pix', 'Lojas: Alterar o recebedor do PIX (chave, nome e cidade)'],
      ...crud('usuarios', 'Usuários', ['ver', 'criar', 'editar', 'excluir']),
      ['usuarios.permissoes', 'Usuários: Alterar permissões'],
      ['usuarios.redefinir_senha', 'Usuários: Redefinir senha'],
      ['usuarios.ver_dados_rh', 'Usuários: Ver dados de RH (salário)'],
      ...crud('perfis', 'Perfis de acesso', ['ver', 'criar', 'editar', 'excluir']),
      ['terminais.ver', 'PDVs/Terminais: Ver'],
      ['terminais.ativar', 'PDVs/Terminais: Gerar código de ativação'],
      ['terminais.revogar', 'PDVs/Terminais: Revogar (inclui terminal perdido/roubado)'],
      [
        'terminais.gerenciar',
        'PDVs/Terminais: Gerenciar (ressincronizar, renovar token, logs, recuperação, fila de erros)',
      ],
    ],
  },
  {
    grupo: 'Estoque',
    modulo: 'erp',
    itens: [
      ...crud('estoques', 'Locais de estoque', ['ver', 'criar', 'editar', 'excluir']),
      // Dispensa a lista de estoques permitidos do usuário (ERP 2.1; README da API › decisão 149). Só o Master no seed.
      [
        'estoques.todos',
        'Locais de estoque: Ver e movimentar todos (ignora os estoques permitidos do usuário)',
      ],
      ['estoque_saldos.ver', 'Saldos de estoque: Ver'],
      ['estoque_acertos.ver', 'Acertos de estoque: Ver'],
      ['estoque_acertos.criar', 'Acertos de estoque: Criar'],
      ['estoque_acertos.estornar', 'Acertos de estoque: Estornar'],
      ...crud('recebimentos', 'Recebimentos', ['ver', 'criar', 'editar']),
      ['recebimentos.movimentar', 'Recebimentos: Movimentar estoque'],
      ['recebimentos.estornar', 'Recebimentos: Estornar'],
      ['notas_entrada.ver', 'NF-e de entrada: Ver'],
      ['notas_entrada.importar', 'NF-e de entrada: Importar XML'],
      ['notas_entrada.manifestar', 'NF-e de entrada: Manifestar'],
      ['notas_entrada.movimentar', 'NF-e de entrada: Movimentar estoque'],
      ['notas_entrada.estornar', 'NF-e de entrada: Estornar'],
      ...crud('tipos_estoque', 'Tipos de estoque', ['ver', 'criar', 'editar', 'excluir']),
      ['transferencias.ver', 'Transferências: Ver'],
      ['transferencias.criar', 'Transferências: Criar'],
      ['transferencias.enviar', 'Transferências: Enviar'],
      ['transferencias.receber', 'Transferências: Receber'],
      ['transferencias.cancelar', 'Transferências: Cancelar'],
    ],
  },
  {
    grupo: 'Financeiro',
    modulo: 'erp',
    itens: [
      ...crud('contas_pagar', 'Contas a pagar', ['ver', 'criar', 'editar', 'excluir', 'exportar']),
      ['contas_pagar.baixar', 'Contas a pagar: Baixar'],
      ['contas_pagar.estornar', 'Contas a pagar: Estornar'],
      ...crud('contas_receber', 'Contas a receber', ['ver', 'criar', 'editar', 'excluir', 'exportar']),
      ['contas_receber.baixar', 'Contas a receber: Baixar'],
      ['contas_receber.estornar', 'Contas a receber: Estornar'],
      ...crud('contas_correntes', 'Contas correntes', ['ver', 'criar', 'editar', 'excluir']),
      ['contas_correntes.lancar', 'Contas correntes: Lançamentos manuais e transferências'],
      ['plano_contas.ver', 'Plano de contas: Ver'],
      ['plano_contas.editar', 'Plano de contas: Editar'],
      ['fechamentos_caixa.ver', 'Fechamentos de caixa: Ver'],
      ['fechamentos_caixa.conferir', 'Fechamentos de caixa: Conferir'],
    ],
  },
  {
    grupo: 'Fiscal',
    modulo: 'erp',
    itens: [
      ['fiscal.download_xml', 'Fiscal: Download de XML'],
      ['fiscal.emitir_nfe', 'Fiscal: Emitir NF-e'],
      ['fiscal.cancelar', 'Fiscal: Cancelar documento'],
      ['fiscal.carta_correcao', 'Fiscal: Carta de correção'],
      ['fiscal.inutilizar', 'Fiscal: Inutilizar numeração'],
    ],
  },
  {
    grupo: 'Vendas',
    modulo: 'erp',
    itens: [
      ...crud('orcamentos', 'Orçamentos', ['ver', 'criar', 'editar', 'excluir']),
      ['orcamentos.converter', 'Orçamentos: Converter em venda'],
      ['movimentos_caixa.ver', 'Sangrias e reforços: Ver'],
      ['movimentos_caixa.imprimir', 'Sangrias e reforços: Imprimir'],
      ...crud('vendas', 'Vendas', ['ver', 'criar', 'editar', 'exportar']),
      ['vendas.cancelar', 'Vendas: Cancelar'],
      ['vendas.desconto_acima_limite', 'Vendas: Desconto acima do limite'],
      ['vendas.ver_lucro', 'Vendas: Ver lucro'],
      ['vendas.alterar_preco', 'Vendas: Alterar preço'],
    ],
  },
  {
    grupo: 'Relatórios',
    modulo: 'erp',
    itens: [
      ['relatorios.produtos_geral', 'Relatório: Produtos geral'],
      ['relatorios.historico_produtos', 'Relatório: Histórico de produtos'],
      ['relatorios.ncm_invalidos', 'Relatório: NCM inválidos'],
      ['relatorios.estoque_atual', 'Relatório: Estoque atual'],
      ['relatorios.movimentacao_estoque', 'Relatório: Movimentação de estoque'],
      ['relatorios.financeiro_geral', 'Relatório: Financeiro geral'],
      ['relatorios.fechamento_caixa', 'Relatório: Fechamento de caixa'],
      ['relatorios.sangria_reforco', 'Relatório: Sangria e reforço'],
      ['relatorios.comissao', 'Relatório: Comissão (própria)'],
      ['relatorios.comissao_todos', 'Relatório: Comissão de todos'],
      ['relatorios.evolucao_vendas', 'Relatório: Evolução de vendas'],
      ['relatorios.produtos_clientes', 'Relatório: Produtos por clientes'],
      ['relatorios.produtos_vendedor', 'Relatório: Produtos por vendedor'],
      ['relatorios.produtos_vendidos', 'Relatório: Produtos vendidos'],
      ['relatorios.recibos_cupons', 'Relatório: Recibos e cupons'],
      ['relatorios.vendas_geral', 'Relatório: Vendas geral'],
      ['relatorios.vendas_forma_pagamento', 'Relatório: Vendas por forma de pagamento'],
      ['relatorios.exportar', 'Relatórios: Exportar'],
    ],
  },
  {
    grupo: 'Administração',
    modulo: 'erp',
    itens: [['auditoria.ver', 'Auditoria: Ver']],
  },
  {
    grupo: 'PDV – Acesso e supervisão',
    modulo: 'pdv',
    itens: [
      ['pdv.acesso.entrar', 'Logar no PDV'],
      ['pdv.aplicativo.sair', 'Fechar o aplicativo do PDV'],
      ['pdv.supervisor', 'Liberar ações de outro operador (supervisor)', { semLiberacao: true }],
      ['pdv.usuario.desbloquear', 'Desbloquear usuário após tentativas'],
      ['pdv.offline.estender', 'Estender prazo offline'],
    ],
  },
  {
    grupo: 'PDV – Caixa',
    modulo: 'pdv',
    itens: [
      ['pdv.caixa.abrir', 'Abrir caixa'],
      ['pdv.caixa.fechar', 'Fechar caixa e trocar turno'],
      ['pdv.caixa.ver_calculado_fechamento', 'Ver valor calculado no fechamento', { semLiberacao: true }],
      ['pdv.caixa.sangria', 'Sangria'],
      ['pdv.caixa.reforco', 'Reforço'],
      ['pdv.caixa.cancelar_movimento', 'Cancelar sangria/reforço'],
      ['pdv.caixa.ignorar_limite_sangria', 'Vender acima do limite de gaveta'],
      ['pdv.caixa.operar_de_outro', 'Operar caixa aberto por outro'],
      ['pdv.gaveta.abrir_avulsa', 'Abrir gaveta sem venda'],
      ['pdv.relatorio.resumo_diario', 'Resumo diário'],
    ],
  },
  {
    grupo: 'PDV – Venda',
    modulo: 'pdv',
    itens: [
      ['pdv.venda.vender', 'Registrar e concluir vendas'],
      ['pdv.venda.cancelar_item', 'Cancelar item'],
      ['pdv.venda.cancelar_venda_aberta', 'Cancelar venda em andamento'],
      ['pdv.venda.cancelar_venda_finalizada', 'Cancelar venda finalizada / NFC-e'],
      ['pdv.venda.desconto_item', 'Desconto no item (até o limite %)'],
      ['pdv.venda.desconto_total', 'Desconto no total (até o limite %)'],
      ['pdv.venda.acrescimo', 'Acréscimo'],
      ['pdv.venda.alterar_preco', 'Alterar preço / preço de produto sem preço'],
      ['pdv.venda.tipo_preco_atacado', 'Tipo de preço atacado'],
      ['pdv.venda.vender_sem_estoque', 'Vender sem estoque'],
      ['pdv.venda.peso_manual', 'Digitar peso'],
      ['pdv.venda.vender_vencido', 'Vender lote vencido'],
      ['pdv.venda.abaixo_qtd_minima', 'Vender abaixo da quantidade mínima'],
      ['pdv.venda.horario_restrito', 'Vender produto em horário restrito'],
      ['pdv.venda.exceder_limite_valor', 'Venda acima do limite de valor do PDV'],
      ['pdv.venda.consultar', 'Gestão de vendas (consulta)'],
      ['pdv.documento.reimprimir', 'Reimprimir documentos'],
      ['pdv.cliente.cadastro_rapido', 'Cadastro rápido de cliente'],
      ['pdv.taxa_servico.remover', 'Remover taxa de serviço'],
    ],
  },
  {
    grupo: 'PDV – Pagamento',
    modulo: 'pdv',
    itens: [
      ['pdv.pagamento.forma_com_senha', 'Usar forma de pagamento com senha de liberação'],
      ['pdv.pagamento.confirmar_pix_manual', 'Confirmar PIX manualmente'],
      ['pdv.pagamento.exceder_limite_credito', 'Crediário acima do limite / cliente em atraso'],
      ['pdv.pagamento.consumo_interno', 'Usar forma de consumo interno'],
      ['pdv.crediario.receber', 'Recebimento de crediário no caixa'],
      ['pdv.crediario.desconto_juros', 'Dispensar juros/multa no recebimento'],
      ['pdv.tef.cancelar', 'Cancelar transação TEF (administrativo)'],
    ],
  },
  {
    grupo: 'PDV – Troca e vale',
    modulo: 'pdv',
    itens: [
      ['pdv.troca.realizar', 'Troca/devolução'],
      ['pdv.troca.fora_prazo', 'Troca fora do prazo / sem venda de origem'],
      ['pdv.troca.devolver_dinheiro', 'Devolver em dinheiro'],
      ['pdv.vale.emitir', 'Emissão avulsa de vale'],
    ],
  },
  {
    grupo: 'PDV – Comandas, pedidos e orçamentos',
    modulo: 'pdv',
    itens: [
      ['pdv.comanda.operar', 'Incluir/fechar comanda'],
      ['pdv.comanda.cancelar', 'Cancelar item/comanda'],
      ['pdv.pedido.operar', 'Delivery/pedidos'],
      ['pdv.pedido.cancelar', 'Cancelar pedido'],
      ['pdv.orcamento.importar', 'Importar orçamento'],
      ['pdv.orcamento.criar', 'Criar orçamento'],
    ],
  },
  {
    grupo: 'PDV – Fiscal e configuração',
    modulo: 'pdv',
    itens: [
      ['pdv.fiscal.retransmitir', 'Retransmitir NFC-e'],
      ['pdv.config.terminal', 'Configuração local e diagnóstico de periféricos do terminal'],
      ['pdv.config.fiscal', 'Série/número NFC-e local e salto de numeração', { semLiberacao: true }],
    ],
  },
  {
    // Central do PDV, a engrenagem (bloco G1; decisão 66 do README do PDV). Só consulta e diagnóstico do próprio caixa:
    // o cancelamento de venda de caixa já fechado não existe no PDV (D23 mantida pelo dono em 04/11/2026).
    grupo: 'PDV – Central do PDV',
    modulo: 'pdv',
    itens: [
      ['pdv.venda.consultar_historico', 'Ver as vendas dos caixas fechados (últimos 30 dias)'],
      ['pdv.caixa.consultar_fechamentos', 'Ver os fechamentos (últimos 30 dias), como foram impressos'],
      ['pdv.diagnostico.ver', 'Ver sincronização, logs, ocorrências e backups do terminal'],
      ['pdv.diagnostico.pacote_suporte', 'Gerar o pacote para o suporte'],
      ['pdv.auditoria.ver_local', 'Ver o histórico de uso do caixa (quem fez o quê)'],
      ['pdv.config.parametros_locais', 'Editar os parâmetros do caixa e fazer backup agora'],
    ],
  },
];

export const PERMISSOES: readonly DefinicaoPermissao[] = Object.freeze(
  GRUPOS.flatMap((g, gi) =>
    g.itens.map(([chave, descricao, opcoes], i) => ({
      chave,
      modulo: g.modulo,
      grupo: g.grupo,
      descricao,
      ordem: (gi + 1) * 1000 + i,
      permiteLiberacao: !opcoes?.semLiberacao,
    })),
  ),
);

export const CHAVES_PERMISSOES: ReadonlySet<string> = new Set(PERMISSOES.map((p) => p.chave));

/** Mesma regra de `ck_permissoes_chave` (MD 3.3.3). */
export const REGEX_CHAVE_PERMISSAO = /^[a-z_]+(\.[a-z_]+)+$/;

export function permissaoExiste(chave: string): boolean {
  return CHAVES_PERMISSOES.has(chave);
}

/** Permissão efetiva = (perfil ∪ concedidas) − negadas; master = todas (MD 3.3.4). */
export function calcularPermissoesEfetivas(entrada: {
  master: boolean;
  doPerfil: Iterable<string>;
  concedidas?: Iterable<string>;
  negadas?: Iterable<string>;
}): Set<string> {
  if (entrada.master) return new Set(CHAVES_PERMISSOES);
  const efetivas = new Set<string>(entrada.doPerfil);
  for (const c of entrada.concedidas ?? []) efetivas.add(c);
  for (const n of entrada.negadas ?? []) efetivas.delete(n);
  for (const c of efetivas) if (!CHAVES_PERMISSOES.has(c)) efetivas.delete(c);
  return efetivas;
}

/** Usuário só com permissões `pdv.*` não entra no ERP (ERP 4.1). */
export function temAcessoErp(permissoes: Iterable<string>): boolean {
  for (const p of permissoes) if (!p.startsWith('pdv.')) return true;
  return false;
}
