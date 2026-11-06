/**
 * Contratos do `/sync/*` (SYNC 2.3): corpos e respostas em `snake_case`, como as colunas. Ficam aqui, e não na API,
 * para a suíte de contrato (SYNC 17) rodar as mesmas fixtures (`packages/shared/testes/sync/*.json`) no Vitest e no
 * xUnit do PDV (`GenesisPDV.Sync.Tests`, que lê os arquivos por link no csproj). A API reexporta tudo e acrescenta a
 * validação com o envelope de erro do sync (`apps/api/src/sync/contratos.ts`).
 *
 * As requisições seguem o que a API aceita (campos desconhecidos são ignorados, como no resto da API). As respostas
 * são `strictObject`: o teste de integração valida a resposta real da API com elas, então um campo novo na API sem
 * fixture e sem o record C# correspondente quebra o teste em vez de passar despercebido.
 */
import { z } from 'zod';
import { MOTIVOS_FALHA_LOGIN } from '../enums.js';

const uuid = z.uuid();
const instante = z.iso.datetime({ offset: true });
const inteiro = z.number().int();

/** Fluxos do `/sync/pull` na ordem da carga inicial (SYNC 6.1; MD 6.1). */
export const FLUXOS = [
  'configuracao',
  'acesso',
  'referencia',
  'catalogo',
  'estoque',
  'pessoas',
  'operacao',
] as const;
export type Fluxo = (typeof FLUXOS)[number];

/**
 * Máximo de `comandos_resultado` num heartbeat (SYNC 21.1). A resposta do heartbeat nunca entrega mais comandos que
 * isto (os demais saem nos heartbeats seguintes, conforme os acks chegam), e o PDV manda os acks em fatias deste tamanho.
 */
export const MAX_COMANDOS_HEARTBEAT = 100;

/** Alfabeto do código de ativação, sem caracteres ambíguos (0/O, 1/I/L) (SYNC 3.1). */
export const ALFABETO_ATIVACAO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** SYNC 19.2: até 50 eventos ou 8 MiB por lote (o limite de bytes vale no corpo, `useBodyParser` da API). */
export const MAXIMO_EVENTOS_LOTE = 50;

// ---------------------------------------------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------------------------------------------

/** `POST /sync/ativar` (SYNC 3.2). */
export const ativarSchema = z.object({
  codigo_empresa: z.coerce.number().int().min(100000).max(999999),
  codigo_ativacao: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(new RegExp(`^[${ALFABETO_ATIVACAO}]{8}$`), 'código de 8 caracteres')),
  requisicao_ativacao_id: uuid,
  maquina: z.object({
    nome_maquina: z.string().trim().min(1).max(100),
    sistema_operacional: z.string().trim().min(1).max(60),
    id_hardware: z.string().regex(/^[0-9A-Za-z]{16,128}$/),
    versao_app: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/),
    plataforma: z.enum(['windows_x64', 'linux_x64']),
    versao_schema_local: z.number().int().min(0),
  }),
  chave_backup_publica: z.base64(),
  chave_publica_terminal: z.object({ algoritmo: z.enum(['x25519', 'p256']), chave: z.base64() }),
});
export type Ativar = z.infer<typeof ativarSchema>;

/** Query do `GET /sync/pull` (SYNC 6.3): `teto` = `cursor_teto` da 1ª página, repetido até o fim da carga. */
export const pullQuerySchema = z.object({
  fluxo: z.enum(FLUXOS),
  desde: z.coerce.number().int().min(0),
  limite: z.coerce.number().int().min(1).max(2000).default(500),
  teto: z.coerce.number().int().min(0).optional(),
});

/** SYNC 7.2: até 200 ids por consulta ao `GET /sync/eventos-status`. */
export const MAXIMO_IDS_EVENTOS_STATUS = 200;

/**
 * Query do `GET /sync/eventos-status?ids=` (SYNC 7.2, 21.1): ids separados por vírgula (ou o parâmetro repetido), sem
 * repetição, de 1 a 200.
 */
export const eventosStatusQuerySchema = z.object({
  ids: z
    .preprocess(
      (v) =>
        (Array.isArray(v) ? v : [v])
          .flatMap((x) => (typeof x === 'string' ? x.split(',') : []))
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
      z.array(uuid).min(1).max(MAXIMO_IDS_EVENTOS_STATUS),
    )
    .transform((ids) => [...new Set(ids)]),
});
export type EventosStatusQuery = z.infer<typeof eventosStatusQuerySchema>;

