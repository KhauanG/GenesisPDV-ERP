/**
 * Consultas online do caixa dentro do `/sync/*` (Fase 2, F2-B35; PDV 10.3; SYNC 1.4, 20.2): o mesmo token do terminal,
 * a mesma exclusão do prefixo `/api` e o mesmo envelope de erro do protocolo. São só leitura e ficam **fora do T13**:
 * não há tipo de evento nem versão nova em `versoes_schema`, e a API antiga responde 404 (o caixa mostra "requer
 * conexão" e a venda segue).
 *
 * `GET /sync/consultas/saldos-outras-lojas?produto_id=` — o F4 "Outras lojas" da pesquisa F2 (F2-Q12 = roadmap D53,
 * vale a recomendação): o saldo do produto nos tipos de estoque **vendáveis** das lojas reais ativas (sem a loja de
 * treino, D39) e dos depósitos sem loja (o CD), liberado a qualquer operador do caixa (o principal é o terminal; nenhum
 * operador vai no pedido) e desligável por `pdv.consulta_outras_lojas` na loja do terminal. **Só quantidades**: nem o
 * custo médio nem o último custo saem daqui. Exige o hardware registrado (`exigirHardware`) e tem limite de chamadas
 * por terminal (`SYNC_CONSULTA_SALDOS_POR_MINUTO`, padrão 30 por minuto).
 */
import {
  CHAVE_CONSULTA_OUTRAS_LOJAS,
  TIPOS_SEM_SALDO_PROPRIO,
  type TIPOS_LOCAL_SALDO_ONLINE,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente } from '../comum/limites-processo.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { RespostaSaldosOutrasLojas, SaldosOutrasLojasQuery } from './contratos.js';
import { ErroSync } from './erros.js';
import type { TerminalAutenticado } from './terminal.js';

/** Consultas por minuto de um terminal (o operador aperta F4 produto a produto; acima disso é laço ou abuso). */
export const CONSULTAS_SALDOS_POR_MINUTO_PADRAO = 30;

/**
 * Tipos que saem com `controla_estoque = false`: os sem saldo próprio da lista única do shared (combo, serviço e
 * produzido, cuja venda baixa os insumos da ficha técnica, decisão 91), menos o "Com variações": o saldo dele é o das
 * variações, que gravam o `produto_id` do pai, e a soma delas é o que o F4 mostra.
 */
const TIPOS_SEM_SALDO_NA_CONSULTA = TIPOS_SEM_SALDO_PROPRIO.filter((t) => t !== 'com_variacoes');

interface LinhaLocal extends Record<string, unknown> {
  estoque_id: string;
  tipo: (typeof TIPOS_LOCAL_SALDO_ONLINE)[number];
  loja_codigo: number | null;
  nome: string;
  loja_do_terminal: boolean;
  quantidade: string;
}

export class ConsultasSync {
  constructor(private readonly tenancy: Tenancy) {}

