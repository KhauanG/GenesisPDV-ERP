/**
 * Árvore de menus e rotas do ERP (ERP 5.4). `fase` = fase do roadmap em que a tela é entregue; enquanto ela não
 * existe, a rota mostra o aviso "Em construção". Item sem a permissão de acesso não aparece; grupo sem itens
 * visíveis também não (ERP 5.1).
 */
export interface ItemMenu {
  rotulo: string;
  rota: string;
  /** Permissão de acesso (`*.ver` na maioria); com `acesso`, é a que a tela "Sem permissão" cita. */
  permissao: string;
  /** Acesso que não cabe numa permissão só (ex.: a Exportação, de produtos ou de clientes): vale no lugar de `permissao`. */
  acesso?: (pode: (chave: string) => boolean) => boolean;
  fase: string;
  /** Rótulo do subgrupo dentro de RELATÓRIOS. */
  secao?: string;
  /** Tela já entregue: a rota é atendida por uma página própria, não pelo "Em construção". */
  pronto?: boolean;
}

export interface GrupoMenu {
  chave: string;
  rotulo: string;
  icone: 'inicio' | 'pessoas' | 'produtos' | 'cadastros' | 'estoque' | 'financeiro' | 'vendas' | 'relatorios';
  itens: ItemMenu[];
}

/**
 * Exportação do catálogo (ERP 8.5, ERP 3.1; decisão 74): o ver do cadastro com a exportação dele ou a dos relatórios,
 * a mesma regra da API (`garantirAcessoCadastro`).
 */
export function podeExportarCadastro(
  pode: (chave: string) => boolean,
  recurso: 'produtos' | 'pessoas',
): boolean {
  return pode(`${recurso}.ver`) && (pode(`${recurso}.exportar`) || pode('relatorios.exportar'));
}

/** A tela Produtos › Exportação abre para quem exporta produtos ou clientes. */
export const podeAbrirExportacao = (pode: (chave: string) => boolean): boolean =>
  podeExportarCadastro(pode, 'produtos') || podeExportarCadastro(pode, 'pessoas');

const rel = (secao: string, rotulo: string, nome: string, fase: string): ItemMenu => ({
  secao,
  rotulo,
  rota: `/relatorios/${nome}`,
  permissao: `relatorios.${nome.replace(/-/g, '_')}`,
  fase,
});

