/**
 * Regras do cadastro de produtos que dependem do banco (ERP 8.2, 8.2.17; MD 3.6.3–3.6.7, 3.6.13) e gravação das
 * filhas num só "Gravar" (códigos de barras, lojas com o ST retido, faixas, categorias, posições do combo/ficha técnica e
 * alternativas, produtos relacionados com a relação inversa, fornecedores, lotes do bloco Validade, a foto e a
 * galeria de imagens, os grupos de complementos, a Tributação por UF).
 */
import {
  CAMPOS_ST_RETIDO,
  CAMPOS_ST_RETIDO_CUSTO,
  CHAVES_TIPO_PRODUTO,
  chaveFornecedorProduto,
  chaveLoteProduto,
  MAXIMO_RELACIONADOS,
  motivoTipoProdutoBloqueado,
  tiposProdutoHabilitados,
  TIPOS_GRUPO_PRECO,
  TIPOS_INSUMO_FICHA,
  TIPOS_PROIBIDOS_NO_COMBO,
  TIPOS_COMPLEMENTO_VINCULADO,
  TIPOS_TROCA_COM_MOVIMENTO,
  ROTULOS_TIPO_PRODUTO,
  type ConflitoVinculoFornecedor,
  type CriarProduto,
  type DetalhesConflitoFornecedor,
  type OrigemHistoricoPreco,
  type TipoProduto,
} from '@genesis/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { vincularArquivo } from '../arquivos/arquivos.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao, lerConfiguracoes } from '../configuracoes/valores.js';
import {
  produtosCategorias,
  produtosCodigosBarras,
  produtosComplementos,
  produtosComponentes,
  produtosComponentesAlternativas,
  produtosFornecedores,
  produtosGruposComplementos,
  produtosHistoricoPrecos,
  produtosImagens,
  produtosLojas,
  produtosLotes,
  produtosPrecosQuantidade,
  produtosRelacionados,
  produtosTributacaoUf,
} from '../database/empresa/schema/index.js';
import { estoquesPermitidos } from '../estoques/permitidos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { complementoDe } from './consultas.js';
import { ncmVigente } from './ncm.js';

type Linha = Record<string, unknown>;
type Campos = Record<string, string[]>;

const add = (campos: Campos, campo: string, msg: string) => (campos[campo] ??= []).push(msg);

export interface ProdutoAntes {
  tipo: TipoProduto;
  temMovimento: boolean;
  saldoNaoZero: boolean;
  /** "Com variações": há variação ativa (o tipo não pode ser trocado; F2-B1). */
  variacoesAtivas?: boolean;
  /** "Com variações": há movimento de estoque de alguma variação (sem ele o legado troca como Simples). */
  movimentoComVariacao?: boolean;
}

/**
 * Tipos liberados pelas chaves `CHAVES_TIPO_PRODUTO` (F2-B1; D43): valor da empresa ?? padrão do catálogo (`false`).
 * Mesma leitura no formulário, na API e na importação.
 */
export async function tiposHabilitados(db: DbEmpresa): Promise<TipoProduto[]> {
  const valores = await lerConfiguracoes(db, Object.values(CHAVES_TIPO_PRODUTO) as string[]);
  return tiposProdutoHabilitados((chave) => valores.get(chave) === true);
}

