import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  type StreamableFile,
} from '@nestjs/common';
import {
  alterarPessoaSchema,
  cadastroRapidoFornecedorSchema,
  criarPessoaSchema,
  EXPORTACAO_CATALOGO_CLIENTES,
  exportacaoQuerySchema,
  filtroPessoasSchema,
  formatarCpfCnpj,
  LIMITE_EXPORTACAO,
  limiteDeslocamento,
  normalizarCnpj,
  ROTULOS_CATEGORIA_PESSOA,
  type CategoriaPessoa,
  type CriarPessoa,
  type ExportacaoEmTarefa,
  type FiltroPessoas,
  type Pagina,
  type PessoaDetalhe,
  type PessoaResumo,
  type ResultadoFornecedorRapido,
} from '@genesis/shared';
import { and, count, eq, gt, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Response } from 'express';
import { z } from 'zod';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, contem, metadados, ordemDaQuery, ref } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { arquivoExportacao, garantirPodeExportar, type ColunaExportacao } from '../comum/exportacao.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import {
  municipios,
  paises,
  parcelasCreditoPessoas,
  pessoas,
  pessoasCategorias,
  pessoasEmails,
  pessoasEnderecos,
  pessoasTelefones,
  usuarios,
} from '../database/empresa/schema/index.js';
import { garantirMunicipio } from '../lojas/municipio.js';
import { garantirLimiteHash, gerarHashPin } from '../seguranca/senhas.js';
import { acharOuCriarFornecedorPorDocumento, opcoesPessoaPorId } from './fornecedores.js';
import { manterNoPdv, recalcularRelevancia } from './relevancia.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Pessoas';

/** `manterNoPdv` ausente (importação de uma pessoa existente) = mantém a marcação manual atual. */
export type DadosPessoa = Omit<CriarPessoa, 'senha' | 'removerSenha' | 'manterNoPdv'> & {
  manterNoPdv?: boolean;
};

const sqlTelefone = sql<
  string | null
>`(select '(' || t.ddd || ') ' || t.numero from pessoas_telefones t where t.pessoa_id = ${ref('pessoas')} and t.excluido_em is null order by t.principal desc, t.criado_em limit 1)`;
const sqlEmail = sql<
  string | null
>`(select e.email from pessoas_emails e where e.pessoa_id = ${ref('pessoas')} and e.excluido_em is null order by e.principal desc, e.criado_em limit 1)`;
const sqlCategorias = sql<
  string[]
>`coalesce((select array_agg(c.categoria order by c.categoria) from pessoas_categorias c where c.pessoa_id = ${ref('pessoas')} and c.excluido_em is null), '{}')`;
const sqlCidade = sql<
  string | null
>`(select coalesce(m.nome, en.cidade_exterior) from pessoas_enderecos en left join municipios m on m.codigo_ibge = en.municipio_ibge where en.pessoa_id = ${ref('pessoas')} and en.excluido_em is null order by (en.tipo = 'principal') desc limit 1)`;
const sqlUf = sql<
  string | null
>`(select en.uf from pessoas_enderecos en where en.pessoa_id = ${ref('pessoas')} and en.excluido_em is null order by (en.tipo = 'principal') desc limit 1)`;

const colunasOrdenacao = {
  codigo: pessoas.codigo,
  nome: sql`lower(fn_unaccent(${pessoas.nome}))`,
  cpf_cnpj: pessoas.cpfCnpj,
  cidade: sqlCidade,
};

/** Texto de busca (MD 3.5.1 `busca`): nome + apelido + documento, sem acento e em minúsculas. */
const textoBusca = (d: { nome: string; apelido: string | null; cpfCnpj: string | null }) =>
  sql`lower(fn_unaccent(${[d.nome, d.apelido, d.cpfCnpj].filter(Boolean).join(' ')}))`;

