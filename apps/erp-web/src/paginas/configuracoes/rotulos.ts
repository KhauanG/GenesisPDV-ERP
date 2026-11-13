/**
 * Rótulos e controles das chaves de Configurações exibidas nesta fase (ERP 9.1, 9.3.1, 9.9). Tipo, padrão e flags
 * Loja/PDV vêm do catálogo `@genesis/shared/configuracoes` (MD 3.1.2); aqui só a apresentação.
 */
export type TipoCampo =
  'bool' | 'int' | 'dinheiro' | 'pct' | 'hora' | 'texto' | { opcoes: Array<[valor: string, rotulo: string]> };

export interface RotuloConfiguracao {
  chave: string;
  rotulo: string;
  tipo: TipoCampo;
  bloco: string;
  ajuda?: string;
  /** Módulo opcional ainda não entregue (comandas, delivery): aparece desabilitado. */
  fut?: boolean;
}

const r = (
  chave: string,
  rotulo: string,
  tipo: TipoCampo,
  bloco: string,
  extra: Partial<RotuloConfiguracao> = {},
): RotuloConfiguracao => ({
  chave,
  rotulo,
  tipo,
  bloco,
  ...extra,
});

export const ABA_GERAL: RotuloConfiguracao[] = [
  r('geral.ativa', 'Ativa (Não = modo implantação: PDVs não abrem caixa)', 'bool', 'Geral'),
  r('geral.altera_preco_produto_erp', 'Altera preço do produto no ERP', 'bool', 'Geral'),
  r('geral.produto_usa_fornecedores', 'Produto usa fornecedores', 'bool', 'Geral'),
  r('geral.utiliza_servico_avulso', 'Utiliza serviço avulso', 'bool', 'Geral'),
  r('geral.margem_lucro_pct', 'Margem de lucro padrão (%)', 'pct', 'Geral', {
    ajuda: '0 = sem sugestão de preço',
  }),
  r(
    'geral.ean_duplicado',
    'EAN duplicado',
    {
      opcoes: [
        ['bloquear', 'Bloquear'],
        ['avisar', 'Avisar (só na migração)'],
      ],
    },
    'Geral',
  ),
  r('geral.dia_operacional_hora_corte', 'Hora de corte do dia operacional', 'hora', 'Geral', {
    ajuda: 'Ex.: 05:00 → venda às 02:30 conta no dia anterior',
  }),
  r('geral.sessao_inatividade_min', 'Tempo de inatividade da sessão (min)', 'int', 'Geral'),
  r('geral.permite_acesso_suporte', 'Permitir acesso do suporte Genesis', 'bool', 'Geral'),
  // F2-B1 (D43): Não = o tipo não pode ser escolhido no cadastro nem na planilha (o produto já gravado segue editável).
  r('produtos.variacoes_habilitadas', 'Cadastrar produtos "Com variações"', 'bool', 'Produtos', {
    fut: true,
    ajuda:
      'Ligar só com a grade de variações e os caixas na versão com a guarda: a tela avisa dos caixas antigos, que vendem o produto pai com o preço e o saldo dele',
  }),
  // F2-B51: ligada por padrão com o modal Complementos (deixou de ser "módulo futuro").
  r('produtos.complementos_habilitados', 'Cadastrar produtos "Com complementos"', 'bool', 'Produtos', {
    ajuda:
      'Os grupos e os complementos são cadastrados no modal Complementos do produto; o caixa ainda vende o produto sem eles (a escolha na venda vem com a Fase 3)',
  }),
  // F2-B16 (F2-Q8 = D49): a base do markup ⇄ preço de venda da compra (recebimento manual; a NF-e no F2-B21).
  r(
    'produtos.custo_base_margem',
    'Custo base do markup na compra',
    {
      opcoes: [
        ['preco_custo', 'Preço de custo (o que o produto terá depois da compra)'],
        ['custo_medio', 'Custo médio do estoque depois da entrada'],
        ['ultimo_custo', 'Último custo (o desta compra)'],
      ],
    },
    'Produtos',
    { ajuda: 'Markup e preço sugerido nos itens do recebimento' },
  ),
  r(
    'geral.tipo_balanca',
    'Tipo de balança',
    {
      opcoes: [
        ['valor', 'Valor (R$)'],
        ['peso', 'Peso (kg)'],
      ],
    },
    'Balança',
  ),
  r('geral.balanca_prefixo', 'Prefixo do EAN de balança', 'texto', 'Balança'),
  r('geral.balanca_tamanho_codigo', 'Dígitos do código (PLU)', 'int', 'Balança'),
  r('geral.balanca_tamanho_valor', 'Dígitos do valor', 'int', 'Balança'),
  r('estoque.permite_negativo_erp', 'Permitir saldo negativo em documentos do ERP', 'bool', 'Estoque'),
  r(
    'estoque.transferencia_recebimento_automatico',
    'Transferência com recebimento automático',
    'bool',
    'Estoque',
  ),
  // F2-B25 (F2-Q11 = D52, padrão até a confirmação do dono).
  r(
    'estoque.reposicao_arredonda_embalagem',
    'Sugestão de reposição arredonda para a embalagem de compra',
    'bool',
    'Estoque',
    {
      ajuda:
        'Fardo ou caixa fechada de maior fator, sem passar do saldo da origem; desligada, sai em unidades',
    },
  ),
  // F2-B26 (padrão aplicado sem pergunta, plano da Fase 2).
  r('estoque.transferencia_alerta_dias', 'Alerta de transferência parada (dias)', 'int', 'Estoque', {
    ajuda: 'Em trânsito desde o envio, ou recebida com divergência sem tratar desde o recebimento',
  }),
  r('estoque.custo_inclui_st', 'Custo da NF-e inclui ICMS ST', 'bool', 'Estoque'),
  r('estoque.custo_inclui_ipi', 'Custo da NF-e inclui IPI', 'bool', 'Estoque'),
  r('estoque.custo_inclui_frete', 'Custo da NF-e inclui frete e despesas', 'bool', 'Estoque'),
  r(
    'estoque.custo_abate_creditos',
    'Abater créditos de ICMS/PIS/COFINS do custo (regime normal)',
    'bool',
    'Estoque',
  ),
  // F2-B15 (F2-Q8 = D49): o preço de custo manual não é sobrescrito pela compra sem confirmação.
  r(
    'estoque.compra_atualiza_preco_custo',
    'Compra atualiza o preço de custo do produto',
    {
      opcoes: [
        ['sempre', 'Sempre'],
        ['perguntar', 'Perguntar ao movimentar'],
        ['nunca', 'Nunca (só custo médio e último custo)'],
      ],
    },
    'Estoque',
    { ajuda: 'Recebimento e NF-e de entrada; o custo médio e o último custo sempre mudam' },
  ),
  r(
    'estoque.lote_baixa_sem_informar',
    'Saída sem lote de produto com lote',
    {
      opcoes: [
        ['fefo', 'Baixar dos lotes, o que vence primeiro (FEFO)'],
        ['nao_baixar', 'Não baixar o saldo por lote'],
      ],
    },
    'Estoque',
    { ajuda: 'Venda do caixa e acerto sem lote informado' },
  ),
  // F2-B11 (F2-Q6 = D47): o veredito do relatório de conferência do "Definir" (aba "Conferência" do acerto).
  r('estoque.tolerancia_conferencia_total_pct', 'Conferência: tolerância total (%)', 'pct', 'Estoque', {
    ajuda: 'Soma das diferenças a custo sobre o valor contado (padrão 1%)',
  }),
  r('estoque.tolerancia_conferencia_item_pct', 'Conferência: tolerância por item (%)', 'pct', 'Estoque', {
    ajuda: 'Diferença de cada item sobre o próprio saldo no sistema (padrão 5%)',
  }),
  // F2-B18 (F2-Q9 = D50, decidida pelo dono em 05/11/2026): as outras recusas da importação valem sempre.
  r(
    'notas_entrada.assinatura_invalida',
    'Assinatura do XML que não confere',
    {
      opcoes: [
        ['avisar', 'Avisar (quem importa confirma)'],
        ['recusar', 'Recusar a nota'],
        ['nao_conferir', 'Não conferir a assinatura'],
      ],
    },
    'NF-e de entrada',
    { ajuda: 'Importação do XML do fornecedor; sem consulta à SEFAZ' },
  ),
];

