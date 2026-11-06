/**
 * Dia civil no fuso da empresa (ERP 1.5; `empresa.fuso_horario`) dentro do SQL. A sessão do Postgres não tem fuso
 * configurado (UTC no servidor local e nos gerenciados): `current_date` e `data::timestamptz` virariam o dia às 21:00
 * de Brasília. Uma regra só por empresa: a manutenção que toca e a projeção que desce precisam virar o dia juntas.
 */
import { sql, type SQL } from 'drizzle-orm';

const fusoDaEmpresa = sql`coalesce((select e.fuso_horario from empresa e limit 1), 'America/Sao_Paulo')`;

/** Hoje (`date`) no fuso da empresa. */
export const hojeNaEmpresa: SQL = sql`(now() at time zone ${fusoDaEmpresa})::date`;

/** Meia-noite da data (`date`) no fuso da empresa, como instante (`timestamptz`). */
export const inicioDoDiaNaEmpresa = (data: SQL): SQL =>
  sql`(${data}::timestamp at time zone ${fusoDaEmpresa})`;