/** Validações com o banco; junta tudo num 422 por campo (ERP 1.8). */
export async function validarNoBanco(
  tx: DbEmpresa,
  d: CriarProduto,
  id: string | null,
  antes: ProdutoAntes | null,
  opcoes: { ncmOpcional?: boolean } = {},
): Promise<void> {
  const campos: Campos = {};
  const existe = async (consulta: ReturnType<typeof sql>) =>
    ((await tx.execute<Linha>(consulta)).rows[0] as Linha | undefined) ?? null;

  const unidade = await existe(
    sql`select id, sigla, permite_fracao from unidades_medida where id = ${d.unidadeId} and excluido_em is null and ativo`,
  );
  if (!unidade) add(campos, 'unidadeId', 'Unidade inexistente ou inativa');
  if (
    d.marcaId &&
    !(await existe(sql`select 1 from marcas where id = ${d.marcaId} and excluido_em is null`))
  ) {
    add(campos, 'marcaId', 'Marca inexistente');
  }
  const categorias = [
    ...new Set([...d.categorias, ...(d.categoriaPrincipalId ? [d.categoriaPrincipalId] : [])]),
  ];
  if (categorias.length) {
    const { rows } = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from categorias where excluido_em is null and id in (${sql.join(
        categorias.map((c) => sql`${c}::uuid`),
        sql`, `,
      )})`,
    );
    if (rows[0]!.n !== categorias.length) add(campos, 'categorias', 'Categoria inexistente');
  }

  // Produtos relacionados (8.2.8; F2-B12): existentes e diferentes do próprio produto (`ck_produtos_relacionados_proprio`).
  const relacionados = d.relacionados ?? [];
  if (relacionados.length) {
    const ids = [...new Set(relacionados.map((r) => r.relacionadoId.toLowerCase()))];
    const { rows } = await tx.execute<{ id: string; codigo: number; nome: string }>(sql`
      select id, codigo, nome from produtos where excluido_em is null and id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const existentes = new Map(rows.map((r) => [r.id, r]));
    // "Criar relação inversa" grava no outro produto: ele não pode passar do teto (MAXIMO_RELACIONADOS), senão nunca
    // mais grava pelo formulário (que manda a lista inteira). A inversa que já existe não conta (a API a pula).
    const comInversa = ids.filter((alvo) =>
      relacionados.some((r) => r.criarInversa && r.relacionadoId.toLowerCase() === alvo),
    );
    const vivas = new Map<string, { n: number; tipos: string[] }>();
    if (comInversa.length) {
      const r = await tx.execute<{ alvo: string; n: number; tipos: string[] }>(sql`
        select produto_id as alvo, count(*)::int as n,
               coalesce(array_agg(tipo) filter (where relacionado_id = ${id}::uuid), '{}') as tipos
          from produtos_relacionados
         where excluido_em is null and produto_id = any(${`{${comInversa.join(',')}}`}::uuid[])
         group by produto_id`);
      for (const l of r.rows) vivas.set(l.alvo, { n: l.n, tipos: l.tipos });
    }
    relacionados.forEach((r, i) => {
      const alvo = r.relacionadoId.toLowerCase();
      const outro = existentes.get(alvo);
      if (id && alvo === id.toLowerCase())
        add(campos, `relacionados.${i}.relacionadoId`, 'O produto não pode ser relacionado a si mesmo');
      else if (!outro) add(campos, `relacionados.${i}.relacionadoId`, 'Produto inexistente');
      else if (r.criarInversa) {
        const v = vivas.get(alvo) ?? { n: 0, tipos: [] };
        if (v.tipos.includes(r.tipo)) return;
        if (v.n >= MAXIMO_RELACIONADOS)
          add(
            campos,
            `relacionados.${i}.criarInversa`,
            `O produto ${outro.codigo} - ${outro.nome} já tem ${MAXIMO_RELACIONADOS} produtos relacionados: remova algum dele para criar a inversa`,
          );
        // Duas linhas para o mesmo outro produto (tipos diferentes) somam.
        vivas.set(alvo, { n: v.n + 1, tipos: [...v.tipos, r.tipo] });
      }
    });
  }

  // Fornecedores (8.2.14; F2-B13): a pessoa existe; o vínculo novo, ou que troca de pessoa, exige a pessoa não excluída
  // e com a categoria Fornecedor. O gravado (mesmo id, mesma pessoa) continua gravável se a pessoa perdeu a categoria
  // ou foi excluída depois (a exclusão da pessoa não mexe nos vínculos): mudar o preço não obriga a mexer no vínculo.
  const fornecedores = d.fornecedores ?? [];
  if (fornecedores.length) {
    const ids = [...new Set(fornecedores.map((f) => f.fornecedorId.toLowerCase()))];
    const { rows } = await tx.execute<{ id: string; excluida: boolean; fornecedor: boolean }>(sql`
      select p.id, p.excluido_em is not null as excluida,
             exists (select 1 from pessoas_categorias c where c.pessoa_id = p.id and c.categoria = 'fornecedor'
                        and c.excluido_em is null) as fornecedor
        from pessoas p where p.id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const pessoasPorId = new Map(rows.map((r) => [r.id, r]));
    const gravados = id
      ? (
          await tx.execute<{ id: string; fornecedor_id: string }>(sql`
            select id, fornecedor_id from produtos_fornecedores where produto_id = ${id} and excluido_em is null`)
        ).rows
      : [];
    fornecedores.forEach((f, i) => {
      const pessoa = pessoasPorId.get(f.fornecedorId.toLowerCase());
      const gravado = gravados.some((g) => g.id === f.id?.toLowerCase() && g.fornecedor_id === pessoa?.id);
      if (!pessoa) add(campos, `fornecedores.${i}.fornecedorId`, 'Fornecedor inexistente: remova a linha');
      else if (gravado) return;
      else if (pessoa.excluida)
        add(campos, `fornecedores.${i}.fornecedorId`, 'Fornecedor excluído: remova a linha');
      else if (!pessoa.fornecedor)
        add(campos, `fornecedores.${i}.fornecedorId`, 'A pessoa não tem a categoria Fornecedor');
    });
  }

  // NCM (MD 3.6.3): existente e vigente; obrigatório quando alguma loja ativa emite documento fiscal (8.2.1).
  const fiscal = !['kit', 'servico'].includes(d.tipo);
  if (d.ncm) {
    if (!(await existe(sql`select 1 where ${ncmVigente(d.ncm)}`))) {
      add(campos, 'ncm', 'NCM inexistente na tabela vigente');
    }
  } else if (fiscal && d.tipo !== 'materia_prima' && !opcoes.ncmOpcional) {
    const emite = await existe(
      sql`select 1 from lojas where ativa and excluido_em is null and tipo_emissao <> 'nao_fiscal' limit 1`,
    );
    if (emite) add(campos, 'ncm', 'NCM obrigatório: há loja que emite documento fiscal');
  }
  for (const campo of ['cfopVendaEstado', 'cfopVendaForaEstado'] as const) {
    const cfop = d[campo];
    if (cfop && !(await existe(sql`select 1 from cfops where codigo = ${cfop} and excluido_em is null`))) {
      add(campos, campo, 'CFOP inexistente');
    }
  }

  // Tributação só gravada (F2-B52; nada fiscal até a fase fiscal): só as FKs e os CHECKs que já existem no banco, com
  // a mensagem no campo em vez do 422 genérico do 23503/23514.
  // Unidade tributável (`fk_produtos_unidade_tributavel_id`): existente; a nova (diferente da gravada) também ativa,
  // como a unidade do produto. A gravada que ficou inativa continua gravável (mudar outro campo não obriga a trocá-la).
  if (
    d.unidadeTributavelId &&
    !(await existe(sql`
      select 1 from unidades_medida where id = ${d.unidadeTributavelId} and excluido_em is null
         and (ativo or id = (select unidade_tributavel_id from produtos where id = ${id}::uuid))`))
  )
    add(campos, 'unidadeTributavelId', 'Unidade inexistente ou inativa');
  // `ck_produtos_is` sobre o valor que fica: o campo ausente mantém o gravado.
  const gravadoIs = id
    ? await existe(sql`select is_aliquota_especifica, is_unidade from produtos where id = ${id}`)
    : null;
  const especifica =
    d.isAliquotaEspecifica === undefined
      ? (gravadoIs?.is_aliquota_especifica ?? null)
      : d.isAliquotaEspecifica;
  const unidadeIs = d.isUnidade === undefined ? (gravadoIs?.is_unidade ?? null) : d.isUnidade;
  if (especifica !== null && unidadeIs === null)
    add(campos, 'isUnidade', 'Informe a unidade da alíquota específica');
  // Tributação por UF: a UF (`fk_produtos_tributacao_uf_uf`) e o CFOP (`fk_..._cfop_venda_estado`) existentes.
  const tributacaoUf = d.tributacaoUf ?? [];
  if (tributacaoUf.length) {
    const { rows: ufsExistentes } = await tx.execute<{ sigla: string }>(sql`
      select sigla from ufs where excluido_em is null and sigla = any(${`{${tributacaoUf.map((t) => t.uf).join(',')}}`}::text[])`);
    const cfopsUf = [...new Set(tributacaoUf.map((t) => t.cfopVendaEstado).filter((c) => c !== null))];
    const { rows: cfopsExistentes } = cfopsUf.length
      ? await tx.execute<{ codigo: string }>(sql`
          select codigo from cfops where excluido_em is null
             and codigo = any(${`{${cfopsUf.join(',')}}`}::text[])`)
      : { rows: [] };
    tributacaoUf.forEach((t, i) => {
      if (!ufsExistentes.some((u) => u.sigla === t.uf)) add(campos, `tributacaoUf.${i}.uf`, 'UF inexistente');
      if (t.cfopVendaEstado && !cfopsExistentes.some((c) => c.codigo === t.cfopVendaEstado))
        add(campos, `tributacaoUf.${i}.cfopVendaEstado`, 'CFOP inexistente');
    });
  }

  // Tipos sem suporte (F2-B1; D43): só passa o tipo já gravado (legado do Nuvem3); criar ou trocar para ele, não.
  const tipoBloqueado = motivoTipoProdutoBloqueado(d.tipo, antes?.tipo ?? null, await tiposHabilitados(tx));
  if (tipoBloqueado) add(campos, 'tipo', tipoBloqueado);
  if (antes?.tipo === 'com_variacoes' && d.tipo !== 'com_variacoes' && antes.variacoesAtivas) {
    add(campos, 'tipo', 'O produto tem variações ativas: inative as variações antes de trocar o tipo');
  }

  // Complementos (8.2.16; F2-B51). Sair de "Com complementos" com grupos vivos exige mandar a lista (vazia = exclui os
  // grupos): o corpo sem a lista (a importação, o ERP antigo) manteria grupos num produto que não os usa.
  if (
    antes?.tipo === 'com_complementos' &&
    d.tipo !== 'com_complementos' &&
    d.gruposComplementos === undefined &&
    id &&
    (await existe(
      sql`select 1 from produtos_grupos_complementos where produto_id = ${id} and excluido_em is null limit 1`,
    ))
  )
    add(
      campos,
      'tipo',
      'O produto tem grupos de complementos: exclua-os no modal Complementos antes de trocar o tipo',
    );
  // O produto que é complemento ativo de outro só troca para um tipo que pode ser complemento.
  if (antes && id && antes.tipo !== d.tipo && !TIPOS_COMPLEMENTO_VINCULADO.includes(d.tipo)) {
    const de = await complementoDe(tx, id);
    if (de.length)
      add(
        campos,
        'tipo',
        `O produto é complemento de ${de.map((p) => `${p.codigo} - ${p.nome}`).join(', ')}: retire-o dos complementos antes de trocar para ${ROTULOS_TIPO_PRODUTO[d.tipo]}`,
      );
  }

  // Troca de tipo com movimento (8.2.1). "Com variações" sem grade só movimentou o pai: troca como Simples (F2-B1).
  if (antes && antes.tipo !== d.tipo && antes.temMovimento) {
    const tipoAntes = antes.tipo === 'com_variacoes' && !antes.movimentoComVariacao ? 'simples' : antes.tipo;
    const compativel =
      TIPOS_TROCA_COM_MOVIMENTO.includes(tipoAntes) &&
      TIPOS_TROCA_COM_MOVIMENTO.includes(d.tipo) &&
      !(d.tipo === 'servico' && antes.saldoNaoZero);
    if (!compativel) {
      add(
        campos,
        'tipo',
        `O produto já tem movimento de estoque: só troca entre Simples, Matéria-prima e Serviço (sem saldo)`,
      );
    }
  }

  // Vasilhame (8.2.6; `ck_produtos_vasilhame`): o alvo é um casco.
  if (d.vasilhameProdutoId) {
    const casco = await existe(
      sql`select tipo from produtos where id = ${d.vasilhameProdutoId} and excluido_em is null`,
    );
    if (!casco || casco.tipo !== 'vasilhame' || d.vasilhameProdutoId === id) {
      add(campos, 'vasilhameProdutoId', 'Escolha um produto do tipo Vasilhame (casco)');
    }
  }

  // Grupo de preço (8.2.9; MD 3.6.13): mesmo tipo/unidade dos demais membros, não fracionado.
  if (d.grupoPrecoQuantidadeId) {
    const g = await existe(
      sql`select id from grupos_preco_quantidade where id = ${d.grupoPrecoQuantidadeId} and excluido_em is null`,
    );
    if (!g) add(campos, 'grupoPrecoQuantidadeId', 'Grupo de preço inexistente');
    else if (TIPOS_GRUPO_PRECO.includes(d.tipo) && !d.permiteFracao) {
      const outro = await existe(sql`
        select p.nome, u.sigla from produtos p join unidades_medida u on u.id = p.unidade_id
         where p.grupo_preco_quantidade_id = ${d.grupoPrecoQuantidadeId} and p.excluido_em is null
           and p.unidade_id <> ${d.unidadeId} and p.id is distinct from ${id}::uuid
         limit 1`);
      if (outro) {
        add(
          campos,
          'grupoPrecoQuantidadeId',
          `Os membros do grupo usam a unidade ${outro.sigla as string} (ex.: ${outro.nome as string})`,
        );
      }
    }
  }

  // Posições do combo e insumos da ficha técnica (MD 3.6.7).
  const idsComp = [
    ...new Set(d.componentes.flatMap((c) => [c.componenteId, ...c.alternativas.map((a) => a.produtoId)])),
  ];
  if (idsComp.length) {
    const { rows } = await tx.execute<Linha>(sql`
      select id, nome, tipo, ativo from produtos
       where excluido_em is null and id in (${sql.join(
         idsComp.map((c) => sql`${c}::uuid`),
         sql`, `,
       )})`);
    const porId = new Map(rows.map((r) => [r.id as string, r]));
    const variacoes = d.componentes.flatMap((c) => [
      c.componenteVariacaoId ? { produto: c.componenteId, variacao: c.componenteVariacaoId } : null,
      ...c.alternativas.map((a) => (a.variacaoId ? { produto: a.produtoId, variacao: a.variacaoId } : null)),
    ]);
    const idsVar = variacoes.filter((v) => v !== null).map((v) => v.variacao);
    const variacoesValidas = new Set<string>();
    if (idsVar.length) {
      const r = await tx.execute<Linha>(sql`
        select id, produto_id from produtos_variacoes where excluido_em is null and id in (${sql.join(
          idsVar.map((v) => sql`${v}::uuid`),
          sql`, `,
        )})`);
      for (const v of r.rows) variacoesValidas.add(`${v.produto_id as string}:${v.id as string}`);
    }
    const conferir = (
      caminho: string,
      produtoId: string,
      variacaoId: string | null,
      tipoLinha: 'kit' | 'ficha_tecnica',
      padrao = false,
    ) => {
      const p = porId.get(produtoId);
      if (!p) return add(campos, caminho, 'Produto inexistente');
      if (produtoId === id) return add(campos, caminho, 'O produto não pode ser componente de si mesmo');
      const tipo = p.tipo as TipoProduto;
      if (tipoLinha === 'kit' && TIPOS_PROIBIDOS_NO_COMBO.includes(tipo)) {
        return add(campos, caminho, `${ROTULOS_TIPO_PRODUTO[tipo]} não pode ser componente de combo`);
      }
      if (tipoLinha === 'ficha_tecnica' && !TIPOS_INSUMO_FICHA.includes(tipo)) {
        return add(campos, caminho, 'Insumo deve ser Matéria-prima ou Simples');
      }
      if (tipo === 'com_variacoes' && !variacaoId) return add(campos, caminho, 'Escolha a variação');
      // Padrão inativo deixaria o combo ativo invendável no PDV (alternativa inativa só vira aviso).
      if (padrao && tipoLinha === 'kit' && d.tipo === 'kit' && d.ativo && !p.ativo) {
        return add(campos, caminho, 'Produto inativo não pode ser o padrão da posição');
      }
      if (variacaoId && !variacoesValidas.has(`${produtoId}:${variacaoId}`)) {
        return add(campos, caminho, 'Variação inexistente para este produto');
      }
    };
    d.componentes.forEach((c, i) => {
      conferir(`componentes.${i}.componenteId`, c.componenteId, c.componenteVariacaoId, c.tipo, true);
      c.alternativas.forEach((a, j) =>
        conferir(`componentes.${i}.alternativas.${j}.produtoId`, a.produtoId, a.variacaoId, 'kit'),
      );
    });
  }

  // Unicidade: código interno e PLU (409 por campo, decisão 44).
  const conflitos: Campos = {};
  if (d.codigoInterno) {
    const outro = await existe(sql`select codigo, nome from produtos
      where lower(codigo_interno) = lower(${d.codigoInterno}) and excluido_em is null and id is distinct from ${id}::uuid`);
    if (outro)
      add(
        conflitos,
        'codigoInterno',
        `Já usado no produto ${outro.codigo as number} - ${outro.nome as string}`,
      );
  }
  if (d.balancaPlu !== null) {
    const outro = await existe(sql`select codigo, nome from produtos
      where balanca_plu = ${d.balancaPlu} and excluido_em is null and id is distinct from ${id}::uuid`);
    if (outro)
      add(
        conflitos,
        'balancaPlu',
        `PLU já usado no produto ${outro.codigo as number} - ${outro.nome as string}`,
      );
  }
  if (Object.keys(campos).length) {
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', { campos });
  }
  if (Object.keys(conflitos).length) {
    throw new ErroApi('CONFLITO', 'Já existe um produto com estes dados.', { campos: conflitos });
  }
}

/**
 * EAN duplicado (ERP 8.2 "Regras", MD 3.6.5): com `geral.ean_duplicado = 'bloquear'` recusa; com `avisar` pede a
 * confirmação do ERP (409 com `detalhes.eanDuplicado.confirmar = true`) e grava quando ela vem. Só os códigos
 * novos ou alterados neste produto contam (códigos já duplicados da migração não travam outras edições). O trigger
 * `tg_produtos_codigos_barras_ean_unico` repete a regra no banco.
 */
export async function conferirEanDuplicado(tx: DbEmpresa, d: CriarProduto, id: string | null): Promise<void> {
  const existentes = id
    ? (
        await tx.execute<{ codigo: string }>(
          sql`select codigo from produtos_codigos_barras where produto_id = ${id} and tipo = 'gtin' and excluido_em is null`,
        )
      ).rows.map((r) => r.codigo)
    : [];
  const novos = d.codigosBarras
    .map((c, i) => ({ ...c, i }))
    .filter((c) => c.tipo === 'gtin' && !existentes.includes(c.codigo));
  if (!novos.length) return;
  const { rows } = await tx.execute<Linha>(sql`
    select cb.codigo, p.id, p.codigo as produto_codigo, p.nome
      from produtos_codigos_barras cb join produtos p on p.id = cb.produto_id and p.excluido_em is null
     where cb.tipo = 'gtin' and cb.excluido_em is null and cb.produto_id is distinct from ${id}::uuid
       and cb.codigo in (${sql.join(
         novos.map((c) => sql`${c.codigo}`),
         sql`, `,
       )})`);
  if (!rows.length) return;
  const modo =
    (await lerConfiguracao<string>(tx, 'geral.ean_duplicado')) === 'avisar' ? 'avisar' : 'bloquear';
  if (modo === 'avisar' && d.confirmarEanDuplicado) return;
  const campos: Campos = {};
  const duplicados = novos
    .filter((c) => rows.some((r) => r.codigo === c.codigo))
    .map((c) => {
      const produtos = rows
        .filter((r) => r.codigo === c.codigo)
        .map((r) => ({ id: r.id as string, codigo: Number(r.produto_codigo), nome: r.nome as string }));
      add(
        campos,
        `codigosBarras.${c.i}.codigo`,
        `O EAN ${c.codigo} já está no produto ${produtos[0]!.codigo} - ${produtos[0]!.nome}`,
      );
      return { codigo: c.codigo, produtos };
    });
  throw new ErroApi(
    'CONFLITO',
    modo === 'bloquear'
      ? 'EAN já cadastrado em outro produto.'
      : `O EAN ${duplicados[0]!.codigo} já está no produto ${duplicados[0]!.produtos[0]!.nome}. Gravar mesmo assim?`,
    { campos, detalhes: { eanDuplicado: { modo, confirmar: modo === 'avisar', duplicados } } },
  );
}

/** Decimal (string do banco ou do zod) comparável: `'1.5000'` e `'1.50'` são o mesmo valor. */
const numeroOuNulo = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/**
 * Grava as filhas: as que vieram atualizadas/criadas, as que saíram excluídas logicamente. Sem `verCusto`, os valores
 * em R$ do ST retido do corpo são ignorados (D68: são custo; o gravado fica, como o `precoCusto`).
 */
export async function gravarFilhas(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  d: CriarProduto,
  categoriaPrincipal: string | null,
  verCusto: boolean,
): Promise<void> {
  const agora = new Date();
  const autor = { atualizadoPorId: sessao.usuarioId };
  const criar = { criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId };

  // Códigos de barras da unidade do produto (os das variações entram com a Fase 2 e ficam como estão).
  const cbs = await tx
    .select({ id: produtosCodigosBarras.id, codigo: produtosCodigosBarras.codigo })
    .from(produtosCodigosBarras)
    .where(
      and(
        eq(produtosCodigosBarras.produtoId, produtoId),
        isNull(produtosCodigosBarras.variacaoId),
        isNull(produtosCodigosBarras.excluidoEm),
      ),
    );
  const manterCb = new Set(
    d.codigosBarras.filter((c) => c.id && cbs.some((e) => e.id === c.id)).map((c) => c.id!),
  );
  const removerCb = cbs.filter((c) => !manterCb.has(c.id)).map((c) => c.id);
  if (removerCb.length)
    await tx
      .update(produtosCodigosBarras)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosCodigosBarras.id, removerCb));
  if (manterCb.size)
    await tx
      .update(produtosCodigosBarras)
      .set({ principal: false })
      .where(inArray(produtosCodigosBarras.id, [...manterCb]));
  for (const c of d.codigosBarras) {
    const { id, ...valores } = c;
    if (id && manterCb.has(id)) {
      await tx
        .update(produtosCodigosBarras)
        .set({ ...valores, ...autor })
        .where(eq(produtosCodigosBarras.id, id));
    } else {
      await tx.insert(produtosCodigosBarras).values({ ...valores, produtoId, ...criar });
    }
  }

  // Lojas (`loja_id` imutável: a linha é da loja). O ST retido (F2-B52) vem junto para saber se mudou.
  const lojas = await tx
    .select()
    .from(produtosLojas)
    .where(and(eq(produtosLojas.produtoId, produtoId), isNull(produtosLojas.excluidoEm)));
  const visiveis = (lojaId: string) => sessao.lojas === null || sessao.lojas.includes(lojaId);
  const removerLojas = lojas
    .filter((l) => visiveis(l.lojaId) && !d.lojas.some((x) => x.lojaId === l.lojaId))
    .map((l) => l.id);
  if (removerLojas.length)
    await tx
      .update(produtosLojas)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosLojas.id, removerLojas));
  for (const corpo of d.lojas) {
    // D68: quem não vê o custo não grava nem apaga os valores em R$ do ST (ausentes = mantêm o gravado, abaixo).
    const l = verCusto
      ? corpo
      : { ...corpo, ...Object.fromEntries(CAMPOS_ST_RETIDO_CUSTO.map((c) => [c, undefined])) };
    const atual = lojas.find((x) => x.lojaId === l.lojaId);
    const { lojaId: _lojaId, ...valores } = l;
    // ST retido preenchido à mão (F2-B52; MD 3.6.9): o campo ausente mantém o gravado (drizzle não grava `undefined`);
    // quando algum valor muda, `st_atualizado_em` marca a gravação e a NF-e de origem sai (os valores já não são os
    // dela). Repetir os valores de agora não conta (a importação e o cadastro em massa não mexem na data).
    const stMudou = CAMPOS_ST_RETIDO.some(
      (c) => l[c] !== undefined && numeroOuNulo(l[c]) !== numeroOuNulo(atual ? atual[c] : null),
    );
    const st = stMudou ? { stAtualizadoEm: agora, stNotaEntradaId: null } : {};
    if (atual)
      await tx
        .update(produtosLojas)
        .set({ ...valores, ...st, ...autor })
        .where(eq(produtosLojas.id, atual.id));
    else await tx.insert(produtosLojas).values({ ...l, ...st, produtoId, ...criar });
  }

  // Faixas de preço por quantidade: a faixa que mudou é excluída e recriada (o `exclude` de sobreposição não é
  // adiável; assim nenhuma ordem de UPDATE cria sobreposição transitória, e `loja_id` continua imutável).
  const faixas = await tx
    .select()
    .from(produtosPrecosQuantidade)
    .where(
      and(
        eq(produtosPrecosQuantidade.produtoId, produtoId),
        isNull(produtosPrecosQuantidade.variacaoId),
        isNull(produtosPrecosQuantidade.excluidoEm),
      ),
    );
  const igual = (a: (typeof faixas)[number], b: CriarProduto['precosQuantidade'][number]) =>
    a.lojaId === b.lojaId &&
    Number(a.quantidadeInicial) === Number(b.quantidadeInicial) &&
    (a.quantidadeFinal === null ? null : Number(a.quantidadeFinal)) ===
      (b.quantidadeFinal === null ? null : Number(b.quantidadeFinal)) &&
    Number(a.preco) === Number(b.preco);
  const manterFaixa = new Set(
    d.precosQuantidade
      .filter((f) => f.id && faixas.some((e) => e.id === f.id && igual(e, f)))
      .map((f) => f.id!),
  );
  // Faixa de loja fora das permitidas não vem no detalhe do restrito: é preservada (decisão 88).
  const removerFaixas = faixas
    .filter((f) => !manterFaixa.has(f.id) && (f.lojaId === null || visiveis(f.lojaId)))
    .map((f) => f.id);
  if (removerFaixas.length)
    await tx
      .update(produtosPrecosQuantidade)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosPrecosQuantidade.id, removerFaixas));
  const novasFaixas = d.precosQuantidade.filter((f) => !(f.id && manterFaixa.has(f.id)));
  if (novasFaixas.length) {
    await tx
      .insert(produtosPrecosQuantidade)
      .values(novasFaixas.map(({ id: _id, ...f }) => ({ ...f, produtoId, ...criar })));
  }

  // Categorias (N:N) com a principal.
  const cats = await tx
    .select({ id: produtosCategorias.id, categoriaId: produtosCategorias.categoriaId })
    .from(produtosCategorias)
    .where(and(eq(produtosCategorias.produtoId, produtoId), isNull(produtosCategorias.excluidoEm)));
  const desejadas = [...new Set([...(categoriaPrincipal ? [categoriaPrincipal] : []), ...d.categorias])];
  const sairam = cats.filter((c) => !desejadas.includes(c.categoriaId)).map((c) => c.id);
  if (sairam.length)
    await tx
      .update(produtosCategorias)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosCategorias.id, sairam));
  const ficam = cats.filter((c) => desejadas.includes(c.categoriaId));
  // Desliga a principal antiga antes de ligar a nova (`uq_produtos_categorias_principal`).
  await tx
    .update(produtosCategorias)
    .set({ principal: false, ...autor })
    .where(
      and(
        eq(produtosCategorias.produtoId, produtoId),
        eq(produtosCategorias.principal, true),
        isNull(produtosCategorias.excluidoEm),
        categoriaPrincipal ? sql`${produtosCategorias.categoriaId} <> ${categoriaPrincipal}` : undefined,
      ),
    );
  for (const categoriaId of desejadas.filter((c) => !cats.some((x) => x.categoriaId === c))) {
    await tx
      .insert(produtosCategorias)
      .values({ produtoId, categoriaId, principal: categoriaId === categoriaPrincipal, ...criar });
  }
  if (categoriaPrincipal && ficam.some((c) => c.categoriaId === categoriaPrincipal)) {
    await tx
      .update(produtosCategorias)
      .set({ principal: true, ...autor })
      .where(
        and(
          eq(produtosCategorias.produtoId, produtoId),
          eq(produtosCategorias.categoriaId, categoriaPrincipal),
          isNull(produtosCategorias.excluidoEm),
        ),
      );
  }

  // Posições do combo / insumos da ficha técnica e alternativas. Primeiro as exclusões (alternativas, depois
  // posições), depois as alterações e inclusões: os triggers de ciclo e de custo do combo rodam a cada linha.
  const comps = await tx
    .select({ id: produtosComponentes.id, tipo: produtosComponentes.tipo })
    .from(produtosComponentes)
    .where(and(eq(produtosComponentes.produtoId, produtoId), isNull(produtosComponentes.excluidoEm)));
  const manterComp = new Set(
    d.componentes
      .filter((c) => c.id && comps.some((e) => e.id === c.id && e.tipo === c.tipo))
      .map((c) => c.id!),
  );
  const alts = comps.length
    ? await tx
        .select({
          id: produtosComponentesAlternativas.id,
          componenteId: produtosComponentesAlternativas.componenteId,
        })
        .from(produtosComponentesAlternativas)
        .where(
          and(
            inArray(
              produtosComponentesAlternativas.componenteId,
              comps.map((c) => c.id),
            ),
            isNull(produtosComponentesAlternativas.excluidoEm),
          ),
        )
    : [];
  const altsDesejadas = new Set(
    d.componentes
      .filter((c) => c.id && manterComp.has(c.id))
      .flatMap((c) => c.alternativas.filter((a) => a.id).map((a) => `${c.id}:${a.id}`)),
  );
  const removerAlts = alts.filter((a) => !altsDesejadas.has(`${a.componenteId}:${a.id}`)).map((a) => a.id);
  if (removerAlts.length)
    await tx
      .update(produtosComponentesAlternativas)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosComponentesAlternativas.id, removerAlts));
  const removerComps = comps.filter((c) => !manterComp.has(c.id)).map((c) => c.id);
  if (removerComps.length)
    await tx
      .update(produtosComponentes)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosComponentes.id, removerComps));
  for (const [ordem, c] of d.componentes.entries()) {
    const { id, alternativas, ...valores } = c;
    const linha = { ...valores, ordem: valores.ordem || ordem, ...autor };
    let compId: string;
    if (id && manterComp.has(id)) {
      await tx.update(produtosComponentes).set(linha).where(eq(produtosComponentes.id, id));
      compId = id;
    } else {
      const [n] = await tx
        .insert(produtosComponentes)
        .values({ ...linha, produtoId, criadoPorId: sessao.usuarioId })
        .returning({ id: produtosComponentes.id });
      compId = n!.id;
    }
    for (const [ordemAlt, a] of alternativas.entries()) {
      const { id: altId, ...va } = a;
      const valoresAlt = { ...va, ordem: va.ordem || ordemAlt + 1, ...autor };
      if (altId && altsDesejadas.has(`${compId}:${altId}`)) {
        await tx
          .update(produtosComponentesAlternativas)
          .set(valoresAlt)
          .where(eq(produtosComponentesAlternativas.id, altId));
      } else {
        await tx
          .insert(produtosComponentesAlternativas)
          .values({ ...valoresAlt, componenteId: compId, criadoPorId: sessao.usuarioId });
      }
    }
  }
}

/** As imagens gravadas do produto (8.2.6; F2-B44): a foto principal e as da galeria, para `vincularImagensProduto`. */
export interface ImagensGravadas {
  foto: string | null;
  galeria: readonly string[];
}

/**
 * A foto e a galeria do produto (ERP 8.2.6; F2-B44; README da API › decisão 190), **antes** de gravar a linha (a FK de
 * `foto_principal_arquivo_id` só confere que o arquivo existe): cada id **novo** (diferente do gravado) tem de ser um
 * envio `produto_foto` desta empresa, vivo e ainda sem dono ou já deste produto (`vincularArquivo`, 422 no campo:
 * `fotoPrincipalArquivoId` ou `imagens.N`), e fica ligado ao produto (`registro_id`). O id que já estava gravado não é
 * conferido de novo (o arquivo é do produto). `antes` nulo = produto novo (o id já foi gerado por quem chama).
 */
export async function vincularImagensProduto(
  tx: DbEmpresa,
  produtoId: string,
  d: Pick<CriarProduto, 'fotoPrincipalArquivoId' | 'imagens'>,
  antes: ImagensGravadas | null,
): Promise<void> {
  const foto = d.fotoPrincipalArquivoId?.toLowerCase();
  if (foto && foto !== antes?.foto?.toLowerCase())
    await vincularArquivo(tx, foto, 'produto_foto', produtoId, 'fotoPrincipalArquivoId');
  const gravadas = new Set(antes?.galeria.map((g) => g.toLowerCase()));
  for (const [i, id] of (d.imagens ?? []).entries())
    if (!gravadas.has(id.toLowerCase()))
      await vincularArquivo(tx, id.toLowerCase(), 'produto_foto', produtoId, `imagens.${i}`);
}

/**
 * A galeria (`produtos_imagens`, ERP 8.2.6; F2-B44): `undefined` mantém as gravadas (a importação, o cadastro em massa
 * e o ERP antigo não mandam a lista). A linha é identificada pelo arquivo (`uq_produtos_imagens`): a que saiu é
 * excluída logicamente, a nova entra, a que ficou só atualiza a ordem (a posição na lista, 1, 2, 3…). O arquivo que
 * saiu fica guardado (o histórico mostra a troca). Os ids já passaram por `vincularImagensProduto`.
 */
export async function gravarImagens(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  imagens: CriarProduto['imagens'],
): Promise<void> {
  if (imagens === undefined) return;
  const atuais = await tx
    .select({ id: produtosImagens.id, arquivoId: produtosImagens.arquivoId, ordem: produtosImagens.ordem })
    .from(produtosImagens)
    .where(and(eq(produtosImagens.produtoId, produtoId), isNull(produtosImagens.excluidoEm)));
  const desejadas = imagens.map((i) => i.toLowerCase());
  const sair = atuais.filter((a) => !desejadas.includes(a.arquivoId)).map((a) => a.id);
  if (sair.length)
    await tx
      .update(produtosImagens)
      .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
      .where(inArray(produtosImagens.id, sair));
  for (const [i, arquivoId] of desejadas.entries()) {
    const atual = atuais.find((a) => a.arquivoId === arquivoId);
    if (!atual)
      await tx.insert(produtosImagens).values({
        produtoId,
        arquivoId,
        ordem: i + 1,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      });
    else if (atual.ordem !== i + 1)
      await tx
        .update(produtosImagens)
        .set({ ordem: i + 1, atualizadoPorId: sessao.usuarioId })
        .where(eq(produtosImagens.id, atual.id));
  }
}

/**
 * Tributação por UF (`produtos_tributacao_uf`, ERP 8.2.15; MD 3.6.9; F2-B52; README da API › decisão 195), só gravada:
 * `undefined` mantém as gravadas (a importação, o cadastro em massa, o "Definir NCM" e o ERP antigo não mandam a lista).
 * A linha é identificada pela UF (`uq_produtos_tributacao_uf`): a que saiu é excluída logicamente (o PDV recebe o
 * tombstone), a nova entra, a que ficou só é regravada quando algum valor mudou (sem versão nova à toa: a linha desce
 * ao PDV das lojas da UF).
 */
export async function gravarTributacaoUf(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  tributacaoUf: CriarProduto['tributacaoUf'],
): Promise<void> {
  if (tributacaoUf === undefined) return;
  const atuais = await tx
    .select()
    .from(produtosTributacaoUf)
    .where(and(eq(produtosTributacaoUf.produtoId, produtoId), isNull(produtosTributacaoUf.excluidoEm)));
  const sair = atuais.filter((a) => !tributacaoUf.some((t) => t.uf === a.uf)).map((a) => a.id);
  if (sair.length)
    await tx
      .update(produtosTributacaoUf)
      .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
      .where(inArray(produtosTributacaoUf.id, sair));
  for (const t of tributacaoUf) {
    const atual = atuais.find((a) => a.uf === t.uf);
    if (!atual) {
      await tx.insert(produtosTributacaoUf).values({
        ...t,
        produtoId,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      });
      continue;
    }
    const mudou = (Object.keys(t) as (keyof typeof t)[]).some((c) =>
      PERCENTUAIS_TRIBUTACAO_UF.has(c)
        ? numeroOuNulo(t[c]) !== numeroOuNulo(atual[c])
        : (t[c] ?? null) !== (atual[c] ?? null),
    );
    if (mudou)
      await tx
        .update(produtosTributacaoUf)
        .set({ ...t, atualizadoPorId: sessao.usuarioId })
        .where(eq(produtosTributacaoUf.id, atual.id));
  }
}

/** Colunas decimais da Tributação por UF (comparadas pelo valor: `'2.0000'` = `'2'`). */
const PERCENTUAIS_TRIBUTACAO_UF = new Set<string>([
  'icmsAliquota',
  'icmsReducaoBcPct',
  'icmsMvaPct',
  'icmsAliquotaSt',
  'fcpAliquota',
  'fcpStAliquota',
]);

/** Relação inversa gravada no outro produto pelo "Criar relação inversa" (para a auditoria dele). */
export interface RelacaoInversaCriada {
  produtoId: string;
  relacionadoId: string;
  tipo: string;
}

/**
 * Produtos relacionados (ERP 8.2.8; F2-B12; README da API › decisão 157). `undefined` mantém os gravados (a importação
 * e o ERP antigo não mandam a lista). A linha é identificada por (relacionado, tipo), a chave de
 * `uq_produtos_relacionados`: a que saiu é excluída logicamente antes das inclusões (trocar o tipo = excluir e
 * incluir), a que ficou só atualiza a ordem. Com `criarInversa`, grava no outro produto a relação para este, do mesmo
 * tipo, se ela ainda não existe; remover daqui nunca remove a inversa (cada sentido é do seu produto, ERP 8.2.8 "não é
 * automaticamente bidirecional"). As linhas descem ao PDV pelo fluxo de catálogo (`produtos_relacionados`).
 */
export async function gravarRelacionados(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  relacionados: CriarProduto['relacionados'],
): Promise<RelacaoInversaCriada[]> {
  if (relacionados === undefined) return [];
  const autor = { atualizadoPorId: sessao.usuarioId };
  const criar = { criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId };
  const chave = (relacionadoId: string, tipo: string) => `${relacionadoId.toLowerCase()}:${tipo}`;
  const atuais = await tx
    .select({
      id: produtosRelacionados.id,
      relacionadoId: produtosRelacionados.relacionadoId,
      tipo: produtosRelacionados.tipo,
      ordem: produtosRelacionados.ordem,
    })
    .from(produtosRelacionados)
    .where(and(eq(produtosRelacionados.produtoId, produtoId), isNull(produtosRelacionados.excluidoEm)));
  const desejados = new Map(
    relacionados.map((r, i) => [chave(r.relacionadoId, r.tipo), { ...r, ordem: r.ordem || i + 1 }]),
  );
  const sair = atuais.filter((a) => !desejados.has(chave(a.relacionadoId, a.tipo))).map((a) => a.id);
  if (sair.length)
    await tx
      .update(produtosRelacionados)
      .set({ excluidoEm: new Date(), ...autor })
      .where(inArray(produtosRelacionados.id, sair));
  for (const [k, r] of desejados) {
    const atual = atuais.find((a) => chave(a.relacionadoId, a.tipo) === k);
    if (!atual)
      await tx
        .insert(produtosRelacionados)
        .values({ produtoId, relacionadoId: r.relacionadoId, tipo: r.tipo, ordem: r.ordem, ...criar });
    else if (atual.ordem !== r.ordem)
      await tx
        .update(produtosRelacionados)
        .set({ ordem: r.ordem, ...autor })
        .where(eq(produtosRelacionados.id, atual.id));
  }
  const inversas: RelacaoInversaCriada[] = [];
  for (const r of desejados.values()) {
    if (!r.criarInversa) continue;
    const { rows } = await tx.execute<{ existe: boolean; ordem: number }>(sql`
      select exists (select 1 from produtos_relacionados
                      where produto_id = ${r.relacionadoId} and relacionado_id = ${produtoId} and tipo = ${r.tipo}
                        and excluido_em is null) as existe,
             (select coalesce(max(ordem), 0)::int + 1 from produtos_relacionados
               where produto_id = ${r.relacionadoId} and excluido_em is null) as ordem`);
    if (rows[0]!.existe) continue;
    await tx.insert(produtosRelacionados).values({
      produtoId: r.relacionadoId,
      relacionadoId: produtoId,
      tipo: r.tipo,
      ordem: rows[0]!.ordem,
      ...criar,
    });
    inversas.push({ produtoId: r.relacionadoId, relacionadoId: produtoId, tipo: r.tipo });
  }
  return inversas;
}

/** Vínculo de fornecedor tirado de outro produto pelo "mover vínculo" (para a auditoria dele). */
export interface VinculoFornecedorMovido {
  /** A linha de `produtos_fornecedores` do outro produto (excluída logicamente). */
  id: string;
  produtoId: string;
  fornecedorId: string;
  codigoFornecedor: string;
}

/**
 * Fornecedores do produto (ERP 8.2.14; MD 3.6.9; F2-B13; README da API › decisão 158). `undefined` mantém os gravados
 * (a importação, o ERP antigo e o formulário com o bloco escondido não mandam a lista). Cada linha do corpo casa com
 * uma gravada pelo `id` e, sem ele, pela chave (fornecedor, código no fornecedor): a referência digitada de novo que
 * já está neste produto é reaproveitada, sem conflito. As gravadas que não casaram saem (exclusão lógica) antes das
 * inclusões, e o código das que mudam de código é limpo antes, para uma troca de códigos entre duas linhas não colidir
 * em `uq_produtos_fornecedores_codigo`. (fornecedor, código) ligado a **outro** produto é o 409 `CONFLITO` com o
 * produto atual (`detalhes` = `DetalhesConflitoFornecedor`: o primeiro conflito e a lista de todos) e o campo
 * `fornecedores.N.codigoFornecedor` de cada linha; com `moverVinculo` o vínculo sai de lá (exige `produtos.editar`,
 * como a relação inversa do F2-B12: altera o outro cadastro). O último custo e a última compra nunca vêm do corpo; o
 * custo do fornecedor só com `verCusto` (sem ela, o gravado fica e a linha nova nasce sem custo). A linha com variação
 * (legado) não é tocada. Não desce ao PDV.
 */
export async function gravarFornecedores(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  fornecedores: CriarProduto['fornecedores'],
  verCusto: boolean,
): Promise<VinculoFornecedorMovido[]> {
  if (fornecedores === undefined) return [];
  const agora = new Date();
  const autor = { atualizadoPorId: sessao.usuarioId };
  const atuais = await tx
    .select({
      id: produtosFornecedores.id,
      fornecedorId: produtosFornecedores.fornecedorId,
      codigoFornecedor: produtosFornecedores.codigoFornecedor,
    })
    .from(produtosFornecedores)
    .where(
      and(
        eq(produtosFornecedores.produtoId, produtoId),
        isNull(produtosFornecedores.variacaoId),
        isNull(produtosFornecedores.excluidoEm),
      ),
    );
  // Casamento: primeiro pelo id, depois pela chave entre as que sobraram.
  const casadas = new Map<number, (typeof atuais)[number]>();
  const usadas = new Set<string>();
  fornecedores.forEach((f, i) => {
    const a = f.id ? atuais.find((x) => x.id === f.id && !usadas.has(x.id)) : undefined;
    if (a) {
      casadas.set(i, a);
      usadas.add(a.id);
    }
  });
  fornecedores.forEach((f, i) => {
    if (casadas.has(i)) return;
    const a = atuais.find(
      (x) => !usadas.has(x.id) && chaveFornecedorProduto(x) === chaveFornecedorProduto(f),
    );
    if (a) {
      casadas.set(i, a);
      usadas.add(a.id);
    }
  });

  // (fornecedor, código) já ligado a outro produto.
  const comCodigo = fornecedores
    .map((f, i) => ({ f, i }))
    .filter(
      (x): x is { f: typeof x.f & { codigoFornecedor: string }; i: number } => x.f.codigoFornecedor !== null,
    );
  const movidos: VinculoFornecedorMovido[] = [];
  if (comCodigo.length) {
    const pares = sql.join(
      comCodigo.map(({ f }) => sql`(${f.fornecedorId}::uuid, ${f.codigoFornecedor}::text)`),
      sql`, `,
    );
    const { rows } = await tx.execute<{
      id: string;
      produto_id: string;
      fornecedor_id: string;
      codigo_fornecedor: string;
      codigo: number;
      nome: string;
    }>(sql`
      select pf.id, pf.produto_id, pf.fornecedor_id, pf.codigo_fornecedor, o.codigo, o.nome
        from produtos_fornecedores pf
        join produtos o on o.id = pf.produto_id
       where pf.excluido_em is null and pf.produto_id <> ${produtoId}
         and (pf.fornecedor_id, pf.codigo_fornecedor) in (${pares})
       for update of pf`);
    const conflitos: ConflitoVinculoFornecedor[] = [];
    const sair: string[] = [];
    for (const r of rows) {
      const linha = comCodigo.find(
        (x) =>
          x.f.fornecedorId.toLowerCase() === r.fornecedor_id && x.f.codigoFornecedor === r.codigo_fornecedor,
      )!;
      // Produto excluído não tem vínculo vivo: o DELETE do produto exclui os vínculos junto.
      if (linha.f.moverVinculo) {
        sair.push(r.id);
        movidos.push({
          id: r.id,
          produtoId: r.produto_id,
          fornecedorId: r.fornecedor_id,
          codigoFornecedor: r.codigo_fornecedor,
        });
      } else
        conflitos.push({
          linha: linha.i,
          fornecedorId: r.fornecedor_id,
          codigoFornecedor: r.codigo_fornecedor,
          produto: { id: r.produto_id, codigo: r.codigo, nome: r.nome },
        });
    }
    if (conflitos.length) {
      conflitos.sort((a, b) => a.linha - b.linha);
      const c = conflitos[0]!;
      const detalhes = { ...c, conflitos } satisfies DetalhesConflitoFornecedor;
      throw new ErroApi(
        'CONFLITO',
        `O código "${c.codigoFornecedor}" deste fornecedor já está ligado ao produto ${c.produto.codigo} - ${c.produto.nome}.`,
        {
          campos: Object.fromEntries(
            conflitos.map((x) => [
              `fornecedores.${x.linha}.codigoFornecedor`,
              [`Já ligado ao produto ${x.produto.codigo} - ${x.produto.nome}`],
            ]),
          ),
          detalhes,
        },
      );
    }
    if (movidos.length && !sessao.permissoes.has('produtos.editar')) {
      const mensagem = 'Mover o vínculo altera o outro produto e exige "Produtos: Editar".';
      throw new ErroApi('SEM_PERMISSAO', mensagem, {
        campos: Object.fromEntries(
          comCodigo
            .filter((x) => x.f.moverVinculo)
            .map((x) => [`fornecedores.${x.i}.moverVinculo`, [mensagem]]),
        ),
      });
    }
    if (sair.length)
      await tx
        .update(produtosFornecedores)
        .set({ excluidoEm: agora, ...autor })
        .where(inArray(produtosFornecedores.id, sair));
  }

  const remover = atuais.filter((a) => !usadas.has(a.id)).map((a) => a.id);
  if (remover.length)
    await tx
      .update(produtosFornecedores)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosFornecedores.id, remover));
  const trocamCodigo = [...casadas].filter(
    ([i, a]) => a.codigoFornecedor !== null && a.codigoFornecedor !== fornecedores[i]!.codigoFornecedor,
  );
  if (trocamCodigo.length)
    await tx
      .update(produtosFornecedores)
      .set({ codigoFornecedor: null })
      .where(
        inArray(
          produtosFornecedores.id,
          trocamCodigo.map(([, a]) => a.id),
        ),
      );
  for (const [i, f] of fornecedores.entries()) {
    const valores = {
      fornecedorId: f.fornecedorId,
      codigoFornecedor: f.codigoFornecedor,
      eanFornecedor: f.eanFornecedor,
      unidadeCompra: f.unidadeCompra,
      fator: f.fator,
      principal: f.principal,
      ...(verCusto ? { custoFornecedor: f.custoFornecedor } : {}),
      ...autor,
    };
    const atual = casadas.get(i);
    if (atual)
      await tx.update(produtosFornecedores).set(valores).where(eq(produtosFornecedores.id, atual.id));
    else
      await tx.insert(produtosFornecedores).values({ ...valores, produtoId, criadoPorId: sessao.usuarioId });
  }
  return movidos;
}

/**
 * Lotes do bloco Validade (ERP 8.2.12; MD 3.6.9; F2-B17; README da API › decisão 162). O corpo traz **só os lotes novos
 * e os alterados** (`lotes`) e os excluídos (`lotesExcluidos`): o lote gravado que não vem fica como está, e ambos
 * ausentes não mudam nada (a importação e o ERP antigo não mandam as listas; os lotes que o recebimento criou não podem
 * sumir). Assim o teto do zod vale para o que muda numa gravação, e não para os lotes do produto, que só crescem. Só os
 * lotes vivos da unidade (sem variação) e de estoque permitido ao usuário (ou sem estoque) entram no casamento: os de
 * outros estoques não vêm no detalhe e ficam como estão (o id deles em `lotesExcluidos` é ignorado, como o de um lote
 * já excluído), e mandar um estoque fora dos permitidos é 403. Cada linha casa com uma gravada pelo `id` e, sem ele,
 * pela chave (estoque, lote) entre as que não vão ser excluídas: o lote digitado de novo é reaproveitado.
 *
 * Regras (422 por campo):
 * - o estoque do lote gravado não muda (`lotes.N.estoqueId`): trocar = excluir e criar outro (o trigger
 *   `tg_produtos_lotes_filtro_imutavel` repete a regra, mas como erro do banco);
 * - o estoque do lote novo é o vinculado de uma loja da empresa (o "Loja" da grade) ou nenhum;
 * - a linha não pode cair na (loja, lote) de um gravado que não veio no corpo (`lotes.N.lote`; o zod só vê o corpo);
 * - o fornecedor existe; o lote novo, ou que troca de pessoa, exige a pessoa não excluída e com a categoria Fornecedor
 *   (como em `gravarFornecedores`: o gravado continua gravável se a pessoa saiu depois);
 * - não se exclui lote com saldo em `saldos_lote`, com movimento no razão ou usado num acerto em rascunho (campo
 *   `lotes`): inativa-se. O saldo vem do razão e o estorno volta ao lote do movimento (F2-B6), então o lote com
 *   histórico fica.
 *
 * Os excluídos saem (exclusão lógica) antes das inclusões, e o texto das que mudam de texto passa por um valor
 * provisório antes, para uma troca de textos entre duas linhas não colidir em `uq_produtos_lotes`. A linha igual à
 * gravada não é regravada. Desce ao PDV (fluxo `catalogo`, filtrado pelo estoque da loja).
 */
export async function gravarLotes(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  lotes: CriarProduto['lotes'],
  excluidos: CriarProduto['lotesExcluidos'],
): Promise<void> {
  if (!lotes?.length && !excluidos?.length) return;
  const linhas = lotes ?? [];
  const agora = new Date();
  const autor = { atualizadoPorId: sessao.usuarioId };
  const permitidos = estoquesPermitidos(sessao, 'ver');
  const visivel = (e: string | null) => e === null || permitidos === null || permitidos.includes(e);
  if (linhas.some((l) => !visivel(l.estoqueId?.toLowerCase() ?? null)))
    throw ErroApi.semPermissao('Há lote de estoque fora dos seus estoques permitidos.');

  const { rows: gravados } = await tx.execute<{
    id: string;
    estoque_id: string | null;
    lote: string;
    validade: string | null;
    fabricacao: string | null;
    fornecedor_id: string | null;
    ativo: boolean;
  }>(sql`
    select id, estoque_id, lote, validade::text, fabricacao::text, fornecedor_id, ativo from produtos_lotes
     where produto_id = ${produtoId} and variacao_id is null and excluido_em is null
     order by id
       for update`);
  const atuais = gravados.filter((a) => visivel(a.estoque_id));
  const chaveAtual = (a: (typeof atuais)[number]) =>
    chaveLoteProduto({ estoqueId: a.estoque_id, lote: a.lote });
  const aExcluir = new Set((excluidos ?? []).map((id) => id.toLowerCase()));

  // Casamento: primeiro pelo id, depois pela chave entre as que sobraram (sem as que vão ser excluídas).
  const casadas = new Map<number, (typeof atuais)[number]>();
  const usadas = new Set<string>();
  linhas.forEach((l, i) => {
    const a = l.id ? atuais.find((x) => x.id === l.id!.toLowerCase() && !usadas.has(x.id)) : undefined;
    if (a) {
      casadas.set(i, a);
      usadas.add(a.id);
    }
  });
  linhas.forEach((l, i) => {
    if (casadas.has(i)) return;
    const a = atuais.find(
      (x) => !usadas.has(x.id) && !aExcluir.has(x.id) && chaveAtual(x) === chaveLoteProduto(l),
    );
    if (a) {
      casadas.set(i, a);
      usadas.add(a.id);
    }
  });
  const remover = atuais.filter((a) => aExcluir.has(a.id) && !usadas.has(a.id));

  const campos: Campos = {};
  // Estoque imutável (MD 3.6.9).
  linhas.forEach((l, i) => {
    const a = casadas.get(i);
    if (a && (l.estoqueId?.toLowerCase() ?? null) !== a.estoque_id)
      add(
        campos,
        `lotes.${i}.estoqueId`,
        'A loja do lote não muda depois de gravado: exclua o lote e crie outro',
      );
  });
  // A (loja, lote) final de cada linha não colide com um gravado que fica como está (fora do corpo).
  const ficam = new Set(atuais.filter((a) => !usadas.has(a.id) && !aExcluir.has(a.id)).map(chaveAtual));
  linhas.forEach((l, i) => {
    const estoqueId = casadas.get(i)?.estoque_id ?? l.estoqueId?.toLowerCase() ?? null;
    if (ficam.has(chaveLoteProduto({ estoqueId, lote: l.lote })))
      add(campos, `lotes.${i}.lote`, `O lote ${l.lote} já existe nesta loja`);
  });
  // Estoque do lote novo: o vinculado de uma loja.
  const novosEstoques = [
    ...new Set(
      linhas.filter((l, i) => !casadas.has(i) && l.estoqueId !== null).map((l) => l.estoqueId!.toLowerCase()),
    ),
  ];
  if (novosEstoques.length) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      select e.id from estoques e join lojas l on l.estoque_id = e.id and l.excluido_em is null
       where e.excluido_em is null and e.id = any(${`{${novosEstoques.join(',')}}`}::uuid[])`);
    const validos = new Set(rows.map((r) => r.id));
    linhas.forEach((l, i) => {
      if (!casadas.has(i) && l.estoqueId !== null && !validos.has(l.estoqueId.toLowerCase()))
        add(campos, `lotes.${i}.estoqueId`, 'Loja inexistente: escolha outra ou deixe "Todas as lojas"');
    });
  }
  // Fornecedor.
  const idsPessoa = [
    ...new Set(linhas.filter((l) => l.fornecedorId).map((l) => l.fornecedorId!.toLowerCase())),
  ];
  if (idsPessoa.length) {
    const { rows } = await tx.execute<{ id: string; excluida: boolean; fornecedor: boolean }>(sql`
      select p.id, p.excluido_em is not null as excluida,
             exists (select 1 from pessoas_categorias c where c.pessoa_id = p.id and c.categoria = 'fornecedor'
                        and c.excluido_em is null) as fornecedor
        from pessoas p where p.id = any(${`{${idsPessoa.join(',')}}`}::uuid[])`);
    const pessoas = new Map(rows.map((r) => [r.id, r]));
    linhas.forEach((l, i) => {
      if (!l.fornecedorId) return;
      const pessoa = pessoas.get(l.fornecedorId.toLowerCase());
      if (!pessoa) return add(campos, `lotes.${i}.fornecedorId`, 'Fornecedor inexistente');
      if (casadas.get(i)?.fornecedor_id === pessoa.id) return;
      if (pessoa.excluida) add(campos, `lotes.${i}.fornecedorId`, 'Fornecedor excluído');
      else if (!pessoa.fornecedor)
        add(campos, `lotes.${i}.fornecedorId`, 'A pessoa não tem a categoria Fornecedor');
    });
  }
  // Exclusão: só o lote sem saldo, sem movimento e fora de acerto em rascunho.
  if (remover.length) {
    const { rows } = await tx.execute<{
      id: string;
      lote: string;
      saldo: boolean;
      movimento: boolean;
      acerto: number | null;
    }>(sql`
      select l.id, l.lote,
             exists (select 1 from saldos_lote s where s.lote_id = l.id and s.quantidade <> 0) as saldo,
             exists (select 1 from movimentos_estoque m where m.lote_id = l.id) as movimento,
             (select min(a.codigo) from itens_acerto_estoque i join acertos_estoque a on a.id = i.acerto_id
               where i.lote_id = l.id and i.excluido_em is null and a.excluido_em is null
                 and a.status = 'rascunho') as acerto
        from produtos_lotes l where l.id = any(${`{${remover.map((a) => a.id).join(',')}}`}::uuid[])
       order by l.lote`);
    for (const r of rows) {
      if (r.saldo)
        add(campos, 'lotes', `O lote ${r.lote} tem saldo em estoque: não pode ser excluído (inative-o)`);
      else if (r.movimento)
        add(
          campos,
          'lotes',
          `O lote ${r.lote} já tem movimento de estoque: não pode ser excluído (inative-o)`,
        );
      else if (r.acerto !== null)
        add(
          campos,
          'lotes',
          `O lote ${r.lote} está no acerto Nº ${r.acerto} em rascunho: tire-o do acerto ou inative o lote`,
        );
    }
  }
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os lotes destacados.', { campos });

  if (remover.length)
    await tx
      .update(produtosLotes)
      .set({ excluidoEm: agora, ...autor })
      .where(
        inArray(
          produtosLotes.id,
          remover.map((a) => a.id),
        ),
      );
  // Texto provisório (≤ 30, único pelo id) para a troca de textos entre duas linhas.
  const trocamTexto = [...casadas].filter(([i, a]) => a.lote !== linhas[i]!.lote).map(([, a]) => a.id);
  if (trocamTexto.length)
    await tx.execute(sql`
      update produtos_lotes set lote = '~' || left(replace(id::text, '-', ''), 29)
       where id = any(${`{${trocamTexto.join(',')}}`}::uuid[])`);
  for (const [i, l] of linhas.entries()) {
    const valores = {
      lote: l.lote,
      validade: l.validade,
      fabricacao: l.fabricacao,
      fornecedorId: l.fornecedorId,
      ativo: l.ativo,
      ...autor,
    };
    const atual = casadas.get(i);
    // A linha igual à gravada não é regravada: cada UPDATE sobe a versão e desce de novo ao PDV.
    const igual =
      atual &&
      atual.lote === l.lote &&
      atual.validade === l.validade &&
      atual.fabricacao === l.fabricacao &&
      atual.fornecedor_id === (l.fornecedorId?.toLowerCase() ?? null) &&
      atual.ativo === l.ativo;
    if (igual) continue;
    if (atual) await tx.update(produtosLotes).set(valores).where(eq(produtosLotes.id, atual.id));
    else
      await tx
        .insert(produtosLotes)
        .values({ ...valores, produtoId, estoqueId: l.estoqueId, criadoPorId: sessao.usuarioId });
  }
}