export const ABA_PARAMETROS: RotuloConfiguracao[] = [
  r('pdv.exibe_cardapio_interno', 'Exibe cardápio interno', 'bool', 'PDV', { fut: true }),
  r('pdv.exibe_estoque_busca', 'Exibe estoque na busca', 'bool', 'PDV'),
  r('pdv.dias_validade_cupom_troca', 'Dias de validade do cupom de troca', 'int', 'PDV'),
  r('pdv.fonte_lista', 'Tamanho da fonte – lista de itens', 'int', 'PDV'),
  r('pdv.fonte_total', 'Tamanho da fonte – total', 'int', 'PDV'),
  r('pdv.fonte_codigo', 'Tamanho da fonte – campo de código', 'int', 'PDV'),
  r('pdv.usa_pinpad_virtual', 'Usa pinpad virtual', 'bool', 'PDV'),
  r('pdv.desmembra_produto_kit', 'Desmembra produto kit (linhas dos componentes na tela)', 'bool', 'PDV'),
  r('pdv.solicita_abertura_caixa', 'Solicita abertura de caixa no PDV', 'bool', 'PDV'),
  r(
    'pdv.resumo_diario_modo',
    'Resumo diário por',
    {
      opcoes: [
        ['intervalo_dias', 'Intervalo de dias'],
        ['horario', 'Horário'],
      ],
    },
    'PDV',
  ),
  r('pdv.comandas_numeracao_automatica', 'Comandas com numeração automática', 'bool', 'PDV', { fut: true }),
  r('pdv.usa_preco_volume', 'Usa produto preço volume (atacarejo)', 'bool', 'PDV'),
  r('pdv.vale_compra_validade_dias', 'Validade do vale compra (dias)', 'int', 'PDV'),
  r('pdv.imprime_cupom_troca', 'Imprime cupom de troca', 'bool', 'PDV'),
  r('pdv.bloqueia_venda_sem_estoque', 'Bloqueia venda sem estoque', 'bool', 'PDV'),
  // F2-B34 (F2-Q2 = D44, decidida pelo dono em 05/11/2026: Sim).
  r('pdv.recusa_produto_com_variacoes', 'Recusa produto com variações no caixa', 'bool', 'PDV', {
    ajuda:
      'Sim: o código de uma variação e o produto com variações ativas não vendem ("venda disponível na próxima versão"). Não: vende o produto pai, com o preço e o saldo dele',
  }),
  // F2-B35 (F2-Q12 = D53; sem resposta explícita do dono, vale a recomendação: Sim, para qualquer operador).
  r('pdv.consulta_outras_lojas', 'Consulta do estoque das outras lojas no caixa (F4)', 'bool', 'PDV', {
    ajuda:
      'Sim: na pesquisa F2 do caixa, o F4 mostra online a quantidade do produto nas outras lojas e no CD (sem a loja de treino e sem custo). Não: o F4 avisa que a consulta está desligada',
  }),
  r('pdv.limite_valor_venda', 'Limite de valor de vendas PDV', 'dinheiro', 'PDV', {
    ajuda: 'Vazio = sem limite',
  }),
  r('pdv.aviso_vencimento', 'Aviso de vencimento', 'bool', 'PDV'),
  r('pdv.aviso_vencimento_dias', 'Dias de aviso de vencimento', 'int', 'PDV'),
  r('pdv.limite_venda_em_aberto', 'Limite de vendas em aberto por terminal', 'int', 'PDV', {
    ajuda: 'Vazio = sem limite',
  }),
  r('pdv.imprime_sangria_automaticamente', 'Imprime sangria automaticamente', 'bool', 'PDV'),
  r('pdv.valor_limite_sangria', 'Valor limite para bloquear o PDV e fazer sangria', 'dinheiro', 'PDV', {
    ajuda: 'Vazio = desligado',
  }),
  r('pdv.exibe_foto_produto', 'Exibe foto do produto no PDV', 'bool', 'PDV'),
];

