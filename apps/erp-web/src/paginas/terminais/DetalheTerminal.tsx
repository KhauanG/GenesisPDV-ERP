import {
  aceitaMarcarPerdido,
  ALERTA_EVENTO_COM_ERRO,
  ALERTA_EVENTO_DESCARTADO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_LACUNA_DECLARADA,
  ALERTA_LACUNA_RECUPERADA,
  ALERTA_RELOGIO_SUSPEITO,
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  FLUXOS,
  SALTO_SEGURANCA_NUMERACAO,
  statusConexao,
  type ModoRevogacao,
  type TerminalDetalhe,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Menu,
  Modal,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconAlertTriangle, IconArrowLeft, IconChevronDown } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ROTA_TERMINAIS, useAcoesTerminais, useTerminal } from '../../api/terminais';
import { formatarDataHora, formatarInteiro } from '../../util/formato';
import { DialogoRevogar } from './DialogoRevogar';
import { EventosComErro } from './FilaDecisao';
import { ModalGerarCodigo, type Substituicao } from './ModalGerarCodigo';
import {
  BadgeStatus,
  Conexao,
  corDoAlerta,
  DesvioRelogio,
  dicaDiscoLivre,
  dicaFilaImpressao,
  DiscoLivre,
  FilaImpressao,
  haQuanto,
  type ModoSaude,
  numeroCaixa,
  rotuloTerminal,
  ROTULOS_FLUXO,
  tamanhoMb,
} from './rotulos';

const seisDigitos = (n: number) => String(n).padStart(6, '0');

/** Aviso da SYNC 13.3 na substituição: sem desativação confirmada, a faixa do salto fica reservada ao antigo. */
export function avisoSalto(t: TerminalDetalhe): string | null {
  if (t.desativacaoConfirmadaEm) return null;
  const de = t.vendaUltimoNumero + 1;
  const ate = t.vendaUltimoNumero + SALTO_SEGURANCA_NUMERACAO;
  return `Números ${seisDigitos(de)}–${seisDigitos(ate)} do Caixa ${numeroCaixa(t.numeroCaixa)} ficam reservados ao terminal antigo (salto de segurança, sem confirmação de desativação).`;
}

/**
 * Detalhe do terminal (ERP 12.4): cabeçalho com status e conexão, barra de ações conforme as permissões, os blocos
 * Identificação, Sincronização, Fiscal, Caixa, Saúde do computador (Central do PDV, G15) e Histórico, e a aba "Eventos com erro" (12.5), a fila de decisão
 * (`FilaDecisao.tsx`). Renovar token, solicitar logs, código de recuperação e "Perdas prováveis" entram com o B3/B5 e a 1C.
 */
