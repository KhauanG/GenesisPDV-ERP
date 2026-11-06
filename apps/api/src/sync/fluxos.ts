/**
 * Registro de fluxos do `/sync/pull` (MD 6.1, 6.2; SYNC 6): tabelas de cada fluxo, filtro no servidor (X = loja do
 * terminal, E = estoque da loja, T = terminal) e colunas que não descem. Toda tabela registrada aqui usa
 * `fn_versao` (trava de ordenação): `TABELAS_FN_VERSAO` e o teste `test:sync-triggers` saem desta lista.
 *
 * Fase 1A: `catalogo`, `estoque` e `pessoas` ganharam as tabelas de produtos, saldos e pessoas; `operacao` continua sem
 * tabelas (orçamentos/comandas/PIX/status de venda chegam nas fases que as criam: o pull devolve vazio e o cursor avança
 * até o teto); `referencia` ainda não tem IBPT/IBS-CBS (README › Decisões de implementação).
 */
import { CHAVES_CONFIGURACAO_PDV, CONFIGURACOES_POR_CHAVE, type Fluxo } from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { hojeNaEmpresa } from '../comum/fuso.js';
import {
  atalhosPdv,
  atributosVariacao,
  atributosVariacaoValores,
  caixas,
  categorias,
  certificadosDigitais,
  cfops,
  cfopsGrupos,
  configuracoes,
  empresa,
  estoques,
  formasPagamento,
  formasPagamentoLojas,
  gruposPrecoQuantidade,
  gruposPrecoQuantidadeFaixas,
  impressorasDestino,
  lojas,
  lojasBanners,
  marcas,
  meiosPagamentoFiscais,
  municipios,
  ncms,
  numeracoesFaixas,
  paises,
  parametrosFiscaisUf,
  parcelasCreditoPessoas,
  perfis,
  perfisPermissoes,
  permissoes,
  pessoas,
  pessoasAliases,
  pessoasCategorias,
  pessoasEnderecos,
  pessoasRelevanciaLoja,
  pessoasTelefones,
  produtos,
  produtosCategorias,
  produtosCodigosBarras,
  produtosComponentes,
  produtosComponentesAlternativas,
  produtosLojas,
  produtosLotes,
  produtosPrecosQuantidade,
  produtosRelacionados,
  produtosTributacaoUf,
  produtosVariacoes,
  produtosVariacoesValores,
  restricoesHorarioVenda,
  saldosCreditoPessoas,
  saldosEstoque,
  saldosLote,
  saldosVasilhamePessoas,
  taxasEntrega,
  templatesDocumentos,
  tiposEstoque,
  ufs,
  unidadesMedida,
  usuarios,
  usuariosLojas,
  usuariosPermissoes,
} from '../database/empresa/schema/index.js';

// A lista dos fluxos é parte do contrato com o PDV (resposta da ativação, query do pull): mora no shared.
export { FLUXOS, type Fluxo } from '@genesis/shared';

/** O que o filtro de uma tabela conhece do terminal. */
export interface EscopoTerminal {
  terminalId: string;
  lojaId: string;
  estoqueId: string;
}

export interface TabelaFluxo {
  tabela: PgTable;
  /** Condição sobre o alias `t` (a linha da tabela). Sem filtro = todas as linhas. */
  filtro?: (e: EscopoTerminal) => SQL;
  /** Colunas que nunca descem (MD 6.2). */
  omitir?: readonly string[];
  /** Colunas que descem com outra expressão (projeção condicional), sobre o alias `t`. */
  projecao?: Record<string, (e: EscopoTerminal) => SQL>;
}

/** Tipos de template impressos pelo PDV (cupom, vale, recibo de crediário). */
const TEMPLATES_PDV = ['cupom_cabecalho', 'cupom_rodape', 'vale_compra', 'recibo_receber'];

/** Loja nula (todas) ou a loja do terminal. */
const lojaNulaOuX = (e: EscopoTerminal) => sql`t.loja_id is null or t.loja_id = ${e.lojaId}`;
/** UF da loja do terminal (tabelas por UF, MD 6.2). */
const ufDaLoja = (e: EscopoTerminal) => sql`(select l.uf from lojas l where l.id = ${e.lojaId})`;
/**
 * Pessoa relevante para a loja do terminal (MD 3.5.4): existe vínculo não excluído com a loja ou com todas. Também
 * usada pelo modo perdido (`terminais/revogacao.ts`), que anula só as senhas que descem para a loja.
 */
export const pessoaRelevante = (coluna: string) => (e: Pick<EscopoTerminal, 'lojaId'>) =>
  sql`exists (select 1 from pessoas_relevancia_loja r where r.pessoa_id = ${sql.raw(`t.${coluna}`)} and r.excluido_em is null and (r.loja_id is null or r.loja_id = ${e.lojaId}))`;
