import {
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_RELOGIO_DESVIO,
  ALERTA_RELOGIO_SUSPEITO,
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  type AtivacaoPendente,
  type StatusConexao,
  type TerminalResumo,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconAlertTriangle, IconLock, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ROTA_TERMINAIS,
  useAcoesTerminais,
  useAtivacoesPendentes,
  useTerminais,
  type FiltroTela,
} from '../../api/terminais';
import { SeletorLoja } from '../../componentes/seletores';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarDataHora, formatarInteiro } from '../../util/formato';
import { ModalGerarCodigo } from './ModalGerarCodigo';
import {
  BadgeStatus,
  CONEXAO,
  Conexao,
  corDoAlerta,
  DesvioRelogio,
  numeroCaixa,
  OPCOES_CONEXAO,
  OPCOES_SITUACAO,
  rotuloTerminal,
} from './rotulos';

/** Alertas que levam ao detalhe do terminal (os demais, à aba "Eventos com erro"). */
const ALERTAS_DO_TERMINAL: readonly string[] = [
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_RELOGIO_SUSPEITO,
  ALERTA_RELOGIO_DESVIO,
];

/**
 * PDVs / Terminais – listagem (ERP 12.2): topo com "Gerar código de ativação", contadores por conexão, faixa de
 * bloqueio com "Liberar ativações", alertas abertos (D20, força bruta, token anterior, relógio) e códigos pendentes;
 * filtros na URL e as colunas da 12.2, mais a "Relógio" da SYNC 21.2 (C16). Tudo se atualiza a cada 30 s.
 */
