/**
 * PDVs/Terminais no ERP (ERP 12; SYNC 3.1, 3.8, 21.1): entradas das ações, DTOs da listagem e do detalhe e o status de
 * conexão calculado pelo último contato, o mesmo na API (listagem, contadores, dashboard) e na tela.
 */
import { z } from 'zod';
import { vazioParaNulo } from './campos.js';
import type { StatusTerminal } from './enums.js';
import { FLUXOS, type Fluxo } from './sync/contratos.js';

// ---------------------------------------------------------------------------------------------------------------
// Status de conexão (ERP 12.1)

/** Limiares do ERP 12.1: online < 2 min ≤ offline < 24 h ≤ sem contato; pendências contam depois de 1 h offline. */
export const LIMIARES_CONEXAO = {
  onlineMs: 2 * 60_000,
  semContatoMs: 24 * 3_600_000,
  pendenciasMs: 3_600_000,
} as const;

export const STATUS_CONEXAO = ['online', 'offline', 'sem_contato'] as const;
export type StatusConexao = (typeof STATUS_CONEXAO)[number];

const instante = (v: string | Date | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** Status do ERP 12.1 pelo último contato; sem contato nenhum (recém-ativado sem heartbeat) = `sem_contato`. */
export function statusConexao(
  ultimoContatoEm: string | Date | null | undefined,
  agora: number | Date = Date.now(),
): StatusConexao {
  const ms = instante(ultimoContatoEm);
  if (ms === null) return 'sem_contato';
  const decorrido = (typeof agora === 'number' ? agora : agora.getTime()) - ms;
  if (decorrido < LIMIARES_CONEXAO.onlineMs) return 'online';
  return decorrido < LIMIARES_CONEXAO.semContatoMs ? 'offline' : 'sem_contato';
}

/** Badge "Com pendências" (ERP 12.1): eventos pendentes no último heartbeat e sem contato há mais de 1 h. */
export function comPendencias(
  t: { ultimoContatoEm: string | Date | null | undefined; eventosPendentes: number },
  agora: number | Date = Date.now(),
): boolean {
  if (t.eventosPendentes <= 0) return false;
  const ms = instante(t.ultimoContatoEm);
  if (ms === null) return true;
  return (typeof agora === 'number' ? agora : agora.getTime()) - ms > LIMIARES_CONEXAO.pendenciasMs;
}

// ---------------------------------------------------------------------------------------------------------------
// Entradas

export const VALIDADES_CODIGO_ATIVACAO = [1, 24, 72] as const;

/** Gerar código de ativação (ERP 12.3). A série NFC-e nova e o "Novo caixa" entram com o fiscal (3F). */
export const gerarCodigoAtivacaoSchema = z.object({
  lojaId: z.uuid(),
  caixaId: z.uuid(),
  descricao: z.preprocess(vazioParaNulo, z.string().trim().max(40).nullable().optional()),
  validadeHoras: z.union([z.literal(1), z.literal(24), z.literal(72)]).default(24),
  substituiTerminalId: z.uuid().nullable().optional(),
});
export type GerarCodigoAtivacaoEntrada = z.input<typeof gerarCodigoAtivacaoSchema>;

/** Caixas que aceitam código (`GET /terminais/caixas-livres?lojaId=`, com `terminais.ativar`, sem `lojas.ver`). */
export const caixasLivresQuerySchema = z.object({ lojaId: z.uuid() });

/**
 * Caixa livre para o modal de gerar código (ERP 12.3): ativo, nunca o caixa 0 e sem terminal `provisionando`/`ativo`
 * (a mesma regra da API ao gerar e ao ativar).
 */
export interface CaixaParaAtivacao {
  id: string;
  numero: number;
  descricao: string | null;
  /** Ainda ocupado por um terminal em desativação (aceitar pendências): o PDV novo o tira do caixa ao ativar. */
  terminalDesativandoId: string | null;
}

export interface CodigoAtivacaoGerado {
  /** Exibido uma única vez (`K7QM-2XRD`); depois só `••••-••RD`. */
  codigo: string;
  expiraEm: string;
  ativacaoId: string;
}

export const MODOS_REVOGACAO = ['aceitar_pendencias', 'imediato', 'perdido'] as const;
export type ModoRevogacao = (typeof MODOS_REVOGACAO)[number];

/**
 * Revogar (ERP 12.4; SYNC 3.8, 4.3 item 6). `imediato` e `perdido` exigem a confirmação digitando o nº do caixa,
 * conferida também na API; `observacao` vai para a auditoria (ex.: "Não reconheço" a troca de hardware).
 */
export const revogarTerminalSchema = z
  .object({
    modo: z.enum(MODOS_REVOGACAO),
    confirmacaoCaixa: z.coerce.number().int().min(0).max(99).optional(),
    observacao: z.preprocess(vazioParaNulo, z.string().trim().max(200).nullable().optional()),
  })
  .refine((v) => v.modo === 'aceitar_pendencias' || v.confirmacaoCaixa !== undefined, {
    message: 'Digite o número do caixa para confirmar',
    path: ['confirmacaoCaixa'],
  });
export type RevogarTerminalEntrada = z.input<typeof revogarTerminalSchema>;
export type RevogarTerminal = z.output<typeof revogarTerminalSchema>;

/** Resposta do `POST /terminais/:id/revogar`: estado final no controle e o que a etapa da empresa fez. */
export interface ResultadoRevogacao {
  status: StatusTerminal;
  motivo: string | null;
  /** O banco da empresa mudou nesta chamada (falso ao repetir uma revogação já aplicada). */
  alterado: boolean;
  pinsAnulados: number;
  senhasClienteAnuladas: number;
  /** Saiu com eventos em erro/retidos: alerta da D20 aberto. */
  alertaEventos: boolean;
}

/** Motivo do terminal revogado que ainda aceita "Terminal perdido/roubado" (o furto descoberto depois). */
export function aceitaMarcarPerdido(t: { status: StatusTerminal; motivoRevogacao: string | null }): boolean {
  if (t.status !== 'revogado') return true;
  return t.motivoRevogacao !== 'perdido_roubado' && t.motivoRevogacao !== 'falha_ativacao';
}

/** Ressincronizar (ERP 12.4): todos os fluxos (`ressincronizar`) ou um só (`ressincronizar_fluxo`). */
export const ressincronizarTerminalSchema = z.object({
  fluxo: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(FLUXOS).optional()),
});
export type RessincronizarTerminalEntrada = z.input<typeof ressincronizarTerminalSchema>;
export type RessincronizarTerminal = z.output<typeof ressincronizarTerminalSchema>;

