/** MD 3.3 – usuários, perfis, permissões, lojas permitidas e sessões. */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
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
  colunasAutoria,
  colunasLog,
  colunasLogMutavel,
  colunasPadrao,
  colunasReferencia,
  timestamptz,
} from '../../colunas.js';
import { estoques, lojas } from './estrutura.js';
import { municipios, ufs } from './referencias.js';

export const perfis = pgTable(
  'perfis',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    nome: varchar('nome', { length: 40 }).notNull(),
    descricao: varchar('descricao', { length: 255 }),
    chaveSistema: varchar('chave_sistema', { length: 30 }),
  },
  (t) => [
    primaryKey({ name: 'pk_perfis', columns: [t.id] }),
    uniqueIndex('uq_perfis_nome')
      .on(sql`lower(nome)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_perfis_chave_sistema')
      .on(t.chaveSistema)
      .where(sql`chave_sistema is not null`),
  ],
);

export const permissoes = pgTable(
  'permissoes',
  {
    chave: varchar('chave', { length: 80 }).notNull(),
    modulo: varchar('modulo', { length: 5 }).notNull(),
    grupo: varchar('grupo', { length: 60 }).notNull(),
    descricao: varchar('descricao', { length: 255 }).notNull(),
    ordem: integer('ordem').notNull().default(0),
    permiteLiberacao: boolean('permite_liberacao').notNull().default(true),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_permissoes', columns: [t.chave] }),
    check('ck_permissoes_chave', sql`chave ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check('ck_permissoes_modulo', sql`modulo in ('erp','pdv')`),
  ],
);