export function ListagemTerminais() {
  useDocumentTitle('PDVs / Terminais · GenesisPDV');
  const { lojaId: lojaContexto } = useLojaContexto();
  const [params, setParams] = useSearchParams();
  const filtro: FiltroTela = {
    lojaId: params.has('lojaId') ? params.get('lojaId') || null : lojaContexto,
    situacao: params.get('situacao') ?? 'ativos',
    conexao: params.get('conexao') ?? 'todos',
    versaoApp: params.get('versaoApp') ?? '',
  };
  const definir = (campo: keyof FiltroTela, valor: string | null) => {
    const novo = new URLSearchParams(params);
    novo.set(campo, valor ?? '');
    setParams(novo, { replace: true });
  };
  const lista = useTerminais(filtro);
  const ativacoes = useAtivacoesPendentes();
  const acoes = useAcoesTerminais();
  const { pode } = acoes;
  const [gerando, setGerando] = useState(false);
  const d = lista.data;
  const bloqueio = ativacoes.data?.bloqueio;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <Title order={2} size="h3">
          PDVs / Terminais
        </Title>
        {pode('terminais.ativar') && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setGerando(true)}>
            Gerar código de ativação
          </Button>
        )}
      </Group>

      {bloqueio?.bloqueado && (
        <Alert color="red" icon={<IconLock size={18} />} title="Ativações temporariamente bloqueadas">
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">
              {bloqueio.falhas} tentativas com código errado na última hora. Nenhum PDV ativa até{' '}
              {formatarDataHora(bloqueio.ate)}, a não ser que as ativações sejam liberadas.
            </Text>
            {pode('terminais.ativar') && (
              <Button
                color="red"
                variant="white"
                loading={acoes.liberarAtivacoes.isPending}
                onClick={() =>
                  modals.openConfirmModal({
                    title: 'Liberar ativações',
                    children: (
                      <Text size="sm">
                        As tentativas erradas deixam de contar e os PDVs voltam a ativar. Faça isso só se as
                        falhas foram engano de quem estava instalando.
                      </Text>
                    ),
                    labels: { confirm: 'Liberar', cancel: 'Cancelar' },
                    onConfirm: () => acoes.liberarAtivacoes.mutate(),
                  })
                }
              >
                Liberar ativações
              </Button>
            )}
          </Group>
        </Alert>
      )}

      {d?.alertas
        // A faixa acima já mostra o bloqueio atual (com "Liberar ativações"); o alerta de força bruta só aparece
        // enquanto o estado do bloqueio não carregou. A manutenção o fecha quando o bloqueio cai sozinho.
        .filter((a) => a.tipo !== 'ATIVACAO_FORCA_BRUTA' || !bloqueio)
        .map((a) => (
          <Alert
            key={a.id}
            color={corDoAlerta(a.severidade)}
            icon={<IconAlertTriangle size={18} />}
            title={a.titulo}
            variant="light"
          >
            <Text size="sm">{a.mensagem}</Text>
            {a.terminalId &&
              (ALERTAS_DO_TERMINAL.includes(a.tipo) ? (
                <Anchor component={Link} to={`${ROTA_TERMINAIS}/${a.terminalId}`} size="sm">
                  Ver o terminal
                </Anchor>
              ) : (
                <Anchor component={Link} to={`${ROTA_TERMINAIS}/${a.terminalId}?aba=eventos`} size="sm">
                  Ver eventos do terminal
                </Anchor>
              ))}
          </Alert>
        ))}

      <SimpleGrid cols={{ base: 3 }} maw={480}>
        {(Object.keys(CONEXAO) as StatusConexao[]).map((c) => (
          <Paper key={c} withBorder p="xs" radius="md">
            <Text size="xs" c="dimmed">
              {CONEXAO[c].rotulo}
            </Text>
            <Text fw={700} size="xl" c={CONEXAO[c].cor} data-testid={`contador-${c}`}>
              {d ? formatarInteiro(d.contadores[c]) : '–'}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>

      {!!ativacoes.data?.pendentes.length && (
        <CodigosPendentes
          pendentes={ativacoes.data.pendentes}
          podeCancelar={pode('terminais.ativar')}
          aoCancelar={(id) => acoes.cancelarCodigo.mutate(id)}
        />
      )}

      <Group align="flex-end" gap="xs" wrap="wrap">
        <SeletorLoja
          label="Loja"
          permitirTodas
          value={filtro.lojaId}
          onChange={(v) => definir('lojaId', v)}
          w={240}
        />
        <Select
          label="Situação"
          data={OPCOES_SITUACAO}
          value={filtro.situacao}
          onChange={(v) => definir('situacao', v)}
          allowDeselect={false}
          w={160}
        />
        <Select
          label="Conexão"
          data={OPCOES_CONEXAO}
          value={filtro.conexao}
          onChange={(v) => definir('conexao', v)}
          allowDeselect={false}
          w={190}
        />
        <TextInput
          label="Versão do app"
          placeholder="ex.: 1.2"
          value={filtro.versaoApp}
          onChange={(e) => definir('versaoApp', e.currentTarget.value)}
          w={140}
        />
      </Group>

      {lista.isError && <Alert color="red">{(lista.error as Error).message}</Alert>}
      {!d ? (
        <Skeleton h={160} />
      ) : (
        <Table.ScrollContainer minWidth={1200}>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Loja / Caixa</Table.Th>
                <Table.Th>Descrição</Table.Th>
                <Table.Th>Conexão</Table.Th>
                <Table.Th>Última sincronização</Table.Th>
                <Table.Th ta="right">Eventos pendentes</Table.Th>
                <Table.Th ta="right">Eventos com erro</Table.Th>
                <Table.Th ta="right">NFC-e em contingência</Table.Th>
                <Table.Th>Relógio</Table.Th>
                <Table.Th>Versão do app</Table.Th>
                <Table.Th>Operador atual</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.itens.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={10}>
                    <Text c="dimmed" size="sm" ta="center" py="md">
                      Nenhum terminal com estes filtros.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {d.itens.map((t) => (
                <LinhaTerminal key={t.id} t={t} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Text size="xs" c="dimmed">
        Atualizado automaticamente a cada 30 s{d ? ` · ${formatarDataHora(d.geradoEm)}` : ''}.
      </Text>
      <ModalGerarCodigo aberto={gerando} aoFechar={() => setGerando(false)} />
    </Stack>
  );
}

function LinhaTerminal({ t }: { t: TerminalResumo }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Anchor component={Link} to={`${ROTA_TERMINAIS}/${t.id}`} size="sm">
            {rotuloTerminal(t)}
          </Anchor>
          {t.status !== 'ativo' && <BadgeStatus status={t.status} />}
        </Group>
      </Table.Td>
      <Table.Td>{t.descricao ?? t.nomeMaquina ?? '—'}</Table.Td>
      <Table.Td>
        <Conexao t={t} />
      </Table.Td>
      <Table.Td>
        <Text size="xs">Pull: {formatarDataHora(t.ultimoPullEm)}</Text>
        <Text size="xs">Push: {formatarDataHora(t.ultimoPushEm)}</Text>
      </Table.Td>
      <Table.Td ta="right">{formatarInteiro(t.eventosPendentes)}</Table.Td>
      <Table.Td ta="right">
        {t.eventosComErro > 0 ? (
          <Badge color="red" variant="light">
            {formatarInteiro(t.eventosComErro)}
          </Badge>
        ) : (
          '0'
        )}
      </Table.Td>
      <Table.Td ta="right">{formatarInteiro(t.nfceContingenciaPendentes)}</Table.Td>
      <Table.Td data-testid={`relogio-${t.id}`}>
        {t.status === 'revogado' ? (
          <Text size="sm" c="dimmed">
            —
          </Text>
        ) : (
          <DesvioRelogio desvioMs={t.desvioRelogioMs} confiavel={t.relogioConfiavel} />
        )}
      </Table.Td>
      <Table.Td>
        {t.versaoApp ?? '—'}{' '}
        {t.abaixoDaMinima && (
          <Tooltip label={`Abaixo da versão mínima ${t.versaoMinima}`}>
            <Badge color="red" size="xs" variant="filled">
              desatualizado
            </Badge>
          </Tooltip>
        )}
      </Table.Td>
      <Table.Td>{t.operadorNome ?? '—'}</Table.Td>
    </Table.Tr>
  );
}

function CodigosPendentes({
  pendentes,
  podeCancelar,
  aoCancelar,
}: {
  pendentes: AtivacaoPendente[];
  podeCancelar: boolean;
  aoCancelar: (id: string) => void;
}) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text fw={600} size="sm" mb="xs">
        Códigos de ativação pendentes
      </Text>
      <Table withRowBorders={false} verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Código</Table.Th>
            <Table.Th>Loja</Table.Th>
            <Table.Th>Caixa</Table.Th>
            <Table.Th>Gerado por</Table.Th>
            <Table.Th>Expira em</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {pendentes.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td ff="monospace">{p.codigoMascarado}</Table.Td>
              <Table.Td>{p.lojaNome ?? '—'}</Table.Td>
              <Table.Td>
                {numeroCaixa(p.numeroCaixa)}
                {p.substituiTerminalId ? ' (substituição)' : ''}
              </Table.Td>
              <Table.Td>{p.geradoPor}</Table.Td>
              <Table.Td>{formatarDataHora(p.expiraEm)}</Table.Td>
              <Table.Td ta="right">
                {podeCancelar && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      modals.openConfirmModal({
                        title: 'Cancelar código de ativação',
                        children: (
                          <Text size="sm">
                            O código {p.codigoMascarado} do caixa {numeroCaixa(p.numeroCaixa)} deixa de valer.
                          </Text>
                        ),
                        labels: { confirm: 'Cancelar código', cancel: 'Voltar' },
                        confirmProps: { color: 'red' },
                        onConfirm: () => aoCancelar(p.id),
                      })
                    }
                  >
                    Cancelar
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