function condicoes(q: FiltroPessoas): SQL | undefined {
  const termo = q.nome?.trim();
  const doc = q.cpfCnpj ? normalizarCnpj(q.cpfCnpj) : '';
  const cep = q.cep?.replace(/\D/g, '');
  const cidade = contem(q.cidade);
  return and(
    isNull(pessoas.excluidoEm),
    q.situacao === 'ativas'
      ? eq(pessoas.ativa, true)
      : q.situacao === 'inativas'
        ? eq(pessoas.ativa, false)
        : undefined,
    termo
      ? sql`(${pessoas.busca} like lower(fn_unaccent(${contem(termo)})) or (${/^\d{1,9}$/.test(termo)} and ${pessoas.codigo} = ${/^\d{1,9}$/.test(termo) ? Number(termo) : 0}))`
      : undefined,
    doc ? sql`${pessoas.cpfCnpj} like ${`${doc}%`}` : undefined,
    q.codigo ? eq(pessoas.codigo, q.codigo) : undefined,
    cep
      ? sql`exists (select 1 from pessoas_enderecos en where en.pessoa_id = ${ref('pessoas')} and en.excluido_em is null and en.cep like ${`${cep}%`})`
      : undefined,
    q.uf
      ? sql`exists (select 1 from pessoas_enderecos en where en.pessoa_id = ${ref('pessoas')} and en.excluido_em is null and en.uf = ${q.uf})`
      : undefined,
    cidade
      ? sql`exists (select 1 from pessoas_enderecos en left join municipios m on m.codigo_ibge = en.municipio_ibge where en.pessoa_id = ${ref('pessoas')} and en.excluido_em is null and fn_unaccent(coalesce(m.nome, en.cidade_exterior, '')) ilike fn_unaccent(${cidade}))`
      : undefined,
    q.categorias?.length
      ? sql`exists (select 1 from pessoas_categorias c where c.pessoa_id = ${ref('pessoas')} and c.excluido_em is null and c.categoria in (${sql.join(
          q.categorias.map((c) => sql`${c}`),
          sql`, `,
        )}))`
      : undefined,
  );
}

function consultaResumo(db: DbEmpresa) {
  return db
    .select({
      id: pessoas.id,
      codigo: pessoas.codigo,
      tipo: pessoas.tipo,
      nome: pessoas.nome,
      apelido: pessoas.apelido,
      cpfCnpj: pessoas.cpfCnpj,
      telefone: sqlTelefone,
      email: sqlEmail,
      categorias: sqlCategorias,
      cidade: sqlCidade,
      uf: sqlUf,
      ativa: pessoas.ativa,
      versao: pessoas.versao,
    })
    .from(pessoas)
    .$dynamic();
}

const COLUNAS_EXPORTACAO: ColunaExportacao<PessoaResumo>[] = [
  { rotulo: 'Cód.', valor: (p) => p.codigo },
  { rotulo: 'Nome', valor: (p) => p.nome },
  { rotulo: 'Apelido / Fantasia', valor: (p) => p.apelido },
  { rotulo: 'CPF/CNPJ', valor: (p) => formatarCpfCnpj(p.cpfCnpj) },
  { rotulo: 'Telefone', valor: (p) => p.telefone },
  { rotulo: 'E-mail', valor: (p) => p.email },
  { rotulo: 'Categorias', valor: (p) => p.categorias.map((c) => ROTULOS_CATEGORIA_PESSOA[c]).join(', ') },
  { rotulo: 'Cidade', valor: (p) => p.cidade },
  { rotulo: 'UF', valor: (p) => p.uf },
  { rotulo: 'Ativa', valor: (p) => p.ativa },
];

