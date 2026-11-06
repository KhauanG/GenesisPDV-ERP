import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Indicator,
  Loader,
  Modal,
  Paper,
  Stack,
  Tabs,
  Text,
  Timeline,
  Title,
} from '@mantine/core';
import { useDisclosure, useDocumentTitle, useHotkeys } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDeviceFloppy,
  IconHistory,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router';
import { apiErp } from '../api/clientes';
import { ErroRequisicao, query } from '../api/http';
import { usePode } from '../auth/permissoes';
import { formatarDataHora } from '../util/formato';
import { rotaComFiltros } from './listagem/voltar';

export interface AbaFormulario {
  valor: string;
  rotulo: string;
  conteudo: ReactNode;
  /** Marcador vermelho na aba/bloco com erro de validação (ERP 3.2). */
  comErro?: boolean;
  /**
   * Marcador laranja na aba/bloco que pede atenção sem ser erro (ex.: "Compensações" com o relógio do caixa suspeito,
   * F2-B10); o `comErro` prevalece.
   */
  comAviso?: boolean;
  /**
   * Aba de consulta que não faz parte do documento (ex.: "Conferência" do acerto, F2-B11, com os campos dos limites
   * só da consulta): fica fora do `fieldset` desabilitado do documento somente leitura.
   */
  consulta?: boolean;
  /** Acordeão: resumo exibido no bloco fechado (ex.: "Categorias: CERVEJA › LATA", ERP 8.2). */
  resumo?: string | null;
  /** Acordeão: bloco aberto ao carregar (o primeiro bloco fica sempre aberto). */
  aberto?: boolean;
  /**
   * Acordeão: bloco sempre aberto, sem fechar (como o Cabeçalho), recalculado a cada renderização — ex.: "Combo" no
   * tipo Combo / kit (ERP 8.2.17), que abre ao trocar o tipo mesmo depois de carregado.
   */
  fixo?: boolean;
}

export interface PropsFormularioEntidade {
  titulo: string;
  codigo?: number | null;
  situacao?: { rotulo: string; cor: string } | null;
  alteradoEm?: string | null;
  alteradoPor?: string | null;
  modo?: 'abas' | 'acordeao';
  abas: AbaFormulario[];
  abaAtiva?: string;
  aoMudarAba?: (aba: string) => void;
  carregando?: boolean;
  salvando?: boolean;
  somenteLeitura?: boolean;
  /** Texto do aviso de somente leitura (padrão: sem permissão), ex.: documento efetivado. */
  avisoSomenteLeitura?: string;
  /** Há alterações não salvas: sair pede confirmação. */
  sujo?: boolean;
  /** Listagem de origem; o Voltar restaura os filtros que estavam na URL. */
  rotaVoltar: string;
  rotaNovo?: string;
  aoSalvar: () => void;
  aoExcluir?: () => Promise<void>;
  /** Erro da última gravação; 409 CONFLITO_VERSAO vira o aviso de "alterado por outro usuário" (ERP 1.4). */
  erro?: unknown;
  aoRecarregar?: () => void;
  /** Trilha de auditoria do registro (ERP 1.7, 17); ausente em registro novo. */
  historico?: { entidade: string; registroId: string };
  acoesExtras?: ReactNode;
}

interface LinhaAuditoria {
  id: string;
  ocorridoEm: string;
  acao: string;
  usuarioNome: string | null;
  origem: string;
  descricao: string | null;
}

const ROTULOS_ACAO: Record<string, string> = {
  criar: 'Criado',
  editar: 'Alterado',
  excluir: 'Excluído',
  restaurar: 'Restaurado',
  permissoes_alteradas: 'Permissões alteradas',
  senha_alterada: 'Senha alterada',
  senha_redefinida: 'Senha redefinida',
  login: 'Login',
  login_negado: 'Login negado',
  logout: 'Saída',
  bloqueio: 'Bloqueio',
};

