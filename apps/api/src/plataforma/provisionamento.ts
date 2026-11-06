import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CriarEmpresa, RegimeFiscal, ResultadoProvisionamento, StatusEmpresa } from '@genesis/shared';
import type pg from 'pg';
import { ErroApi } from '../comum/erros.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas, planos } from '../database/controle/schema.js';
import { garantirNomeBancoEmpresa, nomeBancoEmpresa } from '../database/nomes-bancos.js';
import { carregarReferencias } from '../database/referencias/carregar.js';
import { removerRoleAplicacao } from '../database/roles-empresa.js';
import { aplicarSeedEmpresa, type DadosSeedEmpresa } from '../database/seed/seed-empresa.js';
import type { ServidoresBanco } from '../database/servidores.js';
import { gerarHashSenha, gerarSenhaProvisoria } from '../seguranca/senhas.js';
import type { PoolsEmpresas } from '../tenancy/pools-empresas.js';
import { registrarAuditoriaPlataforma } from './auditoria-plataforma.js';
import type { EmpresaAlvo, MigradorEmpresas } from './migrador-empresas.js';

export interface Ator {
  adminId?: string | null;
  ip?: string | null;
}

export interface AdminInicial {
  nome: string;
  login: string;
  email?: string | null;
}

type LinhaEmpresa = typeof empresas.$inferSelect;

const identificador = (nome: string) => `"${nome.replace(/"/g, '""')}"`;