/** Pessoas (ERP 7.1, 7.2): clientes, fornecedores, funcionários…; filhas gravadas junto, num só "Gravar". */
@Controller('pessoas')
export class PessoasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('pessoas.ver')
  @Get()
  async listar(@Query() query: unknown): Promise<Pagina<PessoaResumo>> {
    const q = validar(filtroPessoasSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const onde = condicoes(q);
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await consultaResumo(db)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', pessoas.codigo))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(pessoas).where(onde);
      return { itens: itens as PessoaResumo[], total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('pessoas.ver')
  @Get('exportar')
  async exportar(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<StreamableFile> {
    garantirPodeExportar(sessao, 'pessoas');
    const q = validar(filtroPessoasSchema.extend(exportacaoQuerySchema.shape), query);
    const onde = condicoes(q);
    const linhas = await this.s.tenancy.cx().transacao(async (tx) => {
      const [total] = await tx.select({ n: count() }).from(pessoas).where(onde);
      if ((total?.n ?? 0) > LIMITE_EXPORTACAO) {
        throw new ErroApi(
          'REGRA_NEGOCIO',
          `A exportação passa de ${LIMITE_EXPORTACAO.toLocaleString('pt-BR')} linhas. Refine os filtros.`,
        );
      }
      const linhas = (await consultaResumo(tx)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', pessoas.codigo))) as PessoaResumo[];
      const { formato, pagina: _p, tamanho: _t, ...filtros } = q;
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'exportar',
        entidade: 'pessoas',
        localizacao: LOCALIZACAO,
        descricao: `Exportação ${formato.toUpperCase()} com ${linhas.length} linha(s)`,
        depois: { formato, filtros, linhas: linhas.length },
      });
      return linhas;
    });
    return arquivoExportacao(q.formato, 'Pessoas', COLUNAS_EXPORTACAO, linhas);
  }

  /**
   * Exportação de clientes de ida e volta (ERP 8.5; F2-B40, README da API › decisão 186): o botão "Exportar Clientes" de
   * Produtos › Exportação, no layout da importação de clientes. Até 5.000 linhas responde o arquivo (`200`); acima,
   * `202` com a tarefa. Exige `pessoas.ver` e `pessoas.exportar` (ou `relatorios.exportar`), pelo provedor.
   */
  @Permissao('pessoas.ver')
  @Get('exportacao')
  async exportacao(
    @Query() query: Record<string, unknown>,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | ExportacaoEmTarefa> {
    const r = await this.s.exportacoes.exportar(
      sessao,
      origemDaRequisicao(req),
      EXPORTACAO_CATALOGO_CLIENTES,
      query ?? {},
    );
    if (r.tipo === 'arquivo') return r.arquivo;
    res.status(202);
    return r.tarefa;
  }

  @Permissao('pessoas.ver')
  @Get(':id')
  async obter(@Param('id') id: string): Promise<PessoaDetalhe> {
    const pessoaId = validar(z.uuid(), id);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, pessoaId));
    if (!d) throw ErroApi.naoEncontrado('Pessoa não encontrada.');
    return d;
  }

  @Permissao('pessoas.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PessoaDetalhe> {
    const { senha, removerSenha: _r, ...dados } = validar(criarPessoaSchema, corpo);
    if (
      (dados.limiteCompras !== null || dados.bloqueadaCredito) &&
      !sessao.permissoes.has('pessoas.editar_credito')
    ) {
      throw ErroApi.semPermissao(
        'Definir limite de compras ou bloqueio exige "Pessoas: Alterar limite de compras e bloqueio".',
      );
    }
    if (senha) garantirLimiteHash(`${sessao.empresa.empresaId}:${sessao.usuarioId}`);
    const senhaHash = senha ? await gerarHashPin(senha) : null;
    const id = await this.s.tenancy
      .cx()
      .transacao((tx) => inserirPessoa(this.s, tx, sessao, origemDaRequisicao(req), dados, senhaHash), {
        travaVersao: true,
      });
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  /**
   * Cadastro rápido de fornecedor (ERP 3.4, 8.2.14, 13.3; F2-B13): acha a pessoa pelo documento normalizado ou a
   * cria. Basta `pessoas.ver` para reaproveitar quem já é fornecedor; criar exige `pessoas.criar` ou
   * `pessoas.criar_fornecedor` (só este cadastro rápido: o Estoquista, decisão do dono de 05/11/2026), e dar a
   * categoria Fornecedor a quem já existe exige `pessoas.editar`, `pessoas.criar` ou `pessoas.criar_fornecedor` (só
   * aqui, porque o cadastro rápido só acrescenta a categoria e não muda mais nada da pessoa — o `PUT /pessoas/:id`
   * continua exigindo `pessoas.editar`; README da API › decisão 165).
   * Sempre 200: `criada` e `categoriaAdicionada` dizem o que aconteceu.
   */
  @Permissao('pessoas.ver')
  @Post('fornecedor-rapido')
  @HttpCode(200)
  async fornecedorRapido(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoFornecedorRapido> {
    const dados = validar(cadastroRapidoFornecedorSchema, corpo);
    const r = await this.s.tenancy.cx().transacao(
      (tx) =>
        acharOuCriarFornecedorPorDocumento(this.s, tx, sessao, origemDaRequisicao(req), dados, {
          autorizar: (acao) => {
            const tem = (p: string) => sessao.permissoes.has(p);
            const criaFornecedor = tem('pessoas.criar') || tem('pessoas.criar_fornecedor');
            if (acao === 'criar' && !criaFornecedor)
              throw ErroApi.semPermissao(
                'Cadastrar o fornecedor exige "Pessoas: Criar" ou "Pessoas: Cadastrar fornecedor".',
              );
            if (acao === 'adicionar_categoria' && !criaFornecedor && !tem('pessoas.editar'))
              throw ErroApi.semPermissao(
                'A pessoa já existe sem a categoria Fornecedor: incluí-la exige "Pessoas: Cadastrar fornecedor", "Pessoas: Criar" ou "Pessoas: Editar".',
              );
          },
        }),
      { travaVersao: true },
    );
    const pessoa = (await this.s.tenancy.cx().consulta((db) => opcoesPessoaPorId(db, [r.pessoaId]))).get(
      r.pessoaId,
    )!;
    return { pessoa, criada: r.criada, categoriaAdicionada: r.categoriaAdicionada };
  }

  @Permissao('pessoas.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PessoaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, senha, removerSenha, ...dados } = validar(alterarPessoaSchema, corpo);
    if (senha) garantirLimiteHash(`${sessao.empresa.empresaId}:${sessao.usuarioId}`);
    const senhaHash = senha ? await gerarHashPin(senha) : undefined;
    await this.s.tenancy.cx().transacao(
      (tx) =>
        atualizarPessoa(this.s, tx, sessao, origemDaRequisicao(req), id, versao, dados, {
          senhaHash,
          removerSenha,
        }),
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  /** ERP 7.2: com parcelas em aberto só inativar. Vendas a prazo e documentos fiscais entram com as fases deles. */
  @Permissao('pessoas.excluir')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(pessoas)
          .where(and(eq(pessoas.id, id), isNull(pessoas.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Pessoa não encontrada.');
        const [aberto] = await tx
          .select({ n: count() })
          .from(parcelasCreditoPessoas)
          .where(
            and(
              eq(parcelasCreditoPessoas.pessoaId, id),
              gt(parcelasCreditoPessoas.saldo, '0'),
              isNull(parcelasCreditoPessoas.excluidoEm),
            ),
          );
        if ((aberto?.n ?? 0) > 0) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'A pessoa tem parcelas em aberto: inative o cadastro em vez de excluir.',
          );
        }
        const [usuario] = await tx
          .select({ nome: usuarios.nome })
          .from(usuarios)
          .where(and(eq(usuarios.pessoaId, id), isNull(usuarios.excluidoEm)));
        if (usuario)
          throw new ErroApi('REGRA_NEGOCIO', `A pessoa está vinculada ao usuário ${usuario.nome}.`);
        const agora = new Date();
        await tx
          .update(pessoas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(pessoas.id, id));
        // Os vínculos de fornecedor dos produtos (`produtos_fornecedores`, F2-B13) ficam: o produto continua
        // gravável com a linha, marcada "excluído" no bloco (README da API › decisão 158).
        for (const t of [pessoasCategorias, pessoasEnderecos, pessoasTelefones, pessoasEmails]) {
          await tx
            .update(t)
            .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
            .where(and(eq(t.pessoaId, id), isNull(t.excluidoEm)));
        }
        // A relevância excluída desce e o PDV purga a pessoa do espelho (MD 3.5.4).
        await recalcularRelevancia(tx, [id]);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'pessoas',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }
}

async function validarReferencias(tx: DbEmpresa, d: DadosPessoa): Promise<void> {
  for (const [i, e] of d.enderecos.entries()) {
    if (!e.exterior) await garantirMunicipio(tx, e.municipioIbge, e.uf, `enderecos.${i}.`);
    if (e.paisCodigo) {
      const [p] = await tx
        .select({ c: paises.codigoBacen })
        .from(paises)
        .where(eq(paises.codigoBacen, e.paisCodigo));
      if (!p)
        throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
          campos: { [`enderecos.${i}.paisCodigo`]: ['País inexistente'] },
        });
    }
  }
}

/** CPF/CNPJ único entre não excluídas (ERP 7.2): o 409 traz a pessoa existente para o link "abrir cadastro". */
async function garantirDocumentoUnico(tx: DbEmpresa, doc: string | null, exceto?: string): Promise<void> {
  if (!doc) return;
  const [outra] = await tx
    .select({ id: pessoas.id, codigo: pessoas.codigo, nome: pessoas.nome })
    .from(pessoas)
    .where(
      and(eq(pessoas.cpfCnpj, doc), isNull(pessoas.excluidoEm), exceto ? ne(pessoas.id, exceto) : undefined),
    );
  if (outra) {
    throw new ErroApi('CONFLITO', `Já existe a pessoa ${outra.codigo} - ${outra.nome} com este documento.`, {
      campos: { cpfCnpj: [`Já cadastrado: ${outra.codigo} - ${outra.nome}`] },
      detalhes: { pessoaId: outra.id, codigo: outra.codigo, nome: outra.nome },
    });
  }
}

/** Grava as filhas: atualiza as que vieram com `id`, cria as novas e exclui logicamente as que saíram. */
async function gravarFilhas(
  tx: DbEmpresa,
  sessao: SessaoErp,
  pessoaId: string,
  d: Pick<DadosPessoa, 'categorias' | 'enderecos' | 'telefones' | 'emails'>,
): Promise<void> {
  const agora = new Date();
  const autoria = { atualizadoPorId: sessao.usuarioId };
  // Categorias: conjunto.
  const cats = await tx
    .select({ id: pessoasCategorias.id, c: pessoasCategorias.categoria })
    .from(pessoasCategorias)
    .where(and(eq(pessoasCategorias.pessoaId, pessoaId), isNull(pessoasCategorias.excluidoEm)));
  const sairam = cats.filter((c) => !d.categorias.includes(c.c as CategoriaPessoa)).map((c) => c.id);
  if (sairam.length)
    await tx
      .update(pessoasCategorias)
      .set({ excluidoEm: agora, ...autoria })
      .where(inArray(pessoasCategorias.id, sairam));
  const novas = d.categorias.filter((c) => !cats.some((x) => x.c === c));
  if (novas.length) {
    await tx
      .insert(pessoasCategorias)
      .values(novas.map((categoria) => ({ pessoaId, categoria, criadoPorId: sessao.usuarioId, ...autoria })));
  }

  // Endereços, telefones e e-mails: primeiro exclui as que saíram e desliga "principal" (índices únicos parciais),
  // depois grava. Assim trocar o principal entre duas linhas na mesma gravação não colide.
  type Tabela = typeof pessoasEnderecos | typeof pessoasTelefones | typeof pessoasEmails;
  const sincronizar = async <T extends { id: string | null }>(
    tabela: Tabela,
    itens: T[],
    preparar: (v: Omit<T, 'id'>) => Record<string, unknown>,
    desligar: Record<string, unknown>,
  ) => {
    const existentes = await tx
      .select({ id: tabela.id })
      .from(tabela)
      .where(and(eq(tabela.pessoaId, pessoaId), isNull(tabela.excluidoEm)));
    const manter = itens.filter((i) => i.id && existentes.some((e) => e.id === i.id)).map((i) => i.id!);
    const remover = existentes.filter((e) => !manter.includes(e.id)).map((e) => e.id);
    if (remover.length)
      await tx
        .update(tabela)
        .set({ excluidoEm: agora, ...autoria })
        .where(inArray(tabela.id, remover));
    if (manter.length) await tx.update(tabela).set(desligar).where(inArray(tabela.id, manter));
    for (const item of itens) {
      const { id, ...valores } = item;
      const linha = { ...preparar(valores), ...autoria };
      if (id && manter.includes(id)) await tx.update(tabela).set(linha).where(eq(tabela.id, id));
      else await tx.insert(tabela).values({ ...linha, pessoaId, criadoPorId: sessao.usuarioId } as never);
    }
  };
  await sincronizar(
    pessoasEnderecos,
    d.enderecos,
    (e) =>
      e.exterior
        ? { ...e, cep: e.cep, uf: null, municipioIbge: null }
        : { ...e, paisCodigo: null, cidadeExterior: null },
    { tipo: 'outro' },
  );
  await sincronizar(pessoasTelefones, d.telefones, (t) => t, { principal: false });
  await sincronizar(pessoasEmails, d.emails, (e) => e, { principal: false });
}

async function filhas(db: DbEmpresa, pessoaId: string) {
  const vivo = <
    T extends
      typeof pessoasEnderecos | typeof pessoasTelefones | typeof pessoasEmails | typeof pessoasCategorias,
  >(
    t: T,
  ) => and(eq(t.pessoaId, pessoaId), isNull(t.excluidoEm));
  const enderecos = await db
    .select({ e: pessoasEnderecos, municipioNome: municipios.nome })
    .from(pessoasEnderecos)
    .leftJoin(municipios, eq(municipios.codigoIbge, pessoasEnderecos.municipioIbge))
    .where(vivo(pessoasEnderecos))
    .orderBy(sql`${pessoasEnderecos.tipo} <> 'principal'`, pessoasEnderecos.criadoEm);
  const telefones = await db
    .select()
    .from(pessoasTelefones)
    .where(vivo(pessoasTelefones))
    .orderBy(sql`not ${pessoasTelefones.principal}`, pessoasTelefones.criadoEm);
  const emails = await db
    .select()
    .from(pessoasEmails)
    .where(vivo(pessoasEmails))
    .orderBy(sql`not ${pessoasEmails.principal}`, pessoasEmails.criadoEm);
  const categorias = await db
    .select({ c: pessoasCategorias.categoria })
    .from(pessoasCategorias)
    .where(vivo(pessoasCategorias));
  return {
    categorias: categorias.map((c) => c.c as CategoriaPessoa).sort(),
    enderecos: enderecos.map(({ e, municipioNome }) => ({
      id: e.id,
      tipo: e.tipo as 'principal',
      cep: e.cep,
      logradouro: e.logradouro,
      numero: e.numero,
      complemento: e.complemento,
      bairro: e.bairro,
      uf: e.uf,
      municipioIbge: e.municipioIbge,
      municipioNome,
      exterior: e.exterior,
      paisCodigo: e.paisCodigo,
      cidadeExterior: e.cidadeExterior,
      referencia: e.referencia,
    })),
    telefones: telefones.map((t) => ({
      id: t.id,
      tipo: t.tipo as 'celular',
      ddd: t.ddd,
      numero: t.numero,
      contato: t.contato,
      principal: t.principal,
    })),
    emails: emails.map((e) => ({
      id: e.id,
      email: e.email,
      principal: e.principal,
      recebeDocumentos: e.recebeDocumentos,
    })),
  };
}

/**
 * Versão do cadastro inteiro (pessoa + filhas, inclusive as excluídas logicamente): o trigger de versão não muda a
 * linha da pessoa quando só as filhas mudam, e o 409 do ERP 1.4 precisa pegar também essa edição concorrente.
 */
async function versaoAgregada(db: DbEmpresa, id: string): Promise<number> {
  const { rows } = await db.execute<{ v: string }>(sql`select greatest(
    (select versao from pessoas where id = ${id}),
    (select max(versao) from pessoas_categorias where pessoa_id = ${id}),
    (select max(versao) from pessoas_enderecos where pessoa_id = ${id}),
    (select max(versao) from pessoas_telefones where pessoa_id = ${id}),
    (select max(versao) from pessoas_emails where pessoa_id = ${id}))::text as v`);
  return Number(rows[0]!.v);
}

export async function detalhe(db: DbEmpresa, id: string): Promise<PessoaDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ p: pessoas, autorNome: autor.nome })
    .from(pessoas)
    .leftJoin(autor, eq(autor.id, pessoas.atualizadoPorId))
    .where(and(eq(pessoas.id, id), isNull(pessoas.excluidoEm)));
  if (!r) return null;
  const p = r.p;
  return {
    ...metadados(p, r.autorNome),
    codigo: p.codigo,
    tipo: p.tipo as 'PF' | 'PJ',
    nome: p.nome,
    apelido: p.apelido,
    ativa: p.ativa,
    cpfCnpj: p.cpfCnpj,
    rgIe: p.rgIe,
    indicadorIe: p.indicadorIe as PessoaDetalhe['indicadorIe'],
    inscricaoMunicipal: p.inscricaoMunicipal,
    nascimento: p.nascimento,
    sexo: p.sexo as PessoaDetalhe['sexo'],
    limiteCompras: p.limiteCompras,
    descontoPct: p.descontoPct,
    bloqueadaCredito: p.bloqueadaCredito,
    observacoes: p.observacoes,
    observacaoPdv: p.observacaoPdv,
    origem: p.origem,
    senhaDefinida: p.senhaHash !== null,
    manterNoPdv: await manterNoPdv(db, id),
    ...(await filhas(db, id)),
    versao: await versaoAgregada(db, id),
  };
}