/**
 * Contato (telefones e endereços) só de quem é relevante por outro motivo além de `funcionario` (D19): o funcionário
 * desce para o login e a identificação no caixa (crédito funcionário), sem os dados pessoais de contato. O funcionário
 * que também tem crediário ou "Manter no PDV" desce como qualquer cliente; quando só sobra `funcionario`, o PDV
 * purga o contato local ao receber a relevância excluída.
 */
const contatoDaPessoaDesce = (e: Pick<EscopoTerminal, 'lojaId'>) =>
  sql`exists (select 1 from pessoas_relevancia_loja r where r.pessoa_id = t.pessoa_id and r.excluido_em is null and r.motivo <> 'funcionario' and (r.loja_id is null or r.loja_id = ${e.lojaId}))`;
/** Saldo do estoque da loja em tipo de estoque vendável (MD 6.2). */
const saldoVendavelDoEstoque = (e: EscopoTerminal) =>
  sql`t.estoque_id = ${e.estoqueId} and exists (select 1 from tipos_estoque te where te.id = t.tipo_estoque_id and te.vendavel)`;

/**
 * Valor efetivo de uma configuração em SQL (loja do terminal ?? empresa ?? padrão do catálogo), como texto
 * (`valor #>> '{}'`), igual a `lerConfiguracoes` (configuracoes/valores.ts).
 */
const configuracaoEfetiva = (chave: string, e: Pick<EscopoTerminal, 'lojaId'>) => {
  const padrao = CONFIGURACOES_POR_CHAVE.get(chave)?.padrao;
  return sql`coalesce(
    (select c.valor #>> '{}' from configuracoes c where c.chave = ${chave} and c.excluido_em is null and c.escopo = 'loja' and c.loja_id = ${e.lojaId}),
    (select c.valor #>> '{}' from configuracoes c where c.chave = ${chave} and c.excluido_em is null and c.escopo = 'empresa'),
    ${padrao === undefined || padrao === null ? null : String(padrao)})`;
};

/**
 * Chaves que decidem se `pessoas.senha_hash` desce (SYNC 4.1): mudá-las toca as pessoas com senha
 * (`configuracoes.controller.ts`), para a projeção nova descer com versão nova.
 */
export const CHAVES_SENHA_CLIENTE_PDV = [
  'pdv.crediario_exige_senha_cliente',
  'financeiro.limite_credito_padrao',
] as const;

/**
 * Senha do cliente (crediário, SYNC 4.1 e 4.3 item 4): só desce com `pdv.crediario_exige_senha_cliente` ligada na
 * loja do terminal **e** crediário habilitado (`coalesce(limite_compras, limite padrão) > 0` e não bloqueada); senão
 * `null`. Mudar o limite ou o bloqueio da pessoa gera versão nova da linha; mudar a configuração toca as pessoas.
 * A condição (alias `t` = pessoas) é a mesma que o modo perdido usa para anular as senhas que desceram.
 */
export const senhaClienteDesce = (e: Pick<EscopoTerminal, 'lojaId'>) =>
  sql`(${configuracaoEfetiva('pdv.crediario_exige_senha_cliente', e)})::boolean
    and coalesce(t.limite_compras, (${configuracaoEfetiva('financeiro.limite_credito_padrao', e)})::numeric) > 0
    and not t.bloqueada_credito`;
const senhaClienteCondicional = (e: EscopoTerminal) =>
  sql`case when ${senhaClienteDesce(e)} then t.senha_hash end`;

const lista = (valores: readonly string[]) =>
  sql.join(
    valores.map((v) => sql`${v}`),
    sql`, `,
  );

