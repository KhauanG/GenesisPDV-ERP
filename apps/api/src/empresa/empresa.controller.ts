import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { alterarEmpresaSchema, type EmpresaDetalhe } from '@genesis/shared';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, metadados } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { empresas } from '../database/controle/schema.js';
import { empresa, municipios, usuarios } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { garantirMunicipio } from '../lojas/municipio.js';

/** Empresa (ERP 10.1): formulário único; razão social, fantasia e CNPJ são replicados para o banco de controle. */
@Controller('empresa')
export class EmpresaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('empresa.ver')
  @Get()
  async obter(): Promise<EmpresaDetalhe> {
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db));
    if (!d) throw ErroApi.naoEncontrado();
    return d;
  }

  @Permissao('empresa.editar')
  @Put()
  async alterar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<EmpresaDetalhe> {
    const { versao, ...dados } = validar(alterarEmpresaSchema, corpo);
    const depois = await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx.select().from(empresa).for('update');
        if (!antes) throw ErroApi.naoEncontrado();
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        if (dados.cnpj !== antes.cnpj && !sessao.master) {
          throw ErroApi.semPermissao('Só um usuário Master pode alterar o CNPJ da empresa.');
        }
        await garantirMunicipio(tx, dados.municipioIbge, dados.uf);
        const [linha] = await tx
          .update(empresa)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(empresa.id, antes.id), eq(empresa.versao, versao)))
          .returning();
        if (!linha) await conflitoVersao(tx, antes);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'empresa',
          registroId: linha!.id,
          localizacao: 'Cadastros › Empresa',
          antes,
          depois: linha,
        });
        return linha!;
      },
      { travaVersao: true },
    );
    // A plataforma lista as empresas por estes dados (ERP 10.1). Bancos diferentes: depois do commit da empresa.
    await this.s.controle.db
      .update(empresas)
      .set({
        razaoSocial: depois.razaoSocial,
        nomeFantasia: depois.nomeFantasia,
        cnpj: depois.cnpj,
        atualizadoEm: new Date(),
      })
      .where(eq(empresas.id, sessao.empresa.empresaId));
    this.s.resolvedor.invalidar();
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db)))!;
  }
}

async function detalhe(db: DbEmpresa): Promise<EmpresaDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [l] = await db
    .select({ e: empresa, municipioNome: municipios.nome, autorNome: autor.nome })
    .from(empresa)
    .leftJoin(municipios, eq(municipios.codigoIbge, empresa.municipioIbge))
    .leftJoin(autor, eq(autor.id, empresa.atualizadoPorId));
  if (!l) return null;
  const e = l.e;
  return {
    ...metadados(e, l.autorNome),
    codigo: e.codigo,
    razaoSocial: e.razaoSocial,
    nomeFantasia: e.nomeFantasia,
    cnpj: e.cnpj,
    ie: e.ie,
    inscricaoMunicipal: e.inscricaoMunicipal,
    cep: e.cep,
    logradouro: e.logradouro,
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
    uf: e.uf,
    municipioIbge: e.municipioIbge,
    municipioNome: l.municipioNome,
    telefone: e.telefone,
    email: e.email,
    emailContador: e.emailContador,
    fusoHorario: e.fusoHorario,
  };
}
