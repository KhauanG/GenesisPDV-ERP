import {
  chaveLigada,
  CODIGO_TERMINAIS_DESATUALIZADOS,
  CONFIGURACOES_POR_CHAVE,
  temVersaoPdv,
  VERSAO_PDV_DA_CHAVE,
  valorGravadoValido,
  type ChaveComTerminaisDesatualizados,
} from '@genesis/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { caixas, configuracoes, lojas, terminais } from '../database/empresa/schema/index.js';
import { compararVersoes } from '../sync/versoes-app.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { valorJson } from './valores.js';

/** Terminal que ainda vende (o `desativando` continua sendo o do caixa durante a substituição, SYNC 3.4). */
export interface TerminalAtivo {
  id: string;
  lojaId: string;
  lojaNome: string | null;
  numeroCaixa: number;
  descricao: string | null;
  versaoApp: string | null;
}

/**
 * Os terminais ativos (`ativo` e `desativando`; o revogado e o que ainda provisiona não vendem), de todas as lojas ou
 * só das pedidas, por loja e caixa. A versão é a do último heartbeat (`terminais.versao_app`).
 */
export async function terminaisAtivos(db: DbEmpresa, lojaIds?: readonly string[]): Promise<TerminalAtivo[]> {
  if (lojaIds && !lojaIds.length) return [];
  return db
    .select({
      id: terminais.id,
      lojaId: terminais.lojaId,
      lojaNome: lojas.nome,
      numeroCaixa: caixas.numero,
      descricao: terminais.descricao,
      versaoApp: terminais.versaoApp,
    })
    .from(terminais)
    .innerJoin(caixas, eq(caixas.id, terminais.caixaId))
    .leftJoin(lojas, eq(lojas.id, terminais.lojaId))
    .where(
      and(
        inArray(terminais.status, ['ativo', 'desativando']),
        isNull(terminais.excluidoEm),
        lojaIds ? inArray(terminais.lojaId, [...lojaIds]) : undefined,
      ),
    )
    .orderBy(asc(lojas.nome), asc(caixas.numero));
}

/** Abaixo da versão, ou sem versão conhecida (nunca mandou o handshake com ela). */
export const abaixoDaVersao = (t: { versaoApp: string | null }, versao: string) =>
  !t.versaoApp || compararVersoes(t.versaoApp, versao) < 0;

/**
 * Quem vê os detalhes dos terminais (id, caixa, descrição, versão): quem tem "PDVs/Terminais: Ver", a permissão da
 * listagem de terminais, ou "Configurações: Editar", a de quem grava a chave e já recebe a lista na trava e na guarda
 * das variações. Só com `configuracoes.ver` vai a contagem (`semDetalhes`), como a prontidão faz sem `terminais.ver`.
 */
export const veDetalhesTerminais = (sessao: SessaoErp) =>
  sessao.permissoes.has('terminais.ver') || sessao.permissoes.has('configuracoes.editar');

/**
 * Os terminais da lista abaixo da versão da chave, com os detalhes só das lojas permitidas ao usuário (ERP 2.1); os das
 * outras lojas entram só na contagem, sem nome de loja, caixa, descrição nem versão (a regra da decisão 181). Sem
 * `veDetalhesTerminais`, os das lojas permitidas também vão só na contagem (`semDetalhes`).
 */
export function chaveComDesatualizados(
  sessao: SessaoErp,
  chave: string,
  ativos: readonly TerminalAtivo[],
): ChaveComTerminaisDesatualizados {
  const { versao, trava } = VERSAO_PDV_DA_CHAVE[chave]!;
  const antigos = ativos.filter((t) => abaixoDaVersao(t, versao));
  const permitidos = antigos.filter((t) => lojaPermitida(sessao, t.lojaId));
  const detalhes = veDetalhesTerminais(sessao);
  return {
    chave,
    versaoMinima: versao,
    trava,
    terminais: detalhes ? permitidos.map(({ lojaId: _lojaId, ...t }) => t) : [],
    outrasLojas: antigos.length - permitidos.length,
    ...(detalhes ? {} : { semDetalhes: permitidos.length }),
  };
}