/** Comando `mensagem` (SYNC 21.1): aviso exibido no PDV. */
export const mensagemTerminalSchema = z.object({
  texto: z.string().trim().min(1, 'Digite a mensagem').max(500),
});
export type MensagemTerminalEntrada = z.input<typeof mensagemTerminalSchema>;
export type MensagemTerminal = z.output<typeof mensagemTerminalSchema>;

/**
 * SYNC 3.7: token anterior usado depois que o novo já funcionou (indício de cópia do terminal). Com o
 * `EVENTO_DESCARTADO` e o `EVENTO_DIVERGENTE`, é o alerta de terminal que alguém resolve na tela: os outros fecham
 * sozinhos (D20 pela manutenção, força bruta ao liberar ou quando o bloqueio cai, `EVENTO_COM_ERRO` ao reprocessar ou
 * descartar).
 */
export const ALERTA_TOKEN_ANTERIOR_REUTILIZADO = 'TOKEN_ANTERIOR_REUTILIZADO';

/**
 * SYNC 11.3: um por evento em `erro`, aberto até Reprocessar ou Descartar. A listagem e o detalhe do terminal o mostram
 * somado por terminal ("N eventos com erro"), com o id do mais recente.
 */
export const ALERTA_EVENTO_COM_ERRO = 'EVENTO_COM_ERRO';

/**
 * SYNC 11.4 (ERP 12.5: "venda nunca é descartada sem gerar alerta"): crítico, um por evento descartado. Aparece na
 * listagem e no detalhe do terminal até alguém com `terminais.gerenciar` marcar "Ciente"; o painel mínimo do Dashboard
 * (C14) o conta e leva ao terminal.
 */
export const ALERTA_EVENTO_DESCARTADO = 'EVENTO_DESCARTADO';