export const MENU: GrupoMenu[] = [
  {
    chave: 'inicio',
    rotulo: 'Início',
    icone: 'inicio',
    itens: [{ rotulo: 'Dashboard', rota: '/', permissao: 'dashboard.ver', fase: 'Fase 1', pronto: true }],
  },
  {
    chave: 'pessoas',
    rotulo: 'Pessoas',
    icone: 'pessoas',
    itens: [
      { rotulo: 'Pessoas', rota: '/pessoas', permissao: 'pessoas.ver', fase: 'Fase 1', pronto: true },
      {
        rotulo: 'Importação de clientes',
        rota: '/pessoas/importacao',
        permissao: 'pessoas.importar',
        fase: 'Fase 1',
        pronto: true,
      },
    ],
  },
  {
    chave: 'produtos',
    rotulo: 'Produtos',
    icone: 'produtos',
    itens: [
      {
        rotulo: 'Cadastro de produtos',
        rota: '/produtos',
        permissao: 'produtos.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Cadastro em massa',
        rota: '/produtos/cadastro-em-massa',
        permissao: 'produtos.cadastro_massa',
        fase: 'Fase 2',
        pronto: true,
      },
      {
        rotulo: 'Categorias',
        rota: '/produtos/categorias',
        permissao: 'categorias.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Exportação',
        rota: '/produtos/exportacao',
        permissao: 'produtos.exportar',
        acesso: podeAbrirExportacao,
        fase: 'Fase 2',
        pronto: true,
      },
      {
        rotulo: 'Importação',
        rota: '/produtos/importacao',
        permissao: 'produtos.importar',
        fase: 'Fase 1',
        pronto: true,
      },
      { rotulo: 'Marcas', rota: '/produtos/marcas', permissao: 'marcas.ver', fase: 'Fase 1', pronto: true },
      {
        rotulo: 'Grupos de preço por quantidade',
        rota: '/produtos/grupos-preco',
        permissao: 'grupos_preco.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      // `promocoes.ver` ainda não está no catálogo (11.4; promoções são da PDV-2): usa `produtos.ver`.
      { rotulo: 'Promoções', rota: '/produtos/promocoes', permissao: 'produtos.ver', fase: 'Fase 3' },
      {
        rotulo: 'Restrições de horário de venda',
        rota: '/produtos/restricoes-horario',
        permissao: 'restricoes_horario.ver',
        fase: 'Fase 1',
        pronto: true,
      },
    ],
  },
  {
    chave: 'cadastros',
    rotulo: 'Cadastros',
    icone: 'cadastros',
    itens: [
      {
        rotulo: 'Configurações',
        rota: '/cadastros/configuracoes',
        permissao: 'configuracoes.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Empresa',
        rota: '/cadastros/empresa',
        permissao: 'empresa.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Formas de Pagamento',
        rota: '/cadastros/formas-pagamento',
        permissao: 'formas_pagamento.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      { rotulo: 'Lojas', rota: '/cadastros/lojas', permissao: 'lojas.ver', fase: 'Fase 1', pronto: true },
      {
        rotulo: 'Usuários',
        rota: '/cadastros/usuarios',
        permissao: 'usuarios.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Perfis de acesso',
        rota: '/cadastros/perfis',
        permissao: 'perfis.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'PDVs / Terminais',
        rota: '/cadastros/pdvs',
        permissao: 'terminais.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      // Implantação do piloto (I5): só leitura, com a permissão de administração que o gerente já tem.
      {
        rotulo: 'Implantação › Prontidão da loja',
        rota: '/cadastros/implantacao/prontidao',
        permissao: 'configuracoes.ver',
        fase: 'Implantação',
        pronto: true,
      },
      {
        rotulo: 'Integrações',
        rota: '/cadastros/integracoes',
        permissao: 'configuracoes.editar_integracoes',
        fase: 'Fase 7',
      },
    ],
  },
  {
    chave: 'estoque',
    rotulo: 'Estoque',
    icone: 'estoque',
    itens: [
      {
        rotulo: 'Locais de estoque',
        rota: '/estoque/locais',
        permissao: 'estoques.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Acerto de Estoque',
        rota: '/estoque/acertos',
        permissao: 'estoque_acertos.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Saldos de estoque',
        rota: '/estoque/saldos',
        permissao: 'estoque_saldos.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Recebimento manual de produtos',
        rota: '/estoque/recebimentos',
        permissao: 'recebimentos.ver',
        fase: 'Fase 2',
        pronto: true,
      },
      {
        rotulo: 'Recebimento de NFe',
        rota: '/estoque/notas-entrada',
        permissao: 'notas_entrada.ver',
        fase: 'Fase 2',
        pronto: true,
      },
      {
        rotulo: 'Tipo de Estoque',
        rota: '/estoque/tipos',
        permissao: 'tipos_estoque.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Transferência de estoque',
        rota: '/estoque/transferencias',
        permissao: 'transferencias.ver',
        fase: 'Fase 2',
        pronto: true,
      },
    ],
  },
  {
    chave: 'financeiro',
    rotulo: 'Financeiro',
    icone: 'financeiro',
    itens: [
      {
        rotulo: 'Contas a Pagar',
        rota: '/financeiro/contas-pagar',
        permissao: 'contas_pagar.ver',
        fase: 'Fase 4',
      },
      {
        rotulo: 'Contas a Receber',
        rota: '/financeiro/contas-receber',
        permissao: 'contas_receber.ver',
        fase: 'Fase 4',
      },
      {
        rotulo: 'Download de XML',
        rota: '/financeiro/download-xml',
        permissao: 'fiscal.download_xml',
        fase: 'Fase 3F',
      },
      {
        rotulo: 'Contas correntes',
        rota: '/financeiro/contas-correntes',
        permissao: 'contas_correntes.ver',
        fase: 'Fase 4',
      },
      {
        rotulo: 'Plano de contas',
        rota: '/financeiro/plano-contas',
        permissao: 'plano_contas.ver',
        fase: 'Fase 4',
      },
      {
        rotulo: 'Fechamento de caixa',
        rota: '/financeiro/fechamentos-caixa',
        permissao: 'fechamentos_caixa.ver',
        fase: 'Fase 1',
        pronto: true,
      },
    ],
  },
  {
    chave: 'vendas',
    rotulo: 'Vendas',
    icone: 'vendas',
    itens: [
      { rotulo: 'Orçamentos', rota: '/vendas/orcamentos', permissao: 'orcamentos.ver', fase: 'Fase 3' },
      {
        rotulo: 'Reforço de caixa',
        rota: '/vendas/reforcos',
        permissao: 'movimentos_caixa.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      {
        rotulo: 'Sangria',
        rota: '/vendas/sangrias',
        permissao: 'movimentos_caixa.ver',
        fase: 'Fase 1',
        pronto: true,
      },
      { rotulo: 'Vendas', rota: '/vendas', permissao: 'vendas.ver', fase: 'Fase 1', pronto: true },
    ],
  },
  {
    chave: 'relatorios',
    rotulo: 'Relatórios',
    icone: 'relatorios',
    itens: [
      rel('Produtos', 'Produtos geral', 'produtos-geral', 'Fase 2'),
      rel('Produtos', 'Histórico de produtos', 'historico-produtos', 'Fase 2'),
      rel('Produtos', 'NCMs inválidos', 'ncm-invalidos', 'Fase 2'),
      // F2-B38 (README do ERP › decisão 72): de quem vê o cadastro, como o filtro "EAN duplicado" da listagem.
      {
        ...rel('Produtos', 'EAN duplicado', 'ean-duplicado', 'Fase 2'),
        permissao: 'produtos.ver',
        pronto: true,
      },
      // F2-B31 (README do ERP › decisão 66).
      { ...rel('Estoque', 'Estoque Atual', 'estoque-atual', 'Fase 2'), pronto: true },
      // F2-B32 e F2-B33 (README do ERP › decisões 67 e 68): analítica, sintética, exportação e "Ver movimentação".
      { ...rel('Estoque', 'Movimentação', 'movimentacao-estoque', 'Fase 2'), pronto: true },
      rel('Financeiro', 'Financeiro geral', 'financeiro-geral', 'Fase 5'),
      rel('Financeiro', 'Fechamento de caixa', 'fechamento-caixa', 'Fase 5'),
      rel('Financeiro', 'Sangria/Reforço', 'sangria-reforco', 'Fase 5'),
      rel('Vendas', 'Comissão', 'comissao', 'Fase 5'),
      rel('Vendas', 'Evolução (gráfico)', 'evolucao-vendas', 'Fase 5'),
      rel('Vendas', 'Produtos x Clientes', 'produtos-clientes', 'Fase 5'),
      rel('Vendas', 'Produtos x Vendedor', 'produtos-vendedor', 'Fase 5'),
      rel('Vendas', 'Produtos vendidos', 'produtos-vendidos', 'Fase 5'),
      rel('Vendas', 'Recibos x Cupons', 'recibos-cupons', 'Fase 5'),
      rel('Vendas', 'Vendas geral', 'vendas-geral', 'Fase 5'),
      rel('Vendas', 'Por forma de pagamento', 'vendas-forma-pagamento', 'Fase 5'),
      {
        secao: 'Administração',
        rotulo: 'Auditoria',
        rota: '/auditoria',
        permissao: 'auditoria.ver',
        fase: 'Fase 1',
      },
    ],
  },
];

/** O item abre para quem tem a permissão de acesso (ou passa no `acesso`, quando o item o tem). */
export const podeAcessar = (i: ItemMenu, pode: (chave: string) => boolean): boolean =>
  i.acesso ? i.acesso(pode) : pode(i.permissao);

/** Menu visível para quem tem estas permissões (grupos vazios somem). */
export function menuVisivel(pode: (chave: string) => boolean): GrupoMenu[] {
  return MENU.map((g) => ({ ...g, itens: g.itens.filter((i) => podeAcessar(i, pode)) })).filter(
    (g) => g.itens.length > 0,
  );
}

export const ITENS_MENU: ItemMenu[] = MENU.flatMap((g) => g.itens);

/** Grupo e item da rota atual (para a trilha "Grupo › Página › Registro", ERP 5.1). */
export function localizarRota(caminho: string): { grupo: GrupoMenu; item: ItemMenu } | undefined {
  let melhor: { grupo: GrupoMenu; item: ItemMenu } | undefined;
  for (const grupo of MENU) {
    for (const item of grupo.itens) {
      const casa =
        item.rota === '/' ? caminho === '/' : caminho === item.rota || caminho.startsWith(`${item.rota}/`);
      if (casa && (!melhor || item.rota.length > melhor.item.rota.length)) melhor = { grupo, item };
    }
  }
  return melhor;
}