/**
 * Grupos de complementos do produto (ERP 8.2.16; MD 3.6.8; F2-B51; README da API › decisão 194). `undefined` mantém os
 * gravados (a importação, o cadastro em massa e o ERP antigo não mandam a lista); o modal manda a lista inteira. Cada
 * grupo do corpo casa com um gravado deste produto pelo `id` (o id de outro produto, ou de um grupo excluído, vale como
 * grupo novo), e cada complemento casa pelo `id` dentro do **mesmo** grupo.
 *
 * **Nada é apagado** (a exclusão física é recusada por trigger, 0028): o grupo gravado que não veio é excluído
 * logicamente, com os complementos dele (`excluido_em` e `ativo = false`), e desce ao caixa como tombstone; o
 * complemento gravado que não veio no seu grupo é **inativado** (`ativo = false`), continua no detalhe e pode ser
 * reativado. Assim o caixa offline que tem o id de uma opção numa venda sempre a acha na nuvem.
 *
 * O produto vinculado (422 por campo, `gruposComplementos.N.complementos.M.produtoId`): existe e não está excluído, não
 * é o próprio produto, é de um tipo que pode ser complemento (`TIPOS_COMPLEMENTO_VINCULADO`) e, no complemento ativo,
 * está ativo; com a baixa de estoque, a quantidade é inteira quando o produto não permite fração (`quantidadeBaixa`).
 * O complemento gravado que não muda o vínculo nem a baixa não é conferido de novo: o produto que ficou inativo, ou
 * trocou de tipo depois, não trava a gravação do resto. A linha igual à gravada não é regravada (cada UPDATE sobe a
 * versão e desce de novo ao caixa).
 */