export const ABA_PDV: RotuloConfiguracao[] = [
  r('pdv.usa_pdv', 'Usa PDV', 'bool', 'PDV'),
  r('pdv.orcamento_pdv', 'Orçamento PDV', 'bool', 'PDV'),
  r('pdv.altera_preco_pdv', 'Altera preço no PDV', 'bool', 'PDV'),
  r('pdv.pedido_pdv', 'Pedido PDV', 'bool', 'PDV', { fut: true }),
  r('pdv.agrupa_produtos', 'Agrupa produtos', 'bool', 'PDV'),
  r('pdv.solicita_vendedor_comanda', 'Solicita vendedor na comanda', 'bool', 'PDV', { fut: true }),
  r('pdv.forca_escolha_vendedor', 'Força escolha do vendedor', 'bool', 'PDV'),
  r('pdv.solicita_vendedor_finalizacao', 'Solicita vendedor na finalização', 'bool', 'PDV'),
  r('pdv.atendente_ao_inves_vendedor', 'Atendente ao invés de vendedor', 'bool', 'PDV'),
  r('pdv.taxa_servico_pct', 'Taxa de serviço (%)', 'pct', 'PDV', { fut: true }),
  r('pdv.taxa_servico_no_balcao', 'Taxa de serviço também no balcão', 'bool', 'Avançado', { fut: true }),
  r('pdv.fechamento_cego', 'Fechamento cego', 'bool', 'Avançado'),
  r('pdv.tolerancia_diferenca_caixa', 'Tolerância de diferença no fechamento', 'dinheiro', 'Avançado'),
  r('pdv.permite_recontagem', 'Permite recontagem no fechamento', 'bool', 'Avançado'),
  r(
    'pdv.fechamento_mostra_conferencia',
    'Mostra o calculado × contado no PDV depois da contagem',
    'bool',
    'Avançado',
  ),
  r(
    'pdv.fechamento_eletronico_automatico',
    'Formas eletrônicas preenchidas automaticamente no fechamento',
    'bool',
    'Avançado',
  ),
  r(
    'pdv.imprime_calculado_no_fechamento',
    'Imprime o calculado no relatório de fechamento',
    'bool',
    'Avançado',
  ),
  r('pdv.sangria_limitada_ao_saldo', 'Sangria limitada ao saldo da gaveta', 'bool', 'Avançado'),
  r('pdv.sangria_exige_senha_quem_retira', 'Sangria exige senha de quem retira', 'bool', 'Avançado'),
  r('pdv.dias_max_offline', 'Dias máximos offline', 'int', 'Avançado'),
  r('pdv.bloqueio_estoque_offline', 'Bloqueio de estoque também offline', 'bool', 'Avançado'),
  r('pdv.crediario_exige_online', 'Crediário exige internet', 'bool', 'Avançado'),
  r('pdv.crediario_exige_senha_cliente', 'Crediário exige senha do cliente', 'bool', 'Avançado'),
  r('pdv.vale_exige_online', 'Vale exige internet', 'bool', 'Avançado'),
  r('pdv.vale_exige_cliente_acima', 'Vale exige cliente acima de (0 = nunca)', 'dinheiro', 'Avançado'),
  r('pdv.troca_kit_parcial', 'Troca parcial de kit', 'bool', 'Avançado'),
  r('pdv.devolucao_emite_nfe_entrada', 'Devolução emite NF-e de entrada', 'bool', 'Avançado'),
  r('pdv.delivery_emite_nota_na_saida', 'Delivery emite nota na saída', 'bool', 'Avançado', { fut: true }),
  r('pdv.pix_validade_s', 'Validade do QR PIX (s)', 'int', 'Avançado'),
  r('pdv.primeiro_vencimento_dias', '1º vencimento do crediário (dias)', 'int', 'Avançado'),
  r('pdv.pergunta_cpf_na_finalizacao', 'Pergunta CPF na finalização', 'bool', 'Avançado'),
  r('pdv.horas_alerta_sessao', 'Alerta de sessão aberta há mais de (h)', 'int', 'Avançado'),
  r('pdv.bloqueia_sessao_dia_anterior', 'Bloqueia sessão de dia anterior', 'bool', 'Avançado'),
  r('pdv.cancelar_item_exige_supervisor', 'Cancelar item sempre pede supervisor', 'bool', 'Avançado'),
  r('pdv.limite_preco_digitado', 'Limite de preço digitado', 'dinheiro', 'Avançado'),
  r('pdv.troco_maximo', 'Troco máximo sem confirmação', 'dinheiro', 'Avançado'),
  r('pdv.exige_impressao_danfe', 'Exige impressão do DANFE NFC-e', 'bool', 'Avançado'),
  r('pdv.imprime_qr_pix', 'Imprime QR do PIX estático', 'bool', 'Avançado'),
  r(
    'pdv.limite_padrao_cliente_pdv',
    'Limite de crediário do cliente criado no caixa',
    'dinheiro',
    'Avançado',
  ),
  r('pdv.imprime_itens_cancelados', 'Imprime itens cancelados no comprovante', 'bool', 'Avançado'),
  r('pdv.pessoas_meses_relevancia', 'Meses de relevância de clientes no PDV', 'int', 'Avançado'),
  r('pdv.permite_pin_curto', 'Aceita PIN curto (4–5 dígitos)', 'bool', 'Avançado'),
  r('pdv.login_aceita_senha_erp', 'Login no PDV aceita a senha do ERP (só online)', 'bool', 'Avançado'),
  r('pdv.taxa_servico_no_documento_fiscal', 'Taxa de serviço no documento fiscal', 'bool', 'Avançado', {
    fut: true,
  }),
  r(
    'pdv.confirmacao_idade',
    'Confirmação de idade',
    {
      opcoes: [
        ['por_venda', 'Uma vez por venda'],
        ['por_item', 'A cada item'],
        ['desligado', 'Desligado'],
      ],
    },
    'Avançado',
  ),
  r('pdv.vasilhame_comodato', 'Empréstimo de cascos (comodato)', 'bool', 'Avançado', { fut: true }),
  r('pdv.cancelamento_devolve_vazios', 'Cancelar venda devolve os vazios trazidos', 'bool', 'Avançado', {
    ajuda:
      'Sim: o caixa devolve os cascos ao cliente e o estoque de vazios volta. Não: os vazios ficam na loja',
  }),
  r('pdv.pix_manual_exige_supervisor', 'PIX manual exige supervisor', 'bool', 'Avançado'),
  r(
    'pdv.desconto_cascos_max_sem_supervisor',
    'Desconto pelos cascos sem supervisor até (R$ por venda)',
    'dinheiro',
    'Avançado',
    { ajuda: 'Acima disso o caixa pede o supervisor. 0 = sem teto' },
  ),
];