/**
 * Trava dura por versão (F3-B12; plano da Fase 3 › Padrões): ligar uma chave com `trava` é recusado (422
 * `REGRA_NEGOCIO`, `detalhes.codigo = 'TERMINAIS_DESATUALIZADOS'` com a lista) enquanto houver terminal ativo abaixo da
 * versão numa loja em que o valor efetivo **passa** de desligado a ligado com esta gravação. Na empresa, são as lojas
 * sem valor próprio válido; na loja, só ela (inclusive o "Herdar" que traz a empresa ligada). Desligar, e regravar o
 * que já estava ligado, sempre pode. Roda dentro da transação da gravação, que já tem a 7300001 (`travaVersao`): duas
 * gravações de configuração não se cruzam. O terminal ativado **depois** com um PDV antigo não é barrado aqui (a
 * versão mínima do canal é quem segura a ativação), e é por isso que o ERP mostra o aviso de versão mesmo com a chave
 * ligada.
 */
export async function conferirTravaVersao(
  tx: DbEmpresa,
  sessao: SessaoErp,
  lojaId: string | null,
  valores: Record<string, unknown>,
): Promise<void> {
  const chaves = Object.keys(valores).filter((c) => temVersaoPdv(c) && VERSAO_PDV_DA_CHAVE[c]!.trava);
  if (!chaves.length) return;
  const linhas = (
    await tx
      .select({
        chave: configuracoes.chave,
        escopo: configuracoes.escopo,
        lojaId: configuracoes.lojaId,
        valor: valorJson,
      })
      .from(configuracoes)
      .leftJoin(lojas, eq(lojas.id, configuracoes.lojaId))
      .where(
        and(inArray(configuracoes.chave, chaves), isNull(configuracoes.excluidoEm), isNull(lojas.excluidoEm)),
      )
  ).filter((l) => valorGravadoValido(l.chave, l.valor));
  const todasLojas = lojaId
    ? [lojaId]
    : (await tx.select({ id: lojas.id }).from(lojas).where(isNull(lojas.excluidoEm))).map((l) => l.id);
  const bloqueadas: ChaveComTerminaisDesatualizados[] = [];
  for (const chave of chaves) {
    const padrao = CONFIGURACOES_POR_CHAVE.get(chave)!.padrao;
    const empresa = linhas.find((l) => l.chave === chave && l.escopo === 'empresa');
    const daLoja = (id: string) =>
      linhas.find((l) => l.chave === chave && l.escopo === 'loja' && l.lojaId === id);
    const novo = valores[chave];
    const lojasLigando = todasLojas.filter((id) => {
      const propria = daLoja(id);
      const antes = propria ? propria.valor : empresa ? empresa.valor : padrao;
      // A empresa não muda a loja com valor próprio; a loja com `null` volta a herdar a empresa.
      const depois = lojaId
        ? novo !== null
          ? novo
          : empresa
            ? empresa.valor
            : padrao
        : propria
          ? propria.valor
          : (novo ?? padrao);
      return !chaveLigada(antes) && chaveLigada(depois);
    });
    if (!lojasLigando.length) continue;
    const r = chaveComDesatualizados(sessao, chave, await terminaisAtivos(tx, lojasLigando));
    if (r.terminais.length || r.outrasLojas || r.semDetalhes) bloqueadas.push(r);
  }
  if (!bloqueadas.length) return;
  const campos = Object.fromEntries(
    bloqueadas.map((b) => {
      const n = b.terminais.length + b.outrasLojas + (b.semDetalhes ?? 0);
      return [
        b.chave,
        [
          `Só liga com todos os caixas no PDV ${b.versaoMinima} ou mais novo: ${n} caixa(s) desatualizado(s). ` +
            'Atualize ou desative esses caixas antes.',
        ],
      ];
    }),
  );
  throw new ErroApi(
    'REGRA_NEGOCIO',
    'Há caixas com o PDV antigo: a configuração mudaria o preço ou o pagamento só nos caixas novos.',
    { campos, detalhes: { codigo: CODIGO_TERMINAIS_DESATUALIZADOS, chaves: bloqueadas } },
  );
}