/** Insere a pessoa com as filhas e a auditoria (transação de quem chama; formulário e importação). */
export async function inserirPessoa(
  s: Pick<Servicos, 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  dados: DadosPessoa,
  senhaHash: string | null = null,
  origemCadastro = 'erp',
): Promise<string> {
  await validarReferencias(tx, dados);
  await garantirDocumentoUnico(tx, dados.cpfCnpj);
  const { categorias, enderecos, telefones, emails, manterNoPdv: manual, ...colunas } = dados;
  const [p] = await tx
    .insert(pessoas)
    .values({
      ...colunas,
      senhaHash,
      busca: textoBusca(dados),
      origem: origemCadastro,
      criadoPorId: sessao.usuarioId,
      atualizadoPorId: sessao.usuarioId,
    })
    .returning();
  await gravarFilhas(tx, sessao, p!.id, { categorias, enderecos, telefones, emails });
  await recalcularRelevancia(tx, [p!.id], manual === undefined ? {} : { manual: new Map([[p!.id, manual]]) });
  // "Manter no PDV" leva os dados pessoais a todos os caixas (LGPD): a marcação fica na auditoria do cadastro.
  await s.auditoria.registrar(tx, origem, {
    acao: 'criar',
    entidade: 'pessoas',
    registroId: p!.id,
    localizacao: LOCALIZACAO,
    depois: { ...p, categorias, enderecos, telefones, emails, manterNoPdv: await manterNoPdv(tx, p!.id) },
  });
  return p!.id;
}

