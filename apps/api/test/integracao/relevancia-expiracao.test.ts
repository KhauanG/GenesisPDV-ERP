/**
 * Expiração diária da relevância das pessoas no PDV (MD 3.5.4; Fase 1C, bloco C14): a tarefa `ExpiracaoRelevancia`
 * exclui logicamente as linhas `compra`/`delivery` mais velhas que `pdv.pessoas_meses_relevancia` (loja ?? empresa ??
 * 12 meses) e as `crediario` sem limite nem saldo, em lotes (uma transação com a trava de versão por lote), e a
 * exclusão ganha versão nova (desce como tombstone no fluxo `pessoas`, e o PDV purga a pessoa). Os outros motivos, as
 * linhas ainda válidas, o `crediario` com saldo em aberto e as já excluídas ficam como estão; a data no futuro
 * (relógio adiantado do caixa) passa a valer hoje antes da conta; a empresa que falha fica em `falhas`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpiracaoRelevancia } from '../../src/pessoas/expiracao-relevancia.js';
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
let lojaA: string;
let lojaB: string;

const mesesAtras = (m: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString();
};

async function pessoa(nome: string, limite: string | null = null): Promise<string> {
  const [p] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into pessoas (nome, tipo, limite_compras) values ($1, 'PF', $2) returning id",
    [nome, limite],
  );
  return p!.id;
}

async function relevancia(
  pessoaId: string,
  lojaId: string | null,
  motivo: string,
  ultima: string,
  excluidaEm: string | null = null,
): Promise<string> {
  const [r] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em, excluido_em)
     values ($1, $2, $3, $4, $5) returning id`,
    [pessoaId, lojaId, motivo, ultima, excluidaEm],
  );
  return r!.id;
}

/** `saldos_credito_pessoas` (a Fase 4 mantém): só o saldo em aberto importa para a expiração do `crediario`. */
async function saldo(pessoaId: string, aberto: string, excluidoEm: string | null = null): Promise<void> {
  await consultar(
    emp.nomeBanco,
    'insert into saldos_credito_pessoas (pessoa_id, saldo_aberto, excluido_em) values ($1, $2, $3)',
    [pessoaId, aberto, excluidoEm],
  );
}