export async function gravarComplementos(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  grupos: CriarProduto['gruposComplementos'],
): Promise<void> {
  if (grupos === undefined) return;
  const agora = new Date();
  const autor = { atualizadoPorId: sessao.usuarioId };
  const criar = { criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId };
  const minusculo = (v: string | null) => v?.toLowerCase() ?? null;
  const { rows: gruposAtuais } = await tx.execute<{
    id: string;
    nome: string;
    minimo: number;
    maximo: number;
    obrigatorio: boolean;
    ordem: number;
  }>(sql`
    select id, nome, minimo, maximo, obrigatorio, ordem from produtos_grupos_complementos
     where produto_id = ${produtoId} and excluido_em is null
     order by id
       for update`);
  const { rows: itensAtuais } = gruposAtuais.length
    ? await tx.execute<{
        id: string;
        grupo_id: string;
        produto_id: string | null;
        descricao: string | null;
        preco_adicional: string;
        baixa_estoque: boolean;
        quantidade_baixa: string;
        ordem: number;
        ativo: boolean;
      }>(sql`
        select id, grupo_id, produto_id, descricao, preco_adicional::text as preco_adicional, baixa_estoque,
               quantidade_baixa::text as quantidade_baixa, ordem, ativo
          from produtos_complementos
         where excluido_em is null and grupo_id = any(${`{${gruposAtuais.map((g) => g.id).join(',')}}`}::uuid[])
         order by id
           for update`)
    : { rows: [] };

  // Casamento pelo id: o grupo entre os deste produto, o complemento entre os do grupo casado.
  const gruposCasados = new Map<number, (typeof gruposAtuais)[number]>();
  const gruposUsados = new Set<string>();
  grupos.forEach((g, i) => {
    const a = gruposAtuais.find((x) => x.id === minusculo(g.id) && !gruposUsados.has(x.id));
    if (a) {
      gruposCasados.set(i, a);
      gruposUsados.add(a.id);
    }
  });
  const itensCasados = new Map<string, (typeof itensAtuais)[number]>();
  const itensUsados = new Set<string>();
  grupos.forEach((g, i) => {
    const grupo = gruposCasados.get(i);
    if (!grupo) return;
    g.complementos.forEach((c, j) => {
      const a = itensAtuais.find(
        (x) => x.grupo_id === grupo.id && x.id === minusculo(c.id) && !itensUsados.has(x.id),
      );
      if (a) {
        itensCasados.set(`${i}:${j}`, a);
        itensUsados.add(a.id);
      }
    });
  });

  // O produto vinculado: só o do complemento novo ou que mudou o vínculo, a baixa ou foi reativado é conferido.
  const campos: Campos = {};
  const mantido = (
    i: number,
    j: number,
    c: NonNullable<CriarProduto['gruposComplementos']>[number]['complementos'][number],
  ) => {
    const a = itensCasados.get(`${i}:${j}`);
    return (
      !!a &&
      a.produto_id === minusculo(c.produtoId) &&
      a.baixa_estoque === c.baixaEstoque &&
      Number(a.quantidade_baixa) === Number(c.quantidadeBaixa) &&
      (a.ativo || !c.ativo)
    );
  };
  const vinculados = [
    ...new Set(
      grupos.flatMap((g, i) =>
        g.complementos.flatMap((c, j) => (c.produtoId && !mantido(i, j, c) ? [minusculo(c.produtoId)!] : [])),
      ),
    ),
  ];
  // A corrida com a exclusão ou a troca de tipo do vinculado (que travam a linha dele com `for update` e conferem o
  // `complementoDe` antes de gravar) não deixa um complemento ativo apontando para um produto excluído ou um combo:
  // as gravações do produto no ERP começam pela trava de ordenação 7300001 (`travaVersao`, MD 1.5), então uma espera
  // o commit da outra e já lê o estado novo. O `for share` garante o mesmo sem depender dela (um caminho futuro que
  // grave o produto sem a trava): esta espera o `for update` da outra e relê a linha (excluída: "Produto inexistente";
  // tipo novo: recusado). Só linhas de `produtos`, depois da trava de ordenação, sem ciclo com a do produto dono. O
  // complemento mantido não precisa dela: já está gravado e ativo, e o `complementoDe` da outra o vê.
  const { rows: produtosVinculados } = vinculados.length
    ? await tx.execute<{
        id: string;
        nome: string;
        tipo: TipoProduto;
        ativo: boolean;
        permite_fracao: boolean;
      }>(
        sql`select id, nome, tipo, ativo, permite_fracao from produtos
             where excluido_em is null and id = any(${`{${vinculados.join(',')}}`}::uuid[])
             order by id
               for share`,
      )
    : { rows: [] };
  const porId = new Map(produtosVinculados.map((p) => [p.id, p]));
  grupos.forEach((g, i) =>
    g.complementos.forEach((c, j) => {
      if (!c.produtoId || mantido(i, j, c)) return;
      const caminho = `gruposComplementos.${i}.complementos.${j}`;
      if (minusculo(c.produtoId) === produtoId.toLowerCase())
        return add(campos, `${caminho}.produtoId`, 'O produto não pode ser complemento de si mesmo');
      const p = porId.get(minusculo(c.produtoId)!);
      if (!p) return add(campos, `${caminho}.produtoId`, 'Produto inexistente');
      if (!TIPOS_COMPLEMENTO_VINCULADO.includes(p.tipo))
        return add(
          campos,
          `${caminho}.produtoId`,
          `${ROTULOS_TIPO_PRODUTO[p.tipo]} não pode ser complemento: use Simples, Matéria-prima ou Produzido, ou um complemento livre`,
        );
      if (c.ativo && !p.ativo) return add(campos, `${caminho}.produtoId`, `O produto ${p.nome} está inativo`);
      if (c.baixaEstoque && !p.permite_fracao && !Number.isInteger(Number(c.quantidadeBaixa)))
        add(
          campos,
          `${caminho}.quantidadeBaixa`,
          `O produto ${p.nome} não permite fração: informe uma quantidade inteira`,
        );
    }),
  );
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os complementos destacados.', { campos });

  // O grupo que saiu: excluído logicamente com os complementos (tombstone ao caixa).
  const sair = gruposAtuais.filter((g) => !gruposUsados.has(g.id)).map((g) => g.id);
  if (sair.length) {
    await tx
      .update(produtosComplementos)
      .set({ excluidoEm: agora, ativo: false, ...autor })
      .where(and(inArray(produtosComplementos.grupoId, sair), isNull(produtosComplementos.excluidoEm)));
    await tx
      .update(produtosGruposComplementos)
      .set({ excluidoEm: agora, ...autor })
      .where(inArray(produtosGruposComplementos.id, sair));
  }
  // O complemento que saiu do grupo que ficou: só inativado.
  const inativar = itensAtuais
    .filter((c) => gruposUsados.has(c.grupo_id) && !itensUsados.has(c.id) && c.ativo)
    .map((c) => c.id);
  if (inativar.length)
    await tx
      .update(produtosComplementos)
      .set({ ativo: false, ...autor })
      .where(inArray(produtosComplementos.id, inativar));

  for (const [i, g] of grupos.entries()) {
    const valores = {
      nome: g.nome,
      minimo: g.minimo,
      maximo: g.maximo,
      obrigatorio: g.obrigatorio,
      ordem: g.ordem || i + 1,
    };
    const atual = gruposCasados.get(i);
    let grupoId: string;
    if (atual) {
      grupoId = atual.id;
      const igual =
        atual.nome === valores.nome &&
        Number(atual.minimo) === valores.minimo &&
        Number(atual.maximo) === valores.maximo &&
        atual.obrigatorio === valores.obrigatorio &&
        Number(atual.ordem) === valores.ordem;
      if (!igual)
        await tx
          .update(produtosGruposComplementos)
          .set({ ...valores, ...autor })
          .where(eq(produtosGruposComplementos.id, atual.id));
    } else {
      const [n] = await tx
        .insert(produtosGruposComplementos)
        .values({ ...valores, produtoId, ...criar })
        .returning({ id: produtosGruposComplementos.id });
      grupoId = n!.id;
    }
    for (const [j, c] of g.complementos.entries()) {
      const item = {
        produtoId: c.produtoId,
        descricao: c.descricao,
        precoAdicional: c.precoAdicional,
        baixaEstoque: c.baixaEstoque,
        quantidadeBaixa: c.quantidadeBaixa,
        ordem: c.ordem || j + 1,
        ativo: c.ativo,
      };
      const a = itensCasados.get(`${i}:${j}`);
      if (!a) {
        await tx.insert(produtosComplementos).values({ ...item, grupoId, ...criar });
        continue;
      }
      const igual =
        a.produto_id === minusculo(item.produtoId) &&
        a.descricao === item.descricao &&
        Number(a.preco_adicional) === Number(item.precoAdicional) &&
        a.baixa_estoque === item.baixaEstoque &&
        Number(a.quantidade_baixa) === Number(item.quantidadeBaixa) &&
        Number(a.ordem) === item.ordem &&
        a.ativo === item.ativo;
      if (!igual)
        await tx
          .update(produtosComplementos)
          .set({ ...item, ...autor })
          .where(eq(produtosComplementos.id, a.id));
    }
  }
}

