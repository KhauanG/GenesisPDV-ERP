import { Alert, Button, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/**
 * Aviso do "Sair" que o servidor não confirmou (README do ERP › decisão 82). Também no login da plataforma.
 * O navegador já está fechado (nada renova a sessão pelo cookie); o botão e as novas tentativas automáticas encerram
 * a sessão no servidor.
 */
export function AvisoSaidaPendente({ tentando, tentar }: { tentando: boolean; tentar: () => Promise<void> }) {
  return (
    <Alert color="orange" icon={<IconAlertTriangle size={18} />} role="alert" title="Saída não concluída">
      <Stack gap="xs">
        <Text size="sm">
          A saída não foi confirmada pelo servidor (sem conexão ou erro). Neste navegador a sessão já está
          fechada, e o sistema tenta encerrá-la de novo sozinho. Se for usar o computador com outro usuário,
          entre normalmente.
        </Text>
        <Button size="xs" variant="light" color="orange" loading={tentando} onClick={() => void tentar()}>
          Tentar sair de novo
        </Button>
      </Stack>
    </Alert>
  );
}