export const ROTULOS_ACOES_ATALHO: Record<string, string> = {
  pesquisar_produto: 'Pesquisar produto',
  remover_item: 'Remover item',
  tipo_preco: 'Tipo de preço',
  pedidos_orcamentos: 'Pedidos/orçamentos',
  concluir_venda: 'Concluir venda',
  gestao_vendas: 'Gestão de vendas',
  nova_venda: 'Nova venda',
  troca_produtos: 'Troca de produtos',
  incluir_comanda: 'Incluir na comanda',
  fechar_comanda: 'Fechar comanda',
  gestao_comandas: 'Gestão de comandas',
  delivery: 'Delivery',
  acompanhamento_pedidos: 'Acompanhamento de pedidos',
  balcao: 'Balcão',
  tabela_precos: 'Tabela de preços',
  produtos_vencidos: 'Produtos vencidos',
  ordem_servico: 'Ordem de serviço',
  agenda: 'Agenda',
  ajuda: 'Ajuda',
  quantidade: 'Quantidade',
  cancelar_venda: 'Cancelar venda',
  cliente: 'Cliente',
  desconto_acrescimo: 'Desconto/acréscimo',
  alterar_preco: 'Alterar preço',
  vendedor: 'Vendedor',
  menu_funcoes: 'Menu de funções',
  consulta_preco: 'Consulta de preço',
  servico_avulso: 'Serviço avulso',
  cardapio_interno: 'Cardápio interno',
  suspender_venda: 'Suspender venda',
  recuperar_venda: 'Recuperar venda',
  cupom_troca_ultima: 'Cupom de troca da última venda',
  bloquear_terminal: 'Bloquear terminal',
  sincronizar_agora: 'Sincronizar agora',
  configuracao_terminal: 'Configuração do terminal',
  gelada: 'Gelada',
};