type Precos = Record<string, string | null>;

/** Linha de `produtos_historico_precos` a inserir. */
export type LinhaHistoricoPreco = typeof produtosHistoricoPrecos.$inferInsert;

/**
 * As linhas do histórico de preços (MD 3.6.10; ERP 8.2 "Alteração de preço") de um produto: uma por preço que mudou,
 * com a **origem** de quem mudou (F2-B15): o formulário passa `cadastro`, a importação de planilha `importacao`, o
 * recebimento `recebimento` com o id do documento em `origemId`, e a NF-e (F2-B21) `nota_entrada`. Antes a origem era
 * fixa em `cadastro`, e as cargas do Nuvem3 apareciam como alteração no cadastro. Separada de
 * `registrarHistoricoPrecos` para o documento de entrada juntar as linhas de vários produtos num `INSERT` por bloco.
 */
export function linhasHistoricoPrecos(
  usuarioId: string | null,
  produtoId: string,
  antes: { produto: Precos; lojas: Record<string, string | null> } | null,
  depois: { produto: Precos; lojas: Record<string, string | null> },
  origem: OrigemHistoricoPreco,
  origemId: string | null = null,
): LinhaHistoricoPreco[] {
  const linhas: LinhaHistoricoPreco[] = [];
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  for (const [tipoPreco, novo] of Object.entries(depois.produto)) {
    const anterior = antes?.produto[tipoPreco] ?? null;
    if (num(anterior) === num(novo) || (antes === null && num(novo) === null)) continue;
    linhas.push({
      produtoId,
      tipoPreco,
      valorAnterior: anterior,
      valorNovo: novo,
      origem,
      origemId,
      usuarioId,
    });
  }
  const lojas = new Set([...Object.keys(antes?.lojas ?? {}), ...Object.keys(depois.lojas)]);
  for (const lojaId of lojas) {
    const anterior = antes?.lojas[lojaId] ?? null;
    const novo = depois.lojas[lojaId] ?? null;
    if (num(anterior) === num(novo)) continue;
    linhas.push({
      produtoId,
      lojaId,
      tipoPreco: 'loja',
      valorAnterior: anterior,
      valorNovo: novo,
      origem,
      origemId,
      usuarioId,
    });
  }
  return linhas;
}

