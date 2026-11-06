import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  criarEmpresaSchema,
  filtroEmpresasSchema,
  filtroSituacaoMigracoesSchema,
  limiteDeslocamento,
  motivoStatusSchema,
  paginacaoQuerySchema,
  type EmpresaResumo,
  type Pagina,
  type PlanoResumo,
  type ResultadoMigracaoEmMassa,
  type ResultadoProvisionamento,
  type SimulacaoMigracoes,
  type SituacaoMigracoes,
} from '@genesis/shared';
import { and, asc, count, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RotaPlataforma } from '../autorizacao/decorators.js';
import { ErroApi } from '../comum/erros.js';
import { Req, SessaoAdmin, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { empresas, migracoesEmpresas, planos } from '../database/controle/schema.js';
import type { Servicos } from '../servicos.js';
import type { SessaoPlataforma } from './admin-auth.service.js';
import { posMigracaoSemAdmin } from './provisionamento.js';

const codigoSchema = z.coerce.number().int().min(100001).max(999999);
const tentarNovamenteSchema = z
  .object({
    admin: z
      .object({
        nome: z.string().trim().min(1).max(100).default('ADMINISTRADOR'),
        login: z.string().trim().toLowerCase().regex(/^\S+$/).max(60).default('admin'),
        email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
      })
      .optional(),
  })
  .default({});

const colunas = {
  id: empresas.id,
  codigo: empresas.codigo,
  razaoSocial: empresas.razaoSocial,
  nomeFantasia: empresas.nomeFantasia,
  cnpj: empresas.cnpj,
  status: empresas.status,
  motivoStatus: empresas.motivoStatus,
  plano: planos.codigo,
  versaoSchema: empresas.versaoSchema,
  canario: empresas.canario,
  criadoEm: empresas.criadoEm,
  ativadaEm: empresas.ativadaEm,
  migracaoComFalha: sql<boolean>`exists (select 1 from migracoes_empresas m where m.empresa_id = empresas.id and m.status = 'falhou')`,
};

/** Painel da plataforma › Empresas (ERP 19.2–19.4). */
@Controller('plataforma')
export class PlataformaEmpresasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @RotaPlataforma()
  @Get('empresas')
  async listar(@Query() query: unknown): Promise<Pagina<EmpresaResumo & { migracaoComFalha: boolean }>> {
    const q = validar(paginacaoQuerySchema.extend(filtroEmpresasSchema.shape), query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = q.busca ? `%${q.busca}%` : undefined;
    const onde = and(
      isNull(empresas.excluidoEm),
      q.status ? eq(empresas.status, q.status) : undefined,
      busca
        ? or(
            ilike(empresas.razaoSocial, busca),
            ilike(empresas.nomeFantasia, busca),
            ilike(empresas.cnpj, busca),
            sql`${empresas.codigo}::text = ${q.busca}`,
          )
        : undefined,
    );
    const linhas = await this.s.controle.db
      .select(colunas)
      .from(empresas)
      .innerJoin(planos, eq(planos.id, empresas.planoId))
      .where(onde)
      .orderBy(asc(empresas.codigo))
      .limit(limite)
      .offset(deslocamento);
    const [total] = await this.s.controle.db.select({ n: count() }).from(empresas).where(onde);
    return {
      itens: linhas.map((l) => ({
        ...l,
        status: l.status as EmpresaResumo['status'],
        criadoEm: l.criadoEm.toISOString(),
        ativadaEm: l.ativadaEm?.toISOString() ?? null,
      })),
      total: total?.n ?? 0,
      pagina: q.pagina,
      tamanho: q.tamanho,
    };
  }

  @RotaPlataforma()
  @Get('empresas/:codigo')
  async obter(@Param('codigo') codigo: string) {
    const c = validar(codigoSchema, codigo);
    const [e] = await this.s.controle.db
      .select(colunas)
      .from(empresas)
      .innerJoin(planos, eq(planos.id, empresas.planoId))
      .where(eq(empresas.codigo, c));
    if (!e) throw ErroApi.naoEncontrado('Empresa não encontrada.');
    const migracoes = await this.s.controle.db
      .select()
      .from(migracoesEmpresas)
      .where(eq(migracoesEmpresas.empresaId, e.id))
      .orderBy(asc(migracoesEmpresas.ordem));
    return { ...e, migracoes };
  }

  @RotaPlataforma('superadmin', 'financeiro')
  @Post('empresas')
  @HttpCode(201)
  criar(
    @Body() corpo: unknown,
    @SessaoAdmin() admin: SessaoPlataforma,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoProvisionamento> {
    return this.s.provisionamento.criar(validar(criarEmpresaSchema, corpo), {
      adminId: admin.adminId,
      ip: req.ip ?? null,
    });
  }

  @RotaPlataforma('superadmin', 'suporte', 'financeiro')
  @Post('empresas/:codigo/provisionamento/tentar-novamente')
  @HttpCode(200)
  tentarNovamente(
    @Param('codigo') codigo: string,
    @Body() corpo: unknown,
    @SessaoAdmin() admin: SessaoPlataforma,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoProvisionamento> {
    const entrada = validar(tentarNovamenteSchema, corpo ?? {});
    return this.s.provisionamento.tentarNovamente(validar(codigoSchema, codigo), entrada.admin, {
      adminId: admin.adminId,
      ip: req.ip ?? null,
    });
  }

  @RotaPlataforma('superadmin')
  @Post('empresas/:codigo/provisionamento/descartar')
  @HttpCode(204)
  async descartar(
    @Param('codigo') codigo: string,
    @SessaoAdmin() admin: SessaoPlataforma,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    await this.s.provisionamento.descartar(validar(codigoSchema, codigo), {
      adminId: admin.adminId,
      ip: req.ip ?? null,
    });
  }

  @RotaPlataforma('superadmin', 'suporte', 'financeiro')
  @Post('empresas/:codigo/suspender')
  @HttpCode(200)
  async suspender(
    @Param('codigo') codigo: string,
    @Body() corpo: unknown,
    @SessaoAdmin() admin: SessaoPlataforma,
    @Req() req: RequisicaoGenesis,
  ) {
    const { motivo } = validar(motivoStatusSchema, corpo);
    const e = await this.s.provisionamento.alterarStatus(validar(codigoSchema, codigo), 'suspender', motivo, {
      adminId: admin.adminId,
      ip: req.ip ?? null,
    });
    return { codigo: e.codigo, status: e.status, motivoStatus: e.motivoStatus };
  }

  @RotaPlataforma('superadmin', 'suporte', 'financeiro')
  @Post('empresas/:codigo/reativar')
  @HttpCode(200)
  async reativar(
    @Param('codigo') codigo: string,
    @SessaoAdmin() admin: SessaoPlataforma,
    @Req() req: RequisicaoGenesis,
  ) {
    const e = await this.s.provisionamento.alterarStatus(validar(codigoSchema, codigo), 'reativar', null, {
      adminId: admin.adminId,
      ip: req.ip ?? null,
    });
    return { codigo: e.codigo, status: e.status, motivoStatus: e.motivoStatus };
  }

  @RotaPlataforma()
  @Get('planos')
  async planos(): Promise<Pagina<PlanoResumo>> {
    const itens = await this.s.controle.db
      .select({
        id: planos.id,
        codigo: planos.codigo,
        nome: planos.nome,
        descricao: planos.descricao,
        limiteLojas: planos.limiteLojas,
        limiteTerminais: planos.limiteTerminais,
        limiteUsuarios: planos.limiteUsuarios,
        recursos: planos.recursos,
        precoMensal: planos.precoMensal,
        ativo: planos.ativo,
      })
      .from(planos)
      .where(isNull(planos.excluidoEm))
      .orderBy(asc(planos.codigo));
    return { itens, total: itens.length, pagina: 1, tamanho: 'todos' as const };
  }

  /** Migrações › Situação (ERP 19.7): versão do código × `versao_schema` de cada empresa, erros e log. */
  @RotaPlataforma()
  @Get('migracoes')
  situacaoMigracoes(@Query() query: unknown): Promise<SituacaoMigracoes> {
    const { filtro } = validar(filtroSituacaoMigracoesSchema, query ?? {});
    return this.s.migrador.situacao({ filtro });
  }

  /** "Simular": pendentes e SQL, sem aplicar; com `codigo`, lido do próprio banco da empresa. */
  @RotaPlataforma('superadmin', 'suporte')
  @Get('migracoes/simular')
  async simularMigracoes(@Query() query: unknown): Promise<SimulacaoMigracoes> {
    const { codigo } = validar(z.object({ codigo: codigoSchema.optional() }), query ?? {});
    const r = await this.s.migrador.simular({ codigo });
    if (!r) throw ErroApi.naoEncontrado('Empresa não encontrada.');
    return r;
  }

  /** "Aplicar em todas" / "Aplicar em uma" (`codigos`) (ERP 19.7): mesma rotina do `db:migrate:empresas`. */
  @RotaPlataforma('superadmin', 'suporte')
  @Post('migracoes/aplicar')
  @HttpCode(200)
  aplicarMigracoes(
    @Body() corpo: unknown,
    @SessaoAdmin() admin: SessaoPlataforma,
  ): Promise<ResultadoMigracaoEmMassa> {
    const entrada = validar(
      z
        .object({
          codigos: z.array(codigoSchema).optional(),
          pararNoPrimeiroErro: z.boolean().default(false),
        })
        .default({ pararNoPrimeiroErro: false }),
      corpo ?? {},
    );
    return this.s.migrador.migrarTodas({
      codigos: entrada.codigos,
      pararNoPrimeiroErro: entrada.pararNoPrimeiroErro,
      posMigracao: posMigracaoSemAdmin(this.s.controle),
      adminId: admin.adminId,
    });
  }
}
