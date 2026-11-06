import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ErroRegraEvento, ErroTransitorioEvento, traduzirErroBanco } from './erros.js';

/** Erro no formato do `pg` (`DatabaseError`): SQLSTATE em `code`, restrição e tabela quando houver. */
const pg = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`erro ${code}`), { code, ...extra });

/** Como o Drizzle lança a falha de `tx.insert`/`tx.update`/`tx.select`: o erro do `pg` só em `.cause`. */
const drizzle = (causa: Error) => new DrizzleQueryError('insert into "vendas" ...', ['12345678900'], causa);

describe('traduzirErroBanco (SYNC 11.2, T14)', () => {
  it('unicidade: número de venda tem código próprio; as demais são AGREGADO_DIVERGENTE', () => {
    const numero = traduzirErroBanco(pg('23505', { constraint: 'uq_vendas_numero', table: 'vendas' }));
    expect(numero).toBeInstanceOf(ErroRegraEvento);
    expect(numero).toMatchObject({
      codigo: 'NUMERO_VENDA_DUPLICADO',
      detalhes: { sqlstate: '23505', restricao: 'uq_vendas_numero', tabela: 'vendas' },
    });
    expect(traduzirErroBanco(pg('23505', { constraint: 'pk_vendas', table: 'vendas' }))).toMatchObject({
      codigo: 'AGREGADO_DIVERGENTE',
    });
    expect(
      traduzirErroBanco(pg('23505', { constraint: 'uq_fechamentos_caixa_sessao_caixa_id', table: 'x' })),
    ).toMatchObject({ codigo: 'AGREGADO_DIVERGENTE' });
  });

  it('FK → REFERENCIA_INEXISTENTE; CHECK → PAYLOAD_INVALIDO', () => {
    expect(
      traduzirErroBanco(
        pg('23503', {
          constraint: 'fk_vendas_cliente_id',
          table: 'vendas',
          detail:
            'Key (cliente_id)=(0190a1b2-0000-7000-8000-000000000000) is not present in table "pessoas".',
        }),
      ),
    ).toMatchObject({ codigo: 'REFERENCIA_INEXISTENTE', detalhes: { colunas: ['cliente_id'] } });
    expect(traduzirErroBanco(pg('23514', { constraint: 'ck_vendas_total', table: 'vendas' }))).toMatchObject({
      codigo: 'PAYLOAD_INVALIDO',
    });
  });

  it('nunca copia o detail do PostgreSQL (valores da chave, linha inteira do CHECK) para os detalhes', () => {
    const unico = traduzirErroBanco(
      pg('23505', {
        constraint: 'uq_pessoas_cpf_cnpj',
        table: 'pessoas',
        detail: 'Key (cpf_cnpj)=(12345678900) already exists.',
      }),
    );
    expect(unico).toMatchObject({
      detalhes: {
        sqlstate: '23505',
        restricao: 'uq_pessoas_cpf_cnpj',
        tabela: 'pessoas',
        colunas: ['cpf_cnpj'],
      },
    });
    const composta = traduzirErroBanco(
      pg('23505', {
        constraint: 'uq_x',
        table: 'x',
        detail: 'Key (loja_id, lower(nome::text))=(a, b) already exists.',
      }),
    );
    expect(composta).toMatchObject({ detalhes: { colunas: ['loja_id', 'lower(nome::text)'] } });
    const check = traduzirErroBanco(
      pg('23514', {
        constraint: 'ck_pessoas_cpf_cnpj',
        table: 'pessoas',
        detail: 'Failing row contains (…, Maria da Silva, 12345678900, (41) 99999-0000, …).',
      }),
    );
    expect(check).toMatchObject({ detalhes: { colunas: null } });
    for (const e of [unico, composta, check]) {
      expect(JSON.stringify((e as ErroRegraEvento).detalhes)).not.toMatch(
        /12345678900|Maria|already|Failing/,
      );
    }
  });

  it('lê o erro do pg por trás do DrizzleQueryError (consultas feitas pelo tx do Drizzle)', () => {
    const numero = traduzirErroBanco(
      drizzle(pg('23505', { constraint: 'uq_vendas_numero', table: 'vendas' })),
    );
    expect(numero).toMatchObject({ codigo: 'NUMERO_VENDA_DUPLICADO', detalhes: { sqlstate: '23505' } });
    expect(traduzirErroBanco(drizzle(pg('23503', { constraint: 'fk_vendas_cliente_id' })))).toMatchObject({
      codigo: 'REFERENCIA_INEXISTENTE',
    });
    expect(traduzirErroBanco(drizzle(pg('23514', { table: 'auditoria' })))).toMatchObject({
      codigo: 'PAYLOAD_INVALIDO',
    });
    expect(traduzirErroBanco(drizzle(pg('40P01')))).toMatchObject({ codigo: 'CONCORRENCIA_BANCO' });
    expect(traduzirErroBanco(drizzle(pg('23505', { table: 'eventos_recebidos' })))).toBeNull();
    expect(traduzirErroBanco(drizzle(new TypeError('x')))).toBeNull();
  });

  it('deadlock, serialização e conexão são transitórios (não contam para ERRO_INTERNO)', () => {
    for (const code of ['40P01', '40001']) {
      const t = traduzirErroBanco(pg(code));
      expect(t).toBeInstanceOf(ErroTransitorioEvento);
      expect(t).toMatchObject({ codigo: 'CONCORRENCIA_BANCO' });
    }
    for (const code of ['08006', '57P01']) {
      expect(traduzirErroBanco(pg(code))).toMatchObject({ codigo: 'BANCO_INDISPONIVEL' });
    }
  });

  it('conexão perdida no driver, sem SQLSTATE, também é BANCO_INDISPONIVEL', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']) {
      expect(traduzirErroBanco(pg(code))).toMatchObject({ codigo: 'BANCO_INDISPONIVEL' });
    }
    // Como o pg 8 cria a queda no meio da conexão: `new Error(...)` sem `code`.
    for (const mensagem of [
      'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout',
      'Client has encountered a connection error and is not queryable',
      'timeout exceeded when trying to connect',
    ]) {
      expect(traduzirErroBanco(new Error(mensagem))).toMatchObject({ codigo: 'BANCO_INDISPONIVEL' });
      expect(traduzirErroBanco(drizzle(new Error(mensagem)))).toBeInstanceOf(ErroTransitorioEvento);
    }
  });

  it('tabelas do protocolo, outros SQLSTATE e erros sem código seguem como falha não classificada', () => {
    expect(traduzirErroBanco(pg('23505', { table: 'eventos_recebidos' }))).toBeNull();
    expect(traduzirErroBanco(pg('23503', { table: 'entidades_evento' }))).toBeNull();
    expect(traduzirErroBanco(pg('42P01'))).toBeNull();
    expect(traduzirErroBanco(pg('ENOENT'))).toBeNull();
    // Mensagem parecida, mas com SQLSTATE: vale o SQLSTATE.
    expect(traduzirErroBanco(pg('42P01', { message: 'Connection terminated' }))).toBeNull();
    expect(traduzirErroBanco(new TypeError('x'))).toBeNull();
    expect(traduzirErroBanco(undefined)).toBeNull();
  });

  it('erro já classificado passa como está', () => {
    const regra = new ErroRegraEvento('SESSAO_INEXISTENTE', 'x');
    expect(traduzirErroBanco(regra)).toBe(regra);
  });
});
