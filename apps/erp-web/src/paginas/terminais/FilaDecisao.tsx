import {
  aceitaNovoNumero,
  JUSTIFICATIVA_DESCARTE_MIN,
  type EventoComErro,
  type ResultadoReprocessamento,
} from '@genesis/shared';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Menu,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { ErroRequisicao } from '../../api/http';
import { TAMANHO_PAGINA_FILA, useAcoesFila, useEventosComErro, type FiltroFila } from '../../api/terminais';
import { formatarDataHora } from '../../util/formato';

/** ERP 12.5 "Retido aguardando qual evento": a sequência (e o tipo) do bloqueador, ou o início do id. */
const rotuloBloqueador = (b: EventoComErro['aguardando'][number]) =>
  b.sequencia !== null
    ? `o evento nº ${b.sequencia}${b.tipo ? ` (${b.tipo})` : ''}`
    : `o evento ${b.eventoId.slice(0, 8)}`;

const ROTULOS_STATUS = {
  aplicado: 'aplicado',
  retido: 'continua retido',
  erro: 'continua com erro',
} as const;

/** O desfecho do Reprocessar / Aplicar com novo número, numa frase (com os dependentes reaplicados em seguida). */
export function mensagemReprocessamento(r: ResultadoReprocessamento): string {
  const principal =
    r.status === 'aplicado'
      ? r.numero
        ? `Evento nº ${r.sequencia} aplicado como ${r.numero.novo} (número do caixa ${r.numero.original}).`
        : `Evento nº ${r.sequencia} aplicado.`
      : r.status === 'retido'
        ? `Evento nº ${r.sequencia} continua retido: ${r.erro ?? 'aguardando outro evento'}.`
        : `Evento nº ${r.sequencia} continua com erro ${r.erroCodigo}: ${r.erro ?? ''}`;
  if (!r.dependentes.length) return principal;
  const aplicados = r.dependentes.filter((d) => d.status === 'aplicado').length;
  const resto = r.dependentes
    .filter((d) => d.status !== 'aplicado')
    .map((d) => `nº ${d.sequencia} ${ROTULOS_STATUS[d.status]}`);
  return `${principal} ${aplicados} de ${r.dependentes.length} evento(s) que dependiam dele aplicados${
    resto.length ? ` (${resto.join(', ')})` : ''
  }.`;
}

/**
 * Aba "Eventos com erro" (ERP 12.5; SYNC 11.4), a fila de decisão: lista paginada com filtro por situação e código, o
 * resumo do agregado e, com `terminais.gerenciar`, as ações Reprocessar, Aplicar com novo número (só
 * `NUMERO_VENDA_DUPLICADO`), Descartar (justificativa e, nos tipos críticos, o número digitado) e Reprocessar todos
 * com o código (tarefa em segundo plano). O resultado volta ao PDV no heartbeat.
 */
