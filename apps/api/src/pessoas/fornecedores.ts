/**
 * Fornecedor achado ou criado pelo documento (ERP 3.4 `<SeletorPessoa>` "+", 8.2.14, 13.3, 13.4; F2-B13; README da API
 * › decisão 158): o cadastro rápido do ERP agora, e o recebimento (F2-B16) e o emitente da NF-e (F2-B19) depois.
 */
import {
  normalizarCnpj,
  telefonePessoaSchema,
  tipoPessoaDoDocumento,
  type CadastroRapidoFornecedor,
  type PessoaOpcao,
} from '@genesis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { pessoas, pessoasCategorias } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { inserirPessoa } from './pessoas.controller.js';

const LOCALIZACAO = 'Pessoas';

type Linha = Record<string, unknown>;

/**
 * Pessoas resumidas pelo id (inclusive excluídas, marcadas em `excluida`: o vínculo antigo continua legível).
 * `semDocumento` devolve `cpfCnpj: null`: quem lê pelo cadastro de outra entidade (o fornecedor no detalhe do
 * produto, com `produtos.ver`) não lê o CPF/CNPJ, que a API de pessoas só mostra com `pessoas.ver` (LGPD).
 */
export async function opcoesPessoaPorId(
  db: DbEmpresa,
  ids: readonly string[],
  opcoes: { semDocumento?: boolean } = {},
): Promise<Map<string, PessoaOpcao>> {
  const unicos = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (!unicos.length) return new Map();
  const { rows } = await db.execute<Linha>(sql`
    select id, codigo, tipo, nome, apelido, cpf_cnpj, ativa, excluido_em is not null as excluida from pessoas
     where id = any(${`{${unicos.join(',')}}`}::uuid[])`);
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id as string,
        codigo: Number(r.codigo),
        tipo: (r.tipo as string).trim() as 'PF' | 'PJ',
        nome: r.nome as string,
        apelido: (r.apelido as string | null) ?? null,
        cpfCnpj: opcoes.semDocumento ? null : ((r.cpf_cnpj as string | null) ?? null),
        ativa: r.ativa as boolean,
        excluida: r.excluida as boolean,
      },
    ]),
  );
}

/** O que `acharOuCriarFornecedorPorDocumento` fez. */
export interface FornecedorAchado {
  pessoaId: string;
  /** Documento novo: a pessoa foi criada com a categoria Fornecedor. */
  criada: boolean;
  /** A pessoa existia sem a categoria Fornecedor e a ganhou. */
  categoriaAdicionada: boolean;
}

export interface OpcoesFornecedor {
  /** `pessoas.origem` da pessoa criada: `erp` (cadastro rápido) ou `nfe` (emitente da nota, F2-B19). */
  origemCadastro?: 'erp' | 'nfe';
  /**
   * Chamado antes de gravar, com o que vai acontecer (o endpoint confere `pessoas.criar` / `pessoas.editar`; a NF-e
   * não confere: o emitente entra com a permissão de importar a nota). Lança para recusar.
   */
  autorizar?: (acao: 'criar' | 'adicionar_categoria') => void;
}

/**
 * Acha a pessoa pelo CPF/CNPJ **normalizado** (`normalizarCnpj`: sem máscara, letras maiúsculas do CNPJ alfanumérico)
 * ou a cria como fornecedor. A pessoa que já existe (ativa ou não) é reaproveitada como está: só ganha a categoria
 * Fornecedor quando não a tem (o nome, a IE e o endereço dela não mudam). O documento é único entre as pessoas não
 * excluídas (`uq_pessoas_cpf_cnpj`), e uma trava de transação pelo documento serializa duas chamadas com o mesmo
 * CNPJ (duas notas do mesmo emitente num ZIP, dois cliques no modal): a segunda acha a pessoa que a primeira criou.
 * Transação de quem chama; a auditoria fica na pessoa (`criar`, ou `editar` com as categorias antes/depois).
 */
export async function acharOuCriarFornecedorPorDocumento(
  s: Pick<Servicos, 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  dados: CadastroRapidoFornecedor,
  opcoes: OpcoesFornecedor = {},
): Promise<FornecedorAchado> {
  const doc = normalizarCnpj(dados.cpfCnpj);
  const tipo = tipoPessoaDoDocumento(doc);
  if (!tipo)
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
      campos: { cpfCnpj: ['CNPJ (14) ou CPF (11)'] },
    });
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`genesis:pessoa_documento:${doc}`}, 0))`,
  );
  const [existente] = await tx
    .select({ id: pessoas.id })
    .from(pessoas)
    .where(and(eq(pessoas.cpfCnpj, doc), isNull(pessoas.excluidoEm)))
    .for('update');

  if (existente) {
    const { rows } = await tx.execute<{ categoria: string }>(sql`
      select categoria from pessoas_categorias
       where pessoa_id = ${existente.id} and excluido_em is null order by categoria`);
    const antes = rows.map((r) => r.categoria);
    if (antes.includes('fornecedor'))
      return { pessoaId: existente.id, criada: false, categoriaAdicionada: false };
    opcoes.autorizar?.('adicionar_categoria');
    await tx.insert(pessoasCategorias).values({
      pessoaId: existente.id,
      categoria: 'fornecedor',
      criadoPorId: sessao.usuarioId,
      atualizadoPorId: sessao.usuarioId,
    });
    await s.auditoria.registrar(tx, origem, {
      acao: 'editar',
      entidade: 'pessoas',
      registroId: existente.id,
      localizacao: LOCALIZACAO,
      descricao: 'Categoria Fornecedor incluída pelo cadastro rápido de fornecedor',
      antes: { categorias: antes },
      depois: { categorias: [...antes, 'fornecedor'].sort() },
    });
    return { pessoaId: existente.id, criada: false, categoriaAdicionada: true };
  }

  opcoes.autorizar?.('criar');
  const ie = tipo === 'PJ' ? dados.rgIe : null;
  const telefone = dados.telefone
    ? telefonePessoaSchema.parse({ numero: dados.telefone, principal: true })
    : null;
  const pessoaId = await inserirPessoa(
    s,
    tx,
    sessao,
    origem,
    {
      tipo,
      nome: dados.nome,
      apelido: dados.apelido,
      ativa: true,
      cpfCnpj: doc,
      // PF: o campo é o RG, que o cadastro rápido não pede; PJ: a IE ("ISENTO" = isento).
      rgIe: ie,
      indicadorIe: ie === null ? 'nao_contribuinte' : ie === 'ISENTO' ? 'isento' : 'contribuinte',
      inscricaoMunicipal: null,
      nascimento: null,
      sexo: 'N',
      limiteCompras: null,
      descontoPct: '0.0000',
      bloqueadaCredito: false,
      observacoes: null,
      observacaoPdv: null,
      categorias: ['fornecedor'],
      enderecos: dados.endereco ? [{ ...dados.endereco, tipo: 'principal' }] : [],
      telefones: telefone ? [telefone] : [],
      emails: [],
    },
    null,
    opcoes.origemCadastro ?? 'erp',
  );
  return { pessoaId, criada: true, categoriaAdicionada: false };
}
