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
 * Catálogo único das ações de `auditoria.acao` (ERP 17.1: lista aberta, sem CHECK no banco; a API e o PDV só gravam
 * ações daqui). MD 3.1.7 + ERP 17.1 + as citadas no MD 1.10 e 2.4.
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
] as const;
export type AcaoAuditoria = (typeof ACOES_AUDITORIA)[number];

const CONJUNTO_ACOES_AUDITORIA: ReadonlySet<string> = new Set(ACOES_AUDITORIA);

export function ehAcaoAuditoria(valor: unknown): valor is AcaoAuditoria {
  return typeof valor === 'string' && CONJUNTO_ACOES_AUDITORIA.has(valor);
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
