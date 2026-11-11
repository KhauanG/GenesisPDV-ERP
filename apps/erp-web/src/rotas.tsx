import type { ReactNode } from 'react';
import { Outlet, type RouteObject } from 'react-router';
import { ExigePermissao, RotaProtegida } from './auth/RotaProtegida';
import { ProvedorSessao } from './auth/sessao';
import { Layout } from './layout/Layout';
import { ITENS_MENU, podeAbrirExportacao } from './menu';
import { Dashboard } from './paginas/Dashboard';
import { EmConstrucao } from './paginas/EmConstrucao';
import { NaoEncontrado, SemPermissao } from './paginas/Erros';
import { Login } from './paginas/Login';
import { MinhaConta } from './paginas/MinhaConta';
import { Sair } from './paginas/Sair';
import { TrocarSenha } from './paginas/TrocarSenha';
import { Categorias } from './paginas/categorias/Categorias';
import { Configuracoes } from './paginas/configuracoes/Configuracoes';
import { Empresa } from './paginas/empresa/Empresa';
import { FormularioAcerto, ListaAcertos } from './paginas/estoques/Acertos';
import { FormularioEstoque, ListaEstoques } from './paginas/estoques/Estoques';
import { FolhaContagemImpressao, ROTA_FOLHA_CONTAGEM } from './paginas/estoques/FolhaContagem';
import { FormularioNotaEntrada, ListaNotasEntrada } from './paginas/estoques/NotasEntrada';
import { FormularioRecebimento, ListaRecebimentos } from './paginas/estoques/Recebimentos';
import { EspelhoRecebimento } from './paginas/estoques/RecebimentosEspelho';
import { ListaSaldos } from './paginas/estoques/Saldos';
import { FormularioTransferencia, ListaTransferencias } from './paginas/estoques/Transferencias';
import { RomaneioTransferenciaImpressao } from './paginas/estoques/TransferenciasRomaneio';
import { FormularioTipoEstoque, TiposEstoque } from './paginas/estoques/TiposEstoque';
import { DetalheTerminal } from './paginas/terminais/DetalheTerminal';
import { ListagemTerminais } from './paginas/terminais/ListagemTerminais';
import { Prontidao } from './paginas/implantacao/Prontidao';
import { Importacao } from './paginas/importacao/Importacao';
import { FormularioFormaPagamento, ListaFormasPagamento } from './paginas/formas-pagamento/FormasPagamento';
import { FormularioLoja, ListaLojas } from './paginas/lojas/Lojas';
import { FormularioMarca, ListaMarcas } from './paginas/marcas/Marcas';
import { FormularioPerfil, ListaPerfis } from './paginas/perfis/Perfis';
import { FormularioPessoa, ListaPessoas } from './paginas/pessoas/Pessoas';
import { CadastroEmMassa, ROTA_CADASTRO_MASSA } from './paginas/produtos/CadastroEmMassa';
import { Exportacao, ROTA_EXPORTACAO } from './paginas/produtos/Exportacao';
import { FormularioProduto } from './paginas/produtos/FormularioProduto';
import { FormularioGrupoPreco, ListaGruposPreco } from './paginas/produtos/GruposPreco';
import { ListaProdutos } from './paginas/produtos/ListaProdutos';
import { FormularioRestricaoHorario, ListaRestricoesHorario } from './paginas/produtos/RestricoesHorario';
import { EanDuplicado, ROTA_EAN_DUPLICADO } from './paginas/relatorios/EanDuplicado';
import { EstoqueAtual, ROTA_ESTOQUE_ATUAL } from './paginas/relatorios/EstoqueAtual';
import { MovimentacaoEstoque, ROTA_MOVIMENTACAO_ESTOQUE } from './paginas/relatorios/MovimentacaoEstoque';
import { NcmInvalidos, ROTA_NCM_INVALIDOS } from './paginas/relatorios/NcmInvalidos';
import { ProdutosGeral, ROTA_PRODUTOS_GERAL } from './paginas/relatorios/ProdutosGeral';
import { FormularioUsuario } from './paginas/usuarios/FormularioUsuario';
import { DetalheFechamentoCaixa, ListaFechamentosCaixa } from './paginas/vendas/FechamentosCaixa';
import {
  DetalheReforco,
  DetalheSangria,
  ListaReforcos,
  ListaSangrias,
} from './paginas/vendas/MovimentosCaixa';
import { DetalheVenda, ListaVendas } from './paginas/vendas/Vendas';
import { ListaUsuarios } from './paginas/usuarios/ListaUsuarios';
import { DetalheEmpresa } from './plataforma/DetalheEmpresa';
import { Empresas } from './plataforma/Empresas';
import { LayoutPlataforma } from './plataforma/Layout';
import { LoginPlataforma } from './plataforma/Login';
import { Migracoes } from './plataforma/Migracoes';
import { NovaEmpresa } from './plataforma/NovaEmpresa';
import { Planos } from './plataforma/Planos';
import { ProvedorSessaoPlataforma } from './plataforma/sessao';