/** Altera a pessoa (versão quando informada, crédito com `pessoas.editar_credito`, documento único). */
export async function atualizarPessoa(
  s: Pick<Servicos, 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  id: string,
  versao: number | null,
  dados: DadosPessoa,
  senha: { senhaHash?: string; removerSenha?: boolean } = {},
): Promise<void> {
  const { senhaHash, removerSenha } = senha;
  const [antes] = await tx
    .select()
    .from(pessoas)
    .where(and(eq(pessoas.id, id), isNull(pessoas.excluidoEm)))
    .for('update');
  if (!antes) throw ErroApi.naoEncontrado('Pessoa não encontrada.');
  const versaoAtual = await versaoAgregada(tx, id);
  if (versao !== null && versaoAtual !== versao) await conflitoVersao(tx, { ...antes, versao: versaoAtual });
  const mudouCredito =
    (antes.limiteCompras === null ? null : Number(antes.limiteCompras)) !==
      (dados.limiteCompras === null ? null : Number(dados.limiteCompras)) ||
    antes.bloqueadaCredito !== dados.bloqueadaCredito;
  if (mudouCredito && !sessao.permissoes.has('pessoas.editar_credito')) {
    throw ErroApi.semPermissao(
      'Alterar limite de compras ou bloqueio exige "Pessoas: Alterar limite de compras e bloqueio".',
    );
  }
  await validarReferencias(tx, dados);
  if (dados.cpfCnpj !== antes.cpfCnpj) await garantirDocumentoUnico(tx, dados.cpfCnpj, id);
  const antesFilhas = await filhas(tx, id);
  const antesManual = await manterNoPdv(tx, id);
  const { categorias, enderecos, telefones, emails, manterNoPdv: manual, ...colunas } = dados;
  const [depois] = await tx
    .update(pessoas)
    .set({
      ...colunas,
      ...(senhaHash ? { senhaHash } : removerSenha ? { senhaHash: null } : {}),
      busca: textoBusca(dados),
      atualizadoPorId: sessao.usuarioId,
    })
    .where(eq(pessoas.id, id))
    .returning();
  await gravarFilhas(tx, sessao, id, { categorias, enderecos, telefones, emails });
  // Categoria Funcionário, limite de crédito ou "Manter no PDV" mudam a relevância (MD 3.5.4).
  await recalcularRelevancia(tx, [id], manual === undefined ? {} : { manual: new Map([[id, manual]]) });
  // A troca de "Manter no PDV" fica na auditoria (LGPD: decide se os dados pessoais descem aos caixas).
  await s.auditoria.registrar(tx, origem, {
    acao: 'editar',
    entidade: 'pessoas',
    registroId: id,
    localizacao: LOCALIZACAO,
    antes: { ...antes, ...antesFilhas, manterNoPdv: antesManual },
    depois: { ...depois, categorias, enderecos, telefones, emails, manterNoPdv: await manterNoPdv(tx, id) },
  });
}
