/**
 * Banco de controle `genesis_control` (MD 2). Só o que é da plataforma; nenhuma FK cruza bancos.
 * Triggers `tg_<tabela>_versao` (fn_versao_local), sequências e funções ficam nas migrações SQL customizadas.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  bytea,
  colunasAutoriaAdmin,
  colunasLog,
  colunasLogMutavel,
  colunasPadrao,
  timestamptz,
} from '../colunas.js';

export const planos = pgTable(
  'planos',
  {
    ...colunasPadrao(),
    codigo: varchar('codigo', { length: 30 }).notNull(),
    nome: varchar('nome', { length: 60 }).notNull(),
    descricao: text('descricao'),
    limiteLojas: integer('limite_lojas').notNull().default(1),
    limiteTerminais: integer('limite_terminais').notNull().default(1),
    limiteUsuarios: integer('limite_usuarios'),
    recursos: jsonb('recursos')
      .notNull()
      .default(sql`'{}'::jsonb`),
    precoMensal: numeric('preco_mensal', { precision: 15, scale: 2 }).notNull().default('0'),
    ativo: boolean('ativo').notNull().default(true),
    ...colunasAutoriaAdmin(),
  },
  (t) => [
    primaryKey({ name: 'pk_planos', columns: [t.id] }),
    uniqueIndex('uq_planos_codigo')
      .on(t.codigo)
      .where(sql`excluido_em is null`),
    check(
      'ck_planos_limites',
      sql`limite_lojas >= 1 and limite_terminais >= 0 and (limite_usuarios is null or limite_usuarios >= 1)`,
    ),
  ],
);

export const servidoresBanco = pgTable(
  'servidores_banco',
  {
    ...colunasPadrao(),
    nome: varchar('nome', { length: 60 }).notNull(),
    host: varchar('host', { length: 255 }).notNull(),
    porta: integer('porta').notNull().default(5432),
    usuario: varchar('usuario', { length: 63 }).notNull(),
    senhaCifrada: bytea('senha_cifrada').notNull(),
    capacidadeEmpresas: integer('capacidade_empresas'),
    aceitaNovasEmpresas: boolean('aceita_novas_empresas').notNull().default(true),
    ativo: boolean('ativo').notNull().default(true),
    observacoes: text('observacoes'),
  },
  (t) => [
    primaryKey({ name: 'pk_servidores_banco', columns: [t.id] }),
    uniqueIndex('uq_servidores_banco_nome')
      .on(t.nome)
      .where(sql`excluido_em is null`),
  ],
);

export const empresas = pgTable(
  'empresas',
  {
    ...colunasPadrao(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_empresa')`),
    razaoSocial: varchar('razao_social', { length: 150 }).notNull(),
    nomeFantasia: varchar('nome_fantasia', { length: 150 }),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    nomeBanco: varchar('nome_banco', { length: 63 }).notNull(),
    servidorBancoId: uuid('servidor_banco_id').notNull(),
    geracaoBanco: integer('geracao_banco').notNull().default(1),
    status: varchar('status', { length: 20 }).notNull().default('provisionando'),
    motivoStatus: varchar('motivo_status', { length: 255 }),
    planoId: uuid('plano_id').notNull(),
    limiteLojas: integer('limite_lojas'),
    limiteTerminais: integer('limite_terminais'),
    limiteUsuarios: integer('limite_usuarios'),
    versaoSchema: varchar('versao_schema', { length: 40 }),
    canalPdv: varchar('canal_pdv', { length: 7 }).notNull().default('estavel'),
    // "Liberar ativações" (ERP 12.2; SYNC 3.1): falhas de ativação anteriores a este instante não contam para o
    // bloqueio por força bruta do código da empresa (README › decisão 112).
    ativacoesLiberadasEm: timestamptz('ativacoes_liberadas_em'),
    // Acréscimo pedido pelo ERP 19.7 e ainda não descrito no MD (README › Decisões de implementação).
    canario: boolean('canario').notNull().default(false),
    // Role de runtime própria da empresa (MD 1.4; README › Decisões de implementação): sem DELETE nas tabelas C/D/P/R
    // e única com CONNECT no banco da empresa. A senha fica cifrada com a chave mestra (MD 1.10).
    usuarioBanco: varchar('usuario_banco', { length: 63 }),
    senhaBancoCifrada: bytea('senha_banco_cifrada'),
    nomeResponsavel: varchar('nome_responsavel', { length: 100 }),
    emailResponsavel: varchar('email_responsavel', { length: 254 }),
    telefoneResponsavel: varchar('telefone_responsavel', { length: 20 }),
    ativadaEm: timestamptz('ativada_em'),
    suspensaEm: timestamptz('suspensa_em'),
    canceladaEm: timestamptz('cancelada_em'),
    dadosRetidosAte: date('dados_retidos_ate'),
    observacoes: text('observacoes'),
    ...colunasAutoriaAdmin(),
  },
  (t) => [
    primaryKey({ name: 'pk_empresas', columns: [t.id] }),
    uniqueIndex('uq_empresas_codigo').on(t.codigo),
    uniqueIndex('uq_empresas_nome_banco').on(t.nomeBanco),
    index('ix_empresas_cnpj').on(t.cnpj),
    foreignKey({
      name: 'fk_empresas_servidor_banco_id',
      columns: [t.servidorBancoId],
      foreignColumns: [servidoresBanco.id],
    }),
    foreignKey({ name: 'fk_empresas_plano_id', columns: [t.planoId], foreignColumns: [planos.id] }),
    index('ix_empresas_plano_id').on(t.planoId),
    index('ix_empresas_servidor_banco_id').on(t.servidorBancoId),
    check('ck_empresas_status', sql`status in ('provisionando','ativa','migrando','suspensa','cancelada')`),
    check('ck_empresas_geracao_banco', sql`geracao_banco >= 1`),
    check('ck_empresas_nome_banco', sql`nome_banco = 'genesis_emp_' || codigo`),
    check('ck_empresas_canal_pdv', sql`canal_pdv in ('estavel','beta')`),
  ],
);

export const ativacoesPdv = pgTable(
  'ativacoes_pdv',
  {
    ...colunasPadrao(),
    empresaId: uuid('empresa_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    descricao: varchar('descricao', { length: 40 }),
    codigoHash: varchar('codigo_hash', { length: 64 }).notNull(),
    codigoFinal: varchar('codigo_final', { length: 2 }).notNull(),
    validadeHoras: smallint('validade_horas').notNull().default(24),
    expiraEm: timestamptz('expira_em').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pendente'),
    substituiTerminalId: uuid('substitui_terminal_id'),
    criadoPorUsuarioId: uuid('criado_por_usuario_id').notNull(),
    criadoPorNome: varchar('criado_por_nome', { length: 100 }).notNull(),
    usadoEm: timestamptz('usado_em'),
    usadoIp: inet('usado_ip'),
    terminalId: uuid('terminal_id'),
    canceladoEm: timestamptz('cancelado_em'),
    canceladoPorUsuarioId: uuid('cancelado_por_usuario_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_ativacoes_pdv', columns: [t.id] }),
    foreignKey({
      name: 'fk_ativacoes_pdv_empresa_id',
      columns: [t.empresaId],
      foreignColumns: [empresas.id],
    }),
    uniqueIndex('uq_ativacoes_pdv_codigo_hash')
      .on(t.codigoHash)
      .where(sql`status = 'pendente'`),
    index('ix_ativacoes_pdv_empresa_id_status').on(t.empresaId, t.status),
    index('ix_ativacoes_pdv_substitui_terminal_id').on(t.substituiTerminalId),
    index('ix_ativacoes_pdv_terminal_id').on(t.terminalId),
    check('ck_ativacoes_pdv_status', sql`status in ('pendente','usado','expirado','cancelado')`),
    check('ck_ativacoes_pdv_validade_horas', sql`validade_horas in (1,24,72)`),
  ],
);

export const terminaisPdv = pgTable(
  'terminais_pdv',
  {
    ...colunasPadrao(),
    empresaId: uuid('empresa_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    descricao: varchar('descricao', { length: 40 }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenEmitidoEm: timestamptz('token_emitido_em').notNull().defaultNow(),
    tokenHashAnterior: varchar('token_hash_anterior', { length: 64 }),
    tokenAnteriorValidoAte: timestamptz('token_anterior_valido_ate'),
    tokenAtualUsadoEm: timestamptz('token_atual_usado_em'),
    tokenRenovacaoRequisicaoId: uuid('token_renovacao_requisicao_id'),
    chaveBackupCifrada: bytea('chave_backup_cifrada'),
    chavePublicaTerminal: bytea('chave_publica_terminal').notNull(),
    chavePublicaAlgoritmo: varchar('chave_publica_algoritmo', { length: 10 }).notNull(),
    idHardwarePendente: varchar('id_hardware_pendente', { length: 128 }),
    hardwarePendenteDesde: timestamptz('hardware_pendente_desde'),
    hardwarePendenteIp: inet('hardware_pendente_ip'),
    hardwarePendenteSo: varchar('hardware_pendente_so', { length: 60 }),
    status: varchar('status', { length: 20 }).notNull().default('provisionando'),
    carenciaAte: timestamptz('carencia_ate'),
    ativadoEm: timestamptz('ativado_em').notNull().defaultNow(),
    ativadoPorUsuarioId: uuid('ativado_por_usuario_id'),
    ativacaoId: uuid('ativacao_id').notNull(),
    revogadoEm: timestamptz('revogado_em'),
    revogadoPorUsuarioId: uuid('revogado_por_usuario_id'),
    motivoRevogacao: varchar('motivo_revogacao', { length: 255 }),
    substituidoPorTerminalId: uuid('substituido_por_terminal_id'),
    nomeMaquina: varchar('nome_maquina', { length: 100 }),
    sistemaOperacional: varchar('sistema_operacional', { length: 60 }),
    idHardware: varchar('id_hardware', { length: 128 }),
    versaoApp: varchar('versao_app', { length: 20 }),
    ultimoContatoEm: timestamptz('ultimo_contato_em'),
    ultimoIp: inet('ultimo_ip'),
  },
  (t) => [
    primaryKey({ name: 'pk_terminais_pdv', columns: [t.id] }),
    foreignKey({
      name: 'fk_terminais_pdv_empresa_id',
      columns: [t.empresaId],
      foreignColumns: [empresas.id],
    }),
    foreignKey({
      name: 'fk_terminais_pdv_ativacao_id',
      columns: [t.ativacaoId],
      foreignColumns: [ativacoesPdv.id],
    }),
    foreignKey({
      name: 'fk_terminais_pdv_substituido_por_terminal_id',
      columns: [t.substituidoPorTerminalId],
      foreignColumns: [t.id],
    }),
    index('ix_terminais_pdv_ativacao_id').on(t.ativacaoId),
    index('ix_terminais_pdv_substituido_por_terminal_id').on(t.substituidoPorTerminalId),
    check('ck_terminais_pdv_status', sql`status in ('provisionando','ativo','desativando','revogado')`),
    check('ck_terminais_pdv_chave_publica_algoritmo', sql`chave_publica_algoritmo in ('x25519','p256')`),
    uniqueIndex('uq_terminais_pdv_caixa_ativo')
      .on(t.empresaId, t.caixaId)
      .where(sql`status in ('provisionando','ativo') and excluido_em is null`),
    index('ix_terminais_pdv_empresa_id_status').on(t.empresaId, t.status),
  ],
);

export const tentativasAtivacao = pgTable(
  'tentativas_ativacao',
  {
    ...colunasLog(),
    ip: inet('ip').notNull(),
    codigoEmpresa: integer('codigo_empresa'),
    sucesso: boolean('sucesso').notNull(),
    motivoFalha: varchar('motivo_falha', { length: 40 }),
  },
  (t) => [
    primaryKey({ name: 'pk_tentativas_ativacao', columns: [t.id] }),
    index('ix_tentativas_ativacao_ip_criado_em').on(t.ip, t.criadoEm),
    check(
      'ck_tentativas_ativacao_motivo_falha',
      sql`motivo_falha is null or motivo_falha in ('codigo_invalido','expirado','empresa_inativa','limite_plano','ip_bloqueado')`,
    ),
  ],
);

export const versoesAppPdv = pgTable(
  'versoes_app_pdv',
  {
    ...colunasPadrao(),
    // O MD 2.7 chama esta coluna de `versao`, nome que colide com a `versao` das CP (README › Decisões).
    versaoApp: varchar('versao_app', { length: 20 }).notNull(),
    canal: varchar('canal', { length: 10 }).notNull().default('estavel'),
    plataforma: varchar('plataforma', { length: 20 }).notNull(),
    urlPacote: text('url_pacote').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }).notNull(),
    versaoMinima: boolean('versao_minima').notNull().default(false),
    publicadaEm: timestamptz('publicada_em'),
    notas: text('notas'),
  },
  (t) => [
    primaryKey({ name: 'pk_versoes_app_pdv', columns: [t.id] }),
    uniqueIndex('uq_versoes_app_pdv_versao').on(t.versaoApp, t.canal, t.plataforma),
    check('ck_versoes_app_pdv_canal', sql`canal in ('estavel','beta')`),
    check('ck_versoes_app_pdv_plataforma', sql`plataforma in ('windows_x64','linux_x64')`),
  ],
);

export const adminsPlataforma = pgTable(
  'admins_plataforma',
  {
    ...colunasPadrao(),
    nome: varchar('nome', { length: 100 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    senhaHash: varchar('senha_hash', { length: 255 }).notNull(),
    papel: varchar('papel', { length: 20 }).notNull().default('suporte'),
    totpSegredoCifrado: bytea('totp_segredo_cifrado'),
    totpAtivo: boolean('totp_ativo').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    tentativasFalhas: smallint('tentativas_falhas').notNull().default(0),
    bloqueadoAte: timestamptz('bloqueado_ate'),
    ultimoLoginEm: timestamptz('ultimo_login_em'),
    /** Último passo TOTP (janela de 30 s) aceito: impede reutilizar o mesmo código (README › Decisões). */
    totpUltimoPasso: bigint('totp_ultimo_passo', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ name: 'pk_admins_plataforma', columns: [t.id] }),
    uniqueIndex('uq_admins_plataforma_email')
      .on(sql`lower(email)`)
      .where(sql`excluido_em is null`),
    check(
      'ck_admins_plataforma_papel',
      sql`papel in ('superadmin','suporte','financeiro','somente_leitura')`,
    ),
  ],
);