/** Listagem + "Novo" + formulário (`:id/:aba?`) de um cadastro, cada rota com a permissão própria (ERP 2.2). */
function cadastro(
  rota: string,
  recurso: string,
  lista: ReactNode,
  formulario: ReactNode,
  permissaoVer = `${recurso}.ver`,
): RouteObject[] {
  return [
    { path: rota, element: <ExigePermissao permissao={permissaoVer}>{lista}</ExigePermissao> },
    {
      path: `${rota}/novo`,
      element: <ExigePermissao permissao={`${recurso}.criar`}>{formulario}</ExigePermissao>,
    },
    {
      path: `${rota}/:id/:aba?`,
      element: <ExigePermissao permissao={permissaoVer}>{formulario}</ExigePermissao>,
    },
  ];
}

/** Cadastro com permissão de ver e uma só de gravar (`<recurso>.editar` também cria; ERP 8.9, 8.10). */
function cadastroVerEditar(
  rota: string,
  ver: string,
  editar: string,
  lista: ReactNode,
  formulario: ReactNode,
): RouteObject[] {
  return [
    { path: rota, element: <ExigePermissao permissao={ver}>{lista}</ExigePermissao> },
    { path: `${rota}/novo`, element: <ExigePermissao permissao={editar}>{formulario}</ExigePermissao> },
    { path: `${rota}/:id`, element: <ExigePermissao permissao={ver}>{formulario}</ExigePermissao> },
  ];
}

/** Consulta só de leitura (Fase 1C, C12): listagem e detalhe com a mesma permissão de ver. */
function consulta(
  rota: string,
  permissao: string,
  lista: ReactNode,
  detalhe: ReactNode,
  sufixo = ':id',
): RouteObject[] {
  return [
    { path: rota, element: <ExigePermissao permissao={permissao}>{lista}</ExigePermissao> },
    { path: `${rota}/${sufixo}`, element: <ExigePermissao permissao={permissao}>{detalhe}</ExigePermissao> },
  ];
}

/** Telas do menu ainda não entregues: a rota existe (e respeita a permissão) e mostra "Em construção". */
const emConstrucao: RouteObject[] = ITENS_MENU.filter((i) => !i.pronto).flatMap((i) => {
  const element = (
    <ExigePermissao permissao={i.permissao} acesso={i.acesso}>
      <EmConstrucao item={i} />
    </ExigePermissao>
  );
  return [
    { path: i.rota, element },
    { path: `${i.rota}/*`, element },
  ];
});

