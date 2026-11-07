import {
  ROTULOS_STATUS_TAREFA,
  ROTULOS_TIPO_TAREFA,
  tarefaEmAndamento,
  type StatusTarefa,
  type TarefaUsuario,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Indicator,
  Popover,
  Progress,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconListCheck, IconRefresh } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { formatarDataHora, formatarInteiro } from '../../util/formato';
import { useTarefas } from './tarefas';

/**
 * Permissões que criam tarefa em segundo plano em nome do usuário (ERP 3.6): quem não tem nenhuma (e não é Master)
 * não vê o ícone, e o ERP nem consulta `GET /tarefas`. `pdv.config.fiscal` é a de quem autoriza a faixa de numeração
 * no PDV (o reprocessamento depois da lacuna sai em nome dele). Tipo novo de tarefa com outra permissão entra aqui.
 */
export const PERMISSOES_COM_TAREFA = [
  'relatorios.exportar',
  'produtos.importar',
  'pessoas.importar',
  'notas_entrada.importar',
  'terminais.gerenciar',
  'pdv.config.fiscal',
] as const;

const CORES_STATUS: Record<StatusTarefa, string> = {
  na_fila: 'gray',
  executando: 'blue',
  concluida: 'green',
  falhou: 'red',
  cancelada: 'gray',
};