/** Faixa de preço por quantidade vigente, como o histórico a compara (`PrecosFilhos`). */
interface FaixaHistorico {
  id: string;
  variacaoId: string | null;
  lojaId: string | null;
  preco: string;
}

/**
 * Os preços das filhas que o histórico acompanha (F2-B37; MD 3.6.10), lidos do banco antes e depois do "Gravar": as
 * **faixas por quantidade** vigentes, pela chave variação × loja × intervalo (o `numeric(15,3)` em texto tem sempre 3
 * casas, então a chave não depende de como a tela escreveu a quantidade), e o preço de venda e o de custo de cada
 * **variação** não excluída. Lidos do banco, e não da entrada, porque a gravação preserva o que o usuário não vê (a
 * faixa de loja fora das permitidas, decisão 88) e as variações ainda não são editadas pelo formulário (F2-B48): só o
 * que de fato mudou vira linha.
 */
export interface PrecosFilhos {
  faixas: Map<string, FaixaHistorico>;
  variacoes: Map<string, { venda: string | null; custo: string | null }>;
}

/** As faixas e as variações gravadas do produto, numa ida ao banco (`PrecosFilhos`). */
export async function precosFilhosGravados(tx: DbEmpresa, produtoId: string): Promise<PrecosFilhos> {
  const { rows } = await tx.execute<{
    k: 'f' | 'v';
    id: string;
    variacao_id: string | null;
    loja_id: string | null;
    qi: string | null;
    qf: string | null;
    venda: string | null;
    custo: string | null;
  }>(sql`
    select 'f' as k, id, variacao_id, loja_id, quantidade_inicial::text as qi, quantidade_final::text as qf,
           preco::text as venda, null::text as custo
      from produtos_precos_quantidade where produto_id = ${produtoId} and excluido_em is null
    union all
    select 'v', id, null, null, null, null, preco_venda::text, preco_custo::text
      from produtos_variacoes where produto_id = ${produtoId} and excluido_em is null`);
  const faixas = new Map<string, FaixaHistorico>();
  const variacoes = new Map<string, { venda: string | null; custo: string | null }>();
  for (const r of rows) {
    if (r.k === 'v') variacoes.set(r.id, { venda: r.venda, custo: r.custo });
    else
      faixas.set(`${r.variacao_id ?? ''}|${r.loja_id ?? ''}|${r.qi}|${r.qf ?? ''}`, {
        id: r.id,
        variacaoId: r.variacao_id,
        lojaId: r.loja_id,
        preco: r.venda!,
      });
  }
  return { faixas, variacoes };
}

