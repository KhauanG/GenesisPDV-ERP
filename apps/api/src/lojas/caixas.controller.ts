import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { alterarCaixaSchema, criarCaixaSchema, type CaixaDetalhe } from '@genesis/shared';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { conflitoVersao, garantirSemConflito } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { caixas, lojas, numeracoes } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { garantirNumeracoesLoja, numeracaoNfce, sqlUltimoNumero } from './numeracoes.js';

const LOCALIZACAO = 'Cadastros › Lojas › Caixas';

/** Caixas da loja (ERP 10.3.10; MD 3.2.7). O caixa 0 (vendas do ERP) é do sistema: somente leitura. */
@Controller('lojas/:lojaId/caixas')
export class CaixasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('lojas.ver')
  @Get()
  async listar(@Param('lojaId') lojaIdBruto: string, @Sessao() sessao: SessaoErp): Promise<CaixaDetalhe[]> {
    const lojaId = validar(z.uuid(), lojaIdBruto);
    garantirLoja(sessao, lojaId);
    return this.s.tenancy.cx().consulta(async (db) => {
      const loja = await obterLoja(db, lojaId);
      const linhas = await db
        .select()
        .from(caixas)
        .where(and(eq(caixas.lojaId, lojaId), isNull(caixas.excluidoEm)))
        .orderBy(asc(caixas.numero));
      return Promise.all(linhas.map((c) => detalheCaixa(db, c, loja.nfceAmbiente)));
    });
  }

  @Permissao('lojas.editar')
  @Post()
  @HttpCode(201)
  async criar(
    @Param('lojaId') lojaIdBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CaixaDetalhe> {
    const lojaId = validar(z.uuid(), lojaIdBruto);
    garantirLoja(sessao, lojaId);
    const { nfceNumeroInicial, ...dados } = validar(criarCaixaSchema, corpo);
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const loja = await obterLoja(tx, lojaId, true);
        if (loja.tipo === 'deposito')
          throw new ErroApi('REGRA_NEGOCIO', 'Depósito/CD não tem caixas de PDV.');
        await garantirUnicos(tx, lojaId, dados.numero, dados.nfceSerie);
        const [c] = await tx
          .insert(caixas)
          .values({ ...dados, lojaId, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
          .returning();
        await garantirNumeracoesLoja(tx, lojaId);
        if (nfceNumeroInicial !== null) await definirInicial(tx, c!, loja.nfceAmbiente, nfceNumeroInicial);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'caixas',
          registroId: c!.id,
          lojaId,
          localizacao: LOCALIZACAO,
          depois: { ...c, nfceNumeroInicial },
        });
        return detalheCaixa(tx, c!, loja.nfceAmbiente);
      },
      { travaVersao: true },
    );
  }

  @Permissao('lojas.editar')
  @Put(':id')
  async alterar(
    @Param('lojaId') lojaIdBruto: string,
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CaixaDetalhe> {
    const lojaId = validar(z.uuid(), lojaIdBruto);
    const id = validar(z.uuid(), idBruto);
    garantirLoja(sessao, lojaId);
    const { versao, nfceNumeroInicial, ...dados } = validar(alterarCaixaSchema, corpo);
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const loja = await obterLoja(tx, lojaId);
        const antes = await travar(tx, lojaId, id);
        if (antes.sistema)
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O caixa 0 é do sistema (vendas do ERP) e não pode ser alterado.',
          );
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        await garantirUnicos(tx, lojaId, null, dados.nfceSerie, id);
        const jaTeve = antes.terminalId !== null || antes.terminalAnteriorId !== null;
        if (nfceNumeroInicial !== null && jaTeve) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O caixa já teve terminal: a numeração da NFC-e é do PDV (SYNC 13.2).',
            {
              campos: { nfceNumeroInicial: ['Só antes da primeira ativação'] },
            },
          );
        }
        if (antes.terminalId && dados.nfceSerie !== antes.nfceSerie) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'Troque a série com o terminal revogado (série nova na substituição, SYNC 13).',
            {
              campos: { nfceSerie: ['Caixa com terminal ativo'] },
            },
          );
        }
        const [depois] = await tx
          .update(caixas)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(caixas.id, id), eq(caixas.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await garantirNumeracoesLoja(tx, lojaId);
        if (nfceNumeroInicial !== null)
          await definirInicial(tx, depois!, loja.nfceAmbiente, nfceNumeroInicial);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'caixas',
          registroId: id,
          lojaId,
          localizacao: LOCALIZACAO,
          antes,
          depois: { ...depois, nfceNumeroInicial },
        });
        return detalheCaixa(tx, depois!, loja.nfceAmbiente);
      },
      { travaVersao: true },
    );
  }

  @Permissao('lojas.editar')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('lojaId') lojaIdBruto: string,
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const lojaId = validar(z.uuid(), lojaIdBruto);
    const id = validar(z.uuid(), idBruto);
    garantirLoja(sessao, lojaId);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, lojaId, id);
        if (antes.sistema)
          throw new ErroApi('REGRA_NEGOCIO', 'O caixa 0 é do sistema e não pode ser excluído.');
        if (antes.terminalId)
          throw new ErroApi('REGRA_NEGOCIO', 'Revogue o terminal do caixa antes de excluí-lo.');
        const agora = new Date();
        await tx
          .update(caixas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(caixas.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'caixas',
          registroId: id,
          lojaId,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }
}

