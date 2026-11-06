import { dec, ROTULOS_STATUS_RECEBIMENTO, type RecebimentoDetalhe } from '@genesis/shared';
import { Alert, Button, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarData, formatarDataHora } from '../../util/formato';

const reais = (v: string) => `R$ ${formatarDecimal(Number(v), 2)}`;
const qtd = (v: string) => formatarDecimal(Number(v), 3);

/**
 * Espelho do recebimento (ERP 13.3 "Imprimir"; Fase 2, F2-B16; padrão "Impressão pelo navegador" do plano): o
 * documento como está gravado — cabeçalho, itens com embalagem, quantidade no estoque, preço de compra, rateio, custo
 * final, preço de venda e lote, e os totais —, impresso pelo navegador (ou salvo em PDF). Aberto pela tela do
 * recebimento em aba nova com `imprimir=1`, chama a impressão assim que os dados chegam; o cabeçalho e o menu do ERP
 * não saem no papel (`estilos.css`). Vale para o rascunho (conferência antes de movimentar) e para o movimentado.
 */
export function EspelhoRecebimento() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const doc = useQuery({
    queryKey: ['recebimentos', id],
    queryFn: () => apiErp.get<RecebimentoDetalhe>(`/recebimentos/${id}`),
    enabled: !!id,
  });
  const impresso = useRef(false);
  useEffect(() => {
    if (!doc.data || impresso.current || params.get('imprimir') !== '1') return;
    impresso.current = true;
    // jsdom não implementa a impressão; o navegador abre a caixa de diálogo depois de desenhar a tabela.
    if (typeof window.print === 'function') setTimeout(() => window.print(), 300);
  }, [doc.data, params]);

  if (doc.isPending) return <Loader />;
  if (doc.error) return <Alert color="red">{(doc.error as Error).message}</Alert>;
  const r = doc.data;
  const rateio = (i: RecebimentoDetalhe['itens'][number]) =>
    dec(i.rateioFrete).plus(i.rateioOutras).minus(i.rateioDesconto).toFixed(2);
  return (
    <Stack gap="sm" className="espelho-recebimento">
      <Group justify="space-between" className="nao-imprimir">
        <Text size="sm" c="dimmed">
          Use a impressão do navegador (ou salve em PDF).
        </Text>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </Group>
      <div>
        <Title order={3}>
          Espelho do recebimento Nº {r.codigo} – {ROTULOS_STATUS_RECEBIMENTO[r.status]}
        </Title>
        <Text size="sm">
          Fornecedor: {r.fornecedor.codigo} - {r.fornecedor.nome} · Data: {formatarData(r.dataRecebimento)}
          {r.codigoRemessa && ` · Cód. remessa: ${r.codigoRemessa}`}
        </Text>
        <Text size="sm">
          Loja: {r.lojaNome} · Estoque: {r.estoqueNome} · Tipo: {r.tipoEstoqueNome}
        </Text>
        {r.movimentadoEm && (
          <Text size="sm">
            Movimentado em {formatarDataHora(r.movimentadoEm)} por {r.movimentadoPorNome ?? '—'}.
          </Text>
        )}
        {r.estornadoEm && (
          <Text size="sm">
            Estornado em {formatarDataHora(r.estornadoEm)} por {r.estornadoPorNome ?? '—'}: {r.motivoEstorno}
          </Text>
        )}
        {r.status === 'rascunho' && (
          <Text size="sm" fw={500}>
            Rascunho: o estoque ainda não mudou; rateio e custo final são calculados ao movimentar.
          </Text>
        )}
      </div>
      <Table withTableBorder withColumnBorders verticalSpacing={4} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Produto</Table.Th>
            <Table.Th>Embalagem</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Quant.</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>No estoque</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Preço compra</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Total</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Rateio</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Custo final</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Preço venda</Table.Th>
            <Table.Th>Lote / validade</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {r.itens.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>{i.sequencia}</Table.Td>
              <Table.Td>
                {i.produto.codigo} - {i.produto.nome}
              </Table.Td>
              <Table.Td>
                {i.codigoBarrasId
                  ? `${i.unidadeCompra ?? 'Emb.'} × ${qtd(i.fator)}${i.codigoBarras ? ` (${i.codigoBarras})` : ''}`
                  : (i.unidadeCompra ?? i.produto.unidadeSigla)}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>{qtd(i.quantidade)}</Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {qtd(i.quantidadeEstoque)} {i.produto.unidadeSigla}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                R$ {formatarDecimal(Number(i.precoCompra), 4)}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>{reais(i.valorTotal)}</Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {r.status === 'rascunho' ? '—' : reais(rateio(i))}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {r.status === 'rascunho' ? '—' : `R$ ${formatarDecimal(Number(i.custoUnitarioFinal), 4)}`}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {i.precoVenda === null ? '—' : reais(i.precoVenda)}
                {i.atualizarPreco !== 'nao' && i.precoVenda !== null && (
                  <Text span size="xs">
                    {' '}
                    ({i.atualizarPreco === 'geral' ? 'geral' : 'loja'})
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                {[i.lote, i.validade && `val. ${formatarData(i.validade)}`].filter(Boolean).join(' · ') ||
                  '—'}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="flex-end" gap="xl" data-testid="totais-espelho">
        <Text size="sm">Itens: {r.qtdItens}</Text>
        <Text size="sm">Produtos: {reais(r.valorProdutos)}</Text>
        <Text size="sm">Frete: {reais(r.valorFrete)}</Text>
        <Text size="sm">Outras despesas: {reais(r.valorOutrasDespesas)}</Text>
        <Text size="sm">Desconto: {reais(r.valorDesconto)}</Text>
        <Text size="sm" fw={700}>
          Total geral: {reais(r.valorTotal)}
        </Text>
      </Group>
      {r.observacoes && <Text size="sm">Observações: {r.observacoes}</Text>}
      <Text size="sm" mt="xl">
        Conferido por: ______________________________ Data: ____/____/______
      </Text>
    </Stack>
  );
}