/** Pós-migração idempotente de uma empresa: referências nacionais, catálogo de permissões, seed e partições. */
export async function posMigracaoEmpresa(
  cliente: pg.ClientBase,
  dados: DadosSeedEmpresa,
  admin?: Parameters<typeof aplicarSeedEmpresa>[2],
): Promise<Awaited<ReturnType<typeof aplicarSeedEmpresa>>> {
  await cliente.query('begin');
  try {
    await cliente.query('select fn_trava_versao()');
    await carregarReferencias(cliente);
    const r = await aplicarSeedEmpresa(cliente, dados, admin);
    await cliente.query('select fn_auditoria_garantir_particoes(1, 12)');
    await cliente.query('commit');
    return r;
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

/** Regime fiscal guardado só no seed da empresa; no controle não há coluna própria (MD 2.3). */
async function lerRegime(cliente: pg.ClientBase): Promise<RegimeFiscal> {
  const { rows } = await cliente
    .query<{ regime: RegimeFiscal }>(
      "select valor #>> '{}' as regime from configuracoes where escopo = 'empresa' and chave = 'fiscal.regime' and excluido_em is null",
    )
    .catch(() => ({ rows: [] as Array<{ regime: RegimeFiscal }> }));
  return rows[0]?.regime ?? 'simples_nacional';
}

export function dadosSeedDe(e: LinhaEmpresa, regime: RegimeFiscal): DadosSeedEmpresa {
  return {
    codigo: e.codigo,
    razaoSocial: e.razaoSocial,
    nomeFantasia: e.nomeFantasia,
    cnpj: e.cnpj,
    email: e.emailResponsavel,
    regime,
  };
}

/**
 * Provisionamento de empresa (MD 7.1; ERP 19.4): registra em `empresas` (status provisionando), `CREATE DATABASE`,
 * migrações, referências, seed e administrador com senha provisória exibida uma única vez. Falha deixa a empresa
 * em `provisionando` com a migração `falhou`; "tentar novamente" continua de onde parou e "descartar" faz DROP.
 */
export class Provisionamento {
  constructor(
    private readonly controle: BancoControle,
    private readonly servidores: ServidoresBanco,
    private readonly migrador: MigradorEmpresas,
    private readonly pools: PoolsEmpresas,
    private readonly opcoes: { icuLocale: string | null },
    private readonly aoAlterarEmpresa: () => void = () => undefined,
  ) {}

  async criar(entrada: CriarEmpresa, ator: Ator = {}): Promise<ResultadoProvisionamento> {
    const [plano] = await this.controle.db
      .select({ id: planos.id })
      .from(planos)
      .where(and(eq(planos.codigo, entrada.planoCodigo), eq(planos.ativo, true), isNull(planos.excluidoEm)));
    if (!plano) {
      throw new ErroApi('VALIDACAO', 'Plano inexistente ou inativo.', {
        campos: { planoCodigo: ['Plano não encontrado'] },
      });
    }
    const servidorId = await this.servidores.escolherParaNovaEmpresa();

    const empresa = await this.controle.transacao(async (tx, cliente) => {
      let codigo = entrada.codigo;
      if (codigo === undefined) {
        const { rows } = await cliente.query<{ codigo: number }>(
          "select nextval('seq_codigo_empresa')::int as codigo",
        );
        codigo = rows[0]!.codigo;
      } else {
        const [usado] = await tx
          .select({ id: empresas.id })
          .from(empresas)
          .where(eq(empresas.codigo, codigo));
        if (usado)
          throw new ErroApi('VALIDACAO', 'Código de empresa já usado.', {
            campos: { codigo: ['Código já usado'] },
          });
        // A sequência nunca deve devolver um código informado manualmente.
        await cliente.query(
          "select setval('seq_codigo_empresa', greatest($1::bigint, (select last_value from seq_codigo_empresa)))",
          [codigo],
        );
      }
      const [nova] = await tx
        .insert(empresas)
        .values({
          codigo,
          razaoSocial: entrada.razaoSocial,
          nomeFantasia: entrada.nomeFantasia ?? null,
          cnpj: entrada.cnpj,
          nomeBanco: nomeBancoEmpresa(codigo),
          servidorBancoId: servidorId,
          planoId: plano.id,
          status: 'provisionando',
          canario: entrada.canario,
          nomeResponsavel: entrada.nomeResponsavel ?? null,
          emailResponsavel: entrada.emailResponsavel ?? null,
          telefoneResponsavel: entrada.telefoneResponsavel ?? null,
          observacoes: entrada.observacoes ?? null,
          criadoPorAdminId: ator.adminId ?? null,
          atualizadoPorAdminId: ator.adminId ?? null,
        })
        .returning();
      await registrarAuditoriaPlataforma(tx, {
        adminId: ator.adminId,
        empresaId: nova!.id,
        acao: 'empresa_criada',
        entidade: 'empresas',
        registroId: nova!.id,
        depois: { ...nova!, regime: entrada.regime, admin_login: entrada.admin.login },
        ip: ator.ip,
      });
      return nova!;
    });

    return this.executar(empresa, entrada.admin, entrada.regime, ator);
  }

  async tentarNovamente(
    codigo: number,
    admin: AdminInicial | undefined,
    ator: Ator = {},
  ): Promise<ResultadoProvisionamento> {
    const empresa = await this.buscar(codigo);
    if (empresa.status !== 'provisionando' || empresa.excluidoEm) {
      throw new ErroApi('REGRA_NEGOCIO', 'Só é possível tentar novamente uma empresa em provisionamento.');
    }
    return this.executar(empresa, admin ?? { nome: 'ADMINISTRADOR', login: 'admin' }, undefined, ator);
  }

  async descartar(codigo: number, ator: Ator = {}): Promise<void> {
    const empresa = await this.buscar(codigo);
    if (empresa.status !== 'provisionando' || empresa.excluidoEm) {
      throw new ErroApi('REGRA_NEGOCIO', 'Só é possível descartar uma empresa em provisionamento.');
    }
    garantirNomeBancoEmpresa(empresa.nomeBanco, empresa.codigo);
    await this.pools.descartarEmpresa(empresa.id);
    const admin = await this.servidores.conectar(
      empresa.servidorBancoId,
      'postgres',
      'genesis_provisionamento',
    );
    try {
      await admin.query(`drop database if exists ${identificador(empresa.nomeBanco)} with (force)`);
      await removerRoleAplicacao(admin, empresa.nomeBanco);
    } finally {
      await admin.end();
    }
    const [depois] = await this.controle.db
      .update(empresas)
      .set({
        status: 'cancelada',
        motivoStatus: 'Provisionamento descartado',
        usuarioBanco: null,
        senhaBancoCifrada: null,
        canceladaEm: new Date(),
        excluidoEm: new Date(),
        atualizadoPorAdminId: ator.adminId ?? null,
      })
      .where(eq(empresas.id, empresa.id))
      .returning();
    await registrarAuditoriaPlataforma(this.controle.db, {
      adminId: ator.adminId,
      empresaId: empresa.id,
      acao: 'provisionamento_descartado',
      entidade: 'empresas',
      registroId: empresa.id,
      antes: empresa,
      depois,
      ip: ator.ip,
    });
    this.aoAlterarEmpresa();
  }

  async alterarStatus(
    codigo: number,
    acao: 'suspender' | 'reativar',
    motivo: string | null,
    ator: Ator = {},
  ): Promise<LinhaEmpresa> {
    const empresa = await this.buscar(codigo);
    if (empresa.excluidoEm) throw ErroApi.naoEncontrado('Empresa não encontrada.');
    const permitido: Record<typeof acao, StatusEmpresa[]> = {
      suspender: ['ativa'],
      reativar: ['suspensa', 'cancelada'],
    };
    if (!permitido[acao].includes(empresa.status as StatusEmpresa)) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        `Não é possível ${acao} uma empresa com status "${empresa.status}".`,
      );
    }
    const valores =
      acao === 'suspender'
        ? { status: 'suspensa', motivoStatus: motivo, suspensaEm: new Date() }
        : { status: 'ativa', motivoStatus: null, suspensaEm: null, canceladaEm: null, dadosRetidosAte: null };
    const [depois] = await this.controle.db
      .update(empresas)
      .set({ ...valores, atualizadoPorAdminId: ator.adminId ?? null })
      .where(eq(empresas.id, empresa.id))
      .returning();
    await registrarAuditoriaPlataforma(this.controle.db, {
      adminId: ator.adminId,
      empresaId: empresa.id,
      acao: acao === 'suspender' ? 'empresa_suspensa' : 'empresa_reativada',
      entidade: 'empresas',
      registroId: empresa.id,
      antes: { status: empresa.status, motivo_status: empresa.motivoStatus },
      depois: { status: depois!.status, motivo_status: depois!.motivoStatus },
      ip: ator.ip,
    });
    this.aoAlterarEmpresa();
    return depois!;
  }

  private async buscar(codigo: number): Promise<LinhaEmpresa> {
    const [e] = await this.controle.db.select().from(empresas).where(eq(empresas.codigo, codigo));
    if (!e) throw ErroApi.naoEncontrado('Empresa não encontrada.');
    return e;
  }

  private async criarBanco(e: LinhaEmpresa): Promise<void> {
    garantirNomeBancoEmpresa(e.nomeBanco, e.codigo);
    const admin = await this.servidores.conectar(e.servidorBancoId, 'postgres', 'genesis_provisionamento');
    try {
      const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [e.nomeBanco]);
      if (rowCount) return;
      const icu = this.opcoes.icuLocale
        ? ` locale_provider icu icu_locale '${this.opcoes.icuLocale.replace(/'/g, '')}'`
        : '';
      await admin.query(
        `create database ${identificador(e.nomeBanco)} template template0 encoding 'UTF8'${icu}`,
      );
    } finally {
      await admin.end();
    }
  }

  private async executar(
    empresa: LinhaEmpresa,
    admin: AdminInicial,
    regimeInformado: RegimeFiscal | undefined,
    ator: Ator,
  ): Promise<ResultadoProvisionamento> {
    const senhaProvisoria = gerarSenhaProvisoria();
    const senhaHash = await gerarHashSenha(senhaProvisoria);
    let resultadoAdmin: string | undefined;
    try {
      await this.criarBanco(empresa);
      const alvo: EmpresaAlvo = empresa;
      const r = await this.migrador.migrarEmpresa(alvo, {
        posMigracao: async (cliente) => {
          const regime = regimeInformado ?? (await lerRegime(cliente));
          const seed = await posMigracaoEmpresa(cliente, dadosSeedDe(empresa, regime), {
            nome: admin.nome,
            login: admin.login,
            email: admin.email ?? null,
            senhaHash,
          });
          resultadoAdmin = seed.admin;
        },
      });
      if (r.status !== 'ok') throw new Error(r.erro ?? 'Falha ao migrar o banco da empresa');
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await registrarAuditoriaPlataforma(this.controle.db, {
        adminId: ator.adminId,
        empresaId: empresa.id,
        acao: 'provisionamento_falhou',
        entidade: 'empresas',
        registroId: empresa.id,
        depois: { erro },
        ip: ator.ip,
      });
      this.aoAlterarEmpresa();
      throw new ErroApi('REGRA_NEGOCIO', `Falha no provisionamento da empresa ${empresa.codigo}: ${erro}`, {
        detalhes: { codigo: empresa.codigo, empresaId: empresa.id, acoes: ['tentar_novamente', 'descartar'] },
      });
    }

    const [ativa] = await this.controle.db
      .update(empresas)
      .set({ status: 'ativa', ativadaEm: sql`coalesce(${empresas.ativadaEm}, now())` })
      .where(eq(empresas.id, empresa.id))
      .returning();
    await registrarAuditoriaPlataforma(this.controle.db, {
      adminId: ator.adminId,
      empresaId: empresa.id,
      acao: 'empresa_provisionada',
      entidade: 'empresas',
      registroId: empresa.id,
      depois: { status: 'ativa', versao_schema: ativa!.versaoSchema, admin: resultadoAdmin },
      ip: ator.ip,
    });
    this.aoAlterarEmpresa();
    const exibirSenha = resultadoAdmin === 'criado' || resultadoAdmin === 'senha_provisoria_redefinida';
    return {
      empresaId: empresa.id,
      codigo: empresa.codigo,
      nomeBanco: empresa.nomeBanco,
      status: 'ativa',
      adminLogin: admin.login,
      ...(exibirSenha ? { senhaProvisoria } : {}),
    };
  }
}

/** Pós-migração usada pelo `db:migrate:empresas`: lê os dados da empresa e reaplica referências e seed (sem admin). */
export function posMigracaoSemAdmin(controle: BancoControle) {
  return async (cliente: pg.Client, alvo: EmpresaAlvo): Promise<void> => {
    const [e] = await controle.db.select().from(empresas).where(eq(empresas.id, alvo.id));
    if (!e) throw new Error(`Empresa ${alvo.codigo} não encontrada`);
    await posMigracaoEmpresa(cliente, dadosSeedDe(e, await lerRegime(cliente)));
  };
}