/**
 * SYNC 8.4 camada 3 e 11.2: o mesmo `evento_id` chegou de novo com outro conteúdo (hash, terminal ou sequência), por
 * corrupção do banco local ou bug de serialização. Crítico, um por evento, com o terminal que mandou em
 * `dados.terminal_id`; a nuvem guarda o payload recebido em `dados` e não muda a linha original. Nada o fecha sozinho:
 * fica na listagem e no detalhe do terminal até alguém com `terminais.gerenciar` marcar "Ciente" depois de conferir o
 * caixa com o suporte (a quarentena do PDV não sai pela consulta horária, README do PDV, decisão 58).
 */
export const ALERTA_EVENTO_DIVERGENTE = 'EVENTO_DIVERGENTE';

/**
 * SYNC 8.6: o caixa declarou uma lacuna (`declarar_lacuna`, liberação de supervisor com `pdv.config.fiscal`) — admitiu
 * que as sequências da faixa se perderam. Crítico, um por faixa (`lacuna_declarada:<terminal>:<de>-<ate>`), no
 * terminal (`entidade = 'terminais'`), com a faixa, o motivo, quem liberou e os `eventos_pendentes` que o terminal
 * informou antes (para estimar a perda, 22.4). Fecha sozinho quando todos os placeholders forem substituídos pelos
 * eventos reais; senão, fica até alguém com `terminais.gerenciar` marcar "Ciente" (a perda conferida).
 */
export const ALERTA_LACUNA_DECLARADA = 'LACUNA_DECLARADA';

/**
 * SYNC 8.6: eventos reais substituíram placeholders de lacuna (`recuperar_lacuna` no push). Aviso, um por lote, com a
 * faixa, a quantidade de eventos e os números das vendas recuperadas; "Ciente" no detalhe do terminal.
 */
export const ALERTA_LACUNA_RECUPERADA = 'LACUNA_RECUPERADA';

/**
 * SYNC 12.4 (C16): a hora de um evento do caixa não bate com a da nuvem — mais de 5 min no futuro (`futuro`), antes da
 * ativação do terminal (− 1 dia) ou mais de 400 dias no passado (`passado`), ou anterior à do evento anterior do
 * terminal sem a marca `relogio_regrediu` e com mais de 1 s (`regressao`, defeito do caixa). O evento é aplicado
 * mesmo assim, com a hora do caixa. Aviso, um aberto por terminal e motivo (`relogio_suspeito:<terminal>:<motivo>`,
 * com as ocorrências somadas em `dados`). A regressão **marcada** pelo caixa (`relogio_regrediu = true`, 12.3) é
 * esperada: `info`, uma por regressão (`relogio_regrediu:<evento_id>`); na tela vem somada por terminal ("voltou N
 * vezes", com o id da mais recente) e o "Ciente" dela fecha todas, para não ocupar o limite dos outros alertas. No
 * terminal (`entidade = 'terminais'`), até alguém com `terminais.gerenciar` marcar "Ciente" depois de acertar o relógio
 * do computador.
 */
export const ALERTA_RELOGIO_SUSPEITO = 'RELOGIO_SUSPEITO';

/**
 * SYNC 12.4 e 21.2 (C16; T40): o desvio que o caixa mede e informa no heartbeat (`desvio_relogio_ms`) passou de
 * 2 min (aviso) ou de 5 min (crítico). Um aberto por terminal (`relogio_desvio:<terminal>`), com a severidade e o
 * desvio do último heartbeat; fecha sozinho quando o desvio volta a até 2 min, ou quando o terminal sai do caixa
 * (revogado ou desativado). Não tem "Ciente": o que o resolve é acertar o relógio.
 */
export const ALERTA_RELOGIO_DESVIO = 'RELOGIO_DESVIO';

/** SYNC 12.3, 12.4 e 21.2 (ERP 12.4): desvio absoluto acima disto é aviso (âmbar). */
export const DESVIO_RELOGIO_AVISO_MS = 2 * 60_000;
/** Acima disto é crítico ("Relógio do computador errado", vermelho). */
export const DESVIO_RELOGIO_CRITICO_MS = 5 * 60_000;

/** Faixa do desvio do relógio (heartbeat) para a coluna "Relógio" e o alerta `RELOGIO_DESVIO`; `null` sem amostra. */
export function nivelDesvioRelogio(
  desvioMs: number | null | undefined,
): 'normal' | 'aviso' | 'critico' | null {
  if (desvioMs === null || desvioMs === undefined) return null;
  const absoluto = Math.abs(desvioMs);
  if (absoluto > DESVIO_RELOGIO_CRITICO_MS) return 'critico';
  if (absoluto > DESVIO_RELOGIO_AVISO_MS) return 'aviso';
  return 'normal';
}

