import {
  DISCO_LIVRE_CRITICO_MB,
  duracaoLegivel,
  nivelDesvioRelogio,
  nivelDiscoLivre,
  nivelFilaImpressao,
  type StatusConexao,
  type StatusTerminal,
  type TerminalResumo,
} from '@genesis/shared';
import { Badge, Group, Text, Tooltip } from '@mantine/core';

/** Cores e rótulos do ERP 12.1. */
export const CONEXAO: Record<StatusConexao, { rotulo: string; cor: string }> = {
  online: { rotulo: 'Online', cor: 'green' },
  offline: { rotulo: 'Offline', cor: 'yellow' },
  sem_contato: { rotulo: 'Sem contato', cor: 'red' },
};

export const STATUS: Record<StatusTerminal, { rotulo: string; cor: string }> = {
  provisionando: { rotulo: 'Ativando', cor: 'blue' },
  ativo: { rotulo: 'Ativo', cor: 'green' },
  desativando: { rotulo: 'Desativando', cor: 'orange' },
  revogado: { rotulo: 'Revogado', cor: 'gray' },
};

export const OPCOES_SITUACAO = [
  { value: 'ativos', label: 'Ativos' },
  { value: 'desativando', label: 'Desativando' },
  { value: 'revogados', label: 'Revogados' },
  { value: 'todos', label: 'Todos' },
];

export const OPCOES_CONEXAO = [
  { value: 'todos', label: 'Todos' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'sem_contato', label: 'Sem contato' },
  { value: 'com_pendencias', label: 'Com pendências' },
  { value: 'hardware_alterado', label: 'Hardware alterado' },
];

export const ROTULOS_FLUXO: Record<string, string> = {
  configuracao: 'Configuração',
  acesso: 'Acesso (usuários e PINs)',
  referencia: 'Referências fiscais',
  catalogo: 'Catálogo (produtos e preços)',
  estoque: 'Estoque',
  pessoas: 'Pessoas',
  operacao: 'Operação',
};

export const numeroCaixa = (n: number) => String(n).padStart(2, '0');