export function DetalheTerminal() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') === 'eventos' ? 'eventos' : 'detalhe';
  const terminal = useTerminal(id);
  const t = terminal.data;
  useDocumentTitle(`${t ? rotuloTerminal(t) : 'Terminal'} · GenesisPDV`);
  const acoes = useAcoesTerminais();
  const { pode } = acoes;
  const [revogando, setRevogando] = useState<{ modo: ModoRevogacao; observacao?: string } | null>(null);
  const [substituindo, setSubstituindo] = useState<Substituicao | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [resolvendo, setResolvendo] = useState<{
    alertaId: string;
    tipo: string;
    resolucao: string;
  } | null>(null);

  if (terminal.isError) return <Alert color="red">{(terminal.error as Error).message}</Alert>;
  if (!t) return <Skeleton h={300} />;
  const ativo = t.status === 'ativo';
  const emContato = ativo || t.status === 'desativando';
  const revogado = t.status === 'revogado';
  // Revogado por outro motivo ainda pode virar "perdido/roubado" (o furto descoberto depois da revogação).
  const podeMarcarPerdido = aceitaMarcarPerdido(t);

  return (
    <Stack gap="md">
      <Anchor component={Link} to={ROTA_TERMINAIS} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> PDVs / Terminais
        </Group>
      </Anchor>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="xs">
            <Title order={2} size="h3">
              {rotuloTerminal(t)}
            </Title>
            <BadgeStatus status={t.status} />
          </Group>
          <Group gap="xs" mt={4}>
            <Text c="dimmed" size="sm">
              {t.descricao ?? t.nomeMaquina ?? 'Sem descrição'}
            </Text>
            <Conexao t={t} />
          </Group>
        </div>
        <Group gap="xs">
          {pode('terminais.revogar') && (!revogado || podeMarcarPerdido) && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button color="red" variant="light" rightSection={<IconChevronDown size={14} />}>
                  {revogado ? 'Perdido/roubado' : 'Revogar'}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {ativo && (
                  <Menu.Item onClick={() => setRevogando({ modo: 'aceitar_pendencias' })}>
                    Revogar – aceitar pendências
                  </Menu.Item>
                )}
                {!revogado && (
                  <Menu.Item onClick={() => setRevogando({ modo: 'imediato' })}>
                    Revogar imediatamente
                  </Menu.Item>
                )}
                {podeMarcarPerdido && (
                  <Menu.Item color="red" onClick={() => setRevogando({ modo: 'perdido' })}>
                    Terminal perdido/roubado
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
          {ativo && pode('terminais.ativar') && pode('terminais.revogar') && (
            <Button
              variant="light"
              onClick={() =>
                setSubstituindo({
                  terminalId: t.id,
                  lojaId: t.lojaId,
                  caixaId: t.caixaId,
                  numeroCaixa: t.numeroCaixa,
                  aviso: avisoSalto(t),
                })
              }
            >
              Substituir terminal
            </Button>
          )}
          {ativo && pode('terminais.gerenciar') && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button variant="default" rightSection={<IconChevronDown size={14} />}>
                  Ressincronizar
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => acoes.ressincronizar.mutate({ id: t.id, fluxo: null })}>
                  Todos os fluxos
                </Menu.Item>
                <Menu.Divider />
                {FLUXOS.filter((f) => f !== 'operacao').map((f) => (
                  <Menu.Item key={f} onClick={() => acoes.ressincronizar.mutate({ id: t.id, fluxo: f })}>
                    {ROTULOS_FLUXO[f] ?? f}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
          {emContato && pode('terminais.gerenciar') && (
            <Button variant="default" onClick={() => setMensagem('')}>
              Enviar mensagem
            </Button>
          )}
          {t.status !== 'revogado' && pode('terminais.gerenciar') && (
            <Button variant="default" onClick={() => setRenomeando(t.descricao ?? '')}>
              Renomear
            </Button>
          )}
        </Group>
      </Group>

      {t.hardwareAlterado && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Hardware alterado">
          <Text size="sm">
            O terminal chamou a nuvem de outra máquina. Até a confirmação ele não envia vendas nem recebe
            segredos.
          </Text>
          <DadosHardwarePendente t={t} />
          <Group mt="xs" gap="xs">
            {pode('terminais.gerenciar') && t.hardwarePendente && (
              <Button
                size="xs"
                onClick={() => {
                  // A confirmação vale para o id mostrado aqui: se outra máquina chamar antes, a API recusa (409).
                  const pendente = t.hardwarePendente!;
                  modals.openConfirmModal({
                    title: 'Confirmar troca de hardware',
                    children: (
                      <Stack gap="xs">
                        <Text size="sm">
                          A máquina abaixo passa a ser a deste terminal, no lugar da registrada na ativação (
                          {t.nomeMaquina ?? 'nome desconhecido'}).
                        </Text>
                        <DadosHardwarePendente t={t} />
                      </Stack>
                    ),
                    labels: { confirm: 'Confirmar', cancel: 'Cancelar' },
                    onConfirm: () =>
                      acoes.confirmarHardware.mutate({ id: t.id, idHardwarePendente: pendente.id }),
                  });
                }}
              >
                Confirmar troca de hardware
              </Button>
            )}
            {pode('terminais.revogar') && (
              <Button
                size="xs"
                color="red"
                variant="white"
                onClick={() =>
                  setRevogando({ modo: 'imediato', observacao: 'Não reconheço a troca de hardware' })
                }
              >
                Não reconheço
              </Button>
            )}
          </Group>
        </Alert>
      )}
      {t.alertas.map((a) => (
        <Alert
          key={a.id}
          color={corDoAlerta(a.severidade)}
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title={a.titulo}
        >
          <Text size="sm">{a.mensagem}</Text>
          {/* A fila de decisão (SYNC 11.3–11.4): o com erro fecha ao reprocessar ou descartar; o descartado, no "Ciente". */}
          {(a.tipo === ALERTA_EVENTO_COM_ERRO || a.tipo === ALERTA_EVENTO_DESCARTADO) && (
            <Group mt="xs" gap="xs">
              {aba !== 'eventos' && (
                <Button
                  size="xs"
                  variant="white"
                  onClick={() => setParams({ aba: 'eventos' }, { replace: true })}
                >
                  Ver eventos com erro
                </Button>
              )}
              {a.tipo === ALERTA_EVENTO_DESCARTADO && pode('terminais.gerenciar') && (
                <Button
                  size="xs"
                  onClick={() => setResolvendo({ alertaId: a.id, tipo: a.tipo, resolucao: '' })}
                >
                  Ciente
                </Button>
              )}
            </Group>
          )}
          {/* O divergente (SYNC 8.4 camada 3) não passa pela fila: o "Ciente" depois de conferir o caixa com o suporte. */}
          {a.tipo === ALERTA_EVENTO_DIVERGENTE && pode('terminais.gerenciar') && (
            <Group mt="xs" gap="xs">
              <Button
                size="xs"
                onClick={() => setResolvendo({ alertaId: a.id, tipo: a.tipo, resolucao: '' })}
              >
                Ciente
              </Button>
            </Group>
          )}
          {/* As lacunas (SYNC 8.6): a declarada fecha sozinha se os eventos voltarem; senão, o "Ciente" da perda. */}
          {(a.tipo === ALERTA_LACUNA_DECLARADA || a.tipo === ALERTA_LACUNA_RECUPERADA) &&
            pode('terminais.gerenciar') && (
              <Group mt="xs" gap="xs">
                <Button
                  size="xs"
                  onClick={() => setResolvendo({ alertaId: a.id, tipo: a.tipo, resolucao: '' })}
                >
                  Ciente
                </Button>
              </Group>
            )}
          {/* O relógio suspeito por evento (SYNC 12.4; C16): o "Ciente" depois de acertar o relógio do computador. O
              desvio do heartbeat (RELOGIO_DESVIO) não tem botão: fecha sozinho quando o desvio volta a até 2 min. */}
          {a.tipo === ALERTA_RELOGIO_SUSPEITO && pode('terminais.gerenciar') && (
            <Group mt="xs" gap="xs">
              <Button
                size="xs"
                onClick={() => setResolvendo({ alertaId: a.id, tipo: a.tipo, resolucao: '' })}
              >
                Ciente
              </Button>
            </Group>
          )}
          {/* O de token anterior (SYNC 3.7) é resolvido depois de conferir a máquina; os de terminal fecham sozinhos. */}
          {a.tipo === ALERTA_TOKEN_ANTERIOR_REUTILIZADO && (
            <Group mt="xs" gap="xs">
              {pode('terminais.gerenciar') && (
                <Button
                  size="xs"
                  onClick={() => setResolvendo({ alertaId: a.id, tipo: a.tipo, resolucao: '' })}
                >
                  Máquina conferida
                </Button>
              )}
              {pode('terminais.revogar') && t.status !== 'revogado' && (
                <Button
                  size="xs"
                  color="red"
                  variant="white"
                  onClick={() =>
                    setRevogando({
                      modo: 'imediato',
                      observacao: 'Token anterior usado: possível cópia do terminal',
                    })
                  }
                >
                  Revogar terminal
                </Button>
              )}
            </Group>
          )}
        </Alert>
      ))}

      <Tabs
        value={aba}
        onChange={(v) => setParams(v === 'eventos' ? { aba: 'eventos' } : {}, { replace: true })}
      >
        <Tabs.List>
          <Tabs.Tab value="detalhe">Detalhe</Tabs.Tab>
          <Tabs.Tab
            value="eventos"
            rightSection={
              t.eventosComErro > 0 ? (
                <Badge size="xs" color="red" circle>
                  {t.eventosComErro}
                </Badge>
              ) : undefined
            }
          >
            Eventos com erro
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="detalhe" pt="md">
          <Blocos t={t} />
        </Tabs.Panel>
        <Tabs.Panel value="eventos" pt="md">
          {aba === 'eventos' && <EventosComErro terminalId={t.id} gerenciar={pode('terminais.gerenciar')} />}
        </Tabs.Panel>
      </Tabs>

      {revogando && (
        <DialogoRevogar
          terminal={t}
          modo={revogando.modo}
          observacaoInicial={revogando.observacao}
          aoFechar={() => setRevogando(null)}
        />
      )}
      {substituindo && (
        <ModalGerarCodigo aberto aoFechar={() => setSubstituindo(null)} substituicao={substituindo} />
      )}
      <Modal opened={mensagem !== null} onClose={() => setMensagem(null)} title="Mensagem para o caixa">
        <Stack gap="sm">
          <Textarea
            label="Mensagem"
            description="Aparece no PDV no próximo contato com a nuvem."
            maxLength={500}
            autosize
            minRows={3}
            value={mensagem ?? ''}
            onChange={(e) => setMensagem(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button
              disabled={!mensagem?.trim()}
              loading={acoes.mensagem.isPending}
              onClick={() =>
                acoes.mensagem.mutate(
                  { id: t.id, texto: mensagem!.trim() },
                  { onSuccess: () => setMensagem(null) },
                )
              }
            >
              Enviar
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={resolvendo !== null} onClose={() => setResolvendo(null)} title="Resolver alerta">
        <Stack gap="sm">
          <Textarea
            label="O que foi verificado"
            description={
              resolvendo?.tipo === ALERTA_EVENTO_DESCARTADO
                ? 'Ex.: venda conferida com o operador; o valor foi lançado à parte. Vai para a auditoria.'
                : resolvendo?.tipo === ALERTA_EVENTO_DIVERGENTE
                  ? 'Ex.: caixa conferido com o suporte; o banco local foi restaurado. Vai para a auditoria.'
                  : resolvendo?.tipo === ALERTA_LACUNA_DECLARADA
                    ? 'Ex.: vendas da faixa conferidas com o operador e lançadas à parte. Vai para a auditoria.'
                    : resolvendo?.tipo === ALERTA_LACUNA_RECUPERADA
                      ? 'Ex.: vendas recuperadas conferidas no relatório. Vai para a auditoria.'
                      : resolvendo?.tipo === ALERTA_RELOGIO_SUSPEITO
                        ? 'Ex.: data, hora e fuso do computador acertados com o técnico. Vai para a auditoria.'
                        : 'Ex.: backup restaurado nesta mesma máquina. Se não reconhecer o uso, revogue o terminal.'
            }
            maxLength={255}
            autosize
            minRows={2}
            value={resolvendo?.resolucao ?? ''}
            onChange={(e) => {
              const resolucao = e.currentTarget.value;
              setResolvendo((r) => (r ? { ...r, resolucao } : r));
            }}
          />
          <Group justify="flex-end">
            <Button
              disabled={(resolvendo?.resolucao.trim().length ?? 0) < 3}
              loading={acoes.resolverAlerta.isPending}
              onClick={() =>
                acoes.resolverAlerta.mutate(
                  { id: t.id, alertaId: resolvendo!.alertaId, resolucao: resolvendo!.resolucao.trim() },
                  { onSuccess: () => setResolvendo(null) },
                )
              }
            >
              Resolver
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={renomeando !== null} onClose={() => setRenomeando(null)} title="Renomear terminal">
        <Stack gap="sm">
          <TextInput
            label="Descrição"
            maxLength={40}
            value={renomeando ?? ''}
            onChange={(e) => setRenomeando(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button
              loading={acoes.renomear.isPending}
              onClick={() =>
                acoes.renomear.mutate(
                  { id: t.id, descricao: renomeando?.trim() || null },
                  { onSuccess: () => setRenomeando(null) },
                )
              }
            >
              Gravar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/**
 * Rótulo à esquerda e valor à direita. `dica`: o que fazer, numa linha embaixo na largura toda do bloco (a frase longa
 * ao lado do rótulo o espremeria palavra por palavra no celular).
 */
function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string | null; children: ReactNode }) {
  const linha = (
    <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed">
        {rotulo}
      </Text>
      {/* `div`: o valor pode ser um selo (`<DiscoLivre>`), que não cabe num parágrafo. */}
      <Text component="div" size="sm" ta="right" style={{ wordBreak: 'break-all' }}>
        {children}
      </Text>
    </Group>
  );
  if (!dica) return linha;
  return (
    <Stack gap={2}>
      {linha}
      <Text size="xs" c="dimmed">
        {dica}
      </Text>
    </Stack>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text fw={600} size="sm" mb="xs">
        {titulo}
      </Text>
      <Stack gap={4}>{children}</Stack>
    </Paper>
  );
}

/**
 * SYNC 20.5: a primeira chamada com o hardware novo (id resumido, horário, IP e SO). Nome da máquina, SO e IP do
 * terminal são os da máquina registrada e não servem para reconhecer a outra.
 */
function DadosHardwarePendente({ t }: { t: TerminalDetalhe }) {
  const p = t.hardwarePendente;
  if (!p) return null;
  return (
    <Text size="sm" data-testid="hardware-pendente">
      Primeira chamada em {formatarDataHora(p.desde)}, IP {p.ip ?? '—'},{' '}
      {p.sistemaOperacional ?? 'SO não informado'} — id <Code>{resumirIdHardware(p.id)}</Code>
    </Text>
  );
}

/** `ABCD…WXYZ`: o bastante para conferir com o que o técnico vê no PDV. */
export const resumirIdHardware = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

/**
 * Saúde do computador do caixa (Central do PDV, bloco G15; SYNC 21.1, 21.2; PDV 32.2): o disco livre, o tamanho do
 * banco local e a fila de impressão que o heartbeat já mandava, com as cores do Painel de saúde do PDV (disco < 1 GB
 * âmbar, < 200 MB vermelho; fila com algum comprovante, âmbar) e o que fazer embaixo. A linha de baixo diz de quando
 * são os números: a fila vem em todo heartbeat; o disco e o banco, só quando o caixa conseguiu medir (um heartbeat sem
 * medida não apaga o anterior), por isso "da última medida". Sem heartbeat há mais de 24 h (`sem_contato` do ERP 12.1):
 * os selos ficam cinza e a dica diz que o dado é antigo, em vez de mandar agir. Revogado: só os últimos valores, sem
 * cor.
 */
function SaudeComputador({ t }: { t: TerminalDetalhe }) {
  const modo: ModoSaude =
    t.status === 'revogado'
      ? 'sem_cor'
      : t.ultimoHeartbeatEm && statusConexao(t.ultimoHeartbeatEm) === 'sem_contato'
        ? 'antigo'
        : 'normal';
  const quando = haQuanto(t.ultimoHeartbeatEm);
  return (
    <Bloco titulo="Saúde do computador">
      <Campo rotulo="Disco livre" dica={dicaDiscoLivre(t.discoLivreMb, modo)}>
        <DiscoLivre mb={t.discoLivreMb} modo={modo} />
      </Campo>
      <Campo rotulo="Banco do caixa">{tamanhoMb(t.tamanhoBancoMb)}</Campo>
      <Campo rotulo="Fila de impressão" dica={dicaFilaImpressao(t.filaImpressaoPendentes, modo)}>
        <FilaImpressao pendentes={t.filaImpressaoPendentes} modo={modo} />
      </Campo>
      <Text size="xs" c="dimmed" data-testid="saude-origem">
        {t.ultimoHeartbeatEm
          ? `Fila do último heartbeat (${quando === 'agora' ? 'há menos de 1 min' : quando}); disco e banco da última medida.`
          : 'O caixa ainda não mandou heartbeat.'}
      </Text>
    </Bloco>
  );
}

function Blocos({ t }: { t: TerminalDetalhe }) {
  const cursor = t.cursorPull
    ? Object.entries(t.cursorPull)
        .map(([f, v]) => `${f}: ${v}`)
        .join(' · ')
    : '—';
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Bloco titulo="Identificação">
          <Campo rotulo="Loja">{t.lojaNome ?? '—'}</Campo>
          <Campo rotulo="Caixa">{numeroCaixa(t.numeroCaixa)}</Campo>
          <Campo rotulo="Descrição">{t.descricao ?? '—'}</Campo>
          <Campo rotulo="Computador">{t.nomeMaquina ?? '—'}</Campo>
          <Campo rotulo="Sistema operacional">{t.sistemaOperacional ?? '—'}</Campo>
          <Campo rotulo="Id de hardware">
            <Code>{t.idHardware ?? '—'}</Code>
          </Campo>
          <Campo rotulo="IP do último contato">{t.ultimoIp ?? '—'}</Campo>
          <Campo rotulo="Ativado em">
            {formatarDataHora(t.ativadoEm)}
            {t.ativadoPorNome ? ` por ${t.ativadoPorNome}` : ''}
          </Campo>
          {t.status === 'desativando' && (
            <Campo rotulo="Carência até">{formatarDataHora(t.carenciaAte)}</Campo>
          )}
          {t.revogadoEm && (
            <Campo rotulo="Revogado em">
              {formatarDataHora(t.revogadoEm)}
              {t.revogadoPorNome ? ` por ${t.revogadoPorNome}` : ''}
              {t.motivoRevogacao ? ` (${t.motivoRevogacao.replace(/_/g, ' ')})` : ''}
            </Campo>
          )}
        </Bloco>
        <Bloco titulo="Sincronização">
          <Campo rotulo="Último heartbeat">
            {formatarDataHora(t.ultimoHeartbeatEm)} ({haQuanto(t.ultimoHeartbeatEm)})
          </Campo>
          <Campo rotulo="Último pull">{formatarDataHora(t.ultimoPullEm)}</Campo>
          <Campo rotulo="Cursor por fluxo">{cursor}</Campo>
          <Campo rotulo="Último push">{formatarDataHora(t.ultimoPushEm)}</Campo>
          <Campo rotulo="Eventos pendentes">{formatarInteiro(t.eventosPendentes)}</Campo>
          <Campo rotulo="Eventos com erro">{formatarInteiro(t.eventosComErro)}</Campo>
          <Campo rotulo="Versão do app">
            {t.versaoApp ?? '—'}
            {t.abaixoDaMinima ? ` (abaixo da mínima ${t.versaoMinima})` : ''}
          </Campo>
          <Campo rotulo="Relógio">
            <DesvioRelogio desvioMs={t.desvioRelogioMs} confiavel={t.relogioConfiavel} />
          </Campo>
          {t.ultimoErro && <Campo rotulo="Último erro">{t.ultimoErro}</Campo>}
        </Bloco>
        <Bloco titulo="Fiscal">
          <Campo rotulo="Tipo de emissão">{t.tipoEmissao ?? '—'}</Campo>
          <Campo rotulo="Série NFC-e">{t.nfceSerie ?? '—'}</Campo>
          <Campo rotulo="Último nº NFC-e">{t.nfceUltimoNumero ?? '—'}</Campo>
          <Campo rotulo="NFC-e em contingência">
            {formatarInteiro(t.nfceContingenciaPendentes)}
            {t.nfceContingenciaMaisAntigaEm
              ? ` (desde ${formatarDataHora(t.nfceContingenciaMaisAntigaEm)})`
              : ''}
          </Campo>
          <Campo rotulo="Certificado no PDV">{formatarDataHora(t.certificadoValidade)}</Campo>
        </Bloco>
        <Bloco titulo="Caixa">
          <Campo rotulo="Sessão aberta">{t.sessaoCaixaId ? 'Sim' : 'Não'}</Campo>
          <Campo rotulo="Operador">{t.operadorNome ?? '—'}</Campo>
          <Campo rotulo="Dinheiro estimado">
            {t.dinheiroEstimadoGaveta ? `R$ ${t.dinheiroEstimadoGaveta.replace('.', ',')}` : '—'}
          </Campo>
          <Campo rotulo="Última venda informada">{t.vendaUltimoNumero || '—'}</Campo>
        </Bloco>
      </SimpleGrid>
      {/* Fora do grid, na largura toda como o Histórico: o quinto bloco ficaria sozinho, com meia linha vazia. */}
      <SaudeComputador t={t} />
      <Bloco titulo="Histórico">
        {t.historico.length === 0 ? (
          <Text size="sm" c="dimmed">
            Sem registros.
          </Text>
        ) : (
          <Timeline bulletSize={12} lineWidth={2} mt="xs">
            {t.historico.map((h, i) => (
              <Timeline.Item key={`${h.em}-${i}`} title={h.titulo}>
                <Text size="xs" c="dimmed">
                  {formatarDataHora(h.em)}
                  {h.usuarioNome ? ` · ${h.usuarioNome}` : ''}
                  {h.situacao ? ` · ${h.situacao}` : ''}
                </Text>
                {h.descricao && <Text size="sm">{h.descricao}</Text>}
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Bloco>
    </Stack>
  );
}
