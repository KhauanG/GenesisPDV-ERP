/**
 * Banco da empresa da Fase 1A (cadastros base): referências e seed novos, e as regras que o banco garante sozinho —
 * EAN único entre produtos (MD 3.6.5), faixas de preço por quantidade sem sobreposição (3.6.9, 3.6.13), composição de
 * kit/ficha técnica sem ciclo (3.6.7), colunas de filtro imutáveis (6.4 regra 2), documentos de estoque imutáveis
 * (1.6, 3.7), versão nas tabelas novas (1.5) e exclusão lógica liberando a unicidade (1.4).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABELAS_COM_AUTORIA } from '../../src/database/empresa/versionamento.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let banco: string;
let un: string;
let loja1: string;
let loja2: string;

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  emp = await amb.criarEmpresa();
  banco = emp.nomeBanco;
  [{ id: un }] = (await consultar<{ id: string }>(
    banco,
    "select id from unidades_medida where sigla = 'UN' and excluido_em is null",
  )) as [{ id: string }];
  loja1 = await criarLoja(banco, 1, 'Loja 1');
  loja2 = await criarLoja(banco, 2, 'Loja 2');
});

afterAll(async () => {
  await amb?.fechar();
});

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const colunas = ['nome', 'unidade_id', ...Object.keys(extra)];
  const valores = [nome, un, ...Object.values(extra)];
  const [p] = await consultar<{ id: string }>(
    banco,
    `insert into produtos (${colunas.join(', ')}) values (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    valores,
  );
  return p!.id;
}

async function codigoBarras(produtoId: string, codigo: string, extra: Record<string, unknown> = {}) {
  const colunas = ['produto_id', 'codigo', ...Object.keys(extra)];
  const valores = [produtoId, codigo, ...Object.values(extra)];
  const [r] = await consultar<{ id: string }>(
    banco,
    `insert into produtos_codigos_barras (${colunas.join(', ')})
     values (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    valores,
  );
  return r!.id;
}

const erroBanco = (mensagem: string) => ({ message: mensagem });

describe('referências e seed da Fase 1A (MD 7.2, 7.12; docs/fiscal/nfce-parana.md)', () => {
  it('NCM completo, Brasil em paises e a linha do PR em parametros_fiscais_uf com os valores confirmados', async () => {
    const [ncm] = await consultar<{ n: number; cerveja: string | null }>(
      banco,
      "select count(*)::int as n, max(descricao) filter (where codigo = '22030000') as cerveja from ncms where excluido_em is null",
    );
    expect(ncm!.n).toBeGreaterThan(10_000);
    expect(ncm!.cerveja).toMatch(/Cervejas de malte/);
    expect(await consultar(banco, 'select codigo_bacen, nome from paises')).toEqual([
      { codigo_bacen: '1058', nome: 'Brasil' },
    ]);
    const [pr] = await consultar(
      banco,
      `select autorizador, prazo_cancelamento_min, prazo_cancelamento_substituicao_h, prazo_transmissao_contingencia_h,
         inutilizacao_prazo_dia, identificacao_obrigatoria_valor, nfce_valor_maximo, regimes_dispensados_nfce,
         modalidades_contingencia_nfce, qrcode_versoes_aceitas, csc_max_ativos_por_ambiente, csc_por_cnpj_base,
         exige_cbenef, exige_cest_bem_listado, aceita_cancelamento_extemporaneo, webservices->'producao'->>'autorizacao' as ws
       from parametros_fiscais_uf where uf = 'PR' and vigencia_fim is null`,
    );
    expect(pr).toEqual({
      autorizador: 'PR',
      prazo_cancelamento_min: 30,
      prazo_cancelamento_substituicao_h: 168,
      prazo_transmissao_contingencia_h: 24,
      inutilizacao_prazo_dia: 10,
      identificacao_obrigatoria_valor: '10000.00',
      nfce_valor_maximo: '200000.00',
      regimes_dispensados_nfce: ['mei'],
      modalidades_contingencia_nfce: [9],
      qrcode_versoes_aceitas: [2, 3],
      csc_max_ativos_por_ambiente: 2,
      csc_por_cnpj_base: true,
      exige_cbenef: true,
      exige_cest_bem_listado: true,
      aceita_cancelamento_extemporaneo: null,
      ws: 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl',
    });
  });

  it('seed: "SEM MARCA", atributos de variação e tipo de estoque vasilhame_vazio; reaplicar não duplica', async () => {
    const { carregarReferencias } = await import('../../src/database/referencias/carregar.js');
    const c = await conectar(banco);
    try {
      await c.query('begin');
      const r = await carregarReferencias(c);
      await c.query('commit');
      expect(r.alteradas).toBe(0);
    } finally {
      await c.end();
    }
    expect(await consultar(banco, 'select descricao from marcas where sem_marca')).toEqual([
      { descricao: 'SEM MARCA' },
    ]);
    const atributos = await consultar<{ nome: string }>(
      banco,
      'select nome from atributos_variacao order by ordem',
    );
    expect(atributos.map((a) => a.nome)).toEqual(['Tamanho', 'Sabor', 'Cor', 'Volume']);
    const [vasilhame] = await consultar(
      banco,
      "select vendavel, padrao from tipos_estoque where chave_sistema = 'vasilhame_vazio'",
    );
    expect(vasilhame).toEqual({ vendavel: false, padrao: false });
  });

  it('FKs de autoria em todas as tabelas com bloco AU (MD 1.3)', async () => {
    const fks = new Set(
      (
        await consultar<{ conname: string }>(
          banco,
          "select conname from pg_constraint where contype = 'f' and conname like 'fk\\_%\\_por\\_id'",
        )
      ).map((f) => f.conname),
    );
    for (const t of TABELAS_COM_AUTORIA) {
      expect(fks.has(`fk_${t}_criado_por_id`), `${t}.criado_por_id`).toBe(true);
      expect(fks.has(`fk_${t}_atualizado_por_id`), `${t}.atualizado_por_id`).toBe(true);
    }
    const [fkPessoa] = await consultar(
      banco,
      "select 1 as ok from pg_constraint where conname = 'fk_usuarios_pessoa_id'",
    );
    expect(fkPessoa).toEqual({ ok: 1 });
  });
});

describe('EAN único entre produtos (MD 3.6.5, geral.ean_duplicado)', () => {
  it('bloqueia gtin já usado em outro produto; código interno, o mesmo produto e excluído não bloqueiam', async () => {
    const a = await produto('Cerveja A lata 350ml');
    const b = await produto('Cerveja B lata 350ml');
    await codigoBarras(a, '7891234567895', { principal: true });
    await expect(codigoBarras(b, '7891234567895')).rejects.toMatchObject(erroBanco('EAN_DUPLICADO'));
    // Código interno (prefixo 2/livre) pode repetir; o índice de busca não é único.
    await codigoBarras(a, 'A100', { tipo: 'interno' });
    await codigoBarras(b, 'A100', { tipo: 'interno' });
    // Fardo do mesmo produto com outro GTIN (DUN-14), fator e preço.
    await codigoBarras(a, '17891234567892', { fator: '12', preco: '59.9000', descricao: 'Fardo 12 un' });
    await expect(codigoBarras(b, '17891234567892')).rejects.toMatchObject(erroBanco('EAN_DUPLICADO'));
    // Trocar o produto de um código para outro que já tem o mesmo EAN também é barrado.
    const c = await produto('Cerveja C lata 350ml');
    const idC = await codigoBarras(c, '7890000000017');
    await expect(
      consultar(banco, 'update produtos_codigos_barras set codigo = $2 where id = $1', [
        idC,
        '7891234567895',
      ]),
    ).rejects.toMatchObject(erroBanco('EAN_DUPLICADO'));
    // Exclusão lógica libera o código.
    await consultar(
      banco,
      "update produtos_codigos_barras set excluido_em = now() where produto_id = $1 and codigo = '7891234567895'",
      [a],
    );
    await codigoBarras(b, '7891234567895');
    // Restaurar o código excluído agora colide com o do produto B.
    await expect(
      consultar(
        banco,
        "update produtos_codigos_barras set excluido_em = null where produto_id = $1 and codigo = '7891234567895'",
        [a],
      ),
    ).rejects.toMatchObject(erroBanco('EAN_DUPLICADO'));
  });

  it('formato GTIN, fator > 0 e um principal por produto/variação', async () => {
    const p = await produto('Água 500ml');
    await expect(codigoBarras(p, '12345')).rejects.toMatchObject({ code: '23514' });
    await expect(codigoBarras(p, '7890000000024', { fator: '0' })).rejects.toMatchObject({ code: '23514' });
    await codigoBarras(p, '7890000000031', { principal: true });
    await expect(codigoBarras(p, '7890000000048', { principal: true })).rejects.toMatchObject({
      code: '23505',
    });
    await expect(codigoBarras(p, '7890000000031')).rejects.toMatchObject({ code: '23505' });
  });

  it('"avisar" e a importação do Nuvem3 aceitam duplicado (relatório de EAN duplicado depois)', async () => {
    const a = await produto('Refrigerante A 2L');
    const b = await produto('Refrigerante B 2L');
    const d = await produto('Refrigerante D 2L');
    await codigoBarras(a, '7890000000055');
    const c = await conectar(banco);
    try {
      await c.query('begin');
      await c.query("set local genesis.ean_duplicado_importacao = 'on'");
      await c.query("insert into produtos_codigos_barras (produto_id, codigo) values ($1, '7890000000055')", [
        b,
      ]);
      await c.query('commit');
    } finally {
      await c.end();
    }
    await expect(codigoBarras(d, '7890000000055')).rejects.toMatchObject(erroBanco('EAN_DUPLICADO'));
    await consultar(
      banco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"'::jsonb)`,
    );
    try {
      await codigoBarras(d, '7890000000055');
    } finally {
      await consultar(
        banco,
        "update configuracoes set excluido_em = now() where chave = 'geral.ean_duplicado' and excluido_em is null",
      );
    }
    const [dup] = await consultar<{ n: number }>(
      banco,
      `select count(distinct produto_id)::int as n from produtos_codigos_barras
       where codigo = '7890000000055' and excluido_em is null`,
    );
    expect(dup!.n).toBe(3);
  });

  it('duas transações concorrentes com o mesmo EAN: a segunda espera a trava e é recusada', async () => {
    const a = await produto('Energético A 2L');
    const b = await produto('Energético B 2L');
    const c1 = await conectar(banco);
    const c2 = await conectar(banco);
    try {
      await c1.query('begin');
      await c1.query(
        "insert into produtos_codigos_barras (produto_id, codigo) values ($1, '7890000000062')",
        [a],
      );
      await c2.query('begin');
      const segunda = c2.query(
        "insert into produtos_codigos_barras (produto_id, codigo) values ($1, '7890000000062')",
        [b],
      );
      const erro = segunda.then(
        () => null,
        (e: Error) => e,
      );
      await new Promise((r) => setTimeout(r, 150));
      await c1.query('commit');
      expect(await erro).toMatchObject(erroBanco('EAN_DUPLICADO'));
      await c2.query('rollback');
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

describe('faixas de preço por quantidade sem sobreposição (MD 3.6.9, 3.6.13; btree_gist)', () => {
  it('produtos_precos_quantidade: mesma (produto, variação, loja) não sobrepõe; outra loja e linha excluída não contam', async () => {
    const p = await produto('Cerveja lata 350ml atacarejo', { preco_venda: '4.9900' });
    const faixa = (loja: string | null, ini: string, fim: string | null, preco: string) =>
      consultar<{ id: string }>(
        banco,
        `insert into produtos_precos_quantidade (produto_id, loja_id, quantidade_inicial, quantidade_final, preco)
         values ($1, $2, $3, $4, $5) returning id`,
        [p, loja, ini, fim, preco],
      );
    await faixa(null, '6', '12', '4.5000');
    const [aberta] = await faixa(null, '12', null, '3.9900');
    await expect(faixa(null, '10', '20', '4.0000')).rejects.toMatchObject({ code: '23P01' });
    await expect(faixa(null, '24', null, '3.5000')).rejects.toMatchObject({ code: '23P01' });
    // Faixa da loja convive com a de todas as lojas (a da loja prevalece no PDV 11.3.1).
    await faixa(loja1, '6', null, '4.2000');
    await expect(faixa(loja1, '12', '24', '4.0000')).rejects.toMatchObject({ code: '23P01' });
    await faixa(loja2, '12', '24', '4.0000');
    await expect(faixa(null, '0', '6', '5.0000')).rejects.toMatchObject({ code: '23514' });
    await expect(faixa(null, '30', '20', '5.0000')).rejects.toMatchObject({ code: '23514' });
    await consultar(banco, 'update produtos_precos_quantidade set excluido_em = now() where id = $1', [
      aberta!.id,
    ]);
    await faixa(null, '12', '24', '4.1000');
  });

  it('grupos_preco_quantidade_faixas (mix): sem sobreposição por (grupo, loja)', async () => {
    const [g] = await consultar<{ id: string; codigo: number }>(
      banco,
      "insert into grupos_preco_quantidade (nome, modo_preco) values ('MIX LATAS 350ML', 'grupo') returning id, codigo",
    );
    expect(g!.codigo).toBeGreaterThan(0);
    const faixa = (loja: string | null, ini: string, fim: string | null) =>
      consultar(
        banco,
        `insert into grupos_preco_quantidade_faixas (grupo_id, loja_id, quantidade_inicial, quantidade_final, preco)
         values ($1, $2, $3, $4, '3.9900')`,
        [g!.id, loja, ini, fim],
      );
    await faixa(null, '12', null);
    await expect(faixa(null, '24', '48')).rejects.toMatchObject({ code: '23P01' });
    await faixa(loja1, '12', '24');
    await faixa(loja1, '24', null);
    await expect(
      consultar(banco, "insert into grupos_preco_quantidade (nome) values ('mix latas 350ml')"),
    ).rejects.toMatchObject({ code: '23505' });
    // Membro do mix: só tipos simples/com_variacoes/produzido.
    await produto('Brahma lata 350ml', { grupo_preco_quantidade_id: g!.id });
    await expect(
      produto('Combo mix', { tipo: 'kit', grupo_preco_quantidade_id: g!.id }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('combo (kit) e ficha técnica sem ciclo (MD 3.6.7)', () => {
  it('COMBO DE WHISKY com troca de componente; ciclo direto, indireto e pela alternativa é recusado', async () => {
    const whisky = await produto('Whisky 1L', { preco_custo: '80.0000', preco_venda: '120.0000' });
    const redbull = await produto('Red Bull 2L', { preco_custo: '12.0000', preco_venda: '18.0000' });
    const monster = await produto('Monster 2L', { preco_custo: '11.0000', preco_venda: '17.0000' });
    const gelo = await produto('Gelo Coco', { preco_custo: '1.5000', preco_venda: '3.0000' });
    const combo = await produto('COMBO DE WHISKY 1L', { tipo: 'kit', preco_venda: '150.0000' });
    const posicao = async (componente: string, quantidade: string, extra = '') => {
      const [r] = await consultar<{ id: string }>(
        banco,
        `insert into produtos_componentes (produto_id, tipo, componente_id, quantidade${extra ? ', rotulo_posicao, permite_substituicao' : ''})
         values ($1, 'kit', $2, $3${extra ? ', $4, true' : ''}) returning id`,
        extra ? [combo, componente, quantidade, extra] : [combo, componente, quantidade],
      );
      return r!.id;
    };
    await posicao(whisky, '1');
    const energetico = await posicao(redbull, '1', 'Energético 2L');
    await posicao(gelo, '2');
    await consultar(
      banco,
      "insert into produtos_componentes_alternativas (componente_id, produto_id, acrescimo) values ($1, $2, '2.0000')",
      [energetico, monster],
    );
    // Custo com os padrões = Σ custo × quantidade (calculado pela API; aqui só a consulta que ela usa).
    const [custo] = await consultar<{ custo: string }>(
      banco,
      `select sum(p.preco_custo * c.quantidade)::numeric(15,4)::text as custo from produtos_componentes c
       join produtos p on p.id = c.componente_id where c.produto_id = $1 and c.excluido_em is null`,
      [combo],
    );
    expect(custo!.custo).toBe('95.0000');

    // Direto (o trigger responde antes do ck_produtos_componentes_ciclo_direto). Indireto: o "Gelo Coco" passa a ser
    // produzido com o combo como insumo.
    await expect(
      consultar(
        banco,
        "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade) values ($1, 'kit', $1, 1)",
        [combo],
      ),
    ).rejects.toMatchObject(erroBanco('COMPOSICAO_CICLICA'));
    await consultar(banco, "update produtos set tipo = 'produzido', usa_ficha_tecnica = true where id = $1", [
      gelo,
    ]);
    await expect(
      consultar(
        banco,
        "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade) values ($1, 'ficha_tecnica', $2, 1)",
        [gelo, combo],
      ),
    ).rejects.toMatchObject(erroBanco('COMPOSICAO_CICLICA'));
    // Pela alternativa: o Monster (alternativa da posição) com ficha técnica contendo o combo.
    await consultar(banco, "update produtos set tipo = 'produzido', usa_ficha_tecnica = true where id = $1", [
      monster,
    ]);
    await expect(
      consultar(
        banco,
        "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade) values ($1, 'ficha_tecnica', $2, 1)",
        [monster, combo],
      ),
    ).rejects.toMatchObject(erroBanco('COMPOSICAO_CICLICA'));
    // Alternativa que é o próprio kit.
    await expect(
      consultar(
        banco,
        'insert into produtos_componentes_alternativas (componente_id, produto_id) values ($1, $2)',
        [energetico, combo],
      ),
    ).rejects.toMatchObject(erroBanco('COMPOSICAO_CICLICA'));
    // Ficha técnica legítima e em cadeia (sem ciclo) passa; a mesma linha de ficha técnica não repete.
    const xarope = await produto('Xarope de coco', { tipo: 'materia_prima' });
    await consultar(
      banco,
      "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade, perda_pct) values ($1, 'ficha_tecnica', $2, '0.200', '5')",
      [gelo, xarope],
    );
    await expect(
      consultar(
        banco,
        "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade) values ($1, 'ficha_tecnica', $2, '0.100')",
        [gelo, xarope],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // No kit, o mesmo padrão pode aparecer em duas posições (dois sabores de gelo).
    await posicao(gelo, '1', 'Gelo de sabor 2');
    // Rótulo/substituição só em kit; perda só na ficha técnica.
    await expect(
      consultar(
        banco,
        "insert into produtos_componentes (produto_id, tipo, componente_id, quantidade, permite_substituicao) values ($1, 'ficha_tecnica', $2, 1, true)",
        [gelo, whisky],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('colunas de filtro imutáveis e documentos de estoque (MD 6.4 regra 2, 1.6, 3.7)', () => {
  it('loja_id de produtos_lojas/faixas/vínculos não muda; mudar = excluir e criar outra linha', async () => {
    const p = await produto('Chopp 1L');
    const [pl] = await consultar<{ id: string }>(
      banco,
      "insert into produtos_lojas (produto_id, loja_id, preco_venda) values ($1, $2, '19.9000') returning id",
      [p, loja1],
    );
    await expect(
      consultar(banco, 'update produtos_lojas set loja_id = $2 where id = $1', [pl!.id, loja2]),
    ).rejects.toMatchObject(erroBanco('FILTRO_IMUTAVEL'));
    await consultar(banco, "update produtos_lojas set preco_venda = '18.9000' where id = $1", [pl!.id]);
    await expect(
      consultar(banco, 'update caixas set loja_id = $2 where loja_id = $1', [loja1, loja2]),
    ).resolves.toEqual([]);
    const [cx] = await consultar<{ id: string }>(
      banco,
      'insert into caixas (loja_id, numero) values ($1, 5) returning id',
      [loja1],
    );
    await expect(
      consultar(banco, 'update caixas set loja_id = $2 where id = $1', [cx!.id, loja2]),
    ).rejects.toMatchObject(erroBanco('FILTRO_IMUTAVEL'));
  });

  it('movimento de estoque é imutável; itens do acerto só mudam em rascunho; acerto efetivado só estorna', async () => {
    const p = await produto('Carvão 3kg');
    const [ctx] = await consultar<{ estoque: string; tipo: string; usuario: string }>(
      banco,
      `select (select estoque_id from lojas where id = $1) as estoque,
              (select id from tipos_estoque where chave_sistema = 'disponivel') as tipo,
              (select id from usuarios where master limit 1) as usuario`,
      [loja1],
    );
    const [acerto] = await consultar<{ id: string; codigo: number }>(
      banco,
      `insert into acertos_estoque (estoque_id, tipo_estoque_id, tipo_ajuste, motivo, responsavel_id)
       values ($1, $2, 'entrada', 'Saldo inicial', $3) returning id, codigo`,
      [ctx!.estoque, ctx!.tipo, ctx!.usuario],
    );
    expect(acerto!.codigo).toBeGreaterThan(0);
    const [item] = await consultar<{ id: string }>(
      banco,
      `insert into itens_acerto_estoque (acerto_id, sequencia, produto_id, quantidade_informada)
       values ($1, 1, $2, '10') returning id`,
      [acerto!.id, p],
    );
    await consultar(
      banco,
      "update itens_acerto_estoque set saldo_anterior = 0, diferenca = 10, custo_unitario = '20.0000' where id = $1",
      [item!.id],
    );
    const [mov] = await consultar<{ id: string }>(
      banco,
      `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade, saldo_anterior,
         saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento, documento_tipo, documento_id,
         documento_item_id)
       values ($1, $2, $3, 'ACERTO_ENTRADA', 10, 0, 10, '20.0000', '200.00', '20.0000', now(), 'acerto', $4, $5)
       returning id`,
      [ctx!.estoque, ctx!.tipo, p, acerto!.id, item!.id],
    );
    await consultar(
      banco,
      `insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio, ultimo_movimento_id)
       values ($1, $2, $3, 10, '20.0000', $4)`,
      [ctx!.estoque, p, ctx!.tipo, mov!.id],
    );
    await consultar(
      banco,
      "update acertos_estoque set status = 'efetivado', efetivado_em = now(), efetivado_por_id = $2 where id = $1",
      [acerto!.id, ctx!.usuario],
    );

    // Saldo: quantidade inconsistente com o razão, idempotência e linha duplicada.
    await expect(
      consultar(
        banco,
        `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade, saldo_anterior,
           saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento, documento_tipo)
         values ($1, $2, $3, 'ACERTO_ENTRADA', 5, 10, 14, 0, 0, 0, now(), 'acerto')`,
        [ctx!.estoque, ctx!.tipo, p],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      consultar(
        banco,
        `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade, saldo_anterior,
           saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento, documento_tipo, documento_item_id)
         values ($1, $2, $3, 'ACERTO_ENTRADA', 10, 10, 20, 0, 0, 0, now(), 'acerto', $4)`,
        [ctx!.estoque, ctx!.tipo, p, item!.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      consultar(
        banco,
        'insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id) values ($1, $2, $3)',
        [ctx!.estoque, p, ctx!.tipo],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      consultar(banco, "update movimentos_estoque set observacao = 'alterado' where id = $1", [mov!.id]),
    ).rejects.toMatchObject(erroBanco('DOCUMENTO_IMUTAVEL'));
    await expect(
      consultar(banco, "update itens_acerto_estoque set quantidade_informada = '11' where id = $1", [
        item!.id,
      ]),
    ).rejects.toMatchObject(erroBanco('DOCUMENTO_IMUTAVEL'));
    await expect(
      consultar(
        banco,
        `insert into itens_acerto_estoque (acerto_id, sequencia, produto_id, quantidade_informada) values ($1, 2, $2, 1)`,
        [acerto!.id, p],
      ),
    ).rejects.toMatchObject(erroBanco('DOCUMENTO_IMUTAVEL'));
    await expect(
      consultar(banco, "update acertos_estoque set motivo = 'outro' where id = $1", [acerto!.id]),
    ).rejects.toMatchObject(erroBanco('DOCUMENTO_IMUTAVEL'));
    await consultar(
      banco,
      `update acertos_estoque set status = 'estornado', estornado_em = now(), estornado_por_id = $2,
         motivo_estorno = 'Contagem errada' where id = $1`,
      [acerto!.id, ctx!.usuario],
    );
    // Saldo não muda de estoque (coluna de filtro do fluxo `estoque`).
    const [outro] = await consultar<{ estoque_id: string }>(
      banco,
      'select estoque_id from lojas where id = $1',
      [loja2],
    );
    await expect(
      consultar(banco, 'update saldos_estoque set estoque_id = $2 where produto_id = $1', [
        p,
        outro!.estoque_id,
      ]),
    ).rejects.toMatchObject(erroBanco('FILTRO_IMUTAVEL'));
  });
});

describe('versão e exclusão lógica nas tabelas novas (MD 1.4, 1.5)', () => {
  it('produtos/pessoas: INSERT e UPDATE geram versão; UPDATE sem mudança não; excluir libera código interno e CPF', async () => {
    const c: pg.Client = await conectar(banco);
    try {
      const {
        rows: [p],
      } = await c.query<{ id: string; versao: string; codigo: number }>(
        "insert into produtos (nome, unidade_id, codigo_interno) values ('Gin 1L', $1, 'GIN-1') returning id, versao, codigo",
        [un],
      );
      expect(Number(p!.versao)).toBeGreaterThan(0);
      expect(p!.codigo).toBeGreaterThan(0);
      const {
        rows: [igual],
      } = await c.query<{ versao: string }>(
        "update produtos set nome = 'Gin 1L' where id = $1 returning versao",
        [p!.id],
      );
      expect(igual!.versao).toBe(p!.versao);
      const {
        rows: [mudou],
      } = await c.query<{ versao: string }>(
        "update produtos set preco_venda = '89.9000' where id = $1 returning versao",
        [p!.id],
      );
      expect(Number(mudou!.versao)).toBeGreaterThan(Number(p!.versao));
      await expect(
        c.query("insert into produtos (nome, unidade_id, codigo_interno) values ('Gin 2', $1, 'gin-1')", [
          un,
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('update produtos set excluido_em = now() where id = $1', [p!.id]);
      await c.query(
        "insert into produtos (nome, unidade_id, codigo_interno) values ('Gin 1L novo', $1, 'GIN-1')",
        [un],
      );

      await c.query("insert into pessoas (nome, tipo, cpf_cnpj) values ('Fulano', 'PF', '12345678909')");
      await expect(
        c.query("insert into pessoas (nome, tipo, cpf_cnpj) values ('Fulano 2', 'PF', '12345678909')"),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        c.query("insert into pessoas (nome, tipo, cpf_cnpj) values ('Empresa', 'PJ', '12345678909')"),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query("update pessoas set excluido_em = now() where cpf_cnpj = '12345678909'");
      await c.query("insert into pessoas (nome, tipo, cpf_cnpj) values ('Fulano 2', 'PF', '12345678909')");
    } finally {
      await c.end();
    }
  });
});
