/** Enumerações fechadas do modelo de dados (MD 1.7: varchar + CHECK, mesmos valores aqui). */

export const STATUS_EMPRESA = ['provisionando', 'ativa', 'migrando', 'suspensa', 'cancelada'] as const;
export type StatusEmpresa = (typeof STATUS_EMPRESA)[number];

export const PAPEIS_ADMIN = ['superadmin', 'suporte', 'financeiro', 'somente_leitura'] as const;
export type PapelAdmin = (typeof PAPEIS_ADMIN)[number];

export const STATUS_MIGRACAO = ['pendente', 'aplicando', 'aplicada', 'falhou'] as const;
export type StatusMigracao = (typeof STATUS_MIGRACAO)[number];

export const STATUS_TERMINAL = ['provisionando', 'ativo', 'desativando', 'revogado'] as const;
export type StatusTerminal = (typeof STATUS_TERMINAL)[number];

export const STATUS_ATIVACAO = ['pendente', 'usado', 'expirado', 'cancelado'] as const;

export const REGIMES_FISCAIS = [
  'simples_nacional',
  'simples_excesso_sublimite',
  'regime_normal',
  'mei',
] as const;
export type RegimeFiscal = (typeof REGIMES_FISCAIS)[number];

export const ORIGENS_AUDITORIA = [
  'erp',
  'pdv',
  'api',
  'sistema',
  'importacao',
  'integracao',
  'suporte',
] as const;
export type OrigemAuditoria = (typeof ORIGENS_AUDITORIA)[number];

/**
 * Ações de auditoria que o caixa da Fase 3 vai gravar (F3-B3; plano da Fase 3 › Padrões, "Auditoria com ação
 * desconhecida"): entram no catálogo da nuvem **antes** de qualquer PDV que as grave, para a API já aceitá-las no
 * `auditoria.registros` (que não passa pelo T13). O PDV publicado não as conhece (o `CatalogosNuvem.AcoesAuditoria` do
 * caixa continua sem elas, conferido pelo `CicloOnlineTests`) e só passa a enviá-las com o recurso da onda disponível
 * (`RecursoDisponivel`, F3-B4). `venda_recuperada` é o nome que o caixa já grava **só localmente** desde a 1C (a venda
 * interrompida por uma queda, `ServicoVenda`): quando o PDV passar a enviá-la, sobem as duas (a da queda e a da venda
 * suspensa do F3-B23, que a distingue pelo `depois`). README da API › decisão 222.
 */
export const ACOES_AUDITORIA_FASE3 = [
  // Preço digitado ou alterado no item, e o F8 (tipo de preço da venda) (F3-B16, F3-B17).
  'preco_alterado',
  'tipo_preco_alterado',
  // F6 › acréscimo no total da venda (F3-B16).
  'acrescimo_total',
  // Lote vencido vendido com a liberação (F3-B21) e o peso digitado com a balança ou sem ela (F3-B22).
  'lote_vencido_liberado',
  'peso_digitado',
  // Venda suspensa e recuperada (F3-B23) e a venda acima de `pdv.limite_valor_venda` liberada (F3-B24).
  'venda_suspensa',
  'venda_recuperada',
  'limite_valor_liberado',
  // Cascos emprestados em comodato (F3-B40).
  'comodato_emprestado',
] as const;

/**
 * Catálogo único das ações de `auditoria.acao` (ERP 17.1: lista aberta, sem CHECK no banco; a API e o PDV só gravam
 * ações daqui). MD 3.1.7 + ERP 17.1 + as citadas no MD 1.10 e 2.4, mais as da Fase 3 (`ACOES_AUDITORIA_FASE3`).
 */
export const ACOES_AUDITORIA = [
  'criar',
  'editar',
  'excluir',
  'restaurar',
  'cancelar',
  'estornar',
  'importar',
  'exportar',
  'login',
  'login_negado',
  'logout',
  'liberacao',
  'permissoes_alteradas',
  'terminal_ativado',
  'gaveta_aberta',
  'efetivar',
  'movimentar',
  'converter',
  'conferir',
  'senha_alterada',
  'senha_redefinida',
  'bloqueio',
  'download_xml',
  'terminal_revogado',
  'evento_descartado',
  // Reprocessar e Aplicar com novo número da fila de decisão (ERP 12.5; SYNC 11.4; T9 da 1C).
  'evento_reprocessado',
  // Placeholder de lacuna substituído pelo evento real (SYNC 8.6; T9 da 1C): o placeholder original vai em `antes`.
  'lacuna_substituida',
  // Regressão do relógio no caixa (SYNC 12.3; T9 da 1C, C16): o último evento estava mais de 2 min à frente da hora
  // corrigida e a monotonicidade não foi aplicada. Gravada no PDV, uma por regressão, com as horas em `depois`.
  'relogio_regrediu',
  'acesso_suporte',
  'segredo_entregue',
  'token_anterior_reutilizado',
  'hardware_alterado',
  'idade_confirmada',
  'idade_recusada',
  'horario_restrito_liberado',
  // PIN com parâmetros argon2 fora dos limites do PDV (SYNC 4.2): o caixa recusa o login offline e avisa.
  'hash_fora_dos_limites',
  // Sangria acima do dinheiro estimado recusada no caixa (PDV 20.1; O5 + O3 da 1C): o valor tentado vai em `depois`.
  'sangria_recusada',
  // Confirmação manual do PIX no caixa (PDV 16.7; C11a): nome de quem pagou e horário do app do banco em `depois`, para
  // a conciliação com o extrato no ERP (Fase 4).
  'pix_confirmado_manual',
  // Reimpressão do comprovante no caixa (PDV 22.2; C11b): número da venda e documento em `depois`.
  'reimpressao',
  // Recebedor do PIX da loja (chave, nome, cidade) cadastrado ou trocado no ERP (implantação I5; `lojas.editar_pix`):
  // os três campos em `antes`/`depois`, além do `editar` da loja.
  'pix_recebedor_alterado',
  // Projeção do saldo (ou o `custo_medio` do produto) refeita pelo razão no `db:recalcular-saldos --corrigir` (Fase 2,
  // F2-B3): a linha de saldo em `antes`/`depois`; nunca altera movimento.
  'recalcular_saldos',
  // Ação do caixa que esta versão da nuvem não conhece (F3-B4; SYNC 9.22): o `auditoria.registros` grava a linha com
  // esta ação e o texto original (até 64 caracteres) na descrição, e abre o `AUDITORIA_ACAO_DESCONHECIDA`, em vez de
  // recusar o lote inteiro. Só o servidor a grava.
  'acao_desconhecida',
  ...ACOES_AUDITORIA_FASE3,
] as const;
export type AcaoAuditoria = (typeof ACOES_AUDITORIA)[number];

