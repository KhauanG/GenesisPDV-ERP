/**
 * `GET /sync/consultas/saldos-outras-lojas` (Fase 2, F2-B35; F2-Q12 = roadmap D53; PDV 10.3; SYNC 1.4, 20.2), pelas
 * rotas reais: o escopo da recomendação (as lojas reais ativas, a loja do tipo depósito — o CD real da Ice Beer, MD
 * Implantação — e os depósitos sem loja, sem a loja de treino, a loja inativa e o estoque sem loja que não é depósito;
 * só os tipos vendáveis, somados com os das variações; o local sem saldo com zero), a ordem (a loja do terminal, as
 * outras pelo código, a loja depósito pelo código e os depósitos sem loja pelo nome) e nenhum custo; o combo, o serviço
 * e o produzido marcados sem controle; a chave `pdv.consulta_outras_lojas` desligada na loja (403); o token de outra
 * empresa, o forjado, o hardware divergente e o terminal revogado recusados; o terminal em desativação recusado como no
 * pull (403 sem `detalhes.chave`); o produto desconhecido 404 com o `produto_id`; e o limite por terminal (429 com
 * `Retry-After`).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { respostaSaldosOutrasLojasSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const ROTA = '/sync/consultas/saldos-outras-lojas';

let amb: Ambiente;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.11.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

interface Empresa {
  emp: EmpresaTeste;
  tokenAdmin: string;
  numeroCaixa: number;
}

interface Ponto {
  terminal: string;
  token: string;
  numero: number;
}

async function novaEmpresa(): Promise<Empresa> {
  const emp = await amb.criarEmpresa();
  return { emp, tokenAdmin: await amb.entrar(emp.codigo, 'admin', emp.senha), numeroCaixa: 0 };
}

async function novoPonto(e: Empresa, loja: string): Promise<Ponto> {
  const numero = ++e.numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    e.emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set({ Authorization: `Bearer ${e.tokenAdmin}` })
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: e.emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { terminal: r.body.terminal_id as string, token: r.body.token as string, numero };
}

const consultarSaldos = (tk: string, produto: string, extra: Record<string, string> = {}) =>
  amb
    .http()
    .get(`${ROTA}?produto_id=${produto}`)
    .set({ ...cabecalhos(tk), ...extra });

async function saldosOk(tk: string, produto: string) {
  const r = await consultarSaldos(tk, produto);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.headers['x-agora-servidor']).toBeTruthy();
  // `strictObject`: campo a mais (um custo, por exemplo) quebra aqui, além do record C# do PDV.
  return respostaSaldosOutrasLojasSchema.parse(r.body);
}

/**
 * Estoque e lojas do teste: Loja 1 (do caixa), 2 e 3, a Treino, uma inativa, a loja do tipo depósito (código 4, o
 * formato do CD real), um depósito sem loja e um estoque "outro" sem loja. Os nomes dos depósitos invertem a ordem
 * alfabética ("Galpão" depois de "CD"), para a ordem pelo código da loja depósito aparecer.
 */
let a: Empresa;
let loja1: string;
let loja2: string;
let loja3: string;
let estoque: Record<'l1' | 'l2' | 'l3' | 'treino' | 'inativa' | 'galpao' | 'cd' | 'outro', string>;
let produto: string;
let variacao: string;
let servico: string;
let combo: string;
let produzido: string;
let ponto: Ponto;

const estoqueDaLoja = async (loja: string) =>
  (
    (await consultar<{ id: string }>(a.emp.nomeBanco, 'select estoque_id as id from lojas where id = $1', [
      loja,
    ])) as [{ id: string }]
  )[0].id;

async function saldo(
  estoqueId: string,
  chaveTipo: string,
  quantidade: string,
  variacao: string | null = null,
) {
  await consultar(
    a.emp.nomeBanco,
    `insert into saldos_estoque (estoque_id, produto_id, variacao_id, tipo_estoque_id, quantidade, custo_medio)
     values ($1, $2, $3, (select id from tipos_estoque where chave_sistema = $4), $5, '7.7700')`,
    [estoqueId, produto, variacao, chaveTipo, quantidade],
  );
}

