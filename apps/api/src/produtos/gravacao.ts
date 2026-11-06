/**
 * Regras do cadastro de produtos que dependem do banco (ERP 8.2, 8.2.17; MD 3.6.3–3.6.7, 3.6.13) e gravação das
 * filhas num só "Gravar" (códigos de barras, lojas, faixas, categorias, posições do combo/ficha técnica e
 * alternativas, produtos relacionados com a relação inversa, fornecedores, lotes do bloco Validade).
 */
import {
  CHAVES_TIPO_PRODUTO,
  chaveFornecedorProduto,
  chaveLoteProduto,
  MAXIMO_RELACIONADOS,
  motivoTipoProdutoBloqueado,
  tiposProdutoHabilitados,
  TIPOS_GRUPO_PRECO,
  TIPOS_INSUMO_FICHA,
  TIPOS_PROIBIDOS_NO_COMBO,
  TIPOS_TROCA_COM_MOVIMENTO,
  ROTULOS_TIPO_PRODUTO,
  type ConflitoVinculoFornecedor,
  type CriarProduto,
  type DetalhesConflitoFornecedor,
  type OrigemHistoricoPreco,
  type TipoProduto,
} from '@genesis/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao, lerConfiguracoes } from '../configuracoes/valores.js';
import {
  produtosCategorias,
  produtosCodigosBarras,
  produtosComponentes,
  produtosComponentesAlternativas,
  produtosFornecedores,
  produtosHistoricoPrecos,
  produtosLojas,
  produtosLotes,
  produtosPrecosQuantidade,
  produtosRelacionados,
} from '../database/empresa/schema/index.js';
import { estoquesPermitidos } from '../estoques/permitidos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
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

  // Tipos sem suporte (F2-B1; D43): só passa o tipo já gravado (legado do Nuvem3); criar ou trocar para ele, não.
  const tipoBloqueado = motivoTipoProdutoBloqueado(d.tipo, antes?.tipo ?? null, await tiposHabilitados(tx));
  if (tipoBloqueado) add(campos, 'tipo', tipoBloqueado);
  if (antes?.tipo === 'com_variacoes' && d.tipo !== 'com_variacoes' && antes.variacoesAtivas) {
    add(campos, 'tipo', 'O produto tem variações ativas: inative as variações antes de trocar o tipo');
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

/** Grava as filhas: as que vieram atualizadas/criadas, as que saíram excluídas logicamente. */
export async function gravarFilhas(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  d: CriarProduto,
  categoriaPrincipal: string | null,
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

  // Lojas (`loja_id` imutável: a linha é da loja).
  const lojas = await tx
    .select({ id: produtosLojas.id, lojaId: produtosLojas.lojaId })
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
  for (const l of d.lojas) {
    const atual = lojas.find((x) => x.lojaId === l.lojaId);
    const { lojaId: _lojaId, ...valores } = l;
    if (atual)
      await tx
        .update(produtosLojas)
        .set({ ...valores, ...autor })
        .where(eq(produtosLojas.id, atual.id));
    else await tx.insert(produtosLojas).values({ ...l, produtoId, ...criar });
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

/** Histórico de preços de um produto com a origem de quem mudou (`linhasHistoricoPrecos`). */
export async function registrarHistoricoPrecos(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  antes: { produto: Precos; lojas: Record<string, string | null> } | null,
  depois: { produto: Precos; lojas: Record<string, string | null> },
  origem: OrigemHistoricoPreco,
): Promise<void> {
  const linhas = linhasHistoricoPrecos(sessao.usuarioId, produtoId, antes, depois, origem);
  if (linhas.length) await tx.insert(produtosHistoricoPrecos).values(linhas);
}