  async saldosOutrasLojas(
    terminal: TerminalAutenticado,
    q: SaldosOutrasLojasQuery,
  ): Promise<RespostaSaldosOutrasLojas> {
    // SYNC 3.8: o terminal em desativação não vende mais; como no pull, só o acesso e a configuração. O `desativando`
    // de uma substituição em andamento já chega como `ativo` e consulta normalmente.
    if (terminal.status === 'desativando') {
      throw ErroSync.escopo('Terminal em desativação não consulta o estoque das outras lojas.');
    }
    limitarPorTerminal(terminal);
    return this.tenancy.cx().consulta(async (db) => {
      if ((await lerConfiguracao<boolean>(db, CHAVE_CONSULTA_OUTRAS_LOJAS, terminal.lojaId)) === false) {
        throw new ErroSync(
          'ESCOPO_INVALIDO',
          'Consulta de saldo das outras lojas desligada no ERP para esta loja.',
          {
            chave: CHAVE_CONSULTA_OUTRAS_LOJAS,
          },
        );
      }
      const { rows: produto } = await db.execute<{ controla: boolean }>(sql`
        select p.controla_estoque
               and p.tipo not in (${sql.join(
                 TIPOS_SEM_SALDO_NA_CONSULTA.map((t) => sql`${t}`),
                 sql`, `,
               )}) as controla
          from produtos p where p.id = ${q.produto_id} and p.excluido_em is null`);
      if (!produto[0]) {
        // `detalhes.produto_id` separa este 404 do da rota que a API antiga não tem (o caixa diz "requer conexão").
        throw new ErroSync('NAO_ENCONTRADO', 'Produto não encontrado na nuvem.', {
          produto_id: q.produto_id,
        });
      }
      // Locais: o estoque de cada loja ativa e não de treino (pelo vínculo `lojas.estoque_id`, um por loja) e os
      // depósitos sem loja; o estoque `loja`/`outro` sem loja fica fora. A soma é das linhas de saldo dos tipos
      // vendáveis do produto, em todas as variações; o local sem linha vem com zero (o operador vê que não tem). Ordem: a
      // loja do terminal, as outras lojas pelo código e os depósitos — primeiro a loja do tipo depósito pelo código,
      // depois os estoques depósito sem loja pelo nome.
      const { rows } = await db.execute<LinhaLocal>(sql`
        with locais as (
          select e.id as estoque_id, e.nome as nome_estoque, l.id as loja_id, l.codigo as loja_codigo, l.nome as nome_loja,
                 l.tipo as tipo_loja
            from estoques e
            left join lojas l on l.estoque_id = e.id and l.excluido_em is null
           where e.excluido_em is null and e.ativo
             and ((l.id is not null and l.ativa and not l.treino) or (l.id is null and e.tipo = 'deposito'))
        )
        select lo.estoque_id,
               case when lo.loja_id is null or lo.tipo_loja = 'deposito' then 'deposito' else 'loja' end as tipo,
               lo.loja_codigo::int as loja_codigo,
               coalesce(lo.nome_loja, lo.nome_estoque) as nome,
               coalesce(lo.loja_id = ${terminal.lojaId}, false) as loja_do_terminal,
               coalesce((select sum(s.quantidade)
                           from saldos_estoque s
                           join tipos_estoque te on te.id = s.tipo_estoque_id and te.vendavel and te.excluido_em is null
                          where s.estoque_id = lo.estoque_id and s.produto_id = ${q.produto_id}
                            and s.excluido_em is null), 0)::numeric(15,3)::text as quantidade
          from locais lo
         order by coalesce(lo.loja_id = ${terminal.lojaId}, false) desc,
                  (lo.loja_id is null or lo.tipo_loja = 'deposito'), lo.loja_codigo nulls last,
                  lower(coalesce(lo.nome_loja, lo.nome_estoque)), lo.estoque_id`);
      return {
        agora_servidor: new Date().toISOString(),
        produto_id: q.produto_id,
        controla_estoque: produto[0].controla,
        locais: rows.map((r) => ({
          estoque_id: r.estoque_id,
          tipo: r.tipo,
          loja_codigo: r.loja_codigo,
          nome: r.nome,
          loja_do_terminal: r.loja_do_terminal,
          quantidade: r.quantidade,
        })),
      };
    });
  }
}

/**
 * Limite por terminal, na memória da instância (como o do throttler): o terminal autenticado que passa do limite recebe
 * `429 LIMITE_TAXA` com `Retry-After`, antes de ler o banco. Lido a cada chamada, para o teste ajustar.
 */
function limitarPorTerminal(terminal: TerminalAutenticado): void {
  try {
    garantirLimitePorMinuto(
      `sync-saldos-outras-lojas:${terminal.terminalId}`,
      limiteDoAmbiente('SYNC_CONSULTA_SALDOS_POR_MINUTO', CONSULTAS_SALDOS_POR_MINUTO_PADRAO),
    );
  } catch (e) {
    if (e instanceof ErroApi && e.codigo === 'LIMITE_TAXA') {
      throw new ErroSync(
        'LIMITE_TAXA',
        'Muitas consultas seguidas deste caixa. Aguarde um minuto.',
        {},
        { 'Retry-After': '60' },
      );
    }
    throw e;
  }
}
