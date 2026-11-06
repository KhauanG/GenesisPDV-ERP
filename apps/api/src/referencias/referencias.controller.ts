import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  somenteDigitos,
  type CfopOpcao,
  type EnderecoCep,
  type NcmOpcao,
  type UnidadeMedida,
} from '@genesis/shared';
import { and, asc, eq, ilike, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { contem } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { cfops, municipios, ncms, paises, ufs, unidadesMedida } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';

const filtroMunicipios = z.object({
  uf: z.string().trim().toUpperCase().length(2).optional(),
  nome: z.string().trim().max(80).optional(),
  codigo: z.coerce.number().int().optional(),
});

interface RespostaViaCep {
  cep?: string;
  logradouro?: string;
  complemento?: string;
  bairro?: string;
  uf?: string;
  ibge?: string;
  erro?: boolean | string;
}

/** Cache curto em memória: o mesmo CEP digitado em vários cadastros não sai de novo para a internet. */
const cacheCep = new Map<string, { r: EnderecoCep; expira: number }>();

/**
 * Referências nacionais para os formulários (UFs, municípios, países) e a consulta de CEP (ERP 7.2, 10.1). Qualquer
 * usuário autenticado: são dados públicos e não dependem de permissão.
 */
@Controller()
export class ReferenciasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Get('referencias/ufs')
  async ufs(): Promise<Array<{ sigla: string; nome: string }>> {
    return this.s.tenancy
      .cx()
      .consulta((db) =>
        db
          .select({ sigla: ufs.sigla, nome: ufs.nome })
          .from(ufs)
          .where(isNull(ufs.excluidoEm))
          .orderBy(asc(ufs.sigla)),
      );
  }

  @Get('referencias/municipios')
  async municipios(
    @Query() query: unknown,
  ): Promise<Array<{ codigoIbge: number; nome: string; uf: string }>> {
    const q = validar(filtroMunicipios, query);
    if (!q.uf && !q.codigo && !q.nome) {
      throw new ErroApi('VALIDACAO', 'Informe a UF, o código ou parte do nome.', {
        campos: { uf: ['Informe a UF'] },
      });
    }
    const busca = contem(q.nome);
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({ codigoIbge: municipios.codigoIbge, nome: municipios.nome, uf: municipios.uf })
        .from(municipios)
        .where(
          and(
            isNull(municipios.excluidoEm),
            q.uf ? eq(municipios.uf, q.uf) : undefined,
            q.codigo ? eq(municipios.codigoIbge, q.codigo) : undefined,
            busca ? sql`fn_unaccent(${municipios.nome}) ilike fn_unaccent(${busca})` : undefined,
          ),
        )
        .orderBy(asc(municipios.nome))
        .limit(q.uf ? 1000 : 50),
    );
  }

  @Get('referencias/paises')
  async paises(@Query('nome') nome?: string): Promise<Array<{ codigoBacen: string; nome: string }>> {
    const busca = contem(typeof nome === 'string' ? nome.slice(0, 80) : undefined);
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({ codigoBacen: paises.codigoBacen, nome: paises.nome })
        .from(paises)
        .where(and(isNull(paises.excluidoEm), busca ? ilike(paises.nome, busca) : undefined))
        .orderBy(asc(paises.nome)),
    );
  }

  /** Unidades de medida ativas (ERP 8.2.1; seed MD 7, editável). */
  @Get('referencias/unidades')
  async unidades(): Promise<UnidadeMedida[]> {
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({
          id: unidadesMedida.id,
          sigla: unidadesMedida.sigla,
          descricao: unidadesMedida.descricao,
          permiteFracao: unidadesMedida.permiteFracao,
        })
        .from(unidadesMedida)
        .where(and(isNull(unidadesMedida.excluidoEm), eq(unidadesMedida.ativo, true)))
        .orderBy(asc(unidadesMedida.sigla)),
    );
  }

  /** CFOPs de saída (ERP 8.2.15): `prefixo=5` (dentro do estado) ou `6` (fora). */
  @Get('referencias/cfops')
  async cfops(@Query('prefixo') prefixo?: string): Promise<CfopOpcao[]> {
    const p = typeof prefixo === 'string' && /^[1-7]$/.test(prefixo) ? prefixo : null;
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({ codigo: cfops.codigo, descricao: cfops.descricao })
        .from(cfops)
        .where(
          and(
            isNull(cfops.excluidoEm),
            eq(cfops.ativo, true),
            p ? like(cfops.codigo, `${p}%`) : eq(cfops.tipo, 'saida'),
          ),
        )
        .orderBy(asc(cfops.codigo)),
    );
  }

  /**
   * Busca de NCM (ERP 8.2.16, `<BuscaNcm>`): código (prefixo) ou descrição sem acento, só os vigentes; até 50.
   */
  @Get('ncms')
  async ncms(@Query('busca') bruto?: string): Promise<NcmOpcao[]> {
    const busca = typeof bruto === 'string' ? bruto.trim().slice(0, 80) : '';
    const digitos = busca.replace(/[.\s]/g, '');
    const porCodigo = /^\d{1,8}$/.test(digitos);
    const texto = contem(busca);
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({
          codigo: ncms.codigo,
          descricao: ncms.descricao,
          vigenciaInicio: ncms.vigenciaInicio,
          vigenciaFim: ncms.vigenciaFim,
        })
        .from(ncms)
        .where(
          and(
            isNull(ncms.excluidoEm),
            porCodigo
              ? like(ncms.codigo, `${digitos}%`)
              : texto
                ? sql`fn_unaccent(${ncms.descricao}) ilike fn_unaccent(${texto})`
                : undefined,
          ),
        )
        .orderBy(asc(ncms.codigo))
        .limit(50),
    );
  }

  @Get('ncms/:codigo')
  async ncm(@Param('codigo') codigo: string): Promise<NcmOpcao> {
    const c = somenteDigitos(codigo ?? '');
    const [n] = await this.s.tenancy.cx().consulta((db) =>
      db
        .select({
          codigo: ncms.codigo,
          descricao: ncms.descricao,
          vigenciaInicio: ncms.vigenciaInicio,
          vigenciaFim: ncms.vigenciaFim,
        })
        .from(ncms)
        .where(and(eq(ncms.codigo, c), isNull(ncms.excluidoEm))),
    );
    if (!n) throw ErroApi.naoEncontrado('NCM inexistente na tabela vigente.');
    return n;
  }

  /**
   * Consulta de CEP (ERP 7.2, "botão buscar"): opcional e tolerante a falta de internet — falha ou demora vira 404
   * e a tela segue com o endereço digitado. O município vem pelo código IBGE e é conferido na tabela local.
   */
  @Get('utilitarios/cep/:cep')
  async cep(@Param('cep') bruto: string): Promise<EnderecoCep> {
    const cep = somenteDigitos(bruto ?? '');
    if (!/^\d{8}$/.test(cep))
      throw new ErroApi('VALIDACAO', 'CEP inválido.', { campos: { cep: ['CEP inválido'] } });
    const emCache = cacheCep.get(cep);
    if (emCache && emCache.expira > Date.now()) return emCache.r;
    const modelo = this.s.config.cepConsultaUrl;
    if (!modelo) throw ErroApi.naoEncontrado('Consulta de CEP desligada. Preencha o endereço.');
    let dados: RespostaViaCep | null = null;
    try {
      const resp = await fetch(modelo.replace('{cep}', cep), { signal: AbortSignal.timeout(3000) });
      if (resp.ok) dados = (await resp.json()) as RespostaViaCep;
    } catch {
      dados = null;
    }
    if (!dados || dados.erro)
      throw ErroApi.naoEncontrado('CEP não encontrado ou consulta indisponível. Preencha o endereço.');
    const ibge = dados.ibge && /^\d{7}$/.test(dados.ibge) ? Number(dados.ibge) : null;
    const [m] = ibge
      ? await this.s.tenancy
          .cx()
          .consulta((db) =>
            db
              .select({ nome: municipios.nome, uf: municipios.uf })
              .from(municipios)
              .where(eq(municipios.codigoIbge, ibge)),
          )
      : [];
    const r: EnderecoCep = {
      cep,
      logradouro: dados.logradouro?.trim() || null,
      complemento: dados.complemento?.trim() || null,
      bairro: dados.bairro?.trim() || null,
      uf: m?.uf ?? (dados.uf?.trim().toUpperCase() || null),
      municipioIbge: m ? ibge : null,
      municipioNome: m?.nome ?? null,
    };
    if (cacheCep.size > 5000) cacheCep.clear();
    cacheCep.set(cep, { r, expira: Date.now() + 24 * 3600_000 });
    return r;
  }
}
