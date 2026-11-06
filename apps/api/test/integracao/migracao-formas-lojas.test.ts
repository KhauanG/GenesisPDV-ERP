/**
 * Migração 0014 (Fase 1C, bloco C8b) sobre um banco já populado com o esquema da 0013: os vínculos de loja nascem da
 * `loja_id` antiga (o da loja excluída já excluído, e a forma que só valia nela excluída também) e as descrições
 * repetidas em lojas diferentes são renomeadas sem colidir com um nome já em uso nem entre si depois do corte em 40
 * caracteres — a descrição passa a ser única na empresa e uma colisão abortaria a migração daquele banco.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { conectar, consultar, urlDoBanco } from './ambiente.js';

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m14`;
let c: pg.Client;

/** 40 caracteres, iguais até o 31º: o corte para o sufixo " (loja 2)" (9) deixa as duas com o mesmo nome. */
const LONGA_A = 'Cartao Convenio Associacao Come-A-123456789';
const LONGA_B = 'Cartao Convenio Associacao Come-B-123456789';

let loja2: string;
let loja3Excluida: string;

async function loja(codigo: number, excluida = false): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro,
       municipio_ibge, uf, excluido_em)
     values ($1, $2, $2, $2, $3, (select id from estoques limit 1), '01001000', 'Praça da Sé', '1', 'Sé', 3550308, 'SP',
       $4) returning id`,
    [codigo, `Loja ${codigo}`, `${codigo}`.padStart(14, '1'), excluida ? new Date() : null],
  );
  return rows[0]!.id;
}

async function forma(descricao: string, lojaId: string | null, ordem = 0): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into formas_pagamento (descricao, tipo_forma, meio_pagamento_fiscal, loja_id, ordem)
     values ($1, 'outros', '99', $2, $3) returning id`,
    [descricao.slice(0, 40), lojaId, ordem],
  );
  return rows[0]!.id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
  const corte = migracoes.findIndex((m) => m.tag === '0014_formas_pagamento_lojas');
  expect(corte).toBeGreaterThan(0);
  await aplicarMigracoes(c, migracoes.slice(0, corte));

  // Esquema da 0013: a forma tem uma loja só (`loja_id`, nula = todas) e a descrição é única por loja.
  await c.query(`insert into ufs (sigla, codigo_ibge, nome) values ('SP', 35, 'São Paulo')`);
  await c.query(`insert into municipios (codigo_ibge, nome, uf) values (3550308, 'São Paulo', 'SP')`);
  await c.query(`insert into meios_pagamento_fiscais (codigo, descricao) values ('99', 'Outros')`);
  await c.query(`insert into estoques (nome) values ('Estoque')`);
  loja2 = await loja(2);
  loja3Excluida = await loja(3, true);

  ids.ticketTodas = await forma('Ticket', null, 1);
  ids.ticketLoja2 = await forma('Ticket', loja2, 2);
  // Já existe "Ticket (loja 2)" na loja 2: o nome gerado para a de cima colidiria no índice antigo.
  ids.ticketJaRenomeado = await forma('Ticket (loja 2)', loja2, 3);
  ids.longaATodas = await forma(LONGA_A, null, 4);
  ids.longaBTodas = await forma(LONGA_B, null, 5);
  ids.longaALoja2 = await forma(LONGA_A, loja2, 6);
  ids.longaBLoja2 = await forma(LONGA_B, loja2, 7);
  ids.soNaExcluida = await forma('Fiado da Loja 3', loja3Excluida, 8);
  ids.dinheiro = await forma('Dinheiro', null, 0);

  await aplicarMigracoes(c, migracoes);
});

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
});

describe('migração 0014 sobre formas por loja já cadastradas (C8b)', () => {
  it('renomeia as repetidas sem colidir: contador no sufixo quando o nome já existe ou o corte iguala', async () => {
    const { rows } = await c.query<{ id: string; descricao: string }>(
      'select id, descricao from formas_pagamento where excluido_em is null',
    );
    const nome = new Map(rows.map((r) => [r.id, r.descricao]));
    expect(nome.get(ids.ticketTodas!)).toBe('Ticket');
    expect(nome.get(ids.ticketJaRenomeado!)).toBe('Ticket (loja 2)');
    expect(nome.get(ids.ticketLoja2!)).toBe('Ticket (loja 2-2)');
    expect(nome.get(ids.longaATodas!)).toBe(LONGA_A.slice(0, 40));
    expect(nome.get(ids.longaBTodas!)).toBe(LONGA_B.slice(0, 40));
    const longas = [nome.get(ids.longaALoja2!)!, nome.get(ids.longaBLoja2!)!];
    expect(longas).toEqual([`${LONGA_A.slice(0, 31)} (loja 2)`, `${LONGA_A.slice(0, 29)} (loja 2-2)`]);
    for (const n of nome.values()) expect(n.length).toBeLessThanOrEqual(40);
    // Única na empresa: o índice novo existe e nenhuma descrição viva se repete.
    expect(new Set([...nome.values()].map((n) => n.toLowerCase())).size).toBe(nome.size);
  });

  it('vínculos da loja antiga; o da loja excluída nasce excluído e a forma que só valia nela sai também', async () => {
    const { rows } = await c.query<{ forma: string; loja: string | null; excluido: boolean }>(
      `select forma_pagamento_id as forma, loja_id as loja, excluido_em is not null as excluido
         from formas_pagamento_lojas`,
    );
    const de = (f: string) => rows.filter((r) => r.forma === f);
    expect(de(ids.dinheiro!)).toEqual([{ forma: ids.dinheiro, loja: null, excluido: false }]);
    expect(de(ids.ticketLoja2!)).toEqual([{ forma: ids.ticketLoja2, loja: loja2, excluido: false }]);
    expect(de(ids.soNaExcluida!)).toEqual([{ forma: ids.soNaExcluida, loja: loja3Excluida, excluido: true }]);
    const [f] = (
      await c.query<{ excluido: boolean }>(
        'select excluido_em is not null as excluido from formas_pagamento where id = $1',
        [ids.soNaExcluida],
      )
    ).rows;
    expect(f).toEqual({ excluido: true });
  });
});