const CONJUNTO_ACOES_AUDITORIA: ReadonlySet<string> = new Set(ACOES_AUDITORIA);

export function ehAcaoAuditoria(valor: unknown): valor is AcaoAuditoria {
  return typeof valor === 'string' && CONJUNTO_ACOES_AUDITORIA.has(valor);
}

/** A ação gravada no lugar da que a nuvem não conhece (F3-B4; README da API › decisão 223). */
export const ACAO_AUDITORIA_DESCONHECIDA = 'acao_desconhecida' satisfies AcaoAuditoria;

/** Até quantos caracteres da ação original do caixa ficam na auditoria (e o máximo que o lote aceita na `acao`). */
export const ACAO_AUDITORIA_ORIGINAL_MAX = 64;

/**
 * Ações do catálogo que só o servidor grava (SYNC 9.22): o estado da revogação do terminal, o token anterior
 * reutilizado, as decisões da fila de eventos, a lacuna substituída e as alterações feitas só no ERP. O PDV nunca as
 * gera, e o push recusa o lote de auditoria que traz alguma delas (`PAYLOAD_INVALIDO`, só naquele evento). Também por
 * isso, quem lê um registro de auditoria como estado do servidor confere que ele não veio de um evento do terminal.
 */
export const ACOES_AUDITORIA_SO_SERVIDOR = [
  'terminal_revogado',
  'token_anterior_reutilizado',
  'evento_descartado',
  'evento_reprocessado',
  'lacuna_substituida',
  'permissoes_alteradas',
  'pix_recebedor_alterado',
  'recalcular_saldos',
  'acao_desconhecida',
] as const satisfies readonly AcaoAuditoria[];

const CONJUNTO_ACOES_SO_SERVIDOR: ReadonlySet<string> = new Set(ACOES_AUDITORIA_SO_SERVIDOR);

export function ehAcaoAuditoriaSoServidor(valor: unknown): boolean {
  return typeof valor === 'string' && CONJUNTO_ACOES_SO_SERVIDOR.has(valor);
}

/**
 * `historico_logins.motivo_falha` (MD 3.3.6; check `ck_historico_logins_motivo_falha`). Os três últimos são recusas
 * próprias do login offline do PDV (PDV 7.2): sem `pdv.acesso.entrar`, usuário de totem e hash do PIN fora dos limites
 * (SYNC 4.2).
 */
export const MOTIVOS_FALHA_LOGIN = [
  'senha_invalida',
  'usuario_inativo',
  'demitido',
  'loja_nao_permitida',
  'bloqueado',
  'empresa_suspensa',
  'sem_acesso_pdv',
  'totem',
  'hash_fora_dos_limites',
] as const;
export type MotivoFalhaLogin = (typeof MOTIVOS_FALHA_LOGIN)[number];

/** `rotacionada` foi acrescentado: marca o refresh token substituído na rotação (detecção de reuso). */
export const MOTIVOS_ENCERRAMENTO_SESSAO = [
  'logout',
  'expirada',
  'encerrada_admin',
  'senha_alterada',
  'reuso_detectado',
  'rotacionada',
] as const;
export type MotivoEncerramentoSessao = (typeof MOTIVOS_ENCERRAMENTO_SESSAO)[number];

export const TIPOS_LOJA = ['ponto_venda', 'deposito'] as const;
export const TIPOS_EMISSAO = ['nao_fiscal', 'sat', 'mfe', 'nfce'] as const;
export const TIPOS_ESTOQUE_LOCAL = ['loja', 'deposito', 'outro'] as const;
export const STATUS_TAREFA = ['na_fila', 'executando', 'concluida', 'falhou', 'cancelada'] as const;
export const SEVERIDADES_ALERTA = ['info', 'aviso', 'critico'] as const;
export const MODULOS_PERMISSAO = ['erp', 'pdv'] as const;
export type ModuloPermissao = (typeof MODULOS_PERMISSAO)[number];
