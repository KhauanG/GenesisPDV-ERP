import {
  ROTULOS_SITUACAO_SALDO,
  SITUACOES_SALDO,
  type EstoqueResumo,
  type Pagina,
  type PaginaSaldos,
  type SaldoEstoqueLinha,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import { Anchor, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { formatarDataHora, formatarInteiro } from '../../util/formato';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';
import { ROTA_ACERTOS } from './Acertos';
import { OPCOES_SITUACAO } from './Estoques';

export const ROTA_SALDOS = '/estoque/saldos';

const reais = (v: string | null) => (v === null ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`);
const qtd = (v: string | null) => (v === null ? '—' : formatarDecimal(Number(v), 3));
/** Em trânsito e divergência: zero é "—" (quase toda linha não tem pendência). */
const pendencia = (v: string) => (Number(v) === 0 ? '—' : qtd(v));

/**
 * Saldos de estoque – consulta simples (ERP 8.2.11; 16.4 sem o ajuste no clique e a data-base, que chegam com o
 * relatório Estoque Atual da Fase 2): saldo por estoque × tipo, custo médio, totais a custo e a venda. F2-B26: o "Em
 * trânsito" (enviado para o estoque e ainda não recebido; a linha aparece também sem saldo lançado) e a "Divergência a
 * tratar" (a diferença recebida a menor, na origem), no tipo de cada linha e só dos estoques permitidos (a API filtra).
 */
export function ListaSaldos() {
  const pode = usePode();
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
  const config = useMemo<ConfigListagem<SaldoEstoqueLinha>>(
    () => ({
      recurso: 'estoque_saldos',
      titulo: 'Saldos de estoque',
      ordenacaoPadrao: 'produto:asc',
      rotaNovo: `${ROTA_ACERTOS}/novo`,
      rotuloNovo: 'Novo acerto',
      permissaoNovo: 'estoque_acertos.criar',
      rotaEdicao: (s) => `${ROTA_PRODUTOS}/${s.produtoId}`,
      chaveLinha: (s) => s.chave,
      filtros: [
        { campo: 'nome', rotulo: 'Nome/código', tipo: 'texto', placeholder: 'Nome, código interno ou EAN' },
        {
          campo: 'estoqueId',
          rotulo: 'Estoque',
          tipo: 'selecao',
          opcoes: (estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome })),
        },
        {
          campo: 'tipoEstoqueId',
          rotulo: 'Tipo de estoque',
          tipo: 'selecao',
          opcoes: (tipos.data ?? []).map((t) => ({ value: t.id, label: t.nome })),
        },
        {
          campo: 'situacaoSaldo',
          rotulo: 'Situação do saldo',
          tipo: 'selecao',
          padrao: 'todos',
          opcoes: SITUACOES_SALDO.map((s) => ({ value: s, label: ROTULOS_SITUACAO_SALDO[s] })),
        },
        { campo: 'situacao', rotulo: 'Produtos', tipo: 'selecao', padrao: 'ativos', opcoes: OPCOES_SITUACAO },
        {
          campo: 'incluirSemMovimento',
          rotulo: 'Sem movimento',
          tipo: 'selecao',
          padrao: 'false',
          opcoes: [
            { value: 'false', label: 'Só com saldo lançado' },
            { value: 'true', label: 'Incluir produtos sem movimento' },
          ],
        },
      ],
      colunas: [
        {
          campo: 'codigo_interno',
          rotulo: 'Ref. interna',
          ordenavel: true,
          formato: (s) => s.codigoInterno ?? '—',
        },
        {
          campo: 'produto',
          rotulo: 'Produto',
          ordenavel: true,
          formato: (s) => (
            <Anchor component={Link} to={`${ROTA_PRODUTOS}/${s.produtoId}`} c="inherit">
              {s.produtoCodigo} - {s.produtoNome}
            </Anchor>
          ),
        },
        { campo: 'estoque', rotulo: 'Estoque', ordenavel: true, formato: (s) => s.estoqueNome },
        { campo: 'tipoEstoqueNome', rotulo: 'Tipo', formato: (s) => s.tipoEstoqueNome ?? '—' },
        {
          campo: 'estoqueMinimo',
          rotulo: 'Est. mínimo',
          alinhamento: 'right',
          formato: (s) => qtd(s.estoqueMinimo),
        },
        {
          campo: 'quantidade',
          rotulo: 'Est. atual',
          ordenavel: true,
          alinhamento: 'right',
          formato: (s) => (
            <Text
              span
              size="sm"
              fw={600}
              c={
                Number(s.quantidade) < 0
                  ? 'red'
                  : s.estoqueMinimo !== null && Number(s.quantidade) < Number(s.estoqueMinimo)
                    ? 'orange'
                    : undefined
              }
            >
              {qtd(s.quantidade)}
            </Text>
          ),
        },
        {
          campo: 'emTransito',
          rotulo: 'Em trânsito',
          alinhamento: 'right',
          formato: (s) => pendencia(s.emTransito),
        },
        {
          campo: 'divergenciaATratar',
          rotulo: 'Divergência a tratar',
          alinhamento: 'right',
          formato: (s) =>
            Number(s.divergenciaATratar) === 0 ? (
              '—'
            ) : (
              <Text span size="sm" c="orange">
                {qtd(s.divergenciaATratar)}
              </Text>
            ),
        },
        { campo: 'unidadeSigla', rotulo: 'Un.', formato: (s) => s.unidadeSigla },
        {
          campo: 'custo_medio',
          rotulo: 'Custo médio',
          ordenavel: true,
          alinhamento: 'right',
          permissao: 'produtos.ver_custo',
          formato: (s) => reais(s.custoMedio),
        },
        {
          campo: 'custo_total',
          rotulo: 'Custo total',
          ordenavel: true,
          alinhamento: 'right',
          permissao: 'produtos.ver_custo',
          formato: (s) => reais(s.custoTotal),
        },
        { campo: 'precoVenda', rotulo: 'Venda', alinhamento: 'right', formato: (s) => reais(s.precoVenda) },
        {
          campo: 'venda_total',
          rotulo: 'Venda total',
          ordenavel: true,
          alinhamento: 'right',
          formato: (s) => reais(s.vendaTotal),
        },
        {
          campo: 'ultimaEntradaEm',
          rotulo: 'Última entrada',
          formato: (s) => formatarDataHora(s.ultimaEntradaEm),
        },
      ],
      buscar: (params, sinal) => apiErp.get<PaginaSaldos>(`/saldos-estoque${query(params)}`, { sinal }),
      rodape: (p) => {
        const t = (p as PaginaSaldos).totais;
        return (
          <Group justify="flex-end" gap="xl" data-testid="totais-saldos">
            <Text size="sm">
              Itens: <b>{formatarInteiro(t.quantidadeItens)}</b>
            </Text>
            {verCusto && (
              <Text size="sm">
                Custo total: <b>{reais(t.custoTotal)}</b>
              </Text>
            )}
            <Text size="sm">
              Venda total: <b>{reais(t.vendaTotal)}</b>
            </Text>
          </Group>
        );
      },
    }),
    [estoques.data, tipos.data, verCusto],
  );
  return <Listagem config={config} />;
}