export const sessoesAdmin = pgTable(
  'sessoes_admin',
  {
    ...colunasLogMutavel(),
    adminId: uuid('admin_id').notNull(),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull(),
    expiraEm: timestamptz('expira_em').notNull(),
    ultimoUsoEm: timestamptz('ultimo_uso_em'),
    ip: inet('ip'),
    userAgent: varchar('user_agent', { length: 255 }),
    encerradaEm: timestamptz('encerrada_em'),
    // Mesmo desenho de `sessoes_usuario` (MD 3.3.6): rotação e detecção de reuso por família.
    familiaId: uuid('familia_id').notNull(),
    motivoEncerramento: varchar('motivo_encerramento', { length: 20 }),
  },
  (t) => [
    primaryKey({ name: 'pk_sessoes_admin', columns: [t.id] }),
    foreignKey({
      name: 'fk_sessoes_admin_admin_id',
      columns: [t.adminId],
      foreignColumns: [adminsPlataforma.id],
    }),
    uniqueIndex('uq_sessoes_admin_refresh_token_hash').on(t.refreshTokenHash),
    index('ix_sessoes_admin_admin_id').on(t.adminId),
    index('ix_sessoes_admin_familia_id').on(t.familiaId),
    check(
      'ck_sessoes_admin_motivo_encerramento',
      sql`motivo_encerramento is null or motivo_encerramento in ('logout','expirada','encerrada_admin','reuso_detectado','rotacionada')`,
    ),
  ],
);

