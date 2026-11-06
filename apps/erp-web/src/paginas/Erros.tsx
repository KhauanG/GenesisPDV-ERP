import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { IconLock, IconMapOff } from '@tabler/icons-react';
import { Link } from 'react-router';

export function SemPermissao({ permissao }: { permissao?: string }) {
  return (
    <Center py={80}>
      <Stack align="center" gap="xs" maw={460} ta="center">
        <IconLock size={48} stroke={1.5} color="var(--mantine-color-red-6)" />
        <Title order={2} size="h3">
          Sem permissão
        </Title>
        <Text c="dimmed">
          Seu usuário não tem acesso a esta página{permissao ? ` (${permissao})` : ''}. Peça a um
          administrador da sua empresa para liberar o acesso.
        </Text>
        <Button component={Link} to="/" variant="light" mt="sm">
          Ir para o início
        </Button>
      </Stack>
    </Center>
  );
}

export function NaoEncontrado({ inicio = '/' }: { inicio?: string }) {
  return (
    <Center py={80}>
      <Stack align="center" gap="xs" maw={460} ta="center">
        <IconMapOff size={48} stroke={1.5} color="var(--mantine-color-gray-6)" />
        <Title order={2} size="h3">
          Página não encontrada
        </Title>
        <Text c="dimmed">O endereço digitado não existe ou foi removido.</Text>
        <Button component={Link} to={inicio} variant="light" mt="sm">
          Voltar ao início
        </Button>
      </Stack>
    </Center>
  );
}