export const rotas: RouteObject[] = [
  {
    path: '/plataforma',
    element: (
      <ProvedorSessaoPlataforma>
        <Outlet />
      </ProvedorSessaoPlataforma>
    ),
    children: [
      { path: 'login', element: <LoginPlataforma /> },
      {
        element: <LayoutPlataforma />,
        children: [
          { index: true, element: <Empresas /> },
          { path: 'empresas', element: <Empresas /> },
          { path: 'empresas/nova', element: <NovaEmpresa /> },
          { path: 'empresas/:codigo', element: <DetalheEmpresa /> },
          { path: 'planos', element: <Planos /> },
          { path: 'migracoes', element: <Migracoes /> },
          { path: '*', element: <NaoEncontrado inicio="/plataforma/empresas" /> },
        ],
      },
    ],
  },
  {
    element: (
      <ProvedorSessao>
        <Outlet />
      </ProvedorSessao>
    ),
    children: [
      { path: '/login', element: <Login /> },
      { path: '/sair', element: <Sair /> },
      {
        element: <RotaProtegida />,
        children: [
          {
            element: <Layout />,
            children: [
              { index: true, element: <Dashboard /> },
              { path: '/minha-conta', element: <MinhaConta /> },
              { path: '/minha-conta/senha', element: <TrocarSenha /> },
              {
                path: '/cadastros/usuarios',
                element: (
                  <ExigePermissao permissao="usuarios.ver">
                    <ListaUsuarios />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/usuarios/novo',
                element: (
                  <ExigePermissao permissao="usuarios.criar">
                    <FormularioUsuario />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/usuarios/:id/:aba?',
                element: (
                  <ExigePermissao permissao="usuarios.ver">
                    <FormularioUsuario />
                  </ExigePermissao>
                ),
              },
              ...cadastro('/pessoas', 'pessoas', <ListaPessoas />, <FormularioPessoa />),
              ...cadastro('/produtos', 'produtos', <ListaProdutos />, <FormularioProduto />),
              ...cadastroVerEditar(
                '/produtos/grupos-preco',
                'grupos_preco.ver',
                'grupos_preco.editar',
                <ListaGruposPreco />,
                <FormularioGrupoPreco />,
              ),
              ...cadastroVerEditar(
                '/produtos/restricoes-horario',
                'restricoes_horario.ver',
                'restricoes_horario.editar',
                <ListaRestricoesHorario />,
                <FormularioRestricaoHorario />,
              ),
              ...cadastro('/produtos/marcas', 'marcas', <ListaMarcas />, <FormularioMarca />),
              {
                path: ROTA_CADASTRO_MASSA,
                element: (
                  <ExigePermissao permissao="produtos.cadastro_massa">
                    <CadastroEmMassa />
                  </ExigePermissao>
                ),
              },
              {
                // Abre para quem exporta produtos ou clientes (o `acesso` do item do menu); os botões conferem cada
                // um, e a API também.
                path: ROTA_EXPORTACAO,
                element: (
                  <ExigePermissao permissao="produtos.exportar" acesso={podeAbrirExportacao}>
                    <Exportacao />
                  </ExigePermissao>
                ),
              },
              {
                path: '/produtos/categorias',
                element: (
                  <ExigePermissao permissao="categorias.ver">
                    <Categorias />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/configuracoes/:aba?',
                element: (
                  <ExigePermissao permissao="configuracoes.ver">
                    <Configuracoes />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/empresa',
                element: (
                  <ExigePermissao permissao="empresa.ver">
                    <Empresa />
                  </ExigePermissao>
                ),
              },
              ...cadastro(
                '/cadastros/formas-pagamento',
                'formas_pagamento',
                <ListaFormasPagamento />,
                <FormularioFormaPagamento />,
              ),
              ...cadastro('/cadastros/lojas', 'lojas', <ListaLojas />, <FormularioLoja />),
              ...cadastro('/cadastros/perfis', 'perfis', <ListaPerfis />, <FormularioPerfil />),
              {
                path: '/cadastros/pdvs',
                element: (
                  <ExigePermissao permissao="terminais.ver">
                    <ListagemTerminais />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/pdvs/:id',
                element: (
                  <ExigePermissao permissao="terminais.ver">
                    <DetalheTerminal />
                  </ExigePermissao>
                ),
              },
              {
                path: '/cadastros/implantacao/prontidao',
                element: (
                  <ExigePermissao permissao="configuracoes.ver">
                    <Prontidao />
                  </ExigePermissao>
                ),
              },
              ...cadastro('/estoque/locais', 'estoques', <ListaEstoques />, <FormularioEstoque />),
              ...cadastro('/estoque/acertos', 'estoque_acertos', <ListaAcertos />, <FormularioAcerto />),
              {
                path: ROTA_FOLHA_CONTAGEM,
                element: (
                  <ExigePermissao permissao="estoque_acertos.ver">
                    <FolhaContagemImpressao />
                  </ExigePermissao>
                ),
              },
              ...cadastro(
                '/estoque/recebimentos',
                'recebimentos',
                <ListaRecebimentos />,
                <FormularioRecebimento />,
              ),
              {
                // O espelho impresso (F2-B16): o segmento fixo `espelho` ganha do `:id/:aba?` do cadastro.
                path: '/estoque/recebimentos/:id/espelho',
                element: (
                  <ExigePermissao permissao="recebimentos.ver">
                    <EspelhoRecebimento />
                  </ExigePermissao>
                ),
              },
              // NF-e de fornecedor por XML (F2-B19): a listagem com o upload e a nota com as abas (sem "Novo").
              ...consulta(
                '/estoque/notas-entrada',
                'notas_entrada.ver',
                <ListaNotasEntrada />,
                <FormularioNotaEntrada />,
                ':id/:aba?',
              ),
              ...cadastro('/estoque/tipos', 'tipos_estoque', <TiposEstoque />, <FormularioTipoEstoque />),
              // Transferência CD ⇄ loja (F2-B27): o rascunho, as etapas e o romaneio impresso (o segmento fixo
              // `romaneio` ganha do `:id/:aba?` do cadastro).
              ...cadastro(
                '/estoque/transferencias',
                'transferencias',
                <ListaTransferencias />,
                <FormularioTransferencia />,
              ),
              {
                path: '/estoque/transferencias/:id/romaneio',
                element: (
                  <ExigePermissao permissao="transferencias.ver">
                    <RomaneioTransferenciaImpressao />
                  </ExigePermissao>
                ),
              },
              {
                path: ROTA_ESTOQUE_ATUAL,
                element: (
                  <ExigePermissao permissao="relatorios.estoque_atual">
                    <EstoqueAtual />
                  </ExigePermissao>
                ),
              },
              {
                path: ROTA_PRODUTOS_GERAL,
                element: (
                  <ExigePermissao permissao="relatorios.produtos_geral">
                    <ProdutosGeral />
                  </ExigePermissao>
                ),
              },
              {
                path: ROTA_NCM_INVALIDOS,
                element: (
                  <ExigePermissao permissao="relatorios.ncm_invalidos">
                    <NcmInvalidos />
                  </ExigePermissao>
                ),
              },
              {
                path: ROTA_EAN_DUPLICADO,
                element: (
                  <ExigePermissao permissao="produtos.ver">
                    <EanDuplicado />
                  </ExigePermissao>
                ),
              },
              {
                path: ROTA_MOVIMENTACAO_ESTOQUE,
                element: (
                  <ExigePermissao permissao="relatorios.movimentacao_estoque">
                    <MovimentacaoEstoque />
                  </ExigePermissao>
                ),
              },
              {
                path: '/estoque/saldos',
                element: (
                  <ExigePermissao permissao="estoque_saldos.ver">
                    <ListaSaldos />
                  </ExigePermissao>
                ),
              },
              {
                path: '/produtos/importacao',
                element: (
                  <ExigePermissao permissao="produtos.importar">
                    <Importacao />
                  </ExigePermissao>
                ),
              },
              {
                path: '/pessoas/importacao',
                element: (
                  <ExigePermissao permissao="pessoas.importar">
                    <Importacao tipoInicial="clientes" />
                  </ExigePermissao>
                ),
              },
              ...consulta('/vendas', 'vendas.ver', <ListaVendas />, <DetalheVenda />, ':id/:aba?'),
              ...consulta('/vendas/reforcos', 'movimentos_caixa.ver', <ListaReforcos />, <DetalheReforco />),
              ...consulta('/vendas/sangrias', 'movimentos_caixa.ver', <ListaSangrias />, <DetalheSangria />),
              ...consulta(
                '/financeiro/fechamentos-caixa',
                'fechamentos_caixa.ver',
                <ListaFechamentosCaixa />,
                <DetalheFechamentoCaixa />,
              ),
              ...emConstrucao,
              { path: '/sem-permissao', element: <SemPermissao /> },
              { path: '/nao-encontrado', element: <NaoEncontrado /> },
              { path: '*', element: <NaoEncontrado /> },
            ],
          },
        ],
      },
      // Fora do layout e da RotaProtegida: a própria tela confere a sessão.
      { path: '/trocar-senha', element: <TrocarSenha obrigatoria /> },
    ],
  },
];
