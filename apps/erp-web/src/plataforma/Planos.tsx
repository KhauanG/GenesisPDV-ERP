import type { Pagina, PlanoResumo } from '@genesis/shared';
import { Alert, Badge, Group, Paper, Skeleton, Table, Text, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { apiPlataforma } from '../api/clientes';

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Módulos incluídos: `recursos` é um objeto `{ modulo: true | false | lista }` (MD 2.1). */
function modulos(recursos: unknown): string[] {
  if (!recursos || typeof recursos !== 'object' || Array.isArray(recursos)) return [];
  return Object.entries(recursos as Record<string, unknown>)
    .filter(([, v]) => v !== false && v !== null)
    .map(([k]) => k);
}

/** Painel › Planos (ERP 19.8): limites padrão e módulos de cada plano. */
export function Planos() {
  useDocumentTitle('Planos · Plataforma');
  const r = useQuery({
    queryKey: ['plataforma', 'planos'],
    queryFn: () => apiPlataforma.get<Pagina<PlanoResumo>>('/planos'),
  });

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={2} size="h3">
          Planos
        </Title>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Limites padrão de cada plano. A empresa usa os do plano, salvo quando tem um limite próprio.
      </Text>
      {r.isError && <Alert color="red">{(r.error as Error).message}</Alert>}
      <Paper p={0} style={{ overflow: 'hidden' }}>
        <Table.ScrollContainer minWidth={760}>
          <Table striped="even" aria-label="Planos">
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Código</Table.Th>
                <Table.Th scope="col">Nome</Table.Th>
                <Table.Th scope="col">Descrição</Table.Th>
                <Table.Th scope="col" ta="right">
                  Lojas
                </Table.Th>
                <Table.Th scope="col" ta="right">
                  Terminais
                </Table.Th>
                <Table.Th scope="col" ta="right">
                  Usuários
                </Table.Th>
                <Table.Th scope="col">Módulos</Table.Th>
                <Table.Th scope="col" ta="right">
                  Valor mensal
                </Table.Th>
                <Table.Th scope="col">Situação</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.isPending
                ? Array.from({ length: 3 }, (_, i) => (
                    <Table.Tr key={i}>
                      <Table.Td colSpan={9}>
                        <Skeleton h={14} />
                      </Table.Td>
                    </Table.Tr>
                  ))
                : (r.data?.itens ?? []).map((p) => (
                    <Table.Tr key={p.id}>
                      <Table.Td>{p.codigo}</Table.Td>
                      <Table.Td fw={500}>{p.nome}</Table.Td>
                      <Table.Td>{p.descricao ?? '—'}</Table.Td>
                      <Table.Td ta="right">{p.limiteLojas}</Table.Td>
                      <Table.Td ta="right">{p.limiteTerminais}</Table.Td>
                      <Table.Td ta="right">{p.limiteUsuarios ?? 'Sem limite'}</Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {modulos(p.recursos).map((m) => (
                            <Badge key={m} variant="light" size="sm">
                              {m}
                            </Badge>
                          ))}
                          {modulos(p.recursos).length === 0 && '—'}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">{moeda.format(Number(p.precoMensal))}</Table.Td>
                      <Table.Td>
                        <Badge color={p.ativo ? 'green' : 'gray'} variant="light">
                          {p.ativo ? 'Ativo' : 'Inativo'}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {r.data?.itens.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            Nenhum plano cadastrado.
          </Text>
        )}
      </Paper>
    </>
  );
}