/** O que a tarefa gerou, numa linha (o nome do arquivo da exportação, quando houver). */
function detalheResultado(t: TarefaUsuario): string | null {
  const r = t.resultado as { nomeArquivo?: unknown; linhas?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  const partes: string[] = [];
  if (typeof r.nomeArquivo === 'string') partes.push(r.nomeArquivo);
  if (typeof r.linhas === 'number') partes.push(`${formatarInteiro(r.linhas)} linha(s)`);
  return partes.length ? partes.join(' · ') : null;
}

const rotuloTipo = (tipo: string) => ROTULOS_TIPO_TAREFA[tipo] ?? tipo;

/**
 * Ícone **Tarefas** do cabeçalho (ERP 3.6, 5.1; F2-B30; README do ERP › decisão 65): o contador das tarefas do
 * usuário na fila ou executando e o painel com as 50 mais recentes, o andamento, o motivo da falha e o link do
 * arquivo (7 dias, sem passar da retenção dele; expirado, avisa). Consulta `GET /tarefas` uma vez ao abrir o ERP e
 * só repete enquanto houver tarefa em andamento ou com o painel aberto (`useTarefas`; depois de uma falha passageira,
 * mais devagar, e o painel avisa com "Tentar novamente" mesmo mostrando a última lista); quando uma tarefa vista em
 * andamento termina, avisa numa notificação. Só para quem tem alguma permissão que cria tarefa
 * (`PERMISSOES_COM_TAREFA`).
 */
export function IconeTarefas() {
  const eu = useEu();
  const pode = usePode();
  const [aberto, setAberto] = useState(false);
  const comPermissao = eu.usuario.master || PERMISSOES_COM_TAREFA.some((p) => pode(p));
  const tarefas = useTarefas({ aberto, habilitada: comPermissao });
  const dados = tarefas.data;
  useAvisoAoTerminar(dados?.itens);

  if (!comPermissao) return null;
  const pendentes = dados?.pendentes ?? 0;

  return (
    <Popover
      opened={aberto}
      onChange={setAberto}
      position="bottom-end"
      width={360}
      shadow="md"
      withinPortal
      trapFocus={false}
      // O cabeçalho é fixo: o painel não precisa sumir com o ícone fora da tela (e o jsdom não mede o ícone).
      hideDetached={false}
    >
      <Popover.Target>
        <Tooltip label="Tarefas">
          <Indicator
            label={pendentes}
            disabled={pendentes === 0}
            size={16}
            offset={4}
            color="blue"
            processing
          >
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={pendentes ? `Tarefas: ${pendentes} em andamento` : 'Tarefas'}
              aria-expanded={aberto}
              onClick={() => {
                if (!aberto) void tarefas.refetch();
                setAberto((a) => !a);
              }}
            >
              <IconListCheck size={18} />
            </ActionIcon>
          </Indicator>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Stack gap="xs" role="region" aria-label="Painel de tarefas">
          <Group justify="space-between" px={4}>
            <Text fw={600} size="sm">
              Tarefas
            </Text>
            <Tooltip label="Atualizar">
              <ActionIcon
                variant="subtle"
                size="sm"
                aria-label="Atualizar tarefas"
                loading={tarefas.isFetching}
                onClick={() => void tarefas.refetch()}
              >
                <IconRefresh size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          {tarefas.isError && (
            <Alert color="red" p="xs">
              <Text size="sm">
                {dados
                  ? 'Não foi possível atualizar as tarefas: a lista abaixo é a última recebida.'
                  : 'Não foi possível carregar as tarefas.'}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                mt={4}
                loading={tarefas.isFetching}
                onClick={() => void tarefas.refetch()}
              >
                Tentar novamente
              </Button>
            </Alert>
          )}
          {dados && dados.itens.length === 0 && (
            <Text size="sm" c="dimmed" px={4} py="sm">
              Nenhuma tarefa ainda. Importações e exportações grandes aparecem aqui.
            </Text>
          )}
          {dados && dados.itens.length > 0 && (
            <Stack gap={6} mah={420} style={{ overflowY: 'auto' }}>
              {dados.itens.map((t) => (
                <ItemTarefa key={t.id} tarefa={t} />
              ))}
            </Stack>
          )}
          <Text size="xs" c="dimmed" px={4}>
            As 50 mais recentes. O arquivo gerado pode ser baixado por 7 dias.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function ItemTarefa({ tarefa: t }: { tarefa: TarefaUsuario }) {
  const detalhe = t.status === 'concluida' ? detalheResultado(t) : null;
  return (
    <Stack
      gap={4}
      p={8}
      data-testid={`tarefa-${t.id}`}
      style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 6 }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={500} truncate>
          {rotuloTipo(t.tipo)}
        </Text>
        <Badge size="sm" variant="light" color={CORES_STATUS[t.status]} miw="fit-content">
          {ROTULOS_STATUS_TAREFA[t.status]}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {formatarDataHora(t.criadoEm)}
        {detalhe ? ` · ${detalhe}` : ''}
      </Text>
      {tarefaEmAndamento(t) && (
        <>
          <Progress
            value={t.progressoPct}
            size="sm"
            animated
            aria-label={`Progresso: ${rotuloTipo(t.tipo)}`}
          />
          <Text size="xs" c="dimmed">
            {t.mensagem ?? 'Na fila…'}
          </Text>
        </>
      )}
      {t.status === 'falhou' && t.erro && (
        <Text size="xs" c="red">
          {t.erro}
        </Text>
      )}
      {t.download && (
        <Anchor href={t.download} size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconDownload size={14} /> Baixar arquivo
        </Anchor>
      )}
      {t.downloadExpirado && (
        <Text size="xs" c="dimmed">
          O arquivo expirou e não pode mais ser baixado.
        </Text>
      )}
    </Stack>
  );
}

/** Notificação quando uma tarefa vista em andamento nesta sessão termina (ERP 3.6: "recebe notificação ao concluir"). */
function useAvisoAoTerminar(itens: TarefaUsuario[] | undefined) {
  const emAndamento = useRef(new Set<string>());
  useEffect(() => {
    if (!itens) return;
    const agora = new Set<string>();
    for (const t of itens) {
      if (tarefaEmAndamento(t)) agora.add(t.id);
      else if (emAndamento.current.has(t.id)) {
        const ok = t.status === 'concluida';
        notifications.show({
          color: ok ? 'green' : 'red',
          title: `${rotuloTipo(t.tipo)}: ${ROTULOS_STATUS_TAREFA[t.status].toLowerCase()}`,
          message: ok
            ? t.download
              ? 'O arquivo está no ícone Tarefas.'
              : 'Detalhes no ícone Tarefas.'
            : (t.erro ?? 'Detalhes no ícone Tarefas.'),
        });
      }
    }
    emAndamento.current = agora;
  }, [itens]);
}