/**
 * Disco livre do computador do caixa (PDV 32.2; SYNC 21.2; Central do PDV, blocos G4 e G15): abaixo de 1 GB é aviso
 * (âmbar) e abaixo de 200 MB é crítico (vermelho: o caixa não abre sessão nova sem a liberação do supervisor; a venda em
 * curso continua). Os mesmos limites do Painel de saúde do PDV (`OpcoesSaude.DiscoAvisoBytes` e `DiscoBloqueioBytes`,
 * README do PDV › decisão 69), em MB inteiros como o heartbeat manda (`disco_livre_mb`, arredondado para baixo): menos
 * de 1 GB em bytes lá é o mesmo que `< 1024` MB aqui, e menos de 200 MB, `< 200`.
 */
export const DISCO_LIVRE_AVISO_MB = 1024;
export const DISCO_LIVRE_CRITICO_MB = 200;

/** Faixa do disco livre do último heartbeat (`DISCO_LIVRE_*_MB`); `null` quando o caixa não informou. */
export function nivelDiscoLivre(mb: number | null | undefined): 'normal' | 'aviso' | 'critico' | null {
  if (mb === null || mb === undefined) return null;
  if (mb < DISCO_LIVRE_CRITICO_MB) return 'critico';
  if (mb < DISCO_LIVRE_AVISO_MB) return 'aviso';
  return 'normal';
}

/**
 * Fila de impressão do caixa (`fila_impressao_pendentes` do heartbeat: comprovantes esperando ou que falharam, PDV
 * 32.2): qualquer um é aviso, como o amarelo "comprovante esperando" do Painel de saúde. O heartbeat não separa o que
 * falhou do que só espera (o vermelho do Painel), por isso o ERP não pinta de vermelho.
 */
export function nivelFilaImpressao(pendentes: number | null | undefined): 'normal' | 'aviso' {
  return (pendentes ?? 0) > 0 ? 'aviso' : 'normal';
}

/**
 * "45 s", "7 min", "3 h 12 min", "12 dias": uma diferença de hora do relógio, sem o sinal. A mesma nos alertas de
 * relógio da API (o valor exato vai em `dados`) e na coluna "Relógio" do ERP, para o título do alerta e o campo da
 * mesma tela dizerem a mesma coisa; a partir de 48 h, em dias inteiros.
 */
