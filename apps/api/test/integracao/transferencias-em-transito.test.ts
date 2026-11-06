/**
 * "Em trânsito", "Divergência a tratar" e o alerta da transferência parada (Fase 2, F2-B26; ERP 8.2.11, 13.7, 16.4;
 * README da API › decisão 174), pela API do ERP. O critério de pronto: com 60 unidades em trânsito para a Loja 2 (que
 * nunca recebeu o produto), o produto mostra "Em trânsito: 60" na Loja 2 até o recebimento, e a transferência parada
 * há 4 dias gera o alerta (um só, mesmo com a varredura repetida). Também: a divergência a tratar fica na origem, fora
 * do em trânsito e do saldo, até o tratamento; o alerta da divergência conta do recebimento e fecha no tratamento; o do
 * trânsito fecha no recebimento e no cancelamento; o rascunho e a transferência dentro do prazo não alertam; a chave
 * `estoque.transferencia_alerta_dias`; o tipo de estoque (Vasilhame vazio) e o filtro por tipo; os estoques permitidos
 * (quem só tem a Loja 1 não vê o trânsito da Loja 2 nem a divergência do CD). E ainda: o recebimento integral fecha o
 * alerta com "Transferência recebida"; a data da mensagem no fuso da loja do alerta (no CD, no da empresa); o prazo
 * aumentado fecha o aberto que voltou para dentro dele; a varredura pula a transferência que outra transação está mudando.
 */
import { ALERTA_TRANSFERENCIA_PARADA } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chaveAlertaTransferencia } from '../../src/transferencias/alertas.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
/** Estoquista só da Loja 1 (lojas e estoques permitidos). */
let tokenLoja1: string;
let un: string;
let loja1: string;
let loja2: string;
let estoqueLoja1: string;
let estoqueLoja2: string;
let cd: string;
let tipoPadrao: string;
let tipoVasilhame: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });

async function produto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function entrada(estoqueId: string, produtoId: string, quantidade: string, tipoEstoqueId = tipoPadrao) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId,
      tipoEstoqueId,
      motivo: 'Saldo inicial',
      dataContagem: new Date().toISOString(),
      tipoAjuste: 'entrada',
      itens: [{ produtoId, quantidade, custoUnitario: '4' }],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
}

