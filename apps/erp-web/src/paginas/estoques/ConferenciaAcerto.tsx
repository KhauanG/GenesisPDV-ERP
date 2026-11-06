import { ROTULOS_VEREDITO_CONFERENCIA, type AcertoDetalhe, type ConferenciaAcerto } from '@genesis/shared';
import { Alert, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarDataHora } from '../../util/formato';

const qtd = (v: string) => formatarDecimal(Number(v), 3);
const pct = (v: string | null) => (v === null ? '—' : `${formatarDecimal(Number(v), 2)}%`);
const reais = (v: string | null) => (v === null ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`);

/**
 * Aba "Conferência" do "Definir" (F2-B11; F2-Q6 = D47, decidida pelo dono em 05/11/2026, ajustável; README da API › decisão
 * 156): por item, o contado, o saldo do sistema na hora da contagem e a diferença a custo, e o veredito "Conferido" ou
 * "Fora da tolerância" pelos limites de Configurações › Estoque (total sobre o valor contado, e por item sobre o saldo
 * do próprio item). Os limites podem ser trocados aqui só para a consulta. No rascunho é uma estimativa (o saldo de
 * agora); efetivado, a venda offline anterior à contagem que chegou depois (a compensação) entra no saldo do sistema.
 */
export function AbaConferencia({ acerto, verCusto }: { acerto: AcertoDetalhe; verCusto: boolean }) {
  const [total, setTotal] = useState('');
  const [item, setItem] = useState('');
  const [limites, setLimites] = useState<{ toleranciaTotalPct?: string; toleranciaItemPct?: string }>({});
  const r = useQuery({
    queryKey: ['acertos', acerto.id, 'conferencia', acerto.versao, acerto.status, limites],
    queryFn: () => apiErp.get<ConferenciaAcerto>(`/acertos/${acerto.id}/conferencia${query(limites)}`),
  });
  const c = r.data;
  const aplicar = () =>
    setLimites({
      ...(total.trim() ? { toleranciaTotalPct: total.trim() } : {}),
      ...(item.trim() ? { toleranciaItemPct: item.trim() } : {}),
    });
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Contado × saldo do sistema na hora da contagem × diferença a custo. Conferido quando a soma das
        diferenças a custo (a sobra de um item não paga a falta de outro) fica dentro do limite total sobre o
        valor contado e nenhum item passa do limite sobre o próprio saldo. Os limites vêm de Configurações ›
        Estoque; os campos abaixo os trocam só nesta consulta.
      </Text>
      <Group align="end" gap="sm">
        <TextInput
          label="Tolerância total (%)"
          placeholder={c?.toleranciaTotalPct.replace('.', ',') ?? ''}
          value={total}
          onChange={(e) => setTotal(e.currentTarget.value)}
          w={170}
        />
        <TextInput
          label="Tolerância por item (%)"
          placeholder={c?.toleranciaItemPct.replace('.', ',') ?? ''}
          value={item}
          onChange={(e) => setItem(e.currentTarget.value)}
          w={170}
        />
        <Button variant="default" onClick={aplicar}>
          Recalcular
        </Button>
      </Group>
      {r.error && (
        <Alert color="red" role="alert">
          {r.error instanceof ErroRequisicao ? r.error.message : (r.error as Error).message}
        </Alert>
      )}
      {c && (
        <>
          {c.estimativa && (
            <Alert color="blue" icon={<IconInfoCircle size={18} />}>
              Rascunho: estimativa com o saldo de agora menos o que foi lançado depois da hora da contagem (
              {formatarDataHora(c.dataContagem)}). A efetivação refaz a conta.
            </Alert>
          )}
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} data-testid="totais-conferencia">
            <Paper withBorder p="xs">
              <Text size="xs" c="dimmed">
                Veredito
              </Text>
              <Badge
                size="lg"
                color={c.veredito === 'conferido' ? 'green' : 'red'}
                variant="light"
                data-testid="veredito-conferencia"
              >
                {ROTULOS_VEREDITO_CONFERENCIA[c.veredito]}
              </Badge>
            </Paper>
            {verCusto && <Total rotulo="Valor contado (custo)" valor={reais(c.valorContado)} />}
            {verCusto && <Total rotulo="Valor no sistema (custo)" valor={reais(c.valorSistema)} />}
            {verCusto && (
              <Total
                rotulo="Diferença a custo (sobra − falta)"
                valor={reais(c.valorDiferenca)}
                detalhe={`Soma dos módulos: ${reais(c.valorDiferencaAbsoluta)}`}
              />
            )}
            <Total
              rotulo={`Diferença total (limite ${pct(c.toleranciaTotalPct)})`}
              valor={pct(c.diferencaTotalPct)}
              fora={c.totalForaTolerancia}
            />
            <Total
              rotulo={`Itens acima de ${pct(c.toleranciaItemPct)}`}
              valor={c.itensForaTolerancia.toLocaleString('pt-BR')}
              fora={c.itensForaTolerancia > 0}
            />
          </SimpleGrid>
          {c.veredito === 'fora_tolerancia' && (
            <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
              Fora da tolerância: recontar os itens destacados (os primeiros da lista) antes de dar a loja
              como conferida. Item sem saldo no sistema e contado diferente de zero não tem percentual e fica
              fora.
            </Alert>
          )}
          <Table.ScrollContainer minWidth={900} mah={520}>
            <Table striped stickyHeader verticalSpacing={4} fz="sm" aria-label="Conferência por item">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Produto</Table.Th>
                  <Table.Th ta="right">Contado</Table.Th>
                  <Table.Th ta="right">Sistema na contagem</Table.Th>
                  <Table.Th ta="right">Diferença</Table.Th>
                  <Table.Th ta="right">%</Table.Th>
                  {verCusto && <Table.Th ta="right">Custo</Table.Th>}
                  {verCusto && <Table.Th ta="right">Diferença a custo</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {c.itens.map((i) => (
                  <Table.Tr
                    key={i.itemId}
                    data-testid={`conferencia-${i.produtoId}`}
                    data-fora={i.foraTolerancia || undefined}
                    bg={i.foraTolerancia ? 'var(--mantine-color-red-light)' : undefined}
                  >
                    <Table.Td>
                      {i.produtoCodigo} · {i.produtoNome}
                    </Table.Td>
                    <Table.Td ta="right">
                      {qtd(i.contado)} {i.unidadeSigla}
                    </Table.Td>
                    <Table.Td ta="right">
                      {qtd(i.saldoSistema)}
                      {Number(i.compensado) !== 0 && (
                        <Text size="xs" c="dimmed">
                          com {qtd(i.compensado)} de venda(s) tardia(s) compensada(s)
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">{qtd(i.diferenca)}</Table.Td>
                    <Table.Td ta="right" fw={i.foraTolerancia ? 700 : undefined}>
                      {pct(i.diferencaPct)}
                    </Table.Td>
                    {verCusto && (
                      <Table.Td ta="right">
                        {i.custoUnitario === null ? '—' : `R$ ${formatarDecimal(Number(i.custoUnitario), 4)}`}
                      </Table.Td>
                    )}
                    {verCusto && <Table.Td ta="right">{reais(i.valorDiferenca)}</Table.Td>}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      )}
    </Stack>
  );
}

function Total({
  rotulo,
  valor,
  detalhe,
  fora,
}: {
  rotulo: string;
  valor: string;
  detalhe?: string;
  fora?: boolean;
}) {
  return (
    <Paper withBorder p="xs">
      <Text size="xs" c="dimmed">
        {rotulo}
      </Text>
      <Text fw={700} size="lg" c={fora ? 'red' : undefined}>
        {valor}
      </Text>
      {detalhe && (
        <Text size="xs" c="dimmed">
          {detalhe}
        </Text>
      )}
    </Paper>
  );
}