export const acessosSuporte = pgTable(
  'acessos_suporte',
  {
    ...colunasPadrao(),
    adminId: uuid('admin_id').notNull(),
    empresaId: uuid('empresa_id').notNull(),
    motivo: varchar('motivo', { length: 255 }).notNull(),
    somenteLeitura: boolean('somente_leitura').notNull().default(true),
    iniciadoEm: timestamptz('iniciado_em').notNull().defaultNow(),
    expiraEm: timestamptz('expira_em').notNull(),
    encerradoEm: timestamptz('encerrado_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_acessos_suporte', columns: [t.id] }),
    index('ix_acessos_suporte_empresa_id_iniciado_em').on(t.empresaId, t.iniciadoEm),
    index('ix_acessos_suporte_admin_id').on(t.adminId),
    foreignKey({
      name: 'fk_acessos_suporte_admin_id',
      columns: [t.adminId],
      foreignColumns: [adminsPlataforma.id],
    }),
    foreignKey({
      name: 'fk_acessos_suporte_empresa_id',
      columns: [t.empresaId],
      foreignColumns: [empresas.id],
    }),
    check('ck_acessos_suporte_expira_em', sql`expira_em <= iniciado_em + interval '4 hours'`),
  ],
);

export const auditoriaPlataforma = pgTable(
  'auditoria_plataforma',
  {
    ...colunasLog(),
    adminId: uuid('admin_id'),
    empresaId: uuid('empresa_id'),
    acao: varchar('acao', { length: 60 }).notNull(),
    entidade: varchar('entidade', { length: 60 }).notNull(),
    registroId: uuid('registro_id'),
    antes: jsonb('antes'),
    depois: jsonb('depois'),
    ip: inet('ip'),
  },
  (t) => [
    primaryKey({ name: 'pk_auditoria_plataforma', columns: [t.id] }),
    index('ix_auditoria_plataforma_empresa_id_criado_em').on(t.empresaId, t.criadoEm),
  ],
);