/** Cria a transferência de um item e, se pedido, envia. Devolve o id e o do item. */
async function transferencia(
  origem: string,
  destino: string,
  produtoId: string,
  quantidade: string,
  enviar = true,
  tipoEstoqueId: string | null = null,
): Promise<{ id: string; itemId: string }> {
  const r = await amb
    .http()
    .post('/api/transferencias')
    .set(bearer())
    .send({
      estoqueOrigemId: origem,
      estoqueDestinoId: destino,
      tipoEstoqueId,
      motivo: 'Reposição',
      itens: [{ produtoId, quantidade }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as string;
  if (enviar) {
    const e = await amb.http().post(`/api/transferencias/${id}/enviar`).set(bearer()).send({});
    expect(e.status, JSON.stringify(e.body)).toBe(200);
  }
  const d = await amb.http().get(`/api/transferencias/${id}`).set(bearer());
  return { id, itemId: d.body.itens[0].id as string };
}

/** Envelhece o envio (ou o recebimento): o trigger de imutabilidade é desligado só para isso. */
async function envelhecer(id: string, coluna: 'enviada_em' | 'recebida_em', dias: number) {
  await consultar(
    emp.nomeBanco,
    `set session_replication_role = replica;
     update transferencias_estoque set ${coluna} = now() - interval '${dias} days' where id = '${id}';
     set session_replication_role = origin;`,
  );
}

type LinhaSaldoProduto = {
  estoqueId: string;
  tipoEstoqueId: string;
  quantidade: string;
  emTransito: string;
  divergenciaATratar: string;
};

async function saldosProduto(produtoId: string, token = tokenAdmin): Promise<LinhaSaldoProduto[]> {
  const r = await amb.http().get(`/api/produtos/${produtoId}/saldos`).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.saldos as LinhaSaldoProduto[];
}

const linha = (l: LinhaSaldoProduto[], estoqueId: string, tipoEstoqueId = tipoPadrao) =>
  l.find((s) => s.estoqueId === estoqueId && s.tipoEstoqueId === tipoEstoqueId);

async function listaSaldos(query: Record<string, string>, token = tokenAdmin) {
  const r = await amb.http().get('/api/saldos-estoque').query(query).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.itens as Array<LinhaSaldoProduto & { produtoId: string; tipoEstoqueNome: string | null }>;
}

type Alerta = {
  id: string;
  titulo: string;
  mensagem: string;
  loja_id: string | null;
  entidade: string;
  registro_id: string;
  dados: Record<string, unknown>;
  chave_deduplicacao: string;
  resolvido_em: string | null;
  resolucao: string | null;
};

const alertas = (transferenciaId: string) =>
  consultar<Alerta>(
    emp.nomeBanco,
    `select id, titulo, mensagem, loja_id, entidade, registro_id, dados, chave_deduplicacao, resolvido_em, resolucao
       from alertas where tipo = $1 and registro_id = $2 order by criado_em, id`,
    [ALERTA_TRANSFERENCIA_PARADA, transferenciaId],
  );

const varrer = () => amb.servicos.alertaTransferencias.executar();

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const estoqueDa = async (loja: string) =>
    (
      await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])
    )[0]!.estoque_id;
  estoqueLoja1 = await estoqueDa(loja1);
  estoqueLoja2 = await estoqueDa(loja2);
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  )) as [{ id: string }];
  [{ id: tipoPadrao }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from tipos_estoque where padrao and excluido_em is null',
  )) as [{ id: string }];
  [{ id: tipoVasilhame }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from tipos_estoque where chave_sistema = 'vasilhame_vazio'",
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'loja1',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoqueLoja1],
  });
  tokenLoja1 = await amb.entrar(emp.codigo, 'loja1', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('em trânsito, divergência a tratar e alerta (F2-B26)', () => {
  it('60 em trânsito para a Loja 2 aparecem até o recebimento; parada há 4 dias gera um alerta só (critério de pronto)', async () => {
    const pilsen = await produto('Pilsen lata 350ml');
    await entrada(cd, pilsen, '100');
    const t = await transferencia(cd, estoqueLoja2, pilsen, '60');

    // A Loja 2 nunca recebeu o produto (sem linha de saldo): a linha aparece com saldo zero e 60 a caminho.
    let s = await saldosProduto(pilsen);
    expect(linha(s, estoqueLoja2)).toMatchObject({
      quantidade: '0.000',
      emTransito: '60.000',
      divergenciaATratar: '0.000',
    });
    expect(linha(s, cd)).toMatchObject({
      quantidade: '40.000',
      emTransito: '0.000',
      divergenciaATratar: '0.000',
    });
    const naLista = await listaSaldos({ estoqueId: estoqueLoja2, nome: 'Pilsen lata' });
    expect(naLista).toHaveLength(1);
    expect(naLista[0]).toMatchObject({ produtoId: pilsen, quantidade: '0.000', emTransito: '60.000' });

    // Dentro do prazo (2 dias com o padrão de 3): nada.
    await envelhecer(t.id, 'enviada_em', 2);
    expect(await varrer()).toMatchObject({ executada: true, abertos: 0, falhas: [] });
    expect(await alertas(t.id)).toEqual([]);

    // Parada há 4 dias: o alerta, na loja do destino (quem tem de receber), com o documento e os números.
    await envelhecer(t.id, 'enviada_em', 4);
    expect(await varrer()).toMatchObject({ executada: true, abertos: 1, falhas: [] });
    let a = await alertas(t.id);
    expect(a).toHaveLength(1);
    const codigo = (
      await consultar<{ codigo: number }>(
        emp.nomeBanco,
        'select codigo from transferencias_estoque where id = $1',
        [t.id],
      )
    )[0]!.codigo;
    expect(a[0]).toMatchObject({
      titulo: `Transferência Nº ${codigo} em trânsito há 4 dias`,
      loja_id: loja2,
      entidade: 'transferencias_estoque',
      registro_id: t.id,
      chave_deduplicacao: chaveAlertaTransferencia(t.id, 'em_transito'),
      resolvido_em: null,
      dados: {
        situacao: 'em_transito',
        codigo,
        dias: 4,
        prazo_dias: 3,
        estoque_origem_id: cd,
        estoque_destino_id: estoqueLoja2,
        tipo_estoque_id: tipoPadrao,
        itens: 1,
        quantidade: '60.000',
      },
    });
    expect(a[0]!.mensagem).toContain('Enviada de CD - Estoque Ice Beer para Estoque Loja 2 - Bairro');
    // A tela da transferência mostra o alerta aberto (F2-B27): o mesmo título e a mensagem da varredura.
    const comAlerta = await amb.http().get(`/api/transferencias/${t.id}`).set(bearer());
    expect(comAlerta.body.alertaParada).toEqual({
      situacao: 'em_transito',
      titulo: `Transferência Nº ${codigo} em trânsito há 4 dias`,
      mensagem: a[0]!.mensagem,
      dias: 4,
      abertoEm: expect.any(String),
    });

    // A varredura repetida mantém o mesmo alerta (deduplicado), com os dias atualizados.
    await envelhecer(t.id, 'enviada_em', 5);
    expect(await varrer()).toMatchObject({ abertos: 1, resolvidos: 0 });
    a = await alertas(t.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.titulo).toBe(`Transferência Nº ${codigo} em trânsito há 5 dias`);

    // Recebe 50 de 60: o trânsito acaba (os 50 no saldo da Loja 2) e os 10 a menor ficam como divergência a tratar na
    // origem, fora do saldo e do em trânsito. O alerta do trânsito fecha no próprio recebimento.
    const rc = await amb
      .http()
      .post(`/api/transferencias/${t.id}/receber`)
      .set(bearer())
      .send({ itens: [{ itemId: t.itemId, quantidadeRecebida: '50' }] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    s = await saldosProduto(pilsen);
    expect(linha(s, estoqueLoja2)).toMatchObject({
      quantidade: '50.000',
      emTransito: '0.000',
      divergenciaATratar: '0.000',
    });
    expect(linha(s, cd)).toMatchObject({
      quantidade: '40.000',
      emTransito: '0.000',
      divergenciaATratar: '10.000',
    });
    expect((await listaSaldos({ estoqueId: cd, nome: 'Pilsen lata' }))[0]).toMatchObject({
      quantidade: '40.000',
      emTransito: '0.000',
      divergenciaATratar: '10.000',
    });
    a = await alertas(t.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.resolvido_em).not.toBeNull();
    expect(a[0]!.resolucao).toBe('Transferência recebida com divergência');
    expect((await amb.http().get(`/api/transferencias/${t.id}`).set(bearer())).body.alertaParada).toBeNull();

    // A divergência conta do recebimento: hoje, nada; há 4 dias, o alerta na loja da origem (o CD não tem: nula).
    expect(await varrer()).toMatchObject({ abertos: 0 });
    await envelhecer(t.id, 'recebida_em', 4);
    expect(await varrer()).toMatchObject({ abertos: 1 });
    a = (await alertas(t.id)).filter((x) => x.resolvido_em === null);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      titulo: `Transferência Nº ${codigo} com divergência a tratar há 4 dias`,
      loja_id: null,
      chave_deduplicacao: chaveAlertaTransferencia(t.id, 'recebida_divergencia'),
      dados: { situacao: 'recebida_divergencia', itens: 1, quantidade: '10.000' },
    });
    expect(
      (await amb.http().get(`/api/transferencias/${t.id}`).set(bearer())).body.alertaParada,
    ).toMatchObject({
      situacao: 'recebida_divergencia',
      titulo: `Transferência Nº ${codigo} com divergência a tratar há 4 dias`,
      dias: 4,
    });

    // Tratada (retorno à origem): a divergência zera, o CD volta a 50 e o alerta fecha.
    const tr = await amb
      .http()
      .post(`/api/transferencias/${t.id}/tratar-divergencia`)
      .set(bearer())
      .send({ itens: [{ itemId: t.itemId, tratamento: 'retorno_origem' }] });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);
    s = await saldosProduto(pilsen);
    expect(linha(s, cd)).toMatchObject({
      quantidade: '50.000',
      emTransito: '0.000',
      divergenciaATratar: '0.000',
    });
    a = await alertas(t.id);
    expect(a.every((x) => x.resolvido_em !== null)).toBe(true);
    expect(a.at(-1)!.resolucao).toBe('Diferença tratada');
    expect(await varrer()).toMatchObject({ abertos: 0, resolvidos: 0 });
  });

  it('rascunho antigo não alerta; o cancelamento fecha o alerta; a chave muda o prazo; a varredura fecha o que sobrou', async () => {
    const ipa = await produto('IPA long neck');
    await entrada(cd, ipa, '30');
    const rascunho = await transferencia(cd, estoqueLoja1, ipa, '5', false);
    await consultar(
      emp.nomeBanco,
      `set session_replication_role = replica;
       update transferencias_estoque set criado_em = now() - interval '10 days' where id = '${rascunho.id}';
       set session_replication_role = origin;`,
    );
    const cancelada = await transferencia(cd, estoqueLoja1, ipa, '6');
    await envelhecer(cancelada.id, 'enviada_em', 4);
    const recente = await transferencia(cd, estoqueLoja1, ipa, '7');
    await envelhecer(recente.id, 'enviada_em', 2);
    await varrer();
    expect(await alertas(rascunho.id)).toEqual([]);
    expect(await alertas(recente.id)).toEqual([]);
    expect(await alertas(cancelada.id)).toHaveLength(1);
    // Em trânsito para a Loja 1: 13 (o rascunho não conta).
    expect(linha(await saldosProduto(ipa), estoqueLoja1)).toMatchObject({ emTransito: '13.000' });

    const c = await amb
      .http()
      .post(`/api/transferencias/${cancelada.id}/cancelar`)
      .set(bearer())
      .send({ motivo: 'Carga desfeita' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const [fechado] = await alertas(cancelada.id);
    expect(fechado).toMatchObject({ resolucao: 'Transferência cancelada' });
    expect(fechado!.resolvido_em).not.toBeNull();
    expect(linha(await saldosProduto(ipa), estoqueLoja1)).toMatchObject({ emTransito: '7.000' });

    // `estoque.transferencia_alerta_dias = 1`: a de 2 dias passa a alertar ("há 2 dias").
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'estoque.transferencia_alerta_dias', '1'::jsonb)`,
    );
    try {
      await varrer();
      const [novo] = await alertas(recente.id);
      expect(novo).toMatchObject({ resolvido_em: null, dados: { dias: 2, prazo_dias: 1 } });
      // O alerta que ficou aberto por fora (a transição sem passar pela API) a varredura fecha.
      await consultar(
        emp.nomeBanco,
        `set session_replication_role = replica;
         update transferencias_estoque set status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'teste'
          where id = '${recente.id}';
         set session_replication_role = origin;`,
      );
      expect(await varrer()).toMatchObject({ resolvidos: 1 });
      expect((await alertas(recente.id))[0]).toMatchObject({ resolucao: 'Transferência cancelada' });
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'estoque.transferencia_alerta_dias'",
      );
    }
  });

  it('tipo de estoque: os cascos vazios a caminho do CD ficam no Vasilhame vazio, e o filtro por tipo os separa', async () => {
    const casco = await produto('Casco 600ml');
    await entrada(estoqueLoja1, casco, '24', tipoVasilhame);
    await transferencia(estoqueLoja1, cd, casco, '24', true, tipoVasilhame);
    const s = await saldosProduto(casco);
    expect(linha(s, cd, tipoVasilhame)).toMatchObject({ quantidade: '0.000', emTransito: '24.000' });
    expect(linha(s, cd, tipoPadrao)).toBeUndefined();
    expect(linha(s, estoqueLoja1, tipoVasilhame)).toMatchObject({ quantidade: '0.000', emTransito: '0.000' });
    // Na lista, só o tipo pedido; também com "Incluir produtos sem movimento".
    expect(await listaSaldos({ estoqueId: cd, nome: 'Casco 600', tipoEstoqueId: tipoPadrao })).toEqual([]);
    for (const incluirSemMovimento of ['false', 'true']) {
      const l = await listaSaldos({
        estoqueId: cd,
        nome: 'Casco 600',
        tipoEstoqueId: tipoVasilhame,
        incluirSemMovimento,
      });
      expect(l, incluirSemMovimento).toHaveLength(1);
      expect(l[0]).toMatchObject({ tipoEstoqueId: tipoVasilhame, quantidade: '0.000', emTransito: '24.000' });
    }
    // Sem o tipo, "sem movimento" mostra a mesma linha do Vasilhame vazio (a pendência conta como linha de saldo).
    const todos = await listaSaldos({ estoqueId: cd, nome: 'Casco 600', incluirSemMovimento: 'true' });
    expect(todos.map((x) => [x.tipoEstoqueId, x.emTransito])).toEqual([[tipoVasilhame, '24.000']]);
  });

  it('estoques permitidos: quem só tem a Loja 1 não vê o trânsito da Loja 2 nem a divergência do CD', async () => {
    const weiss = await produto('Weiss garrafa');
    await entrada(cd, weiss, '20');
    await transferencia(cd, estoqueLoja2, weiss, '8');
    const paraLoja1 = await transferencia(cd, estoqueLoja1, weiss, '5');
    const rc = await amb
      .http()
      .post(`/api/transferencias/${paraLoja1.id}/receber`)
      .set(bearer())
      .send({ itens: [{ itemId: paraLoja1.itemId, quantidadeRecebida: '3' }] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const admin = await saldosProduto(weiss);
    expect(linha(admin, estoqueLoja2)).toMatchObject({ emTransito: '8.000' });
    expect(linha(admin, cd)).toMatchObject({ quantidade: '7.000', divergenciaATratar: '2.000' });
    const loja = await saldosProduto(weiss, tokenLoja1);
    expect(loja.map((x) => x.estoqueId)).toEqual([estoqueLoja1]);
    expect(loja[0]).toMatchObject({ quantidade: '3.000', emTransito: '0.000', divergenciaATratar: '0.000' });
    const lista = await listaSaldos({ nome: 'Weiss garrafa' }, tokenLoja1);
    expect(lista.map((x) => x.estoqueId)).toEqual([estoqueLoja1]);
  });

  it('recebimento integral fecha o alerta do trânsito com "Transferência recebida", sem abrir divergência', async () => {
    const lager = await produto('Lager garrafa 600ml');
    await entrada(cd, lager, '12');
    const t = await transferencia(cd, estoqueLoja1, lager, '12');
    await envelhecer(t.id, 'enviada_em', 4);
    await varrer();
    expect(await alertas(t.id)).toMatchObject([{ resolvido_em: null, dados: { situacao: 'em_transito' } }]);
    const rc = await amb
      .http()
      .post(`/api/transferencias/${t.id}/receber`)
      .set(bearer())
      .send({ receberTudo: true });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const a = await alertas(t.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.resolvido_em).not.toBeNull();
    expect(a[0]!.resolucao).toBe('Transferência recebida');
    await varrer();
    expect((await alertas(t.id)).filter((x) => x.resolvido_em === null)).toEqual([]);
    expect(linha(await saldosProduto(lager), estoqueLoja1)).toMatchObject({
      quantidade: '12.000',
      emTransito: '0.000',
      divergenciaATratar: '0.000',
    });
  });

  it('a data da mensagem sai no fuso da loja do alerta e, no CD, no da empresa (ERP 1.5)', async () => {
    const stout = await produto('Stout lata 473ml');
    await entrada(cd, stout, '10');
    await entrada(estoqueLoja1, stout, '10');
    // Para o CD (sem loja): o fuso da empresa (Manaus, UTC-4). Para a Loja 2: o fuso dela (Rio Branco, UTC-5).
    const paraCd = await transferencia(estoqueLoja1, cd, stout, '3');
    const paraLoja2 = await transferencia(cd, estoqueLoja2, stout, '4');
    // Enviadas às 23:30 de 5 dias atrás no fuso de cada uma: em Brasília já seria o dia seguinte.
    const enviarAs = async (id: string, fuso: string) => {
      await consultar(
        emp.nomeBanco,
        `set session_replication_role = replica;
         update transferencias_estoque
            set enviada_em = ((date_trunc('day', now() at time zone '${fuso}') - interval '5 days'
                               + interval '23 hours 30 minutes') at time zone '${fuso}')
          where id = '${id}';
         set session_replication_role = origin;`,
      );
      const [{ dia, brasilia }] = (await consultar<{ dia: string; brasilia: string }>(
        emp.nomeBanco,
        `select to_char(enviada_em at time zone '${fuso}', 'DD/MM/YYYY') as dia,
                to_char(enviada_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') as brasilia
           from transferencias_estoque where id = $1`,
        [id],
      )) as [{ dia: string; brasilia: string }];
      expect(brasilia).not.toBe(dia);
      return dia;
    };
    const diaCd = await enviarAs(paraCd.id, 'America/Manaus');
    const diaLoja2 = await enviarAs(paraLoja2.id, 'America/Rio_Branco');
    await consultar(emp.nomeBanco, "update empresa set fuso_horario = 'America/Manaus'");
    await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'America/Rio_Branco' where id = $1", [
      loja2,
    ]);
    try {
      await varrer();
      const [noCd] = await alertas(paraCd.id);
      expect(noCd).toMatchObject({ loja_id: null, resolvido_em: null });
      expect(noCd!.mensagem).toContain(`para CD - Estoque Ice Beer em ${diaCd} e ainda não recebida`);
      const [naLoja2] = await alertas(paraLoja2.id);
      expect(naLoja2).toMatchObject({ loja_id: loja2, resolvido_em: null });
      expect(naLoja2!.mensagem).toContain(`para Estoque Loja 2 - Bairro em ${diaLoja2} e ainda não recebida`);
    } finally {
      await consultar(emp.nomeBanco, "update empresa set fuso_horario = 'America/Sao_Paulo'");
      await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'America/Sao_Paulo' where id = $1", [
        loja2,
      ]);
      for (const id of [paraCd.id, paraLoja2.id]) {
        const c = await amb
          .http()
          .post(`/api/transferencias/${id}/cancelar`)
          .set(bearer())
          .send({ motivo: 'Teste' });
        expect(c.status, JSON.stringify(c.body)).toBe(200);
      }
    }
  });

  it('o prazo aumentado fecha o aberto que voltou para dentro dele; reabre quando o prazo novo vence', async () => {
    const apa = await produto('APA lata 350ml');
    await entrada(cd, apa, '9');
    const t = await transferencia(cd, estoqueLoja1, apa, '9');
    await envelhecer(t.id, 'enviada_em', 5);
    await varrer();
    expect(await alertas(t.id)).toMatchObject([{ resolvido_em: null, dados: { dias: 5, prazo_dias: 3 } }]);
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'estoque.transferencia_alerta_dias', '10'::jsonb)`,
    );
    try {
      await varrer();
      let a = await alertas(t.id);
      expect(a).toHaveLength(1);
      expect(a[0]!.resolvido_em).not.toBeNull();
      expect(a[0]!.resolucao).toBe('Prazo do alerta alterado');
      // Ainda dentro do prazo novo: continua fechado.
      await envelhecer(t.id, 'enviada_em', 8);
      await varrer();
      expect((await alertas(t.id)).filter((x) => x.resolvido_em === null)).toEqual([]);
      // Passou do prazo novo: um alerta novo, com o prazo e os dias de agora.
      await envelhecer(t.id, 'enviada_em', 11);
      await varrer();
      a = (await alertas(t.id)).filter((x) => x.resolvido_em === null);
      expect(a).toMatchObject([{ dados: { situacao: 'em_transito', dias: 11, prazo_dias: 10 } }]);
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'estoque.transferencia_alerta_dias'",
      );
      const c = await amb
        .http()
        .post(`/api/transferencias/${t.id}/cancelar`)
        .set(bearer())
        .send({ motivo: 'Teste' });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    }
  });

  it('a varredura pula a transferência que outra transação está mudando e não reabre o alerta que ela fechou', async () => {
    const red = await produto('Red Ale garrafa');
    await entrada(cd, red, '6');
    const t = await transferencia(cd, estoqueLoja1, red, '6');
    await envelhecer(t.id, 'enviada_em', 4);
    await varrer();
    expect(await alertas(t.id)).toMatchObject([{ resolvido_em: null }]);
    // Como o cancelar: trava a transferência, muda a situação e fecha o alerta, ainda sem confirmar.
    const c = await conectar(emp.nomeBanco);
    try {
      await c.query('begin');
      await c.query('select id from transferencias_estoque where id = $1 for update', [t.id]);
      await c.query('set local session_replication_role = replica');
      await c.query(
        `update transferencias_estoque set status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'teste'
          where id = $1`,
        [t.id],
      );
      await c.query(
        `update alertas set resolvido_em = now(), resolucao = 'Transferência cancelada'
          where registro_id = $1 and resolvido_em is null`,
        [t.id],
      );
      // Sem a trava, o insert da varredura esperaria esta transação e, depois dela, gravaria um alerta novo aberto: o
      // limite falha o teste em vez de travá-lo (o `end` do finally desfaz a transação e solta a varredura).
      let limite: NodeJS.Timeout | undefined;
      const r = await Promise.race([
        varrer(),
        new Promise<never>((_, rejeitar) => {
          limite = setTimeout(() => rejeitar(new Error('A varredura esperou a transação aberta')), 10_000);
        }),
      ]).finally(() => clearTimeout(limite));
      expect(r).toMatchObject({ executada: true, falhas: [] });
      await c.query('commit');
    } finally {
      await c.end();
    }
    expect(await alertas(t.id)).toMatchObject([{ resolucao: 'Transferência cancelada' }]);
    await varrer();
    const a = await alertas(t.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.resolvido_em).not.toBeNull();
  });
});
