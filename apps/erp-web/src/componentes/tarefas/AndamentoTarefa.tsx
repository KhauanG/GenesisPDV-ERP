import type { TarefaUsuario } from '@genesis/shared';
import { Alert, Button, Group, Progress, Stack, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { erroDefinitivo } from './tarefas';

/**
 * O andamento de uma tarefa em segundo plano na tela que a pediu (ERP 3.6; F2-B30): a barra de progresso com a
 * mensagem enquanto está na fila ou executando, o motivo quando falha e, no fim, o que a tela quiser mostrar
 * (`children`: o resumo da importação, o link do arquivo…). O mesmo da Importação, do upload de NF-e e da exportação
 * dos relatórios; o ícone Tarefas do cabeçalho mostra as mesmas tarefas.
 *
 * Quando a consulta falha no meio do andamento (sem conexão, a API reiniciando), o aviso aparece acima da barra, que
 * fica no último andamento conhecido, com "Tentar novamente"; a consulta também se repete sozinha, mais devagar
 * (`useTarefa`), e o aviso some quando ela volta a responder.
 */
export function AndamentoTarefa({
  tarefa,
  erroConsulta,
  aoTentarNovamente,
  tentando = false,
  rotulo,
  aviso,
  children,
}: {
  tarefa: TarefaUsuario<unknown> | undefined;
  /** A consulta da tarefa falhou (sem conexão, por exemplo). */
  erroConsulta?: Error | null;
  /** Consulta a tarefa de novo (o `refetch` do `useTarefa`): o botão "Tentar novamente" do aviso de falha. */
  aoTentarNovamente?: () => void;
  /** A consulta está em andamento (o botão fica carregando). */
  tentando?: boolean;
  /** O que a tarefa faz, no feminino e em minúsculas: "importação", "exportação". */
  rotulo: string;
  /** Texto depois da mensagem de andamento (ex.: "Você pode sair desta tela: a importação continua."). */
  aviso?: ReactNode;
  /** O conteúdo da tarefa concluída. */
  children?: ReactNode;
}) {
  if (tarefa?.status === 'concluida') return <>{children}</>;
  if (tarefa?.status === 'falhou')
    return (
      <Alert color="red" role="alert" title={`A ${rotulo} falhou`}>
        {tarefa.erro}
      </Alert>
    );
  if (tarefa?.status === 'cancelada')
    return (
      <Alert color="gray" title={`A ${rotulo} foi cancelada`}>
        {tarefa.erro ?? tarefa.mensagem}
      </Alert>
    );
  const falha = erroConsulta ? (
    <Alert color="red" role="alert" title={`Não foi possível acompanhar a ${rotulo}`}>
      <Text size="sm">
        {erroConsulta.message}
        {erroDefinitivo(erroConsulta)
          ? null
          : tarefa
            ? ` O andamento abaixo é o último recebido; a ${rotulo} continua no servidor e a tela tenta de novo sozinha.`
            : ' A tela tenta de novo sozinha.'}
      </Text>
      {aoTentarNovamente && (
        <Button size="compact-sm" variant="subtle" mt={4} loading={tentando} onClick={aoTentarNovamente}>
          Tentar novamente
        </Button>
      )}
    </Alert>
  ) : null;
  if (falha && !tarefa) return falha;
  return (
    <Stack gap={4}>
      {falha}
      <Progress value={tarefa?.progressoPct ?? 0} animated aria-label={`Progresso da ${rotulo}`} />
      <Text size="sm" c="dimmed">
        {tarefa?.mensagem ?? 'Na fila…'}
        {aviso ? <> {aviso}</> : null}
      </Text>
    </Stack>
  );
}

/** O botão de download do arquivo da tarefa, ou o aviso de que ele expirou (passou da retenção, ERP 3.6). */
export function DownloadTarefa({
  tarefa,
  rotulo,
  rotuloExpirado,
}: {
  tarefa: Pick<TarefaUsuario, 'download' | 'downloadExpirado'>;
  rotulo: string;
  rotuloExpirado: string;
}) {
  if (tarefa.download)
    return (
      <Group>
        <Button
          component="a"
          href={tarefa.download}
          variant="default"
          leftSection={<IconDownload size={16} />}
        >
          {rotulo}
        </Button>
      </Group>
    );
  if (tarefa.downloadExpirado)
    return (
      <Text size="sm" c="dimmed">
        {rotuloExpirado}
      </Text>
    );
  return null;
}