/** Formulário padrão (ERP 3.2): cabeçalho, abas ou acordeão, Salvar (Ctrl+S), Voltar (Esc), Excluir, Histórico. */
export function FormularioEntidade(p: PropsFormularioEntidade) {
  useDocumentTitle(`${p.titulo} · GenesisPDV`);
  const navigate = useNavigate();
  const [historicoAberto, historico] = useDisclosure(false);
  const voltar = () => navigate(rotaComFiltros(p.rotaVoltar));

  const bloqueio = useBlocker(({ currentLocation, nextLocation }) => {
    return !!p.sujo && !p.salvando && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!p.sujo) return;
    const aviso = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', aviso);
    return () => window.removeEventListener('beforeunload', aviso);
  }, [p.sujo]);

  useHotkeys(
    [
      [
        'mod+S',
        (e) => {
          e.preventDefault();
          if (!p.somenteLeitura && !p.salvando) p.aoSalvar();
        },
      ],
    ],
    [],
  );
  // Esc com um modal/menu aberto só fecha o modal (o Mantine trata), não sai do formulário.
  useHotkeys([
    [
      'Escape',
      () => !document.querySelector('[role="dialog"], [aria-haspopup][aria-expanded="true"]') && voltar(),
    ],
  ]);

  const confirmarExclusao = () =>
    modals.openConfirmModal({
      title: 'Excluir registro',
      children: (
        <Text size="sm">
          Confirma a exclusão de “{p.titulo}”? O registro deixa de aparecer nas listagens.
        </Text>
      ),
      labels: { confirm: 'Excluir', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: () => void p.aoExcluir?.(),
    });

  const conflito = p.erro instanceof ErroRequisicao && p.erro.codigo === 'CONFLITO_VERSAO' ? p.erro : null;
  const outroErro =
    p.erro instanceof ErroRequisicao && !conflito && !p.erro.campos
      ? p.erro
      : p.erro && !(p.erro instanceof ErroRequisicao)
        ? (p.erro as Error)
        : null;
  const detalhesConflito = (conflito?.corpo.detalhes ?? {}) as {
    alteradoPorNome?: string;
    alteradoEm?: string;
  };

  const [abaInterna, setAbaInterna] = useState(p.abas[0]?.valor ?? '');
  const abaAtiva = p.abaAtiva ?? abaInterna;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={4}>
          <Group gap="sm">
            <Title order={2} size="h3">
              {p.titulo}
            </Title>
            {p.codigo != null && (
              <Badge variant="light" color="gray" size="lg" radius="sm">
                Cód. {p.codigo}
              </Badge>
            )}
            {p.situacao && (
              <Badge variant="light" color={p.situacao.cor}>
                {p.situacao.rotulo}
              </Badge>
            )}
          </Group>
          {p.alteradoEm && (
            <Text size="xs" c="dimmed">
              Última alteração em {formatarDataHora(p.alteradoEm)}
              {p.alteradoPor ? ` por ${p.alteradoPor}` : ''}
            </Text>
          )}
        </Stack>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={voltar}>
            Voltar
          </Button>
          {p.historico && (
            <Button variant="default" leftSection={<IconHistory size={16} />} onClick={historico.open}>
              Histórico
            </Button>
          )}
          {p.rotaNovo && (
            <Button variant="default" component={Link} to={p.rotaNovo} leftSection={<IconPlus size={16} />}>
              Novo
            </Button>
          )}
          {p.aoExcluir && !p.somenteLeitura && (
            <Button
              variant="light"
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={confirmarExclusao}
            >
              Excluir
            </Button>
          )}
          {p.acoesExtras}
          {!p.somenteLeitura && (
            <Button
              leftSection={<IconDeviceFloppy size={16} />}
              loading={p.salvando}
              disabled={p.carregando}
              onClick={p.aoSalvar}
              title="Salvar (Ctrl+S)"
            >
              Salvar
            </Button>
          )}
        </Group>
      </Group>

      {conflito && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={18} />}
          title="Registro alterado por outro usuário"
          role="alert"
        >
          <Stack gap="xs">
            <Text size="sm">
              {detalhesConflito.alteradoPorNome ?? 'Outro usuário'} alterou este registro
              {detalhesConflito.alteradoEm ? ` em ${formatarDataHora(detalhesConflito.alteradoEm)}` : ''}{' '}
              depois que você o abriu. Recarregue para ver a versão atual (as suas alterações serão perdidas).
            </Text>
            {p.aoRecarregar && (
              <Group>
                <Button
                  size="xs"
                  color="yellow"
                  leftSection={<IconRefresh size={14} />}
                  onClick={p.aoRecarregar}
                >
                  Recarregar (perde suas alterações)
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}
      {outroErro && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} role="alert">
          {outroErro.message}
        </Alert>
      )}
      {p.somenteLeitura && (
        <Alert color="gray" variant="light">
          {p.avisoSomenteLeitura ?? 'Somente leitura: você não tem permissão para alterar este registro.'}
        </Alert>
      )}

      <Paper p="md" pos="relative">
        {p.carregando ? (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        ) : p.modo === 'acordeao' ? (
          <Acordeao abas={p.abas} somenteLeitura={!!p.somenteLeitura} />
        ) : (
          <Tabs
            value={abaAtiva}
            onChange={(v) => v && (p.aoMudarAba ? p.aoMudarAba(v) : setAbaInterna(v))}
            keepMounted={false}
          >
            <Tabs.List mb="md">
              {p.abas.map((a) => (
                <Tabs.Tab key={a.valor} value={a.valor}>
                  <Indicator
                    disabled={!a.comErro && !a.comAviso}
                    color={a.comErro ? 'red' : 'orange'}
                    size={8}
                    offset={-4}
                    position="top-end"
                    data-marcador={a.comErro ? 'erro' : a.comAviso ? 'aviso' : undefined}
                  >
                    <Box>{a.rotulo}</Box>
                  </Indicator>
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {p.abas.map((a) => (
              <Tabs.Panel key={a.valor} value={a.valor}>
                <fieldset
                  disabled={p.somenteLeitura && !a.consulta}
                  style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                >
                  {a.conteudo}
                </fieldset>
              </Tabs.Panel>
            ))}
          </Tabs>
        )}
      </Paper>

      {p.historico && (
        <Drawer
          opened={historicoAberto}
          onClose={historico.close}
          position="right"
          title="Histórico do registro"
          size="md"
        >
          {historicoAberto && <Historico {...p.historico} />}
        </Drawer>
      )}

      <Modal
        opened={bloqueio.state === 'blocked'}
        onClose={() => bloqueio.reset?.()}
        title="Descartar alterações?"
        centered
      >
        <Text size="sm">Há alterações não salvas neste formulário. Se sair agora, elas serão perdidas.</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => bloqueio.reset?.()}>
            Continuar editando
          </Button>
          <Button color="red" onClick={() => bloqueio.proceed?.()}>
            Descartar
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

/**
 * Acordeão do ERP 8.2: o primeiro bloco (Cabeçalho) fica sempre aberto; os demais abrem sob demanda e mostram um
 * resumo quando fechados. Bloco com erro de validação abre sozinho.
 */
function Acordeao({ abas, somenteLeitura }: { abas: AbaFormulario[]; somenteLeitura: boolean }) {
  // Fixos: o primeiro bloco (Cabeçalho) e os marcados `fixo` — derivados a cada renderização.
  const fixos = abas.filter((a, i) => i === 0 || a.fixo).map((a) => a.valor);
  const [abertos, setAbertos] = useState<string[]>(() =>
    abas.filter((a, i) => i === 0 || a.aberto).map((a) => a.valor),
  );
  // Bloco com erro fica aberto enquanto o erro existir (derivado na renderização, sem efeito).
  const visiveis = [...new Set([...fixos, ...abertos, ...abas.filter((a) => a.comErro).map((a) => a.valor)])];
  return (
    <Accordion
      multiple
      value={visiveis}
      onChange={(v) => setAbertos([...new Set([...fixos, ...v])])}
      variant="separated"
    >
      {abas.map((a) => (
        <Accordion.Item key={a.valor} value={a.valor}>
          <Accordion.Control
            chevron={fixos.includes(a.valor) ? <span /> : undefined}
            aria-disabled={fixos.includes(a.valor) || undefined}
            data-fixo={fixos.includes(a.valor) || undefined}
          >
            <Group gap="xs" wrap="nowrap">
              <Text fw={500} size="sm">
                {a.rotulo}
              </Text>
              {(a.comErro || a.comAviso) && (
                <Badge color={a.comErro ? 'red' : 'orange'} size="xs" circle>
                  !
                </Badge>
              )}
              {a.resumo && !visiveis.includes(a.valor) && (
                <Text size="xs" c="dimmed" truncate>
                  {a.resumo}
                </Text>
              )}
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <fieldset
              disabled={somenteLeitura && !a.consulta}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              {a.conteudo}
            </fieldset>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

/** Linha do tempo da auditoria do registro (ERP 1.4 "Histórico"); também nas consultas só de leitura (C12). */
export function Historico({ entidade, registroId }: { entidade: string; registroId: string }) {
  const pode = usePode();
  const permitido = pode('auditoria.ver');
  const r = useQuery({
    queryKey: ['auditoria', entidade, registroId],
    queryFn: () =>
      apiErp.get<{ itens: LinhaAuditoria[] }>(
        `/auditoria${query({ entidade, registro_id: registroId, tamanho: 50 })}`,
      ),
    enabled: permitido,
  });
  if (!permitido) return <Text c="dimmed">Você não tem permissão para ver a auditoria (auditoria.ver).</Text>;
  if (r.isPending) return <Loader size="sm" />;
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!r.data.itens.length) return <Text c="dimmed">Nenhuma alteração registrada.</Text>;
  return (
    <Stack gap="md">
      <Timeline bulletSize={14} lineWidth={2}>
        {r.data.itens.map((a) => (
          <Timeline.Item key={a.id} title={ROTULOS_ACAO[a.acao] ?? a.acao}>
            <Text size="xs" c="dimmed">
              {formatarDataHora(a.ocorridoEm)} · {a.usuarioNome ?? a.origem}
            </Text>
            {a.descricao && <Text size="sm">{a.descricao}</Text>}
          </Timeline.Item>
        ))}
      </Timeline>
      <Text size="xs" c="dimmed">
        A comparação campo a campo (antes × depois) chega com a tela de Auditoria, na Fase 1.
      </Text>
    </Stack>
  );
}
