import { Badge, Center, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconTools } from '@tabler/icons-react';
import type { ItemMenu } from '../menu';

/** Placeholder das telas do menu que ainda não foram entregues (a fase vem do roadmap). */
export function EmConstrucao({ item }: { item: ItemMenu }) {
  useDocumentTitle(`${item.rotulo} · GenesisPDV`);
  return (
    <Center py={60}>
      <Paper p="xl" maw={520} w="100%">
        <Stack align="center" ta="center" gap="sm">
          <ThemeIcon size={64} radius="xl" variant="light">
            <IconTools size={34} stroke={1.5} />
          </ThemeIcon>
          <Title order={2} size="h3">
            {item.rotulo}
          </Title>
          <Badge variant="light" size="lg">
            Em construção · {item.fase}
          </Badge>
          <Text c="dimmed">
            Esta tela ainda está sendo construída e chega na <strong>{item.fase}</strong> do roadmap. Enquanto
            isso, as demais áreas liberadas para o seu usuário continuam disponíveis no menu.
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
