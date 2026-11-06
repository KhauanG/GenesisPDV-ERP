/**
 * MD 3.1 – configurações, templates, numerações, arquivos, tarefas, alertas e mensagens.
 * `auditoria` (particionada por mês) é criada em SQL na migração customizada; ver `../auditoria.ts`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { bytea, colunasAutoria, colunasLogMutavel, colunasPadrao, timestamptz } from '../../colunas.js';
import { caixas, lojas } from './estrutura.js';
import { usuarios } from './acesso.js';

export const configuracoes = pgTable(
  'configuracoes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    escopo: varchar('escopo', { length: 10 }).notNull().default('empresa'),
    lojaId: uuid('loja_id'),
    chave: varchar('chave', { length: 100 }).notNull(),
    valor: jsonb('valor'),
    valorCifrado: bytea('valor_cifrado'),
    segredoDefinidoEm: timestamptz('segredo_definido_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_configuracoes', columns: [t.id] }),
    foreignKey({ name: 'fk_configuracoes_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_configuracoes_loja_id').on(t.lojaId),
    check(
      'ck_configuracoes_escopo',
      sql`(escopo = 'empresa' and loja_id is null) or (escopo = 'loja' and loja_id is not null)`,
    ),
    check('ck_configuracoes_valor', sql`(valor is null) <> (valor_cifrado is null)`),
  ],
);

export const TIPOS_TEMPLATE = [
  'orcamento_logado',
  'orcamento_nao_logado',
  'email_cliente',
  'recibo_remessa_boleto',
  'recibo_receber',
  'recibo_pagar',
  'recibo_venda',
  'impressao_venda',
  'cupom_cabecalho',
  'cupom_rodape',
  'vale_compra',
  'ordem_servico',
  'whatsapp_cupom',
  'whatsapp_orcamento',
  'whatsapp_cobranca',
  'whatsapp_pedido_pronto',
  'whatsapp_pesquisa',
] as const;

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));

export const templatesDocumentos = pgTable(
  'templates_documentos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    tipo: varchar('tipo', { length: 40 }).notNull(),
    nome: varchar('nome', { length: 60 }).notNull(),
    descricao: varchar('descricao', { length: 255 }),
    assunto: varchar('assunto', { length: 150 }),
    formato: varchar('formato', { length: 10 }).notNull().default('html'),
    conteudo: text('conteudo').notNull(),
    lojaId: uuid('loja_id'),
    padrao: boolean('padrao').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_templates_documentos', columns: [t.id] }),
    foreignKey({ name: 'fk_templates_documentos_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_templates_documentos_loja_id').on(t.lojaId),
    check('ck_templates_documentos_tipo', sql`tipo in (${listaSql(TIPOS_TEMPLATE)})`),
    check('ck_templates_documentos_formato', sql`formato in ('html','texto')`),
  ],
);

export const numeracoes = pgTable(
  'numeracoes',
  {
    ...colunasPadrao(),
    tipo: varchar('tipo', { length: 20 }).notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id'),
    modelo: smallint('modelo'),
    serie: integer('serie'),
    ambiente: smallint('ambiente'),
    ultimoNumero: bigint('ultimo_numero', { mode: 'number' }).notNull().default(0),
    dono: varchar('dono', { length: 10 }).notNull(),
    // FK para `terminais` (MD 3.15) entra com o esqueleto de sincronização.
    ultimoAtualizadoPorTerminalId: uuid('ultimo_atualizado_por_terminal_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_numeracoes', columns: [t.id] }),
    foreignKey({ name: 'fk_numeracoes_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_numeracoes_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    index('ix_numeracoes_caixa_id').on(t.caixaId),
    index('ix_numeracoes_ultimo_atualizado_por_terminal_id').on(t.ultimoAtualizadoPorTerminalId),
    check('ck_numeracoes_tipo', sql`tipo in ('venda','nfce','vale','nfe','comanda')`),
    check('ck_numeracoes_dono', sql`dono in ('nuvem','terminal')`),
    check(
      'ck_numeracoes_escopo',
      sql`(tipo in ('venda','nfce','vale') and caixa_id is not null) or (tipo in ('nfe','comanda') and caixa_id is null)`,
    ),
  ],
);

export const CATEGORIAS_ARQUIVO = [
  'logotipo',
  'banner',
  'foto_produto',
  'foto_loja',
  'imagem_categoria',
  'xml_nfce',
  'xml_nfe_saida',
  'xml_nfe_entrada',
  'xml_evento',
  'xml_inutilizacao',
  'danfe_pdf',
  'planilha_importacao',
  'planilha_exportacao',
  'anexo_financeiro',
  'logs_terminal',
  'outro',
] as const;

export const arquivos = pgTable(
  'arquivos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    chaveArmazenamento: varchar('chave_armazenamento', { length: 500 }).notNull(),
    nomeOriginal: varchar('nome_original', { length: 255 }).notNull(),
    tipoMime: varchar('tipo_mime', { length: 100 }).notNull(),
    tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    categoria: varchar('categoria', { length: 30 }).notNull(),
    entidade: varchar('entidade', { length: 60 }),
    registroId: uuid('registro_id'),
    lojaId: uuid('loja_id'),
    publico: boolean('publico').notNull().default(false),
    retencaoAte: date('retencao_ate'),
  },
  (t) => [
    primaryKey({ name: 'pk_arquivos', columns: [t.id] }),
    foreignKey({ name: 'fk_arquivos_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_arquivos_entidade_registro_id').on(t.entidade, t.registroId),
    index('ix_arquivos_sha256').on(t.sha256),
    index('ix_arquivos_loja_id')
      .on(t.lojaId)
      .where(sql`loja_id is not null`),
    check('ck_arquivos_categoria', sql`categoria in (${listaSql(CATEGORIAS_ARQUIVO)})`),
  ],
);

export const tarefas = pgTable(
  'tarefas',
  {
    ...colunasLogMutavel(),
    tipo: varchar('tipo', { length: 40 }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('na_fila'),
    parametros: jsonb('parametros')
      .notNull()
      .default(sql`'{}'::jsonb`),
    progressoPct: smallint('progresso_pct').notNull().default(0),
    mensagem: varchar('mensagem', { length: 255 }),
    resultado: jsonb('resultado'),
    arquivoId: uuid('arquivo_id'),
    erro: text('erro'),
    usuarioId: uuid('usuario_id').notNull(),
    lojaId: uuid('loja_id'),
    iniciadaEm: timestamptz('iniciada_em'),
    concluidaEm: timestamptz('concluida_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_tarefas', columns: [t.id] }),
    foreignKey({ name: 'fk_tarefas_arquivo_id', columns: [t.arquivoId], foreignColumns: [arquivos.id] }),
    foreignKey({ name: 'fk_tarefas_usuario_id', columns: [t.usuarioId], foreignColumns: [usuarios.id] }),
    index('ix_tarefas_usuario_id_criado_em').on(t.usuarioId, t.criadoEm),
    index('ix_tarefas_arquivo_id').on(t.arquivoId),
    index('ix_tarefas_status')
      .on(t.status)
      .where(sql`status in ('na_fila','executando')`),
    check('ck_tarefas_status', sql`status in ('na_fila','executando','concluida','falhou','cancelada')`),
    check('ck_tarefas_progresso_pct', sql`progresso_pct between 0 and 100`),
  ],
);

export const alertas = pgTable(
  'alertas',
  {
    ...colunasPadrao(),
    tipo: varchar('tipo', { length: 40 }).notNull(),
    severidade: varchar('severidade', { length: 10 }).notNull().default('aviso'),
    titulo: varchar('titulo', { length: 150 }).notNull(),
    mensagem: text('mensagem'),
    lojaId: uuid('loja_id'),
    entidade: varchar('entidade', { length: 60 }),
    registroId: uuid('registro_id'),
    dados: jsonb('dados'),
    chaveDeduplicacao: varchar('chave_deduplicacao', { length: 150 }),
    resolvidoEm: timestamptz('resolvido_em'),
    resolvidoPorId: uuid('resolvido_por_id'),
    resolucao: varchar('resolucao', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_alertas', columns: [t.id] }),
    foreignKey({ name: 'fk_alertas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_alertas_resolvido_por_id',
      columns: [t.resolvidoPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_alertas_chave_deduplicacao')
      .on(t.chaveDeduplicacao)
      .where(sql`resolvido_em is null and excluido_em is null`),
    index('ix_alertas_loja_id_resolvido_em').on(t.lojaId, t.resolvidoEm),
    index('ix_alertas_resolvido_por_id').on(t.resolvidoPorId),
    check('ck_alertas_severidade', sql`severidade in ('info','aviso','critico')`),
  ],
);

export const mensagensEnviadas = pgTable(
  'mensagens_enviadas',
  {
    ...colunasLogMutavel(),
    canal: varchar('canal', { length: 8 }).notNull(),
    destino: varchar('destino', { length: 254 }).notNull(),
    templateId: uuid('template_id'),
    templateTipo: varchar('template_tipo', { length: 40 }),
    lojaId: uuid('loja_id'),
    entidade: varchar('entidade', { length: 60 }),
    registroId: uuid('registro_id'),
    status: varchar('status', { length: 10 }).notNull().default('pendente'),
    tentativas: smallint('tentativas').notNull().default(0),
    erro: text('erro'),
    enviadaEm: timestamptz('enviada_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_mensagens_enviadas', columns: [t.id] }),
    foreignKey({
      name: 'fk_mensagens_enviadas_template_id',
      columns: [t.templateId],
      foreignColumns: [templatesDocumentos.id],
    }),
    foreignKey({ name: 'fk_mensagens_enviadas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_mensagens_enviadas_status')
      .on(t.status, t.criadoEm)
      .where(sql`status = 'pendente'`),
    index('ix_mensagens_enviadas_entidade').on(t.entidade, t.registroId),
    check('ck_mensagens_enviadas_canal', sql`canal in ('email','whatsapp')`),
    check('ck_mensagens_enviadas_status', sql`status in ('pendente','enviada','falhou','cancelada')`),
  ],
);

/** MD 3.2.3 (aqui para referenciar `arquivos` sem import circular com `estrutura.ts`). */
export const lojasBanners = pgTable(
  'lojas_banners',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id').notNull(),
    arquivoId: uuid('arquivo_id').notNull(),
    titulo: varchar('titulo', { length: 60 }),
    ordem: integer('ordem').notNull().default(0),
    exibirEm: varchar('exibir_em', { length: 15 }).notNull().default('pdv_espera'),
    inicio: timestamptz('inicio'),
    fim: timestamptz('fim'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_lojas_banners', columns: [t.id] }),
    foreignKey({ name: 'fk_lojas_banners_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_lojas_banners_arquivo_id',
      columns: [t.arquivoId],
      foreignColumns: [arquivos.id],
    }),
    index('ix_lojas_banners_loja_id').on(t.lojaId),
    index('ix_lojas_banners_arquivo_id').on(t.arquivoId),
    check('ck_lojas_banners_exibir_em', sql`exibir_em in ('pdv_espera','menu_digital','totem')`),
    check('ck_lojas_banners_vigencia', sql`fim is null or inicio is null or fim > inicio`),
  ],
);