const linhas = async (ids: string[]) =>
  new Map(
    (
      await consultar<{ id: string; excluido_em: Date | null; versao: string }>(
        emp.nomeBanco,
        'select id, excluido_em, versao::text from pessoas_relevancia_loja where id = any($1::uuid[])',
        [ids],
      )
    ).map((l) => [l.id, l]),
  );

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  emp = await amb.criarEmpresa();
  lojaA = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  lojaB = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  // A Loja 2 guarda o cliente só por 2 meses sem compra (a empresa fica no padrão de 12).
  await consultar(
    emp.nomeBanco,
    `insert into configuracoes (escopo, loja_id, chave, valor)
     values ('loja', $1, 'pdv.pessoas_meses_relevancia', '2'::jsonb)`,
    [lojaB],
  );
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('expiração da relevância (MD 3.5.4)', () => {
  it('exclui compra/delivery vencidas pelo prazo da loja ou da empresa e crediario sem limite nem saldo, em lotes', async () => {
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = await Promise.all([
      pessoa('CLIENTE ANTIGO'),
      pessoa('CLIENTE RECENTE'),
      pessoa('CLIENTE DA LOJA 2'),
      pessoa('CLIENTE DO DELIVERY'),
      pessoa('CREDIARIO QUITADO'),
      pessoa('CREDIARIO COM LIMITE', '150.00'),
      pessoa('CREDIARIO COM SALDO'),
      pessoa('CREDIARIO SALDO ZERO'),
      pessoa('CREDIARIO SALDO EXCLUIDO'),
    ]);
    // Sem limite próprio: o saldo em aberto (Fase 4) segura a linha; o zerado e o excluído não.
    await saldo(p7!, '30.00');
    await saldo(p8!, '0.00');
    await saldo(p9!, '45.00', mesesAtras(1));
    const vencidas = {
      compraA: await relevancia(p1!, lojaA, 'compra', mesesAtras(13)),
      compraB: await relevancia(p3!, lojaB, 'compra', mesesAtras(3)),
      delivery: await relevancia(p4!, lojaA, 'delivery', mesesAtras(13)),
      crediario: await relevancia(p5!, null, 'crediario', mesesAtras(1)),
      crediarioSaldoZero: await relevancia(p8!, null, 'crediario', mesesAtras(1)),
      crediarioSaldoExcluido: await relevancia(p9!, null, 'crediario', mesesAtras(1)),
    };
    const ficam = {
      compraRecente: await relevancia(p2!, lojaA, 'compra', mesesAtras(11)),
      // A mesma compra de 3 meses atrás vale na Loja 1 (12 meses da empresa).
      compraA3: await relevancia(p3!, lojaA, 'compra', mesesAtras(3)),
      crediarioComLimite: await relevancia(p6!, null, 'crediario', mesesAtras(30)),
      crediarioComSaldo: await relevancia(p7!, null, 'crediario', mesesAtras(30)),
      funcionario: await relevancia(p1!, null, 'funcionario', mesesAtras(30)),
      manual: await relevancia(p4!, null, 'manual', mesesAtras(30)),
    };
    const jaExcluida = await relevancia(p2!, lojaB, 'compra', mesesAtras(40), mesesAtras(20));
    const todas = [...Object.values(vencidas), ...Object.values(ficam), jaExcluida];
    const antes = await linhas(todas);

    // Lote de 2: quatro transações (2 + 2 + 2 + 0), a última confirma que não sobrou nada; sem o `limit` seria uma
    // transação com as seis e outra vazia (2 lotes).
    const tarefa = new ExpiracaoRelevancia(
      amb.servicos.controle,
      amb.servicos.resolvedor,
      amb.servicos.tenancy,
      2,
    );
    expect(await tarefa.executar()).toEqual({
      executada: true,
      empresas: 1,
      compra: 2,
      delivery: 1,
      crediario: 3,
      datasFuturasCorrigidas: 0,
      lotes: 4,
      falhas: [],
    });
    const depois = await linhas(todas);
    for (const id of Object.values(vencidas)) {
      expect(depois.get(id)!.excluido_em, id).not.toBeNull();
      // A exclusão ganha versão nova: desce como tombstone e o PDV purga a pessoa.
      expect(BigInt(depois.get(id)!.versao)).toBeGreaterThan(BigInt(antes.get(id)!.versao));
    }
    for (const id of Object.values(ficam)) expect(depois.get(id), id).toEqual(antes.get(id));
    expect(depois.get(jaExcluida)).toEqual(antes.get(jaExcluida));

    // Repetir não muda nada (a tarefa roda todo dia).
    expect(await tarefa.executar()).toMatchObject({ compra: 0, delivery: 0, crediario: 0, falhas: [] });
    expect(await linhas(todas)).toEqual(depois);
  });

  it('data no futuro (relógio adiantado do caixa) passa a valer hoje e o prazo conta daí', async () => {
    const p = await pessoa('CLIENTE DO CAIXA ADIANTADO');
    const id = await relevancia(p, lojaA, 'compra', '2028-06-01T12:00:00Z');
    const [antes] = await consultar<{ versao: string }>(
      emp.nomeBanco,
      'select versao::text from pessoas_relevancia_loja where id = $1',
      [id],
    );
    const inicio = Date.now();
    expect(await amb.servicos.expiracaoRelevancia.executar()).toMatchObject({
      datasFuturasCorrigidas: 1,
      compra: 0,
      falhas: [],
    });
    const [depois] = await consultar<{
      ultima_ocorrencia_em: Date;
      excluido_em: Date | null;
      versao: string;
    }>(
      emp.nomeBanco,
      'select ultima_ocorrencia_em, excluido_em, versao::text from pessoas_relevancia_loja where id = $1',
      [id],
    );
    expect(depois!.excluido_em).toBeNull();
    expect(depois!.ultima_ocorrencia_em.getTime()).toBeGreaterThanOrEqual(inicio - 5_000);
    expect(depois!.ultima_ocorrencia_em.getTime()).toBeLessThanOrEqual(Date.now());
    expect(BigInt(depois!.versao)).toBeGreaterThan(BigInt(antes!.versao));
    // Uma vez só: no dia seguinte a linha já não está no futuro.
    expect(await amb.servicos.expiracaoRelevancia.executar()).toMatchObject({ datasFuturasCorrigidas: 0 });
  });

  it('a empresa que falha fica em `falhas` (o trabalho da fila a registra no log e lança para o pg-boss repetir)', async () => {
    // Valor fora do padrão na configuração da loja: o cast `::int` quebra a consulta só desta empresa.
    const [cfg] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor)
       values ('loja', $1, 'pdv.pessoas_meses_relevancia', '"doze"'::jsonb) returning id`,
      [lojaA],
    );
    try {
      const p = await pessoa('CLIENTE COM CONFIGURACAO QUEBRADA');
      await relevancia(p, lojaA, 'compra', mesesAtras(13));
      const r = await amb.servicos.expiracaoRelevancia.executar();
      expect(r).toMatchObject({ executada: true, empresas: 0 });
      expect(r.falhas).toEqual([{ empresaId: emp.empresaId, erro: expect.any(String) }]);
    } finally {
      await consultar(emp.nomeBanco, 'update configuracoes set excluido_em = now() where id = $1', [cfg!.id]);
    }
  });

  it('não roda enquanto outra execução segura a trava consultiva no controle', async () => {
    const outra = await conectar(amb.bancoControle);
    try {
      await outra.query("select pg_advisory_lock(hashtext('genesis:expiracao_relevancia'))");
      expect(await amb.servicos.expiracaoRelevancia.executar()).toMatchObject({
        executada: false,
        empresas: 0,
      });
      await outra.query("select pg_advisory_unlock(hashtext('genesis:expiracao_relevancia'))");
      expect(await amb.servicos.expiracaoRelevancia.executar()).toMatchObject({
        executada: true,
        empresas: 1,
      });
    } finally {
      await outra.end();
    }
  });
});
