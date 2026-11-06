/**
 * Bancos e travas dos servidores do e2e do PDV (`servidor.ts`, do CI, e `ensaio-piloto.ts`, o ensaio local com a
 * planilha real, implantação I5): o banco de controle próprio, o bloco de 1.000 códigos de empresa na faixa
 * 600000–699999 sob uma trava consultiva até o fim do processo (dois e2e ao mesmo tempo nunca sorteiam o mesmo bloco,
 * o mesmo esquema do `ambiente.ts`) e a limpeza do que o processo criou: as empresas do bloco e as roles delas, o
 * controle e a aplicação. Restos de um processo morto à força (`kill -9`) saem com `pnpm --filter api test:limpar`.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type pg from 'pg';
import { conectar, consultar, FAIXA_E2E_PDV } from '../integracao/ambiente.js';

const TRAVA_FAIXA = 'genesis:e2e-pdv:faixa';

export class RecursosE2ePdv {
  readonly bancoControle = `genesis_e2epdv_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_ctl`;
  private trava: pg.Client | null = null;
  private bloco: number | null = null;
  private controle = false;
  /** A aplicação Nest escutando (fechada antes de apagar os bancos). */
  app: { close(): Promise<void> } | null = null;

  /** Bloco de 1.000 códigos sem banco de empresa no servidor; devolve o primeiro código do bloco. */
  async reservarBloco(): Promise<number> {
    const trava = await conectar('postgres');
    this.trava = trava;
    for (let i = 0; i < 50; i++) {
      const bloco = randomInt(FAIXA_E2E_PDV.inicio / 1000, (FAIXA_E2E_PDV.fim + 1) / 1000) * 1000;
      const { rows: lock } = await trava.query<{ ok: boolean }>(
        'select pg_try_advisory_lock(hashtext($1), $2) as ok',
        [TRAVA_FAIXA, bloco],
      );
      if (!lock[0]?.ok) continue;
      const { rows } = await trava.query<{ n: number }>(
        `select count(*)::int as n from pg_database
         where datname ~ '^genesis_emp_[0-9]+$' and substring(datname from 13)::int between $1 and $2`,
        [bloco, bloco + 999],
      );
      if (rows[0]?.n === 0) {
        this.bloco = bloco;
        return bloco;
      }
      await trava.query('select pg_advisory_unlock(hashtext($1), $2)', [TRAVA_FAIXA, bloco]);
    }
    throw new Error('Sem faixa de códigos livre para o e2e do PDV');
  }

  /** A partir daqui a limpeza apaga o banco de controle (chamar antes de criá-lo). */
  marcarControle(): void {
    this.controle = true;
  }

  /** Apaga o que foi criado (idempotente): a aplicação, as empresas do bloco e as roles delas e o controle. */
  async limpar(): Promise<void> {
    await this.app?.close().catch(() => undefined);
    if (this.bloco !== null) {
      // O bloco é deste processo (trava consultiva): toda empresa nele foi criada aqui, até a de um provisionamento
      // que falhou no meio.
      const empresas = await consultar<{ datname: string }>(
        'postgres',
        `select datname from pg_database
         where datname ~ '^genesis_emp_[0-9]{6}$' and substring(datname from 13)::int between $1 and $2`,
        [this.bloco, this.bloco + 999],
      );
      for (const { datname } of empresas) {
        await consultar('postgres', `drop database if exists "${datname}" with (force)`);
      }
      const roles = await consultar<{ rolname: string }>(
        'postgres',
        `select rolname from pg_roles
         where rolname ~ '^genesis_emp_[0-9]{6}_app$' and substring(rolname from 13 for 6)::int between $1 and $2`,
        [this.bloco, this.bloco + 999],
      );
      for (const { rolname } of roles) await consultar('postgres', `drop role if exists "${rolname}"`);
    }
    if (this.controle) {
      await consultar('postgres', `drop database if exists "${this.bancoControle}" with (force)`);
    }
    await this.trava?.end().catch(() => undefined);
  }
}
