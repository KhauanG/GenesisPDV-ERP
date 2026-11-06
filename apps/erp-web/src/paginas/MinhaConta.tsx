import { Badge, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconKey } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useEu } from '../auth/sessao';

export function MinhaConta() {
  useDocumentTitle('Minha conta · GenesisPDV');
  const eu = useEu();
  const linhas: [string, ReactNode][] = [
    ['Nome', eu.usuario.nome],
    ['Login', eu.usuario.login],
    ['Código', eu.usuario.codigo],
    ['Empresa', `${eu.empresa.nome} (${eu.empresa.codigo})`],
    ['Tipo', eu.usuario.master ? <Badge key="m">Master</Badge> : 'Usuário'],
    ['Lojas', eu.todasLojas ? 'Todas' : eu.lojas.map((l) => l.nome).join(', ') || 'Nenhuma'],
    ['Permissões', `${eu.permissoes.length} permissões efetivas`],
  ];
  return (
    <Stack gap="md" maw={640}>
      <Group justify="space-between">
        <Title order={2} size="h3">
          Minha conta
        </Title>
        <Button
          component={Link}
          to="/minha-conta/senha"
          variant="default"
          leftSection={<IconKey size={16} />}
        >
          Trocar senha
        </Button>
      </Group>
      <Paper p="md">
        <Table>
          <Table.Tbody>
            {linhas.map(([rotulo, valor]) => (
              <Table.Tr key={rotulo}>
                <Table.Th w={160} scope="row">
                  <Text size="sm" c="dimmed">
                    {rotulo}
                  </Text>
                </Table.Th>
                <Table.Td>{valor}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
