import {
  RELATORIO_ESTOQUE_ATUAL,
  ROTULOS_SITUACAO_SALDO,
  SITUACOES_SALDO,
  type AjusteEstoqueProduto,
  type EstoqueResumo,
  type LinhaEstoqueAtual,
  type Pagina,
  type RespostaEstoqueAtual,
  type ResultadoAjusteProduto,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import { Anchor, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useCategorias, useMarcas } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarDecimal } from '../../componentes/grade/decimal';
import type { FiltroListagem } from '../../componentes/listagem/Listagem';
import {
  exportarPelaApi,
  Relatorio,
  type ColunaRelatorio,
  type ConfigRelatorio,
} from '../../componentes/relatorio/Relatorio';
import { formatarData, formatarInteiro } from '../../util/formato';
import { ModalAjustarEstoque } from '../produtos/BlocosProduto';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';
import { linkVerMovimentacao } from './MovimentacaoEstoque';
import { useFiltroTreino } from '../vendas/comum';

export const ROTA_ESTOQUE_ATUAL = '/relatorios/estoque-atual';
/** Valor do filtro de estoque para a soma dos estoques permitidos (a API aceita `todas` como vazio). */
const TODAS = 'todas';

const reais = (v: string | null) => (v === null ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`);
const qtd = (v: string | null) => (v === null ? '—' : formatarDecimal(Number(v), 3));
/** Em trânsito e divergência: zero é "—" (quase toda linha não tem pendência); nulo na data-base. */
const pendencia = (v: string | null) => (v === null || Number(v) === 0 ? '—' : qtd(v));
const dataBr = (iso: string) => iso.split('-').reverse().join('/');

/**
 * Relatório **Estoque Atual** (ERP 16.4; Fase 2, F2-B31; README do ERP › decisão 66): o saldo por estoque × tipo com
 * o custo (só com `produtos.ver_custo`), Venda, Atacado, iFood, mínimo, "Em trânsito" e "Divergência a tratar", e os
 * totais do relatório inteiro, no `<Relatorio>` paginado no servidor com a exportação pela API (Excel/CSV; acima de
 * 50 mil linhas vira tarefa). Filtros: nome/código/EAN, marca, departamento (com as filhas), estoque (padrão: o da loja
 * de contexto; "Todas" soma os estoques permitidos, sem a loja de treino salvo o filtro), tipo de estoque, situação do
 * saldo, produtos ativos, "Vencendo em N dias" (lotes) e a data-base "Saldo em" (o saldo do fim do dia pelo razão).
 *
 * **Ajuste no clique do saldo** (com `estoque_acertos.criar`): o modal do "Ajustar" do produto com o estoque da linha
 * fixo — tipo de estoque, nova quantidade, motivo e hora da contagem (padrão: agora) — que cria e efetiva um "Definir"
 * de um item com a origem `relatorio_estoque` (AJUSTE_RELATORIO). Não abre no "Todas" (a soma não é de um estoque), na
 * data-base (é o saldo de outro dia) nem no tipo de estoque inativo (não recebe acerto). Nos filtros "Zerado" e
 * "Abaixo do mínimo" vêm também os produtos sem movimento no estoque (saldo 0): o clique lança a contagem inicial.
 *
 * **"Ver movimentação"** (F2-B33; README do ERP › decisão 68, com `relatorios.movimentacao_estoque`): na linha de um
 * estoque (não no "Todas"), a Movimentação analítica do produto nesse local nos 30 dias até hoje ou até a data-base.
 */
export function EstoqueAtual() {
  const pode = usePode();
  const cliente = useQueryClient();
  const [params] = useSearchParams();
  const { lojaId } = useLojaContexto();
  const marcas = useMarcas();
  const categorias = useCategorias();
  const treino = useFiltroTreino();
  const estoques = useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    staleTime: 60_000,
  });
  const tipos = useQuery({
    queryKey: ['opcoes', 'tipos-estoque'],
    queryFn: () => apiErp.get<TipoEstoqueOpcao[]>('/tipos-estoque'),
    staleTime: 5 * 60_000,
  });
  const verCusto = pode('produtos.ver_custo');
  const podeAjustar = pode('estoque_acertos.criar');
  const verMovimentacao = pode('relatorios.movimentacao_estoque');
  const dataBase = params.get('dataBase');
  const comVencendo = params.has('vencendoEmDias');
  const [ajuste, setAjuste] = useState<LinhaEstoqueAtual | null>(null);
  // O estoque da loja de contexto (ERP 3.1: o filtro de loja começa nela); sem ela, ou fora dos permitidos, "Todas".
  const estoquePadrao = estoques.data?.itens.find((e) => lojaId && e.lojaId === lojaId)?.id ?? TODAS;

  const config = useMemo<ConfigRelatorio<LinhaEstoqueAtual>>(() => {
    // O tipo inativo não recebe ajuste (a API recusa o acerto nele): o saldo dele fica só o número, com a dica.
    const tiposInativos = new Set((tipos.data ?? []).filter((t) => !t.ativo).map((t) => t.id));
    const filtros: FiltroListagem[] = [
      { campo: 'nome', rotulo: 'Nome/código', tipo: 'texto', placeholder: 'Nome, código interno ou EAN' },
      {
        campo: 'estoqueId',
        rotulo: 'Loja (estoque)',
        tipo: 'selecao',
        padrao: estoquePadrao,
        opcoes: [
          { value: TODAS, label: 'Todas (soma dos permitidos)' },
          ...(estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome })),
        ],
      },
      {
        campo: 'marcaId',
        rotulo: 'Marca',
        tipo: 'selecao',
        opcoes: (marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao })),
      },
      {
        campo: 'categoriaId',
        rotulo: 'Departamento',
        tipo: 'selecao',
        placeholder: 'Todos (inclui os filhos)',
        opcoes: (categorias.data ?? [])
          .map((c) => ({ value: c.id, label: c.caminhoNomes }))
          .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
      },
      {
        campo: 'tipoEstoqueId',
        rotulo: 'Tipo de estoque',
        tipo: 'selecao',
        opcoes: (tipos.data ?? []).map((t) => ({ value: t.id, label: t.nome })),
      },
      {
        campo: 'situacaoSaldo',
        rotulo: 'Estoque',
        tipo: 'selecao',
        padrao: 'todos',
        opcoes: SITUACOES_SALDO.map((s) => ({ value: s, label: ROTULOS_SITUACAO_SALDO[s] })),
      },
      {
        campo: 'situacao',
        rotulo: 'Produtos',
        tipo: 'selecao',
        padrao: 'ativos',
        opcoes: [
          { value: 'ativos', label: 'Somente ativos' },
          { value: 'inativos', label: 'Somente inativos' },
          { value: 'todos', label: 'Todos' },
        ],
      },
      { campo: 'vencendoEmDias', rotulo: 'Vencendo em (dias)', tipo: 'numero', placeholder: 'Ex.: 30' },
      { campo: 'dataBase', rotulo: 'Saldo em (data-base)', tipo: 'data' },
    ];
    if (treino) filtros.push(treino);

    const colunas: ColunaRelatorio<LinhaEstoqueAtual>[] = [
      { campo: 'codigoInterno', rotulo: 'Ref. Interna', formato: (l) => l.codigoInterno ?? '—' },
      {
        campo: 'produto',
        rotulo: 'Produto',
        formato: (l) => (
          <Anchor component={Link} to={`${ROTA_PRODUTOS}/${l.produtoId}`} c="inherit" size="sm">
            {l.produtoCodigo} - {l.produtoNome}
          </Anchor>
        ),
      },
      ...(verCusto
        ? [
            {
              campo: 'custoMedio',
              rotulo: 'Preço Custo',
              alinhamento: 'right' as const,
              formato: (l: LinhaEstoqueAtual) => reais(l.custoMedio),
            },
          ]
        : []),
      { campo: 'precoVenda', rotulo: 'Venda', alinhamento: 'right', formato: (l) => reais(l.precoVenda) },
      {
        campo: 'precoAtacado',
        rotulo: 'Atacado',
        alinhamento: 'right',
        formato: (l) => reais(l.precoAtacado),
      },
      { campo: 'precoIfood', rotulo: 'iFood', alinhamento: 'right', formato: (l) => reais(l.precoIfood) },
      {
        campo: 'estoqueMinimo',
        rotulo: 'Est. Mínimo',
        alinhamento: 'right',
        formato: (l) => qtd(l.estoqueMinimo),
      },
      {
        campo: 'quantidade',
        rotulo: dataBase ? `Saldo em ${dataBr(dataBase)}` : 'Est. Atual',
        alinhamento: 'right',
        formato: (l) => (
          <SaldoClicavel
            linha={l}
            ajustavel={podeAjustar && !dataBase}
            tipoInativo={tiposInativos.has(l.tipoEstoqueId)}
            aoClicar={setAjuste}
          />
        ),
      },
      {
        campo: 'emTransito',
        rotulo: 'Em trânsito',
        alinhamento: 'right',
        formato: (l) => pendencia(l.emTransito),
      },
      {
        campo: 'divergenciaATratar',
        rotulo: 'Divergência a tratar',
        alinhamento: 'right',
        formato: (l) =>
          pendencia(l.divergenciaATratar) === '—' ? (
            '—'
          ) : (
            <Text span size="sm" c="orange">
              {qtd(l.divergenciaATratar)}
            </Text>
          ),
      },
      ...(comVencendo
        ? [
            {
              campo: 'vencendo',
              rotulo: 'Vencendo',
              alinhamento: 'right' as const,
              formato: (l: LinhaEstoqueAtual) =>
                l.vencendo ? (
                  <Text span size="sm" c="orange">
                    {qtd(l.vencendo.quantidade)} até {formatarData(l.vencendo.validade)}
                  </Text>
                ) : (
                  '—'
                ),
            },
          ]
        : []),
      ...(verCusto
        ? [
            {
              campo: 'custoTotal',
              rotulo: 'Custo total',
              alinhamento: 'right' as const,
              formato: (l: LinhaEstoqueAtual) => reais(l.custoTotal),
            },
          ]
        : []),
      {
        campo: 'vendaTotal',
        rotulo: 'Venda total',
        alinhamento: 'right',
        formato: (l) => reais(l.vendaTotal),
      },
      { campo: 'unidadeSigla', rotulo: 'Unidade', formato: (l) => l.unidadeSigla },
      { campo: 'estoqueNome', rotulo: 'Estoque', formato: (l) => l.estoqueNome },
      { campo: 'tipoEstoqueNome', rotulo: 'Tipo', formato: (l) => l.tipoEstoqueNome },
      // "Ver movimentação" (F2-B33): a analítica do produto no estoque da linha, nos 30 dias até hoje ou até a
      // data-base. No "Todas" a linha soma estoques, e a Movimentação é de um local só.
      ...(verMovimentacao
        ? [
            {
              campo: 'movimentacao',
              rotulo: 'Movimentação',
              formato: (l: LinhaEstoqueAtual) =>
                l.estoqueId ? (
                  <Anchor
                    component={Link}
                    to={linkVerMovimentacao({
                      estoqueId: l.estoqueId,
                      produtoId: l.produtoId,
                      dataFinal: dataBase,
                    })}
                    size="sm"
                    aria-label={`Ver movimentação de ${l.produtoNome} em ${l.estoqueNome}`}
                  >
                    Ver movimentação
                  </Anchor>
                ) : (
                  '—'
                ),
            },
          ]
        : []),
    ];

    return {
      nome: RELATORIO_ESTOQUE_ATUAL,
      titulo: 'Estoque Atual',
      filtros,
      colunas,
      paginacao: 'pagina',
      chaveLinha: (l) => l.chave,
      exportar: exportarPelaApi(RELATORIO_ESTOQUE_ATUAL),
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaEstoqueAtual>(`/relatorios/estoque-atual${query(p)}`, { sinal });
        return {
          linhas: r.itens,
          total: r.total,
          resumo: [
            ...(r.dataBase ? [{ rotulo: 'Saldo em', valor: dataBr(r.dataBase) }] : []),
            { rotulo: 'Itens', valor: formatarInteiro(r.totais.quantidadeItens) },
            ...(r.totais.custoTotal !== null
              ? [{ rotulo: 'Custo total', valor: reais(r.totais.custoTotal) }]
              : []),
            { rotulo: 'Venda total', valor: reais(r.totais.vendaTotal) },
          ],
          totais: {
            codigoInterno: `Total (${formatarInteiro(r.totais.quantidadeItens)} itens)`,
            ...(r.totais.custoTotal !== null ? { custoTotal: reais(r.totais.custoTotal) } : {}),
            vendaTotal: reais(r.totais.vendaTotal),
          },
        };
      },
    };
  }, [
    estoques.data,
    tipos.data,
    marcas.data,
    categorias.data,
    treino,
    estoquePadrao,
    verCusto,
    podeAjustar,
    verMovimentacao,
    dataBase,
    comVencendo,
  ]);

  return (
    <>
      <Relatorio config={config} />
      {ajuste && ajuste.estoqueId && (
        <ModalDoRelatorio
          linha={ajuste as LinhaEstoqueAtual & { estoqueId: string }}
          aoFechar={() => setAjuste(null)}
          aoAjustar={() => cliente.invalidateQueries({ queryKey: ['relatorio', RELATORIO_ESTOQUE_ATUAL] })}
        />
      )}
    </>
  );
}

/**
 * O saldo da linha: com o ajuste disponível, é o botão que abre o modal; no "Todas", na data-base e no tipo de
 * estoque inativo, só o número.
 */
function SaldoClicavel({
  linha,
  ajustavel,
  tipoInativo,
  aoClicar,
}: {
  linha: LinhaEstoqueAtual;
  ajustavel: boolean;
  tipoInativo: boolean;
  aoClicar: (l: LinhaEstoqueAtual) => void;
}) {
  const cor = Number(linha.quantidade) < 0 ? 'red' : undefined;
  const numero = (
    <Text span size="sm" fw={600} c={cor}>
      {qtd(linha.quantidade)}
    </Text>
  );
  if (!ajustavel) return numero;
  if (!linha.estoqueId)
    return <Tooltip label="A soma não é de um estoque: escolha a loja para ajustar">{numero}</Tooltip>;
  if (tipoInativo)
    return <Tooltip label="Tipo de estoque inativo: reative o tipo para ajustar">{numero}</Tooltip>;
  return (
    <Tooltip label="Ajustar o saldo">
      <UnstyledButton
        aria-label={`Ajustar o saldo de ${linha.produtoNome} em ${linha.estoqueNome} (${linha.tipoEstoqueNome})`}
        onClick={() => aoClicar(linha)}
        style={{ textDecoration: 'underline dotted' }}
      >
        {numero}
      </UnstyledButton>
    </Tooltip>
  );
}

/**
 * O modal de ajuste com a linha clicada: o estoque fixo, o tipo da linha e o saldo de cada tipo do produto nesse
 * estoque (o relatório filtrado no produto, para o "Saldo atual" acompanhar a troca do tipo).
 */
function ModalDoRelatorio({
  linha,
  aoFechar,
  aoAjustar,
}: {
  linha: LinhaEstoqueAtual & { estoqueId: string };
  aoFechar: () => void;
  aoAjustar: () => Promise<unknown>;
}) {
  const saldos = useQuery({
    queryKey: ['relatorio', RELATORIO_ESTOQUE_ATUAL, 'saldos-do-produto', linha.estoqueId, linha.produtoId],
    queryFn: () =>
      apiErp.get<RespostaEstoqueAtual>(
        `/relatorios/estoque-atual${query({
          estoqueId: linha.estoqueId,
          produtoId: linha.produtoId,
          situacao: 'todos',
          tamanho: '50',
        })}`,
      ),
  });
  const lista = (saldos.data?.itens ?? [linha]).map((l) => ({
    estoqueId: linha.estoqueId,
    tipoEstoqueId: l.tipoEstoqueId,
    quantidade: l.quantidade,
  }));
  return (
    <ModalAjustarEstoque
      aberto
      produtoId={linha.produtoId}
      saldos={lista}
      estoqueFixo={{ id: linha.estoqueId, nome: linha.estoqueNome }}
      tipoInicial={linha.tipoEstoqueId}
      nomeProduto={`${linha.produtoCodigo} - ${linha.produtoNome}`}
      titulo="Ajustar o saldo"
      rotuloGravar="Gravar"
      rotuloFechar="Fechar"
      enviar={(corpo: AjusteEstoqueProduto) =>
        apiErp.post<ResultadoAjusteProduto>('/relatorios/estoque-atual/ajustar', {
          ...corpo,
          produtoId: linha.produtoId,
        })
      }
      aoAjustar={aoAjustar}
      aoFechar={aoFechar}
    />
  );
}
