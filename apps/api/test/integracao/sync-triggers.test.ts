/**
 * `pnpm --filter api test:sync-triggers` (MD 1.5): toda tabela do registro de fluxos do pull (`src/sync/fluxos.ts`)
 * precisa do trigger `tg_<tabela>_versao` com `fn_versao` (trava de ordenação) e do índice `ix_<tabela>_versao`;
 * com `fn_versao_local` ou sem trigger, o cursor do PDV poderia pular linhas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTRO_FLUXOS, TABELAS_DOS_FLUXOS, nomeTabela } from '../../src/sync/fluxos.js';
import { consultar, criarAmbiente, type Ambiente, type EmpresaTeste } from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  emp = await amb.criarEmpresa();
});

afterAll(async () => {
  await amb?.fechar();
});

describe('triggers das tabelas do pull (MD 1.5)', () => {
  it('toda tabela registrada num fluxo usa fn_versao e tem ix_<tabela>_versao', async () => {
    const triggers = await consultar<{ tabela: string; funcao: string }>(
      emp.nomeBanco,
      `select c.relname as tabela, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and t.tgname = 'tg_' || c.relname || '_versao'`,
    );
    const indices = new Set(
      (
        await consultar<{ indexname: string }>(
          emp.nomeBanco,
          "select indexname from pg_indexes where schemaname = 'public' and indexname like 'ix\\_%\\_versao'",
        )
      ).map((i) => i.indexname),
    );
    const mapa = new Map(triggers.map((t) => [t.tabela, t.funcao]));
    expect(TABELAS_DOS_FLUXOS.length).toBeGreaterThan(0);
    for (const tabela of TABELAS_DOS_FLUXOS) {
      expect(mapa.get(tabela), `${tabela}: trigger tg_${tabela}_versao`).toBe('fn_versao');
      expect(indices.has(`ix_${tabela}_versao`), `${tabela}: índice ix_${tabela}_versao`).toBe(true);
    }
  });

  it('nenhuma tabela aparece em dois fluxos (cada linha desce por um único cursor)', () => {
    const vistos = new Map<string, string>();
    for (const [fluxo, tabelas] of Object.entries(REGISTRO_FLUXOS)) {
      for (const t of tabelas) {
        const nome = nomeTabela(t.tabela);
        expect(vistos.get(nome), `${nome} em ${vistos.get(nome)} e ${fluxo}`).toBeUndefined();
        vistos.set(nome, fluxo);
      }
    }
  });
});