/**
 * As linhas do histórico das filhas (F2-B37): uma `quantidade` por faixa criada (anterior nulo), removida (novo nulo)
 * ou com o preço trocado no mesmo intervalo, com a `loja_id` e a `variacao_id` da faixa; e uma `venda`/`custo` com a
 * `variacao_id` por preço de variação que mudou. A faixa não tem coluna própria no histórico (sem migração): **na
 * linha `quantidade`, `origem_id` é a faixa** (`produtos_precos_quantidade.id`, a atual, ou a removida, que fica com
 * `excluido_em`), de onde a consulta tira o intervalo. Nenhum documento muda faixa (o recebimento e a NF-e mudam o
 * preço de venda, o de custo e o da loja), então o `origem_id` do documento não se confunde com ela.
 */
export function linhasHistoricoFilhos(
  usuarioId: string | null,
  produtoId: string,
  antes: PrecosFilhos | null,
  depois: PrecosFilhos,
  origem: OrigemHistoricoPreco,
): LinhaHistoricoPreco[] {
  const linhas: LinhaHistoricoPreco[] = [];
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const chaves = new Set([...(antes?.faixas.keys() ?? []), ...depois.faixas.keys()]);
  for (const chave of chaves) {
    const a = antes?.faixas.get(chave);
    const d = depois.faixas.get(chave);
    if (num(a?.preco) === num(d?.preco)) continue;
    const faixa = (d ?? a)!;
    linhas.push({
      produtoId,
      variacaoId: faixa.variacaoId,
      lojaId: faixa.lojaId,
      tipoPreco: 'quantidade',
      valorAnterior: a?.preco ?? null,
      valorNovo: d?.preco ?? null,
      origem,
      origemId: faixa.id,
      usuarioId,
    });
  }
  for (const [variacaoId, d] of depois.variacoes) {
    const a = antes?.variacoes.get(variacaoId);
    for (const tipoPreco of ['venda', 'custo'] as const) {
      const anterior = a?.[tipoPreco] ?? null;
      const novo = d[tipoPreco];
      if (num(anterior) === num(novo)) continue;
      linhas.push({
        produtoId,
        variacaoId,
        tipoPreco,
        valorAnterior: anterior,
        valorNovo: novo,
        origem,
        origemId: null,
        usuarioId,
      });
    }
  }
  return linhas;
}

/**
 * Histórico de preços de um produto com a origem de quem mudou (`linhasHistoricoPrecos`), e o das filhas
 * (`linhasHistoricoFilhos`: as faixas e as variações) quando quem chama passa os `PrecosFilhos` de antes e de depois.
 */
export async function registrarHistoricoPrecos(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  antes: { produto: Precos; lojas: Record<string, string | null> } | null,
  depois: { produto: Precos; lojas: Record<string, string | null> },
  origem: OrigemHistoricoPreco,
  filhos?: { antes: PrecosFilhos | null; depois: PrecosFilhos },
): Promise<void> {
  const linhas = [
    ...linhasHistoricoPrecos(sessao.usuarioId, produtoId, antes, depois, origem),
    ...(filhos
      ? linhasHistoricoFilhos(sessao.usuarioId, produtoId, filhos.antes, filhos.depois, origem)
      : []),
  ];
  if (linhas.length) await tx.insert(produtosHistoricoPrecos).values(linhas);
}