/** SYNC 22.2: página padrão e máxima do `GET /sync/recuperar` (a reidratação aplica uma página por transação). */
export const LIMITE_RECUPERAR_PADRAO = 50;
export const LIMITE_RECUPERAR_MAXIMO = 200;

/**
 * Query do `GET /sync/recuperar?desde_sequencia=&limite=` (SYNC 22.2): os eventos do terminal com
 * `sequencia_terminal > desde_sequencia`, em ordem, até `limite` (padrão 50, máximo 200).
 */
export const recuperarQuerySchema = z.object({
  desde_sequencia: z.coerce.number().int().min(0),
  limite: z.coerce.number().int().min(1).max(LIMITE_RECUPERAR_MAXIMO).default(LIMITE_RECUPERAR_PADRAO),
});
export type RecuperarQuery = z.infer<typeof recuperarQuerySchema>;

const dependencia = z.object({ agregado_tipo: z.string().min(1).max(30), agregado_id: uuid });

/** Envelope de cada evento do push (SYNC 7.3). */
export const eventoSchema = z.object({
  evento_id: uuid,
  terminal_id: uuid.optional(),
  sequencia: z.number().int().min(1),
  tipo: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/)
    .max(40),
  versao_schema: z.number().int().min(1).max(32767),
  agregado_tipo: z.string().min(1).max(30),
  agregado_id: uuid,
  dependencias: z.array(dependencia).max(100).default([]),
  ocorrido_em: instante,
  ocorrido_em_local: instante.optional(),
  desvio_relogio_ms: z.number().int().optional(),
  relogio_confiavel: z.boolean().optional(),
  relogio_regrediu: z.boolean().optional(),
  usuario_id: uuid.nullable().optional(),
  contexto: z.object({
    loja_id: uuid,
    caixa_id: uuid,
    numero_caixa: z.number().int().optional(),
    estoque_id: uuid.optional(),
    sessao_caixa_id: uuid.nullable().optional(),
    versao_app: z.string().max(20).optional(),
    versao_schema_local: z.number().int().optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EnvelopeEvento = z.infer<typeof eventoSchema>;

/**
 * Payload do `auditoria.registros` v1 (SYNC 9): o `log_auditoria_local` do PDV. `acao` é texto aqui; a API recusa o
 * evento com ação fora de `ACOES_AUDITORIA` (`ehAcaoAuditoria`). O `motivo_falha` do login segue `historico_logins`
 * (MD 3.3.6), que inclui as recusas próprias do login offline. A fixture `auditoria.registros.payload.json` traz o que
 * o PDV grava e passa por aqui e pelo xUnit do PDV.
 */
export const payloadAuditoriaRegistrosSchema = z.object({
  registros: z
    .array(
      z.object({
        id: uuid,
        ocorrido_em: instante,
        usuario_id: uuid.nullable().optional(),
        autorizado_por_id: uuid.nullable().optional(),
        acao: z.string().max(40),
        entidade: z.string().min(1).max(60),
        registro_id: uuid.nullable().optional(),
        localizacao: z.string().max(60).nullable().optional(),
        descricao: z.string().max(2000).nullable().optional(),
        antes: z.unknown().optional(),
        depois: z.unknown().optional(),
        sessao_caixa_id: uuid.nullable().optional(),
      }),
    )
    .max(1000)
    .default([]),
  logins: z
    .array(
      z.object({
        id: uuid,
        ocorrido_em: instante,
        usuario_id: uuid.nullable().optional(),
        login_informado: z.string().min(1).max(60),
        sucesso: z.boolean(),
        motivo_falha: z.enum(MOTIVOS_FALHA_LOGIN).nullable().optional(),
      }),
    )
    .max(1000)
    .default([]),
});
export type PayloadAuditoriaRegistros = z.infer<typeof payloadAuditoriaRegistrosSchema>;

/** Tipo do placeholder de lacuna (SYNC 6.3 M8, 8.6): gerado só pela nuvem, nunca pelo PDV. */
export const TIPO_TERMINAL_LACUNA = 'terminal.lacuna';

/**
 * Por que o caixa declara a lacuna (SYNC 8.6): `banco_local_perdido` = as sequências não existem mais no banco local
 * (linhas perdidas, bug); `restauracao_backup` = a nuvem foi restaurada de backup (22.5) e o caixa não tem mais o
 * payload; `outro` = o supervisor explica em `observacao`.
 */
export const MOTIVOS_LACUNA = ['banco_local_perdido', 'restauracao_backup', 'outro'] as const;
export type MotivoLacuna = (typeof MOTIVOS_LACUNA)[number];

/**
 * Teto de sequências numa declaração ou recuperação de lacuna (SYNC 8.6): uma faixa maior não é perda de eventos, é
 * sequência local corrompida (chame o suporte), e cada sequência vira uma linha placeholder na nuvem.
 */
export const MAXIMO_SEQUENCIAS_LACUNA = 5000;

const faixaLacuna = {
  de: z.number().int().min(1),
  ate: z.number().int().min(1),
  /** Supervisor que liberou no caixa (PDV 31.3), com `pdv.config.fiscal`: a nuvem confere a permissão. */
  autorizado_por_id: uuid,
};

const faixaValida = (f: { de: number; ate: number }) =>
  f.ate >= f.de && f.ate - f.de + 1 <= MAXIMO_SEQUENCIAS_LACUNA;
const mensagemFaixa = `faixa inválida: de ≤ ate e no máximo ${MAXIMO_SEQUENCIAS_LACUNA} sequências`;

/**
 * `declarar_lacuna` do push (SYNC 8.6): as sequências `de`..`ate` do terminal não existem mais em lugar nenhum. A
 * nuvem só aceita a faixa que começa na `proxima_sequencia_esperada` (a que ela espera) — senão sobraria outra lacuna
 * antes, ou a faixa cobriria sequências já recebidas — e grava um placeholder `terminal.lacuna` (`descartado`) por
 * sequência. A mesma declaração repetida (reenvio sem resposta) devolve o mesmo resultado.
 */
export const declararLacunaSchema = z
  .object({
    ...faixaLacuna,
    motivo: z.enum(MOTIVOS_LACUNA),
    /** Texto do supervisor (o motivo da liberação, PDV 31.3). */
    observacao: z.string().trim().max(255).optional(),
  })
  .refine(faixaValida, mensagemFaixa);
export type DeclararLacuna = z.infer<typeof declararLacunaSchema>;

/**
 * `recuperar_lacuna` do push (SYNC 8.6): o caixa achou os eventos reais de uma lacuna já declarada e o supervisor
 * autorizou substituir os placeholders `de`..`ate`. Sem ela, o evento que cai num placeholder recebe
 * `lacuna_recuperavel` e o lote para.
 */
export const recuperarLacunaSchema = z.object(faixaLacuna).refine(faixaValida, mensagemFaixa);
export type RecuperarLacuna = z.infer<typeof recuperarLacunaSchema>;

/**
 * `POST /sync/push` (SYNC 7.4). Os eventos são validados um a um depois (`eventoSchema`), para o erro apontar o
 * índice do evento inválido. O lote pode ir sem eventos só para declarar uma lacuna (8.6); `declarar_lacuna` e
 * `recuperar_lacuna` não vão juntos.
 */
export const pushSchema = z
  .object({
    lote_id: uuid,
    terminal_id: uuid,
    enviado_em: instante,
    eventos_pendentes_total: z.number().int().min(0).optional(),
    eventos: z.array(z.unknown()),
    declarar_lacuna: declararLacunaSchema.optional(),
    recuperar_lacuna: recuperarLacunaSchema.optional(),
  })
  .refine((l) => l.eventos.length > 0 || l.declarar_lacuna !== undefined, {
    message: 'Lote sem eventos.',
    path: ['eventos'],
  })
  .refine((l) => !(l.declarar_lacuna && l.recuperar_lacuna), {
    message: 'declarar_lacuna e recuperar_lacuna não vão no mesmo lote.',
    path: ['recuperar_lacuna'],
  });

const inteiroOpcional = z.number().int().nullable().optional();

/** Situação local do terminal informada no heartbeat (SYNC 3.8). */
export const ESTADOS_LOCAIS_TERMINAL = ['ativo', 'desativando', 'desativando_confirmado'] as const;

/** `POST /sync/heartbeat` (SYNC 21.1). */
export const heartbeatSchema = z.object({
  versao_app: z.string().max(20).optional(),
  estado_local: z.enum(ESTADOS_LOCAIS_TERMINAL).default('ativo'),
  so: z.string().max(60).optional(),
  hora_local: instante.optional(),
  desvio_relogio_ms: inteiroOpcional,
  relogio_confiavel: z.boolean().nullable().optional(),
  cursor_pull: z.partialRecord(z.enum(FLUXOS), z.number().int().min(0)).optional(),
  ultimo_pull_sucesso_em: instante.nullable().optional(),
  eventos_pendentes: z.number().int().min(0).default(0),
  evento_mais_antigo_em: instante.nullable().optional(),
  eventos_rejeitados: z.number().int().min(0).default(0),
  ultima_sequencia_gerada: inteiroOpcional,
  venda_ultimo_numero: inteiroOpcional,
  vale_ultimo_numero: inteiroOpcional,
  nfce_ultimo_numero: z
    .array(z.object({ serie: z.number().int(), ambiente: z.number().int(), numero: z.number().int() }))
    .optional(),
  nfce_contingencia_pendentes: z.number().int().min(0).default(0),
  nfce_contingencia_mais_antiga_em: instante.nullable().optional(),
  inutilizacoes_pendentes: z.number().int().min(0).default(0),
  sessao_caixa_id: uuid.nullable().optional(),
  operador_id: uuid.nullable().optional(),
  dinheiro_estimado_gaveta: z
    .string()
    .regex(/^-?\d{1,13}\.\d{2}$/)
    .nullable()
    .optional(),
  certificado_validade: instante.nullable().optional(),
  disco_livre_mb: inteiroOpcional,
  tamanho_banco_mb: inteiroOpcional,
  fila_impressao_pendentes: z.number().int().min(0).default(0),
  sse_conectado: z.boolean().optional(),
  versao_schema_local: inteiroOpcional,
  ultimo_erro: z.string().max(2000).nullable().optional(),
  vendas_cancelamento_pendente: z.array(uuid).max(50).default([]),
  eventos_resolvidos_ack: z.array(uuid).max(500).default([]),
  comandos_resultado: z
    .array(
      z.object({
        comando_id: uuid,
        status: z.enum(['recebido', 'executado', 'falhou']),
        resultado: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(MAX_COMANDOS_HEARTBEAT)
    .default([]),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/**
 * `POST /sync/token/renovar` (SYNC 3.7): o PDV gera o segredo novo, grava-o como `token.pendente` e manda só o SHA-256
 * dele (o mesmo `sha256_hex(segredo)` de `terminais_pdv.token_hash`). O `requisicao_id` é o do pendente: repetir a
 * renovação com ele não muda nada.
 */
export const renovarTokenSchema = z.object({
  novo_token_hash: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 em hex minúsculo'),
  requisicao_id: uuid,
});
export type RenovarToken = z.infer<typeof renovarTokenSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------------------------------------------

const numeracoesSchema = z.strictObject({
  venda: z.strictObject({ ultimo_numero: inteiro }),
  nfce: z.array(z.strictObject({ serie: inteiro, ambiente: inteiro, ultimo_numero: inteiro })),
  vale: z.strictObject({ ultimo_numero: inteiro }),
});
export type NumeracoesTerminal = z.infer<typeof numeracoesSchema>;

/** Intervalos sugeridos pela nuvem, em segundos (SYNC 18.2). */
export const intervalosSyncSchema = z.strictObject({
  heartbeat_s: inteiro,
  pull_s: inteiro,
  pull_com_sse_s: inteiro,
  push_pendente_s: inteiro,
});
export type IntervalosSync = z.infer<typeof intervalosSyncSchema>;

/** Versão mínima e disponível do app para a plataforma e o canal da empresa (SYNC 17.3). */
const appSchema = z.strictObject({
  versao_minima: z.string().nullable(),
  versao_disponivel: z.string().nullable(),
  url_pacote: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  atualizar_ate: instante.nullable(),
});

/** Resposta `201` do `POST /sync/ativar` (SYNC 3.2). */
export const respostaAtivacaoSchema = z.strictObject({
  terminal_id: uuid,
  /** `<terminal_id>.<segredo>`: só aparece nesta resposta; o PDV guarda cifrado (SYNC 3.6). */
  token: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
  token_emitido_em: instante,
  renovar_token_apos_dias: inteiro,
  empresa: z.strictObject({ codigo: inteiro, razao_social: z.string() }),
  loja: z.strictObject({
    id: uuid,
    codigo: inteiro,
    nome: z.string(),
    cnpj: z.string(),
    fuso_horario: z.string(),
    estoque_id: uuid,
    tipo_emissao: z.enum(['nao_fiscal', 'sat', 'mfe', 'nfce']),
  }),
  caixa: z.strictObject({ id: uuid, numero: inteiro, nfce_serie: inteiro.nullable() }),
  /** Já com o salto de segurança quando o caixa teve terminal sem desativação confirmada (SYNC 13.3). */
  numeracoes: numeracoesSchema,
  sequencia_terminal: z.strictObject({ ultima_recebida: inteiro }),
  fluxos: z.array(z.enum(FLUXOS)),
  /** Chave de backup cifrada para a `chave_backup_publica` efêmera do assistente (SYNC 22.3). */
  chave_backup_cifrada: z.base64(),
  intervalos: intervalosSyncSchema,
  versao_protocolo: inteiro,
  agora_servidor: instante,
});
export type RespostaAtivacao = z.infer<typeof respostaAtivacaoSchema>;

/** Status do terminal na nuvem (MD 2.4; SYNC 3.8): `revogado` nunca chega aqui (é 401 `TERMINAL_REVOGADO`). */
export const STATUS_TERMINAL_AUTENTICADO = ['ativo', 'desativando'] as const;

/** Resposta `200` do `GET /sync/estado` (SYNC 5), o handshake de inicialização. */
export const respostaEstadoSchema = z.strictObject({
  terminal: z.strictObject({
    id: uuid,
    status: z.enum(STATUS_TERMINAL_AUTENTICADO),
    loja_id: uuid,
    caixa_id: uuid,
    numero_caixa: inteiro,
    carencia_ate: instante.nullable(),
    id_hardware_confere: z.boolean(),
  }),
  empresa_status: z.enum(['provisionando', 'ativa', 'migrando', 'suspensa', 'cancelada']),
  loja: z.strictObject({
    ativa: z.boolean(),
    usa_pdv: z.boolean(),
    estoque_id: uuid.nullable(),
    tipo_emissao: z.string().nullable(),
  }),
  sequencia_terminal: z.strictObject({
    ultima_recebida: inteiro,
    ultimo_evento_id: uuid.nullable(),
    ultima_recebida_em: instante.nullable(),
  }),
  /** O maior entre o que a nuvem recebeu e o que o terminal informou no último heartbeat. */
  numeracoes: numeracoesSchema,
  informado_pelo_terminal: z.strictObject({
    ultimo_heartbeat_em: instante.nullable(),
    ultima_sequencia_gerada: inteiro,
    eventos_pendentes: inteiro,
    nfce_contingencia_pendentes: inteiro,
  }),
  /**
   * A sessão aberta **deste** terminal na nuvem (MD 3.12.1, bloco C5 da 1C), nunca a de outro terminal do mesmo caixa;
   * `null` sem sessão aberta (a fechada à força na substituição/revogação não volta).
   */
  sessao_caixa_aberta: z.strictObject({ id: uuid, operador_id: uuid, aberta_em: instante }).nullable(),
  eventos: z.strictObject({ com_erro: inteiro, retidos: inteiro }),
  protocolo: z.strictObject({ atual: inteiro, minimo: inteiro }),
  /** Tipos de evento com handler na nuvem e as versões de payload aceitas (SYNC 17.5). */
  versoes_schema: z.record(z.string(), z.array(inteiro)),
  app: appSchema,
  agora_servidor: instante,
});
export type RespostaEstado = z.infer<typeof respostaEstadoSchema>;

/**
 * Uma linha alterada (SYNC 6.3): a linha vem inteira na projeção do fluxo, com datas ISO UTC e decimais em texto.
 * Tombstone = `excluido_em` preenchido (a linha continua no espelho, MD 4.2).
 */
export const alteracaoPullSchema = z.strictObject({
  tabela: z.string(),
  versao: inteiro,
  linha: z.record(z.string(), z.unknown()),
});

/** Resposta `200` do `GET /sync/pull` (SYNC 6.3). Página não cortada → `novo_cursor = cursor_teto`. */
export const respostaPullSchema = z.strictObject({
  fluxo: z.enum(FLUXOS),
  desde: inteiro,
  novo_cursor: inteiro,
  tem_mais: z.boolean(),
  cursor_teto: inteiro,
  agora_servidor: instante,
  alteracoes: z.array(alteracaoPullSchema),
});
export type RespostaPull = z.infer<typeof respostaPullSchema>;

/** Desfecho de cada evento do lote (SYNC 7.4, 8.1–8.4). */
export const STATUS_RESULTADO_EVENTO = [
  'aplicado',
  'duplicado',
  'rejeitado',
  'retido',
  'descartado',
  'fora_de_ordem',
  // Sequência numa faixa declarada como lacuna (placeholder `terminal.lacuna`) sem `recuperar_lacuna` no lote (8.6):
  // não processado e o lote para; `resultado.lacuna` traz a faixa declarada (`de`, `ate`) que o supervisor libera.
  'lacuna_recuperavel',
  'nao_processado',
  'erro_temporario',
] as const;
export type StatusResultadoEvento = (typeof STATUS_RESULTADO_EVENTO)[number];

const erroEventoSchema = z.strictObject({ codigo: z.string(), mensagem: z.string() });

export const resultadoEventoSchema = z.strictObject({
  evento_id: uuid,
  sequencia: inteiro,
  status: z.enum(STATUS_RESULTADO_EVENTO),
  versao_nuvem: inteiro.nullable().optional(),
  versao_nuvem_fim: inteiro.nullable().optional(),
  resultado: z.record(z.string(), z.unknown()).nullable().optional(),
  erro: erroEventoSchema.optional(),
});
export type ResultadoEvento = z.infer<typeof resultadoEventoSchema>;

/** Comando para o terminal (SYNC 21.1), entregue no heartbeat (e, no futuro, no push) até o ack. */
export const comandoTerminalSchema = z.strictObject({
  id: uuid,
  tipo: z.string(),
  parametros: z.unknown(),
});

/** Resposta `200` do `POST /sync/push` (SYNC 7.4): sempre 200 quando o lote foi lido; o resultado é por evento. */
export const respostaPushSchema = z.strictObject({
  lote_id: uuid,
  recebido_em: instante,
  agora_servidor: instante,
  proxima_sequencia_esperada: inteiro,
  resultados: z.array(resultadoEventoSchema),
  comandos: z.array(comandoTerminalSchema),
});
export type RespostaPush = z.infer<typeof respostaPushSchema>;

/** Resolução de um evento decidida depois do push (reprocessado/descartado no ERP), entregue no heartbeat. */
export const eventoResolvidoSchema = z.strictObject({
  evento_id: uuid,
  status: z.enum(['aplicado', 'descartado']),
  versao_nuvem: inteiro.nullable().optional(),
  versao_nuvem_fim: inteiro.nullable().optional(),
  resultado: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Situação atual na nuvem de um evento do terminal (`GET /sync/eventos-status`, SYNC 7.2, 21.1): o formato dos itens de
 * `eventos_resolvidos`, mais `erro` e `retido` (ainda sem decisão no ERP; o PDV não muda nada), estes com o `erro`
 * gravado (código da SYNC 11.2 e mensagem). Só os estados finais e os da fila: `recebido` nunca fica gravado fora da
 * transação do evento.
 */
export const STATUS_EVENTO_NUVEM = ['aplicado', 'descartado', 'erro', 'retido'] as const;
export type StatusEventoNuvem = (typeof STATUS_EVENTO_NUVEM)[number];

export const statusEventoNuvemSchema = z.strictObject({
  evento_id: uuid,
  status: z.enum(STATUS_EVENTO_NUVEM),
  versao_nuvem: inteiro.nullable().optional(),
  versao_nuvem_fim: inteiro.nullable().optional(),
  resultado: z.record(z.string(), z.unknown()).nullable(),
  erro: erroEventoSchema.optional(),
});
export type StatusEventoNuvemItem = z.infer<typeof statusEventoNuvemSchema>;

/**
 * Resposta `200` do `GET /sync/eventos-status` (SYNC 7.2, 21.1; T6): um item por id que a nuvem tem **deste**
 * terminal, na ordem da sequência; id desconhecido (ou de outro terminal) fica fora, sem dizer qual dos dois. Só
 * leitura: não marca `resolucao_entregue_em` (o ack continua sendo o do heartbeat).
 */
export const respostaEventosStatusSchema = z.strictObject({
  agora_servidor: instante,
  eventos: z.array(statusEventoNuvemSchema),
});
export type RespostaEventosStatus = z.infer<typeof respostaEventosStatusSchema>;

/**
 * Envelope original de um evento devolvido pelo `GET /sync/recuperar` (SYNC 22.2): o que o PDV mandou no push (7.3),
 * remontado de `eventos_recebidos` (colunas + `envelope`, T1). `payload` nulo quando já anulado (13 meses, MD 3.15.2);
 * o `dependencias` é o do envelope gravado (a coluna ganha os bloqueadores do `retido` e não volta aqui).
 */
export const envelopeRecuperadoSchema = z.strictObject({
  ...eventoSchema.shape,
  payload: z.record(z.string(), z.unknown()).nullable(),
});
export type EnvelopeRecuperado = z.infer<typeof envelopeRecuperadoSchema>;

/**
 * Item do `GET /sync/recuperar` (SYNC 22.2): o envelope e a situação na nuvem, no formato do `eventos-status` (os
 * marcadores de versão, o `resultado`, o `erro` de `erro`/`retido`). `lacuna = true` marca o placeholder de uma lacuna
 * declarada (tipo `terminal.lacuna`, 8.6; T7): a sequência foi perdida e não há o que recriar no caixa.
 */
export const eventoRecuperadoSchema = z.strictObject({
  envelope: envelopeRecuperadoSchema,
  status: z.enum(STATUS_EVENTO_NUVEM),
  versao_nuvem: inteiro.nullable(),
  versao_nuvem_fim: inteiro.nullable(),
  resultado: z.record(z.string(), z.unknown()).nullable(),
  erro: erroEventoSchema.optional(),
  lacuna: z.boolean(),
});
export type EventoRecuperado = z.infer<typeof eventoRecuperadoSchema>;

/**
 * Resposta `200` do `GET /sync/recuperar` (SYNC 22.1, 22.2; Fase 1C, C17): a "re-hidratação", a nuvem devolve ao PDV o
 * que ele mesmo enviou. `ultima_recebida` é a maior sequência que a nuvem tem do terminal (placeholders incluídos);
 * `tem_mais` diz se há página seguinte (o PDV pede de novo com `desde_sequencia` = a última sequência da página). Só
 * leitura: nada muda na nuvem.
 */
export const respostaRecuperarSchema = z.strictObject({
  agora_servidor: instante,
  desde_sequencia: inteiro,
  ultima_recebida: inteiro,
  tem_mais: z.boolean(),
  eventos: z.array(eventoRecuperadoSchema),
});
export type RespostaRecuperar = z.infer<typeof respostaRecuperarSchema>;

/** Resposta `200` do `POST /sync/heartbeat` (SYNC 21.1). */
export const respostaHeartbeatSchema = z.strictObject({
  agora_servidor: instante,
  status_terminal: z.enum(['ativo', 'desativando', 'revogado', 'hardware_alterado']),
  comandos: z.array(comandoTerminalSchema),
  eventos_resolvidos: z.array(eventoResolvidoSchema),
  renovar_token: z.boolean(),
  app: appSchema,
  intervalos: intervalosSyncSchema,
});
export type RespostaHeartbeat = z.infer<typeof respostaHeartbeatSchema>;

/** Resposta `200` do `POST /sync/token/renovar` (SYNC 3.7): o PDV só promove o pendente na 1ª chamada com ele. */
export const respostaRenovarTokenSchema = z.strictObject({
  token_emitido_em: instante,
});
export type RespostaRenovarToken = z.infer<typeof respostaRenovarTokenSchema>;

/** Envelope de erro do `/sync/*` (SYNC 2.4): `requisicao_id` = `X-Requisicao-Id` aceito (ou gerado) pela API. */
export const envelopeErroSyncSchema = z.strictObject({
  erro: z.strictObject({
    codigo: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    mensagem: z.string(),
    detalhes: z.record(z.string(), z.unknown()),
    requisicao_id: uuid.nullable(),
  }),
});
export type EnvelopeErroSync = z.infer<typeof envelopeErroSyncSchema>;