async function obterLoja(db: DbEmpresa, lojaId: string, travar = false) {
  const consulta = db
    .select({ id: lojas.id, tipo: lojas.tipo, nfceAmbiente: lojas.nfceAmbiente })
    .from(lojas)
    .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm)));
  const [l] = travar ? await consulta.for('update') : await consulta;
  if (!l) throw ErroApi.naoEncontrado('Loja não encontrada.');
  return l;
}

async function travar(tx: DbEmpresa, lojaId: string, id: string) {
  const [c] = await tx
    .select()
    .from(caixas)
    .where(and(eq(caixas.id, id), eq(caixas.lojaId, lojaId), isNull(caixas.excluidoEm)))
    .for('update');
  if (!c) throw ErroApi.naoEncontrado('Caixa não encontrado.');
  return c;
}

async function garantirUnicos(
  tx: DbEmpresa,
  lojaId: string,
  numero: number | null,
  serie: number | null,
  exceto?: string,
): Promise<void> {
  const vivos = and(
    eq(caixas.lojaId, lojaId),
    isNull(caixas.excluidoEm),
    exceto ? ne(caixas.id, exceto) : undefined,
  );
  const campos: Record<string, string[]> = {};
  if (numero !== null) {
    const [n] = await tx
      .select({ id: caixas.id })
      .from(caixas)
      .where(and(vivos, eq(caixas.numero, numero)));
    if (n) campos.numero = ['Já existe um caixa com este número na loja'];
  }
  if (serie !== null) {
    const [s] = await tx
      .select({ numero: caixas.numero })
      .from(caixas)
      .where(and(vivos, eq(caixas.nfceSerie, serie)));
    if (s) campos.nfceSerie = [`Série já usada pelo caixa ${s.numero} (uma série por caixa, ADR-04)`];
  }
  garantirSemConflito(campos, 'Já existe um caixa com estes dados.');
}

/** Nº inicial da NFC-e: `ultimo_numero = inicial − 1` na série/ambiente atuais (só antes do primeiro terminal). */
async function definirInicial(
  tx: DbEmpresa,
  caixa: typeof caixas.$inferSelect,
  ambiente: number,
  inicial: number,
): Promise<void> {
  const n = await numeracaoNfce(tx, caixa, ambiente);
  if (!n) {
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
      campos: { nfceNumeroInicial: ['Informe a série da NFC-e antes do número inicial'] },
    });
  }
  await tx
    .update(numeracoes)
    .set({ ultimoNumero: inicial - 1 })
    .where(eq(numeracoes.id, n.id));
}

async function detalheCaixa(
  db: DbEmpresa,
  c: typeof caixas.$inferSelect,
  ambiente: number,
): Promise<CaixaDetalhe> {
  const nfce = await numeracaoNfce(db, c, ambiente);
  const [venda] = await db
    .select({ n: sqlUltimoNumero('venda') })
    .from(caixas)
    .where(eq(caixas.id, c.id));
  return {
    id: c.id,
    lojaId: c.lojaId,
    numero: c.numero,
    descricao: c.descricao,
    sistema: c.sistema,
    nfceSerie: c.nfceSerie,
    tefTerminal: c.tefTerminal,
    posIdTerminal: c.posIdTerminal,
    ativo: c.ativo,
    terminalId: c.terminalId,
    jaTeveTerminal: c.terminalId !== null || c.terminalAnteriorId !== null,
    nfceUltimoNumero: nfce?.ultimoNumero ?? null,
    vendaUltimoNumero: venda?.n === null || venda?.n === undefined ? null : Number(venda.n),
    versao: c.versao,
  };
}