beforeAll(async () => {
  amb = await criarAmbiente();
  a = await novaEmpresa();
  loja1 = await criarLoja(a.emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(a.emp.nomeBanco, 2, 'Petiscaria 2');
  loja3 = await criarLoja(a.emp.nomeBanco, 3, 'Loja 3');
  const treino = await criarLoja(a.emp.nomeBanco, 9, 'Loja Treino');
  await consultar(a.emp.nomeBanco, 'update lojas set treino = true where id = $1', [treino]);
  const inativa = await criarLoja(a.emp.nomeBanco, 8, 'Loja Fechada');
  await consultar(a.emp.nomeBanco, 'update lojas set ativa = false where id = $1', [inativa]);
  const galpao = await criarLoja(a.emp.nomeBanco, 4, 'Galpão 4 - CD Ice Beer');
  await consultar(a.emp.nomeBanco, "update lojas set tipo = 'deposito', usa_pdv = false where id = $1", [
    galpao,
  ]);
  await consultar(
    a.emp.nomeBanco,
    "update estoques set tipo = 'deposito' where id = (select estoque_id from lojas where id = $1)",
    [galpao],
  );
  const [{ id: cd }] = (await consultar<{ id: string }>(
    a.emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  )) as [{ id: string }];
  const [{ id: outro }] = (await consultar<{ id: string }>(
    a.emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('Estoque de eventos', 'outro') returning id",
  )) as [{ id: string }];
  estoque = {
    l1: await estoqueDaLoja(loja1),
    l2: await estoqueDaLoja(loja2),
    l3: await estoqueDaLoja(loja3),
    treino: await estoqueDaLoja(treino),
    inativa: await estoqueDaLoja(inativa),
    galpao: await estoqueDaLoja(galpao),
    cd,
    outro,
  };

  const unidades = (
    await amb
      .http()
      .get('/api/referencias/unidades')
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
  ).body as Array<{ id: string; sigla: string }>;
  const un = unidades.find((u) => u.sigla === 'UN')!.id;
  const criar = async (nome: string, extra: Record<string, unknown> = {}) => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({ nome, unidadeId: un, precoVenda: '9.9', precoCusto: '7.77', ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  produto = await criar('CERVEJA LATA 350 TESTE');
  servico = await criar('TAXA DE ENTREGA TESTE', { tipo: 'servico', controlaEstoque: false });
  // O combo e o produzido nascem com `controla_estoque` (o padrão da coluna): o falso da resposta vem do tipo.
  const insumo = await criar('LIMAO TAHITI TESTE', { tipo: 'materia_prima', precoVenda: '0' });
  combo = await criar('COMBO CERVEJA E GELO TESTE', {
    tipo: 'kit',
    componentes: [{ tipo: 'kit', componenteId: produto, quantidade: '2' }],
  });
  produzido = await criar('CAIPIRINHA TESTE', {
    tipo: 'produzido',
    usaFichaTecnica: true,
    componentes: [{ tipo: 'ficha_tecnica', componenteId: insumo, quantidade: '1' }],
  });
  [{ id: variacao }] = (await consultar<{ id: string }>(
    a.emp.nomeBanco,
    "insert into produtos_variacoes (produto_id, nome) values ($1, 'LATA GELADA') returning id",
    [produto],
  )) as [{ id: string }];

  // Loja 2: 10 vendáveis + 5 na variação + 4 em avaria (não vendável); Loja 3: -2 (vendeu sem estoque); a loja
  // depósito só com saldo na variação (30); CD: 120,5 e 3 em avaria; a Treino, a inativa e o "outro" com saldo que não
  // pode aparecer; a Loja 1 sem linha nenhuma.
  await saldo(estoque.l2, 'disponivel', '10');
  await saldo(estoque.l2, 'disponivel', '5', variacao);
  await saldo(estoque.galpao, 'disponivel', '30', variacao);
  await saldo(estoque.l2, 'avaria', '4');
  await saldo(estoque.l3, 'disponivel', '-2');
  await saldo(estoque.cd, 'disponivel', '120.5');
  await saldo(estoque.cd, 'avaria', '3');
  await saldo(estoque.treino, 'disponivel', '999');
  await saldo(estoque.inativa, 'disponivel', '55');
  await saldo(estoque.outro, 'disponivel', '77');
  ponto = await novoPonto(a, loja1);
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('GET /sync/consultas/saldos-outras-lojas (F2-B35)', () => {
  it('lojas reais e o CD, só o vendável, a loja do terminal primeiro; nenhum custo', async () => {
    const r = await saldosOk(ponto.token, produto);
    expect(r.produto_id).toBe(produto);
    expect(r.controla_estoque).toBe(true);
    expect(r.locais).toEqual([
      {
        estoque_id: estoque.l1,
        tipo: 'loja',
        loja_codigo: 1,
        nome: 'Loja 1 - Centro',
        loja_do_terminal: true,
        quantidade: '0.000',
      },
      {
        estoque_id: estoque.l2,
        tipo: 'loja',
        loja_codigo: 2,
        nome: 'Petiscaria 2',
        loja_do_terminal: false,
        // O pai (10) e a variação (5): a soma é de todas as variações.
        quantidade: '15.000',
      },
      {
        estoque_id: estoque.l3,
        tipo: 'loja',
        loja_codigo: 3,
        nome: 'Loja 3',
        loja_do_terminal: false,
        quantidade: '-2.000',
      },
      // A loja do tipo depósito sai como depósito, com o código, antes dos depósitos sem loja (o nome não conta);
      // só tem saldo na variação.
      {
        estoque_id: estoque.galpao,
        tipo: 'deposito',
        loja_codigo: 4,
        nome: 'Galpão 4 - CD Ice Beer',
        loja_do_terminal: false,
        quantidade: '30.000',
      },
      {
        estoque_id: estoque.cd,
        tipo: 'deposito',
        loja_codigo: null,
        nome: 'CD - Estoque Ice Beer',
        loja_do_terminal: false,
        quantidade: '120.500',
      },
    ]);
    // O custo médio gravado nas linhas (7,77) e o preço de custo do produto não saem em lugar nenhum da resposta.
    const corpo = JSON.stringify(r);
    expect(corpo).not.toMatch(/7\.77|custo/);

    // O produto sem saldo próprio (serviço, combo e produzido) vem marcado, com os locais zerados: o caixa mostra a
    // nota "não controla estoque", e não um zero que diria que nenhuma loja tem.
    for (const semSaldo of [servico, combo, produzido]) {
      const s = await saldosOk(ponto.token, semSaldo);
      expect(s.controla_estoque, semSaldo).toBe(false);
      expect(s.locais.map((l) => l.quantidade)).toEqual(['0.000', '0.000', '0.000', '0.000', '0.000']);
    }
  });

  it('terminal em desativação recusado como no pull (403 sem detalhes.chave)', async () => {
    const p = await novoPonto(a, loja2);
    await saldosOk(p.token, produto);
    const rev = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set({ Authorization: `Bearer ${a.tokenAdmin}` })
      .send({ modo: 'aceitar_pendencias' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const r = await consultarSaldos(p.token, produto);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.erro.codigo).toBe('ESCOPO_INVALIDO');
    // Sem `detalhes.chave`: o caixa não confunde com a chave desligada.
    expect(r.body.erro.detalhes).toEqual({});
  });

  it('a chave desligada na loja do terminal recusa (403); em outra loja continua valendo', async () => {
    const outra = await novoPonto(a, loja2);
    await consultar(
      a.emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor) values ('loja', $1, 'pdv.consulta_outras_lojas', 'false'::jsonb)`,
      [loja1],
    );
    try {
      const r = await consultarSaldos(ponto.token, produto);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.erro.codigo).toBe('ESCOPO_INVALIDO');
      expect(r.body.erro.detalhes).toEqual({ chave: 'pdv.consulta_outras_lojas' });
      const daLoja2 = await saldosOk(outra.token, produto);
      expect(daLoja2.locais.filter((l) => l.loja_do_terminal).map((l) => l.loja_codigo)).toEqual([2]);
    } finally {
      await consultar(a.emp.nomeBanco, `delete from configuracoes where chave = 'pdv.consulta_outras_lojas'`);
    }
  });

  it('query inválida 400; produto desconhecido 404 com o produto_id (a rota existe)', async () => {
    for (const q of ['', 'produto_id=abc']) {
      const r = await amb.http().get(`${ROTA}?${q}`).set(cabecalhos(ponto.token));
      expect(r.status, `${q}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
    }
    const desconhecido = uuidv7();
    const r = await consultarSaldos(ponto.token, desconhecido);
    expect(r.status).toBe(404);
    expect(r.body.erro).toMatchObject({ codigo: 'NAO_ENCONTRADO', detalhes: { produto_id: desconhecido } });
  });

  it('token de outra empresa só vê a própria; o forjado, o hardware divergente e o revogado são recusados', async () => {
    const b = await novaEmpresa();
    const lojaB = await criarLoja(b.emp.nomeBanco, 1, 'Loja da outra empresa');
    const pontoB = await novoPonto(b, lojaB);
    // O produto da empresa A não existe no banco da B: a empresa vem do token, nunca do pedido.
    const deB = await consultarSaldos(pontoB.token, produto);
    expect(deB.status).toBe(404);
    // O id do terminal da A com o segredo do token da B: não autentica.
    const forjado = `${ponto.terminal}.${pontoB.token.split('.')[1]}`;
    const f = await consultarSaldos(forjado, produto);
    expect(f.status).toBe(401);
    expect(f.body.erro.codigo).toBe('TOKEN_INVALIDO');

    // SYNC 20.5: a cópia do token em outra máquina não lê o estoque da empresa.
    const hw = await consultarSaldos(ponto.token, produto, { 'X-Genesis-Id-Hardware': 'f'.repeat(64) });
    expect(hw.status, JSON.stringify(hw.body)).toBe(409);
    expect(hw.body.erro.codigo).toBe('HARDWARE_ALTERADO');

    const rev = await amb
      .http()
      .post(`/api/terminais/${pontoB.terminal}/revogar`)
      .set({ Authorization: `Bearer ${b.tokenAdmin}` })
      .send({ modo: 'imediato', confirmacaoCaixa: pontoB.numero });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const r = await consultarSaldos(pontoB.token, produto);
    expect(r.status).toBe(401);
    expect(r.body.erro.codigo).toBe('TERMINAL_REVOGADO');
  });

  it('limite por terminal: acima dele 429 com Retry-After; outro terminal segue consultando', async () => {
    const anterior = process.env.SYNC_CONSULTA_SALDOS_POR_MINUTO;
    process.env.SYNC_CONSULTA_SALDOS_POR_MINUTO = '3';
    try {
      const p = await novoPonto(a, loja3);
      for (let i = 0; i < 3; i++) await saldosOk(p.token, produto);
      const r = await consultarSaldos(p.token, produto);
      expect(r.status, JSON.stringify(r.body)).toBe(429);
      expect(r.body.erro.codigo).toBe('LIMITE_TAXA');
      expect(r.headers['retry-after']).toBe('60');
      // O limite é do terminal, não da empresa nem do IP (os caixas de uma loja saem pelo mesmo IP).
      const outro = await novoPonto(a, loja3);
      await saldosOk(outro.token, produto);
    } finally {
      if (anterior === undefined) delete process.env.SYNC_CONSULTA_SALDOS_POR_MINUTO;
      else process.env.SYNC_CONSULTA_SALDOS_POR_MINUTO = anterior;
    }
  });
});