export function duracaoLegivel(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} dias`;
}

/** Resolver o alerta de token anterior (ERP 12.4): quem conferiu a máquina diz o que viu. */
export const resolverAlertaTerminalSchema = z.object({
  resolucao: z.string().trim().min(3, 'Diga o que foi verificado').max(255),
});
export type ResolverAlertaTerminalEntrada = z.input<typeof resolverAlertaTerminalSchema>;
export type ResolverAlertaTerminal = z.output<typeof resolverAlertaTerminalSchema>;

/**
 * Confirmar troca de hardware (ERP 12.4; SYNC 20.5): o id pendente que a tela mostrou. Se outra máquina chamou depois
 * e o pendente mudou, a API responde 409 e a tela recarrega com os dados novos.
 */
export const confirmarHardwareSchema = z.object({
  idHardwarePendente: z.string().regex(/^[0-9A-Za-z]{16,128}$/, 'Id de hardware inválido'),
});
export type ConfirmarHardware = z.infer<typeof confirmarHardwareSchema>;

/** Renomear (ERP 12.4). */
export const alterarTerminalSchema = z.object({
  descricao: z.preprocess(vazioParaNulo, z.string().trim().max(40).nullable()),
});
export type AlterarTerminalEntrada = z.input<typeof alterarTerminalSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Listagem (ERP 12.2)

export const SITUACOES_FILTRO_TERMINAL = ['ativos', 'desativando', 'revogados', 'todos'] as const;
export type SituacaoFiltroTerminal = (typeof SITUACOES_FILTRO_TERMINAL)[number];
export const CONEXOES_FILTRO_TERMINAL = [
  'todos',
  'online',
  'offline',
  'sem_contato',
  'com_pendencias',
  'hardware_alterado',
] as const;
export type ConexaoFiltroTerminal = (typeof CONEXOES_FILTRO_TERMINAL)[number];

const vazioParaIndefinido = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const filtroTerminaisSchema = z.object({
  lojaId: z.preprocess(vazioParaIndefinido, z.uuid().optional()),
  situacao: z.preprocess(vazioParaIndefinido, z.enum(SITUACOES_FILTRO_TERMINAL).default('ativos')),
  conexao: z.preprocess(vazioParaIndefinido, z.enum(CONEXOES_FILTRO_TERMINAL).default('todos')),
  versaoApp: z.preprocess(vazioParaIndefinido, z.string().trim().max(20).optional()),
});
export type FiltroTerminais = z.infer<typeof filtroTerminaisSchema>;

export interface TerminalResumo {
  id: string;
  status: StatusTerminal;
  lojaId: string;
  lojaCodigo: number | null;
  lojaNome: string | null;
  caixaId: string;
  numeroCaixa: number;
  descricao: string | null;
  nomeMaquina: string | null;
  /** O mais recente entre o contato registrado no controle (qualquer chamada) e o último heartbeat. */
  ultimoContatoEm: string | null;
  conexao: StatusConexao;
  comPendencias: boolean;
  hardwareAlterado: boolean;
  ultimoPullEm: string | null;
  ultimoPushEm: string | null;
  eventosPendentes: number;
  /** `eventos_recebidos` em `erro` ou `retido` (ERP 12.5). */
  eventosComErro: number;
  nfceContingenciaPendentes: number;
  /**
   * Desvio do relógio do último heartbeat (`servidor − local`, SYNC 12.2): positivo = o computador está atrasado.
   * Coluna "Relógio" da listagem (SYNC 21.2): > 2 min aviso, > 5 min crítico (`nivelDesvioRelogio`).
   */
  desvioRelogioMs: number | null;
  /** `false` = o caixa não tem amostra confiável no boot atual (SYNC 12.2): a hora dos fatos não foi confirmada. */
  relogioConfiavel: boolean | null;
  versaoApp: string | null;
  /** Mínima publicada para a plataforma e o canal da empresa (ERP 19.5); `null` = nenhuma. */
  versaoMinima: string | null;
  abaixoDaMinima: boolean;
  operadorNome: string | null;
  carenciaAte: string | null;
  revogadoEm: string | null;
}

/** Alerta aberto ligado a terminais (`alertas`): D20, força bruta na ativação, token anterior reutilizado. */
export interface AlertaTerminal {
  id: string;
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  titulo: string;
  mensagem: string | null;
  terminalId: string | null;
  criadoEm: string;
}

export interface ListagemTerminais {
  itens: TerminalResumo[];
  /** Terminais `ativo` das lojas filtradas, por conexão (topo da ERP 12.2). */
  contadores: Record<StatusConexao, number>;
  alertas: AlertaTerminal[];
  geradoEm: string;
}

export interface AtivacaoPendente {
  id: string;
  /** `••••-••RD`. */
  codigoMascarado: string;
  lojaId: string;
  lojaNome: string | null;
  caixaId: string;
  numeroCaixa: number;
  descricao: string | null;
  geradoPor: string;
  criadoEm: string;
  expiraEm: string;
  substituiTerminalId: string | null;
}

/** Bloqueio por força bruta do código da empresa (SYNC 3.1: 20 falhas em 1 h). */
export interface BloqueioAtivacoes {
  bloqueado: boolean;
  /** Falhas que contam na última hora (desde a última liberação). */
  falhas: number;
  limite: number;
  /** Quando o bloqueio cai sozinho, se nada mais falhar. */
  ate: string | null;
}

export interface AtivacoesPendentes {
  pendentes: AtivacaoPendente[];
  bloqueio: BloqueioAtivacoes;
}

// ---------------------------------------------------------------------------------------------------------------
// Detalhe (ERP 12.4)

export interface EventoHistoricoTerminal {
  em: string;
  tipo: 'auditoria' | 'comando';
  titulo: string;
  descricao: string | null;
  usuarioNome: string | null;
  /** Comando: `pendente`, `entregue`, `executado`, `falhou`, `cancelado`. */
  situacao: string | null;
}

/**
 * A primeira chamada com o `X-Genesis-Id-Hardware` pendente (SYNC 20.5): quando, de que IP e com que SO (do primeiro
 * heartbeat dessa máquina). Os dados da máquina registrada (`sistemaOperacional`, `ultimoIp`) não mudam com ela.
 */
export interface HardwarePendente {
  id: string;
  desde: string | null;
  ip: string | null;
  sistemaOperacional: string | null;
}

export interface TerminalDetalhe extends TerminalResumo {
  /** Da máquina registrada (ativação ou último heartbeat com o hardware que confere). */
  sistemaOperacional: string | null;
  idHardware: string | null;
  idHardwarePendente: string | null;
  hardwarePendente: HardwarePendente | null;
  ultimoIp: string | null;
  ativadoEm: string;
  ativadoPorNome: string | null;
  motivoRevogacao: string | null;
  revogadoPorNome: string | null;
  substituidoPorTerminalId: string | null;
  ultimoHeartbeatEm: string | null;
  cursorPull: Partial<Record<Fluxo, number>> | null;
  estadoLocal: string | null;
  ultimoErro: string | null;
  tipoEmissao: string | null;
  nfceSerie: number | null;
  nfceUltimoNumero: number | null;
  nfceContingenciaMaisAntigaEm: string | null;
  certificadoValidade: string | null;
  sessaoCaixaId: string | null;
  dinheiroEstimadoGaveta: string | null;
  /** O maior entre `numeracoes` do caixa e o último número informado pelo terminal. */
  vendaUltimoNumero: number;
  /**
   * Saúde do computador no último heartbeat (SYNC 21.1, 21.2; Central do PDV, bloco G15): o disco livre da unidade do
   * `pdv.db`, em MB (`nivelDiscoLivre`); `null` = o caixa nunca informou. Um heartbeat que não conseguiu medir não
   * apaga o último valor (a tela diz de quando são os números).
   */
  discoLivreMb: number | null;
  /**
   * Tamanho do arquivo `pdv.db` em MB, sem o `-wal` e o `-shm` (o heartbeat mede só o arquivo; o Sobre do PDV soma os
   * três, então pode mostrar mais). Só medir, PC-11 da Central: não há expurgo nem limite; `null` = nunca informado.
   */
  tamanhoBancoMb: number | null;
  /** Comprovantes esperando impressão ou que falharam no caixa (`nivelFilaImpressao`). */
  filaImpressaoPendentes: number;
  desativacaoConfirmadaEm: string | null;
  historico: EventoHistoricoTerminal[];
  alertas: AlertaTerminal[];
}

/** Linha da aba "Eventos com erro" (ERP 12.5; SYNC 11.4), a fila de decisão. */
export interface EventoComErro {
  id: string;
  eventoId: string;
  sequencia: number;
  tipo: string;
  ocorridoEm: string;
  status: 'erro' | 'retido';
  erroCodigo: string | null;
  erro: string | null;
  agregadoTipo: string;
  agregadoId: string;
  tentativas: number;
  recebidoEm: string;
  /**
   * Retido (ERP 12.5, "Retido aguardando qual evento"): os eventos com erro/retidos do mesmo terminal que seguram
   * este, com a sequência e o tipo deles (nulos se o bloqueador não está mais registrado).
   */
  aguardando: Array<{ eventoId: string; sequencia: number | null; tipo: string | null }>;
  /** Dependências declaradas pelo PDV no envelope (agregados de que o evento precisa). */
  dependencias: Array<{ agregadoTipo: string; agregadoId: string }>;
  /** Só com `terminais.gerenciar` (pode trazer dados pessoais). */
  payload: unknown;
  /**
   * Resumo do agregado lido do payload (ERP 12.5): "Venda L01-C02-000123 · R$ 71,58 · 4 itens". Nulo quando o tipo
   * não tem resumo ou o payload não é legível. Vem também sem `terminais.gerenciar`, mas aí sem dado pessoal (o nome
   * digitado de quem retira a sangria só vai a quem vê o payload, D19).
   */
  resumo: string | null;
  /**
   * O que digitar para confirmar o descarte (`venda.*`, `caixa.*`, `nfce.*`, SYNC 11.4): o número exibido da venda
   * lido do payload; sem ele (eventos de caixa, payload ilegível), a sequência do evento. Nulo: não exige.
   */
  confirmacaoDescarte: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Fila de decisão (ERP 12.5; SYNC 8.5, 11.2–11.4)

/** Justificativa do descarte (SYNC 11.4: pelo menos 15 caracteres). */
export const JUSTIFICATIVA_DESCARTE_MIN = 15;
export const JUSTIFICATIVA_DESCARTE_MAX = 500;

/** `erro_codigo` que aceita "Aplicar com novo número" (SYNC 11.2, 13.1). */
export const CODIGO_NUMERO_VENDA_DUPLICADO = 'NUMERO_VENDA_DUPLICADO';

/**
 * Tipos críticos da fila (SYNC 11.3, 11.4): o `EVENTO_COM_ERRO` deles é `critico` (os outros, `aviso`) e o descarte
 * exige a confirmação digitando o número.
 */
export function eventoCritico(tipo: string): boolean {
  return /^(venda|caixa|nfce)\./.test(tipo);
}

/** "Aplicar com novo número" (SYNC 11.4): só o `erro` `NUMERO_VENDA_DUPLICADO` de um documento de venda. */
export function aceitaNovoNumero(e: { status: string; erroCodigo: string | null; tipo: string }): boolean {
  return e.status === 'erro' && e.erroCodigo === CODIGO_NUMERO_VENDA_DUPLICADO && e.tipo.startsWith('venda.');
}

const codigoErroEvento = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Código inválido')
  .max(40);

/** `GET /terminais/:id/eventos-erro`: filtro e página da fila (ERP 12.5). */
export const filtroEventosComErroSchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['erro', 'retido']).optional()),
  codigo: z.preprocess((v) => (v === '' ? undefined : v), codigoErroEvento.optional()),
  pagina: z.coerce.number().int().min(1).default(1),
  tamanho: z.coerce.number().int().min(1).max(200).default(50),
});
export type FiltroEventosComErro = z.output<typeof filtroEventosComErroSchema>;

export interface ListagemEventosComErro {
  itens: EventoComErro[];
  /** Total do filtro (para a paginação). */
  total: number;
  pagina: number;
  tamanho: number;
  /** Códigos de `erro` do terminal com a quantidade, sem o filtro (para "Reprocessar todos com este código"). */
  codigos: Array<{ codigo: string; quantidade: number }>;
}

/** Descartar (SYNC 11.4): justificativa e, nos tipos críticos, o número digitado (`confirmacaoDescarte`). */
export const descartarEventoSchema = z.object({
  justificativa: z
    .string()
    .trim()
    .min(
      JUSTIFICATIVA_DESCARTE_MIN,
      `A justificativa precisa de pelo menos ${JUSTIFICATIVA_DESCARTE_MIN} caracteres`,
    )
    .max(JUSTIFICATIVA_DESCARTE_MAX),
  confirmacao: z.preprocess(vazioParaNulo, z.string().trim().max(30).nullable().optional()),
});
export type DescartarEventoEntrada = z.input<typeof descartarEventoSchema>;
export type DescartarEvento = z.output<typeof descartarEventoSchema>;

/** "Reprocessar todos com este código" (SYNC 11.4): os `erro` do terminal com o código, numa tarefa. */
export const reprocessarLoteSchema = z.object({
  terminalId: z.uuid(),
  codigo: codigoErroEvento,
});
export type ReprocessarLoteEntrada = z.input<typeof reprocessarLoteSchema>;

/** Desfecho de um evento reaplicado pela fila. */
export interface DesfechoReprocessamento {
  eventoId: string;
  sequencia: number;
  tipo: string;
  status: 'aplicado' | 'retido' | 'erro';
  erroCodigo: string | null;
  erro: string | null;
}

/** Resposta de Reprocessar e de Aplicar com novo número. */
export interface ResultadoReprocessamento extends DesfechoReprocessamento {
  /** Retidos que dependiam dele, reaplicados em seguida em ordem de sequência (SYNC 8.5). */
  dependentes: DesfechoReprocessamento[];
  /** Aplicar com novo número: o número do caixa e o que a nuvem gravou. */
  numero: { original: string; novo: string } | null;
}

/** Resposta do Descartar: os retidos que dependiam dele e foram a `erro` `DEPENDENCIA_DESCARTADA` (SYNC 8.5). */
export interface ResultadoDescarte {
  eventoId: string;
  dependentes: Array<{ eventoId: string; sequencia: number; tipo: string }>;
}

/** Resposta do lote: a tarefa (ícone "Tarefas", ERP 3.6) e quantos eventos ela vai reaplicar. */
export interface ReprocessamentoAgendado {
  tarefaId: string;
  quantidade: number;
}

/** Salto de segurança da SYNC 13.3 quando o terminal anterior não confirmou a desativação. */
export const SALTO_SEGURANCA_NUMERACAO = 1000;