export const usuarios = pgTable(
  'usuarios',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_usuarios')`),
    nome: varchar('nome', { length: 100 }).notNull(),
    login: varchar('login', { length: 60 }).notNull(),
    email: varchar('email', { length: 254 }),
    senhaHash: varchar('senha_hash', { length: 255 }),
    senhaProvisoria: boolean('senha_provisoria').notNull().default(false),
    senhaAlteradaEm: timestamptz('senha_alterada_em'),
    senhaPdvHash: varchar('senha_pdv_hash', { length: 255 }),
    ativo: boolean('ativo').notNull().default(true),
    perfilId: uuid('perfil_id'),
    master: boolean('master').notNull().default(false),
    limiteDescontoPct: numeric('limite_desconto_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    comissaoPct: numeric('comissao_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    telefone: varchar('telefone', { length: 20 }),
    salario: numeric('salario', { precision: 15, scale: 2 }),
    admissao: date('admissao'),
    demissao: date('demissao'),
    rg: varchar('rg', { length: 20 }),
    cpf: varchar('cpf', { length: 11 }),
    cep: varchar('cep', { length: 8 }),
    logradouro: varchar('logradouro', { length: 150 }),
    numero: varchar('numero', { length: 20 }),
    complemento: varchar('complemento', { length: 80 }),
    bairro: varchar('bairro', { length: 80 }),
    municipioIbge: integer('municipio_ibge'),
    uf: char('uf', { length: 2 }),
    vendedor: boolean('vendedor').notNull().default(false),
    entregador: boolean('entregador').notNull().default(false),
    tecnico: boolean('tecnico').notNull().default(false),
    pdvUtilitario: boolean('pdv_utilitario').notNull().default(false),
    comandaEletronica: boolean('comanda_eletronica').notNull().default(false),
    totem: boolean('totem').notNull().default(false),
    // FK para `pessoas` (MD 3.5) entra na migração que criar a tabela de pessoas (Fase 1).
    pessoaId: uuid('pessoa_id'),
    observacoes: text('observacoes'),
    permissoesVersao: integer('permissoes_versao').notNull().default(0),
    tentativasFalhas: smallint('tentativas_falhas').notNull().default(0),
    bloqueadoAte: timestamptz('bloqueado_ate'),
    ultimoLoginEm: timestamptz('ultimo_login_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_usuarios', columns: [t.id] }),
    uniqueIndex('uq_usuarios_codigo')
      .on(t.codigo)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_usuarios_login')
      .on(sql`lower(login)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_usuarios_cpf')
      .on(t.cpf)
      .where(sql`cpf is not null and excluido_em is null`),
    foreignKey({ name: 'fk_usuarios_perfil_id', columns: [t.perfilId], foreignColumns: [perfis.id] }),
    foreignKey({
      name: 'fk_usuarios_municipio_ibge',
      columns: [t.municipioIbge],
      foreignColumns: [municipios.codigoIbge],
    }),
    foreignKey({ name: 'fk_usuarios_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    index('ix_usuarios_perfil_id').on(t.perfilId),
    index('ix_usuarios_pessoa_id').on(t.pessoaId),
    check('ck_usuarios_perfil', sql`master or perfil_id is not null or totem`),
    check(
      'ck_usuarios_limites',
      sql`limite_desconto_pct between 0 and 100 and comissao_pct between 0 and 100`,
    ),
    check('ck_usuarios_demissao', sql`demissao is null or admissao is null or demissao >= admissao`),
    check('ck_usuarios_login', sql`login !~ '\\s'`),
  ],
);

export const perfisPermissoes = pgTable(
  'perfis_permissoes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    perfilId: uuid('perfil_id').notNull(),
    permissao: varchar('permissao', { length: 80 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_perfis_permissoes', columns: [t.id] }),
    foreignKey({
      name: 'fk_perfis_permissoes_perfil_id',
      columns: [t.perfilId],
      foreignColumns: [perfis.id],
    }),
    foreignKey({
      name: 'fk_perfis_permissoes_permissao',
      columns: [t.permissao],
      foreignColumns: [permissoes.chave],
    }),
    uniqueIndex('uq_perfis_permissoes')
      .on(t.perfilId, t.permissao)
      .where(sql`excluido_em is null`),
    index('ix_perfis_permissoes_permissao').on(t.permissao),
  ],
);

export const usuariosPermissoes = pgTable(
  'usuarios_permissoes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    usuarioId: uuid('usuario_id').notNull(),
    permissao: varchar('permissao', { length: 80 }).notNull(),
    efeito: varchar('efeito', { length: 8 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_usuarios_permissoes', columns: [t.id] }),
    foreignKey({
      name: 'fk_usuarios_permissoes_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_usuarios_permissoes_permissao',
      columns: [t.permissao],
      foreignColumns: [permissoes.chave],
    }),
    uniqueIndex('uq_usuarios_permissoes')
      .on(t.usuarioId, t.permissao)
      .where(sql`excluido_em is null`),
    index('ix_usuarios_permissoes_permissao').on(t.permissao),
    check('ck_usuarios_permissoes_efeito', sql`efeito in ('conceder','negar')`),
  ],
);

export const usuariosLojas = pgTable(
  'usuarios_lojas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    usuarioId: uuid('usuario_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_usuarios_lojas', columns: [t.id] }),
    foreignKey({
      name: 'fk_usuarios_lojas_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({ name: 'fk_usuarios_lojas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    uniqueIndex('uq_usuarios_lojas')
      .on(t.usuarioId, t.lojaId)
      .where(sql`excluido_em is null`),
    index('ix_usuarios_lojas_loja_id').on(t.lojaId),
  ],
);

export const usuariosEstoques = pgTable(
  'usuarios_estoques',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    usuarioId: uuid('usuario_id').notNull(),
    estoqueId: uuid('estoque_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_usuarios_estoques', columns: [t.id] }),
    foreignKey({
      name: 'fk_usuarios_estoques_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_usuarios_estoques_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    uniqueIndex('uq_usuarios_estoques')
      .on(t.usuarioId, t.estoqueId)
      .where(sql`excluido_em is null`),
    index('ix_usuarios_estoques_estoque_id').on(t.estoqueId),
  ],
);

export const sessoesUsuario = pgTable(
  'sessoes_usuario',
  {
    ...colunasLogMutavel(),
    usuarioId: uuid('usuario_id').notNull(),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull(),
    familiaId: uuid('familia_id').notNull(),
    expiraEm: timestamptz('expira_em').notNull(),
    ultimoUsoEm: timestamptz('ultimo_uso_em'),
    ip: inet('ip'),
    userAgent: varchar('user_agent', { length: 255 }),
    encerradaEm: timestamptz('encerrada_em'),
    motivoEncerramento: varchar('motivo_encerramento', { length: 20 }),
  },
  (t) => [
    primaryKey({ name: 'pk_sessoes_usuario', columns: [t.id] }),
    foreignKey({
      name: 'fk_sessoes_usuario_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_sessoes_usuario_refresh_token_hash').on(t.refreshTokenHash),
    index('ix_sessoes_usuario_usuario_id_encerrada_em').on(t.usuarioId, t.encerradaEm),
    index('ix_sessoes_usuario_familia_id').on(t.familiaId),
    check(
      'ck_sessoes_usuario_motivo_encerramento',
      sql`motivo_encerramento is null or motivo_encerramento in ('logout','expirada','encerrada_admin','senha_alterada','reuso_detectado','rotacionada')`,
    ),
  ],
);

export const historicoLogins = pgTable(
  'historico_logins',
  {
    ...colunasLog(),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    origem: varchar('origem', { length: 5 }).notNull(),
    usuarioId: uuid('usuario_id'),
    loginInformado: varchar('login_informado', { length: 60 }).notNull(),
    terminalId: uuid('terminal_id'),
    sucesso: boolean('sucesso').notNull(),
    motivoFalha: varchar('motivo_falha', { length: 30 }),
    ip: inet('ip'),
    userAgent: varchar('user_agent', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_historico_logins', columns: [t.id] }),
    index('ix_historico_logins_usuario_id_ocorrido_em').on(t.usuarioId, t.ocorridoEm),
    check('ck_historico_logins_origem', sql`origem in ('erp','pdv')`),
    check(
      'ck_historico_logins_motivo_falha',
      // MOTIVOS_FALHA_LOGIN (`@genesis/shared`); os três últimos são recusas próprias do login offline do PDV (PDV 7.2).
      sql`motivo_falha is null or motivo_falha in ('senha_invalida','usuario_inativo','demitido','loja_nao_permitida','bloqueado','empresa_suspensa','sem_acesso_pdv','totem','hash_fora_dos_limites')`,
    ),
  ],
);

export const redefinicoesSenha = pgTable(
  'redefinicoes_senha',
  {
    ...colunasLog(),
    usuarioId: uuid('usuario_id').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiraEm: timestamptz('expira_em').notNull(),
    usadoEm: timestamptz('usado_em'),
    ip: inet('ip'),
  },
  (t) => [
    primaryKey({ name: 'pk_redefinicoes_senha', columns: [t.id] }),
    foreignKey({
      name: 'fk_redefinicoes_senha_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_redefinicoes_senha_token_hash').on(t.tokenHash),
    index('ix_redefinicoes_senha_usuario_id').on(t.usuarioId),
  ],
);