export const migracoesEmpresas = pgTable(
  'migracoes_empresas',
  {
    ...colunasPadrao(),
    empresaId: uuid('empresa_id').notNull(),
    migracao: varchar('migracao', { length: 120 }).notNull(),
    ordem: integer('ordem').notNull(),
    hash: varchar('hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pendente'),
    iniciadaEm: timestamptz('iniciada_em'),
    concluidaEm: timestamptz('concluida_em'),
    duracaoMs: integer('duracao_ms'),
    erro: text('erro'),
    executadoPor: varchar('executado_por', { length: 100 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_migracoes_empresas', columns: [t.id] }),
    foreignKey({
      name: 'fk_migracoes_empresas_empresa_id',
      columns: [t.empresaId],
      foreignColumns: [empresas.id],
    }),
    uniqueIndex('uq_migracoes_empresas_empresa_id_migracao').on(t.empresaId, t.migracao),
    index('ix_migracoes_empresas_status')
      .on(t.status)
      .where(sql`status in ('pendente','aplicando','falhou')`),
    check('ck_migracoes_empresas_status', sql`status in ('pendente','aplicando','aplicada','falhou')`),
  ],
);

export const backupsEmpresas = pgTable(
  'backups_empresas',
  {
    ...colunasPadrao(),
    empresaId: uuid('empresa_id').notNull(),
    tipo: varchar('tipo', { length: 12 }).notNull().default('diario'),
    chaveArmazenamento: varchar('chave_armazenamento', { length: 500 }),
    tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }),
    sha256: varchar('sha256', { length: 64 }),
    status: varchar('status', { length: 12 }).notNull().default('executando'),
    iniciadoEm: timestamptz('iniciado_em').notNull().defaultNow(),
    concluidoEm: timestamptz('concluido_em'),
    retencaoAte: date('retencao_ate'),
    erro: text('erro'),
  },
  (t) => [
    primaryKey({ name: 'pk_backups_empresas', columns: [t.id] }),
    foreignKey({
      name: 'fk_backups_empresas_empresa_id',
      columns: [t.empresaId],
      foreignColumns: [empresas.id],
    }),
    index('ix_backups_empresas_empresa_id_iniciado').on(t.empresaId, t.iniciadoEm.desc()),
    check('ck_backups_empresas_tipo', sql`tipo in ('diario','manual','cancelamento')`),
    check('ck_backups_empresas_status', sql`status in ('executando','concluido','falhou','expirado')`),
    check(
      'ck_backups_empresas_concluido',
      sql`status <> 'concluido' or (chave_armazenamento is not null and sha256 is not null and concluido_em is not null)`,
    ),
  ],
);

/** Tabelas com `versao` (recebem `tg_<tabela>_versao` com fn_versao_local na migração customizada). */
export const TABELAS_CONTROLE_COM_VERSAO = [
  'planos',
  'servidores_banco',
  'empresas',
  'ativacoes_pdv',
  'terminais_pdv',
  'versoes_app_pdv',
  'admins_plataforma',
  'acessos_suporte',
  'migracoes_empresas',
  'backups_empresas',
] as const;