/** "há 3 min" (ERP 12.2), a partir do último contato. */
export function haQuanto(iso: string | null | undefined, agora = Date.now()): string {
  if (!iso) return 'nunca';
  const ms = agora - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'nunca';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

/** "Loja 1 - Ice Beer Hermes · Caixa 02". */
export function rotuloTerminal(t: Pick<TerminalResumo, 'lojaCodigo' | 'lojaNome' | 'numeroCaixa'>): string {
  const loja = t.lojaNome ?? (t.lojaCodigo !== null ? `Loja ${t.lojaCodigo}` : 'Loja');
  return `${loja} · Caixa ${numeroCaixa(t.numeroCaixa)}`;
}

/** Conexão com o tempo desde o último contato e os badges "Com pendências" e "Hardware alterado" (ERP 12.1). */
export function Conexao({ t }: { t: TerminalResumo }) {
  const c = CONEXAO[t.conexao];
  return (
    <Group gap={4} wrap="wrap">
      {t.status === 'revogado' ? (
        <Text size="sm" c="dimmed">
          —
        </Text>
      ) : (
        <>
          <Badge color={c.cor} variant="light">
            {c.rotulo}
          </Badge>
          <Text size="xs" c="dimmed">
            {haQuanto(t.ultimoContatoEm)}
          </Text>
        </>
      )}
      {t.comPendencias && (
        <Badge color="orange" variant="filled" size="sm">
          Com pendências
        </Badge>
      )}
      {t.hardwareAlterado && (
        <Badge color="red" variant="filled" size="sm">
          Hardware alterado
        </Badge>
      )}
    </Group>
  );
}

export function BadgeStatus({ status }: { status: StatusTerminal }) {
  const s = STATUS[status];
  return (
    <Badge color={s.cor} variant="outline" size="sm">
      {s.rotulo}
    </Badge>
  );
}

/** Cor do `Alert` pela severidade do alerta (o `info` do relógio regredido, SYNC 12.4, é azul). */
export const corDoAlerta = (severidade: 'info' | 'aviso' | 'critico') =>
  severidade === 'critico' ? 'red' : severidade === 'info' ? 'blue' : 'orange';

/**
 * Coluna "Relógio" (SYNC 21.2; C16) e o campo do detalhe: o desvio do último heartbeat, em âmbar acima de 2 min e em
 * vermelho acima de 5 min (`nivelDesvioRelogio`, os mesmos limites do alerta `RELOGIO_DESVIO`), com o sentido na dica
 * (desvio = servidor − local: positivo é o computador atrasado) e "hora não confirmada" sem amostra confiável no boot.
 * O `data-nivel` (normal/aviso/critico) é o que os testes conferem: a cor sai dele.
 */
export function DesvioRelogio({
  desvioMs,
  confiavel,
}: {
  desvioMs: number | null;
  confiavel: boolean | null;
}) {
  const nivel = nivelDesvioRelogio(desvioMs);
  if (nivel === null || desvioMs === null) {
    return (
      <Text span size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const sentido = desvioMs > 0 ? 'atrasado' : desvioMs < 0 ? 'adiantado' : 'certo';
  const dica =
    sentido === 'certo'
      ? 'Relógio do computador igual ao da nuvem'
      : `Relógio do computador ${duracaoLegivel(desvioMs)} ${sentido} em relação à nuvem`;
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={dica}>
        {nivel === 'normal' ? (
          <Text span size="sm" data-nivel={nivel}>
            {duracaoLegivel(desvioMs)}
          </Text>
        ) : (
          <Badge color={nivel === 'critico' ? 'red' : 'orange'} variant="light" data-nivel={nivel}>
            {duracaoLegivel(desvioMs)} {sentido}
          </Badge>
        )}
      </Tooltip>
      {confiavel === false && (
        <Tooltip label="O caixa ainda não confirmou a hora com a nuvem desde que o computador ligou">
          <Badge color="gray" variant="outline" size="xs">
            hora não confirmada
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

const gigas = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * "850 MB", "1,0 GB", "47,1 GB": um tamanho que o heartbeat manda em MB inteiros, como o PDV mostra no Sobre (GB com
 * uma casa a partir de 1024 MB); "—" quando o caixa não informou.
 */
export function tamanhoMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—';
  return mb >= 1024 ? `${gigas.format(mb / 1024)} GB` : `${Math.max(0, Math.trunc(mb))} MB`;
}

/**
 * O que fazer no caixa, com as frases do Painel de saúde do PDV (`VerificacaoDisco`, README do PDV › decisões 69 e 77):
 * apagar só o que não é do caixa (downloads, fotos, vídeos), nunca programa (o driver da impressora, o TEF e o acesso
 * remoto do suporte são programas), e a liberação de 1 h pelo supervisor.
 */
const DICA_DISCO = {
  aviso: `Libere espaço: apague arquivos que não são do caixa (downloads, fotos, vídeos) ou chame o suporte. Abaixo de ${DISCO_LIVRE_CRITICO_MB} MB o caixa não abre caixa novo; o supervisor pode liberar a abertura por 1 h.`,
  critico:
    'Abrir caixa novo está bloqueado no caixa (a venda em curso continua). Apague arquivos que não são do caixa (downloads, fotos, vídeos) ou chame o suporte. O supervisor pode liberar a abertura do caixa por 1 h.',
} as const;

const DICA_FILA =
  'Comprovante que esperava ou falhou no caixa: confira o papel e a impressora e imprima de novo na Central do PDV › 3 Impressora e gaveta (F7).';

/**
 * Dado antigo: o caixa não manda heartbeat há mais de 24 h (`sem_contato` do ERP 12.1). O selo fica cinza e, no lugar
 * do que fazer, diz que o número é da última vez: o disco pode já ter sido liberado (ou enchido) desde então.
 */
const DICA_ANTIGO =
  'Dado antigo: o caixa não manda heartbeat há mais de 24 h. Confira no Painel de saúde do caixa (Central do PDV › 0) antes de agir.';

/** Como pintar a saúde do computador: `normal` com cor; `antigo` (sem heartbeat há 24 h) cinza; `sem_cor` (revogado). */
export type ModoSaude = 'normal' | 'antigo' | 'sem_cor';

/**
 * Disco livre do caixa no detalhe do terminal (Central do PDV, bloco G15; PDV 32.2; SYNC 21.2): o valor sozinho a
 * partir de 1 GB; abaixo, o selo âmbar "pouco espaço" e, abaixo de 200 MB, o vermelho "quase cheio" (`nivelDiscoLivre`
 * do shared, os limites do Painel de saúde do PDV). O que fazer vem de `dicaDiscoLivre`, que o detalhe escreve embaixo
 * do campo na largura toda (não só na dica: o dono olha de relance). `antigo`: o selo cinza com o mesmo texto;
 * `sem_cor` (terminal revogado): só o último valor, sem selo, porque não há mais o que resolver. O `data-nivel`
 * (normal/aviso/critico) é o que os testes conferem; o `data-antigo`, o selo cinza.
 */
export function DiscoLivre({ mb, modo = 'normal' }: { mb: number | null; modo?: ModoSaude }) {
  const nivel = nivelDiscoLivre(mb);
  if (nivel === null) {
    return (
      <Tooltip label="O caixa ainda não informou o disco livre">
        <Text span size="sm" c="dimmed">
          —
        </Text>
      </Tooltip>
    );
  }
  if (nivel === 'normal' || modo === 'sem_cor') {
    return (
      <Text span size="sm" data-nivel={modo === 'sem_cor' ? undefined : nivel}>
        {tamanhoMb(mb)}
      </Text>
    );
  }
  const antigo = modo === 'antigo';
  return (
    <Badge
      color={antigo ? 'gray' : nivel === 'critico' ? 'red' : 'orange'}
      variant="light"
      data-nivel={nivel}
      data-antigo={antigo || undefined}
    >
      {tamanhoMb(mb)} · {nivel === 'critico' ? 'quase cheio' : 'pouco espaço'}
    </Badge>
  );
}

/** O que fazer com o disco livre (o texto embaixo do `<DiscoLivre>`); `null` sem selo. */
export function dicaDiscoLivre(mb: number | null, modo: ModoSaude = 'normal'): string | null {
  const nivel = nivelDiscoLivre(mb);
  if (nivel === null || nivel === 'normal' || modo === 'sem_cor') return null;
  return modo === 'antigo' ? DICA_ANTIGO : DICA_DISCO[nivel];
}

/**
 * Fila de impressão do caixa (G15): "Nenhum" sem pendência; com algum comprovante que espera ou que falhou, o selo
 * âmbar "N não impresso(s)" (não "esperando": a impressora pode ter falhado) e o que fazer de `dicaFilaImpressao` (F7 na
 * aba 3 da Central). O heartbeat soma os que esperam e os que falharam, por isso nunca é vermelho aqui
 * (`nivelFilaImpressao`). `modo` como no `<DiscoLivre>`.
 */
export function FilaImpressao({ pendentes, modo = 'normal' }: { pendentes: number; modo?: ModoSaude }) {
  const nivel = nivelFilaImpressao(pendentes);
  const texto =
    pendentes === 0
      ? 'Nenhum'
      : `${pendentes} comprovante${pendentes > 1 ? 's' : ''} não impresso${pendentes > 1 ? 's' : ''}`;
  if (nivel === 'normal' || modo === 'sem_cor') {
    return (
      <Text span size="sm" data-nivel={modo === 'sem_cor' ? undefined : nivel}>
        {texto}
      </Text>
    );
  }
  const antigo = modo === 'antigo';
  return (
    <Badge
      color={antigo ? 'gray' : 'orange'}
      variant="light"
      data-nivel={nivel}
      data-antigo={antigo || undefined}
    >
      {texto}
    </Badge>
  );
}

/** O que fazer com a fila de impressão (o texto embaixo do `<FilaImpressao>`); `null` sem selo. */
export function dicaFilaImpressao(pendentes: number, modo: ModoSaude = 'normal'): string | null {
  if (nivelFilaImpressao(pendentes) === 'normal' || modo === 'sem_cor') return null;
  return modo === 'antigo' ? DICA_ANTIGO : DICA_FILA;
}