export const REGISTRO_FLUXOS: Readonly<Record<Fluxo, readonly TabelaFluxo[]>> = {
  configuracao: [
    { tabela: empresa },
    {
      tabela: lojas,
      filtro: (e) => sql`t.id = ${e.lojaId}`,
      // Segredos descem só cifrados para a chave do terminal (MD 1.10, SYNC 20.2): ainda não implementado, descem
      // nulos (README › Decisões).
      projecao: {
        nfce_csc_cifrado: () => sql`null`,
        nfce_csc_homologacao_cifrado: () => sql`null`,
        sat_codigo_ativacao_cifrado: () => sql`null`,
        tef_token_cifrado: () => sql`null`,
      },
      // Marca de loja de treino (O10): só filtra as consultas e o dashboard do ERP; o caixa não usa.
      omitir: ['treino'],
    },
    {
      tabela: lojasBanners,
      filtro: (e) => sql`t.loja_id = ${e.lojaId} and t.exibir_em = 'pdv_espera'`,
    },
    { tabela: caixas, filtro: (e) => sql`t.loja_id = ${e.lojaId}` },
    { tabela: estoques, filtro: (e) => sql`t.id = ${e.estoqueId}` },
    { tabela: tiposEstoque },
    {
      tabela: configuracoes,
      filtro: (e) =>
        // Chaves marcadas PDV no catálogo (MD 3.1.2, `@genesis/shared`).
        sql`t.chave in (${lista(CHAVES_CONFIGURACAO_PDV)}) and (t.escopo = 'empresa' or t.loja_id = ${e.lojaId})`,
      projecao: { valor_cifrado: () => sql`null` },
    },
    {
      tabela: templatesDocumentos,
      filtro: (e) =>
        sql`t.tipo in (${lista(TEMPLATES_PDV)}) and (t.loja_id is null or t.loja_id = ${e.lojaId})`,
    },
    { tabela: numeracoesFaixas, filtro: (e) => sql`t.terminal_id = ${e.terminalId}` },
    {
      tabela: certificadosDigitais,
      filtro: (e) =>
        sql`t.loja_id = ${e.lojaId} and exists (select 1 from lojas l where l.id = t.loja_id and l.tipo_emissao = 'nfce')`,
      // Arquivo e senha só cifrados para a chave do terminal (MD 1.10): ainda não implementado, descem nulos.
      projecao: { arquivo_cifrado: () => sql`null`, senha_cifrada: () => sql`null` },
    },
    { tabela: impressorasDestino, filtro: lojaNulaOuX },
    { tabela: taxasEntrega, filtro: (e) => sql`t.loja_id = ${e.lojaId}` },
    { tabela: atalhosPdv, filtro: lojaNulaOuX },
    {
      tabela: formasPagamento,
      // Só a forma que já valeu na loja do terminal (C8b, MD 3.10.1): existe linha de `formas_pagamento_lojas` de
      // "todas" (loja nula) ou da loja X, viva ou excluída. A excluída mantém a forma no filtro para a exclusão dela
      // (ou da própria forma) continuar descendo; a forma de outra loja nunca desce. Quem muda as lojas toca a forma
      // (`formas-pagamento.controller.ts`), para ela descer ao caixa da loja que acabou de ganhar.
      filtro: (e) =>
        sql`exists (select 1 from formas_pagamento_lojas fl where fl.forma_pagamento_id = t.id and (fl.loja_id is null or fl.loja_id = ${e.lojaId}))`,
      omitir: ['conta_corrente_id', 'plano_contas_id', 'dias_recebimento'],
    },
    // Vínculo da forma com "todas" ou com a loja do terminal: o PDV oferece a forma com uma linha viva (C11a).
    { tabela: formasPagamentoLojas, filtro: lojaNulaOuX },
    { tabela: unidadesMedida },
  ],
  acesso: [
    {
      tabela: usuarios,
      // A senha do ERP nunca desce (ADR-08); o PIN do PDV só para quem tem acesso à loja (MD 6.2). Telefone, admissão
      // e demissão também não (D19, LGPD): o caixa recebe só o necessário ao login e à identificação.
      omitir: [
        'senha_hash',
        'telefone',
        'admissao',
        'demissao',
        'salario',
        'rg',
        'cpf',
        'cep',
        'logradouro',
        'numero',
        'complemento',
        'bairro',
        'municipio_ibge',
        'uf',
        'email',
        'observacoes',
        'tentativas_falhas',
        'bloqueado_ate',
        'senha_provisoria',
      ],
      projecao: {
        // PDV 7.2 regra 3 ("ativo e demissão nula ou futura") resolvida na nuvem, sem a data no caixa: no dia da
        // demissão (fuso da empresa, o mesmo da manutenção) a manutenção toca o usuário (`terminais/manutencao.ts`)
        // e o `false` desce.
        ativo: () => sql`t.ativo and (t.demissao is null or t.demissao > ${hojeNaEmpresa})`,
        senha_pdv_hash: (e) =>
          sql`case when t.master or exists (select 1 from usuarios_lojas ul where ul.usuario_id = t.id and ul.loja_id = ${e.lojaId} and ul.excluido_em is null) then t.senha_pdv_hash end`,
      },
    },
    { tabela: perfis },
    { tabela: permissoes, filtro: () => sql`t.modulo = 'pdv'` },
    { tabela: perfisPermissoes, filtro: () => sql`t.permissao like 'pdv.%'` },
    { tabela: usuariosPermissoes, filtro: () => sql`t.permissao like 'pdv.%'` },
    { tabela: usuariosLojas, filtro: (e) => sql`t.loja_id = ${e.lojaId}` },
  ],
  referencia: [
    { tabela: ncms },
    { tabela: cfops },
    { tabela: cfopsGrupos },
    { tabela: meiosPagamentoFiscais },
    { tabela: ufs },
    { tabela: municipios },
    { tabela: paises },
    {
      tabela: parametrosFiscaisUf,
      // Vigência atual e futuras da UF da loja; `fundamento`/`pendencias` são só do ERP.
      filtro: (e) =>
        sql`t.uf = ${ufDaLoja(e)} and (t.vigencia_fim is null or t.vigencia_fim >= current_date)`,
      omitir: ['fundamento', 'pendencias'],
    },
  ],
  catalogo: [
    { tabela: marcas },
    { tabela: categorias },
    {
      tabela: produtos,
      // Custo não vai para o caixa (MD 3.6.3, 6.2). `custo_medio` também é isento de versão (0011,
      // `COLUNAS_ISENTAS_VERSAO`): precisa ficar aqui, senão o caixa ficaria com o valor velho.
      omitir: [
        'preco_custo',
        'custo_medio',
        'markup_pct',
        'descricao_longa',
        'material',
        'busca',
        'preco_menu_digital',
        'preco_ifood',
        'largura_cm',
        'altura_cm',
        'profundidade_cm',
        'peso_g',
        'peso_abatimento_g',
        'peso_pacote_kg',
        'reposicao_rodizio',
      ],
    },
    { tabela: produtosCategorias },
    { tabela: produtosCodigosBarras },
    { tabela: atributosVariacao },
    { tabela: atributosVariacaoValores },
    { tabela: produtosVariacoes, omitir: ['preco_custo'] },
    { tabela: produtosVariacoesValores },
    { tabela: produtosComponentes },
    { tabela: produtosComponentesAlternativas },
    { tabela: produtosRelacionados },
    {
      tabela: produtosLojas,
      filtro: (e) => sql`t.loja_id = ${e.lojaId}`,
      omitir: ['estoque_maximo', 'st_nota_entrada_id'],
    },
    { tabela: produtosTributacaoUf, filtro: (e) => sql`t.uf = ${ufDaLoja(e)}` },
    { tabela: produtosPrecosQuantidade, filtro: lojaNulaOuX },
    {
      tabela: produtosLotes,
      filtro: (e) => sql`t.estoque_id is null or t.estoque_id = ${e.estoqueId}`,
    },
    { tabela: restricoesHorarioVenda, filtro: lojaNulaOuX },
    { tabela: gruposPrecoQuantidade },
    { tabela: gruposPrecoQuantidadeFaixas, filtro: lojaNulaOuX },
  ],
  estoque: [
    {
      tabela: saldosEstoque,
      filtro: saldoVendavelDoEstoque,
      omitir: [
        'custo_medio',
        'ultima_entrada_em',
        'ultima_saida_em',
        'ultima_compra_em',
        'ultimo_custo_compra',
        'ultimo_movimento_id',
      ],
    },
    { tabela: saldosLote, filtro: saldoVendavelDoEstoque },
  ],
  pessoas: [
    { tabela: pessoasRelevanciaLoja, filtro: lojaNulaOuX },
    {
      tabela: pessoas,
      filtro: pessoaRelevante('id'),
      omitir: [
        'observacoes',
        'inscricao_municipal',
        'busca',
        'origem',
        'origem_terminal_id',
        'anonimizada_em',
      ],
      projecao: { senha_hash: senhaClienteCondicional },
    },
    { tabela: pessoasCategorias, filtro: pessoaRelevante('pessoa_id') },
    { tabela: pessoasEnderecos, filtro: contatoDaPessoaDesce },
    { tabela: pessoasTelefones, filtro: contatoDaPessoaDesce },
    { tabela: pessoasAliases },
    { tabela: saldosCreditoPessoas, filtro: pessoaRelevante('pessoa_id') },
    { tabela: parcelasCreditoPessoas, filtro: pessoaRelevante('pessoa_id') },
    { tabela: saldosVasilhamePessoas, filtro: pessoaRelevante('pessoa_id') },
  ],
  operacao: [],
};

export function nomeTabela(t: PgTable): string {
  return getTableConfig(t).name;
}

/** Todas as tabelas lidas por algum fluxo (devem usar `fn_versao`, MD 1.5). */
export const TABELAS_DOS_FLUXOS: readonly string[] = [
  ...new Set(Object.values(REGISTRO_FLUXOS).flatMap((ts) => ts.map((t) => nomeTabela(t.tabela)))),
];

/** Fluxos que um terminal `desativando` ainda recebe (SYNC 3.8). */
export const FLUXOS_DESATIVANDO: readonly Fluxo[] = ['acesso', 'configuracao'];