export function EventosComErro({
  terminalId,
  gerenciar,
}: {
  terminalId: string;
  /** `terminais.gerenciar`: as ações e o payload. */
  gerenciar: boolean;
}) {
  const [filtro, setFiltro] = useState<FiltroFila>({ pagina: 1, status: null, codigo: null });
  const fila = useEventosComErro(terminalId, filtro);
  const acoes = useAcoesFila();
  const [payload, setPayload] = useState<EventoComErro | null>(null);
  const [descartando, setDescartando] = useState<EventoComErro | null>(null);
  const dados = fila.data;
  const paginas = Math.max(1, Math.ceil((dados?.total ?? 0) / TAMANHO_PAGINA_FILA));
  // A ação (ou o push, ou o lote) esvaziou a página atual: volta para a última que ainda tem eventos (ajuste no
  // próprio render, sem efeito; a condição deixa de valer com a página nova).
  const alemDaUltima = !!dados && dados.itens.length === 0 && dados.total > 0 && filtro.pagina > paginas;
  if (alemDaUltima) setFiltro({ ...filtro, pagina: paginas });
  const erro = (e: unknown) => notifications.show({ color: 'red', message: (e as Error).message });
  const resultado = (r: ResultadoReprocessamento) =>
    notifications.show({
      color: r.status === 'aplicado' ? 'green' : 'yellow',
      message: mensagemReprocessamento(r),
      autoClose: r.status === 'aplicado' ? 6000 : false,
    });

  const reprocessar = (e: EventoComErro) =>
    modals.openConfirmModal({
      title: `Reprocessar o evento nº ${e.sequencia}`,
      children: (
        <Text size="sm">
          O evento é aplicado de novo com o código atual (depois de corrigir o cadastro ou publicar a
          correção). Dando certo, os eventos retidos que dependem dele são aplicados em seguida, em ordem.
        </Text>
      ),
      labels: { confirm: 'Reprocessar', cancel: 'Cancelar' },
      onConfirm: () => acoes.reprocessar.mutate(e.id, { onSuccess: resultado, onError: erro }),
    });

  const novoNumero = (e: EventoComErro) =>
    modals.openConfirmModal({
      title: `Aplicar com novo número o evento nº ${e.sequencia}`,
      children: (
        <Text size="sm">
          O número desta venda já foi usado por outra venda do caixa. A nuvem grava a venda com o próximo
          número livre da faixa de renumeração do caixa e guarda o número original na observação e na
          auditoria. O cupom impresso continua com o número do caixa.
        </Text>
      ),
      labels: { confirm: 'Aplicar com novo número', cancel: 'Cancelar' },
      onConfirm: () => acoes.aplicarNovoNumero.mutate(e.id, { onSuccess: resultado, onError: erro }),
    });

  const lote = (codigo: string, quantidade: number) =>
    modals.openConfirmModal({
      title: `Reprocessar todos com ${codigo}`,
      children: (
        <Text size="sm">
          {quantidade} evento(s) com erro {codigo} deste terminal são reaplicados em segundo plano, em ordem
          (ex.: depois de publicar uma correção). Acompanhe pelo ícone Tarefas.
        </Text>
      ),
      labels: { confirm: 'Reprocessar todos', cancel: 'Cancelar' },
      onConfirm: () =>
        acoes.reprocessarLote.mutate(
          { terminalId, codigo },
          {
            onSuccess: (r) =>
              notifications.show({
                color: 'green',
                message: `Tarefa criada: ${r.quantidade} evento(s) com ${codigo} serão reprocessados.`,
              }),
            onError: erro,
          },
        ),
    });

  if (fila.isError) return <Alert color="red">{(fila.error as Error).message}</Alert>;
  if (!dados || alemDaUltima) return <Skeleton h={120} />;
  const filtrado = filtro.status !== null || filtro.codigo !== null;

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Group gap="xs" align="flex-end">
          <Select
            label="Situação"
            w={160}
            data={[
              { value: 'erro', label: 'Erro' },
              { value: 'retido', label: 'Retido' },
            ]}
            placeholder="Todas"
            clearable
            value={filtro.status}
            onChange={(v) => setFiltro({ ...filtro, pagina: 1, status: (v as FiltroFila['status']) ?? null })}
          />
          <Select
            label="Código do erro"
            w={260}
            data={dados.codigos.map((c) => ({ value: c.codigo, label: `${c.codigo} (${c.quantidade})` }))}
            placeholder="Todos"
            clearable
            value={filtro.codigo}
            onChange={(v) => setFiltro({ ...filtro, pagina: 1, codigo: v ?? null })}
          />
        </Group>
        {gerenciar && dados.codigos.length > 0 && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="default" rightSection={<IconChevronDown size={14} />}>
                Reprocessar todos com o código
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {dados.codigos.map((c) => (
                <Menu.Item key={c.codigo} onClick={() => lote(c.codigo, c.quantidade)}>
                  {c.codigo} ({c.quantidade})
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {dados.itens.length === 0 ? (
        <Text size="sm" c="dimmed">
          {filtrado ? 'Nenhum evento neste filtro.' : 'Nenhum evento com erro ou retido.'}
        </Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Sequência</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th>Data no PDV</Table.Th>
              <Table.Th>Situação</Table.Th>
              <Table.Th>Agregado</Table.Th>
              <Table.Th ta="right">Tentativas</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dados.itens.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td>{e.sequencia}</Table.Td>
                <Table.Td>
                  <Code>{e.tipo}</Code>
                </Table.Td>
                <Table.Td>{formatarDataHora(e.ocorridoEm)}</Table.Td>
                <Table.Td>
                  <Badge color={e.status === 'erro' ? 'red' : 'yellow'} variant="light" size="sm">
                    {e.status === 'erro' ? 'Erro' : 'Retido'}
                  </Badge>{' '}
                  <Text span size="xs">
                    {e.status === 'retido' && e.aguardando.length
                      ? `Aguardando ${e.aguardando.map(rotuloBloqueador).join(', ')}`
                      : `${e.erroCodigo ? `${e.erroCodigo}: ` : ''}${e.erro ?? ''}`}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{e.resumo ?? `${e.agregadoTipo} ${e.agregadoId.slice(0, 8)}`}</Text>
                </Table.Td>
                <Table.Td ta="right">{e.tentativas}</Table.Td>
                <Table.Td>
                  {gerenciar && (
                    // O menu da linha fica aberto até o clique fora, mesmo com a linha fora da área visível.
                    <Menu position="bottom-end" withinPortal hideDetached={false}>
                      <Menu.Target>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          rightSection={<IconChevronDown size={12} />}
                          aria-label={`Ações do evento ${e.sequencia}`}
                        >
                          Ações
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item onClick={() => reprocessar(e)}>Reprocessar</Menu.Item>
                        {aceitaNovoNumero(e) && (
                          <Menu.Item onClick={() => novoNumero(e)}>Aplicar com novo número</Menu.Item>
                        )}
                        <Menu.Item color="red" onClick={() => setDescartando(e)}>
                          Descartar
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item onClick={() => setPayload(e)}>Ver payload</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {(paginas > 1 || filtro.pagina > 1) && (
        <Group justify="flex-end">
          <Pagination
            size="sm"
            total={paginas}
            value={filtro.pagina}
            onChange={(pagina) => setFiltro({ ...filtro, pagina })}
          />
        </Group>
      )}
      <Modal
        opened={!!payload}
        onClose={() => setPayload(null)}
        title={`Evento ${payload?.sequencia ?? ''}`}
        size="xl"
      >
        {!!payload?.dependencias.length && (
          <Text size="sm" mb="xs">
            Depende de:{' '}
            {payload.dependencias.map((d) => `${d.agregadoTipo} ${d.agregadoId.slice(0, 8)}`).join(', ')}
          </Text>
        )}
        <Code block>{JSON.stringify(payload?.payload, null, 2)}</Code>
      </Modal>
      {descartando && (
        <DialogoDescartar
          evento={descartando}
          aoFechar={() => setDescartando(null)}
          enviando={acoes.descartar.isPending}
          aoConfirmar={(justificativa, confirmacao) =>
            acoes.descartar.mutate(
              { id: descartando.id, justificativa, confirmacao },
              {
                onSuccess: (r) => {
                  setDescartando(null);
                  notifications.show({
                    color: 'green',
                    message: r.dependentes.length
                      ? `Evento descartado. ${r.dependentes.length} evento(s) que dependiam dele foram para a fila com DEPENDENCIA_DESCARTADA.`
                      : 'Evento descartado.',
                  });
                },
                onError: (e) => {
                  // 409: outra pessoa resolveu o evento antes; a lista já foi recarregada sem ele.
                  if (e instanceof ErroRequisicao && e.status === 409) setDescartando(null);
                  erro(e);
                },
              },
            )
          }
        />
      )}
    </Stack>
  );
}

/**
 * Descartar (SYNC 11.4): justificativa de pelo menos 15 caracteres e, para `venda.*`/`caixa.*`/`nfce.*`, o número
 * exibido da venda (ou a sequência do evento de caixa) digitado — a API confere de novo.
 */
export function DialogoDescartar({
  evento,
  aoFechar,
  aoConfirmar,
  enviando,
}: {
  evento: EventoComErro;
  aoFechar: () => void;
  aoConfirmar: (justificativa: string, confirmacao: string | null) => void;
  enviando: boolean;
}) {
  const [justificativa, setJustificativa] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const exigida = evento.confirmacaoDescarte;
  const curta = justificativa.trim().length < JUSTIFICATIVA_DESCARTE_MIN;
  return (
    <Modal opened onClose={aoFechar} title={`Descartar o evento nº ${evento.sequencia}`}>
      <Stack gap="sm">
        <Alert color="red" variant="light">
          <Text size="sm">
            {evento.resumo ? `${evento.resumo}. ` : ''}O evento não será aplicado na nuvem, e o caixa recebe o
            descarte no próximo contato. Gera um alerta crítico, mostrado no detalhe do terminal e na listagem
            de terminais.
          </Text>
        </Alert>
        <Textarea
          label="Justificativa"
          description={`Pelo menos ${JUSTIFICATIVA_DESCARTE_MIN} caracteres; vai para a auditoria.`}
          maxLength={500}
          autosize
          minRows={3}
          value={justificativa}
          onChange={(e) => setJustificativa(e.currentTarget.value)}
        />
        {exigida && (
          <TextInput
            label={`Digite ${exigida} para confirmar`}
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.currentTarget.value)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={aoFechar}>
            Cancelar
          </Button>
          <Button
            color="red"
            disabled={curta || (!!exigida && !confirmacao.trim())}
            loading={enviando}
            onClick={() => aoConfirmar(justificativa.trim(), exigida ? confirmacao.trim() : null)}
          >
            Descartar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
