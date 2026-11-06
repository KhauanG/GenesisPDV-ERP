/**
 * PDVs/Terminais no ERP (ERP 12): listagem, detalhe, ações e códigos de ativação. O estado de autenticação mora no
 * controle (`terminais_pdv`, `ativacoes_pdv`) e a telemetria no banco da empresa (`terminais`, gravada pelo
 * heartbeat): cada tela faz uma consulta por banco e junta em memória. As ações gravam primeiro o controle (o 401 ou o
 * `desativando` valem na hora) e depois a empresa (`revogacao.ts`), cada passo idempotente; a manutenção periódica
 * (`manutencao.ts`) repete o que tiver faltado.
 */
import {
  ALERTA_EVENTO_COM_ERRO,
  ALERTA_EVENTO_DESCARTADO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_LACUNA_DECLARADA,
  ALERTA_LACUNA_RECUPERADA,
  ALERTA_RELOGIO_DESVIO,
  ALERTA_RELOGIO_SUSPEITO,
  comPendencias,
  statusConexao,
  type AlertaTerminal,
  type AtivacaoPendente,
  type CaixaParaAtivacao,
  type AtivacoesPendentes,
  type ConfirmarHardware,
  type EventoComErro,
  type EventoHistoricoTerminal,
  type FiltroEventosComErro,
  type FiltroTerminais,
  type ListagemEventosComErro,
  type ListagemTerminais,
  type MensagemTerminal,
  type RessincronizarTerminal,
  type ResolverAlertaTerminal,
  type ResultadoRevogacao,
  type RevogarTerminal,
  type StatusConexao,
  type TerminalDetalhe,
  type TerminalResumo,
} from '@genesis/shared';
import { and, desc, eq, getTableColumns, inArray, isNull, not, or, sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import { filtroLojas, garantirLoja } from '../autorizacao/lojas.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { ativacoesPdv, empresas, terminaisPdv, versoesAppPdv } from '../database/controle/schema.js';
import { auditoria as tabelaAuditoria } from '../database/empresa/auditoria.js';
import {
  alertas,
  caixas,
  comandosTerminal,
  eventosRecebidos,
  lojas,
  numeracoes,
  terminais,
  usuarios,
} from '../database/empresa/schema/index.js';
import type { AtivacaoTerminais } from '../sync/ativacao.js';
import { enfileirarComando, garantirComandoRevogar } from '../sync/comandos.js';
import { substituicaoEmAndamento } from '../sync/terminal.js';
import { ALERTA_TOKEN_ANTERIOR } from '../sync/token.js';
import { compararVersoes } from '../sync/versoes-app.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import {
  confirmacaoDescarte,
  numerosDasVendas,
  resumoDoAgregado,
  terminalDoAlerta,
  vendaDoPayload,
} from './fila-decisao.js';
import {
  ALERTA_EVENTOS_NAO_RESOLVIDOS,
  ALERTA_FORCA_BRUTA,
  aplicarEstadoNaEmpresa,
  MOTIVOS_REVOGACAO,
  resolverAlertaForcaBruta,
} from './revogacao.js';

/** SYNC 3.8: carência máxima do "aceitar pendências". */
export const CARENCIA_DESATIVACAO_DIAS = 7;
const LOCALIZACAO = 'PDVs/Terminais';

/**
 * Alertas de terminal que alguém resolve na tela ("Ciente"/"Máquina conferida"): os demais fecham sozinhos. As lacunas
 * (SYNC 8.6; C15): o `LACUNA_DECLARADA` fecha sozinho só quando todos os eventos voltam; senão, a perda conferida com o
 * caixa; o `LACUNA_RECUPERADA` é aviso. O `RELOGIO_SUSPEITO` (SYNC 12.4; C16) depois de acertar o relógio do
 * computador; o `RELOGIO_DESVIO` não: fecha sozinho quando o heartbeat traz o desvio normal (T40).
 */
const RESOLVIDOS_NA_TELA: readonly string[] = [
  ALERTA_TOKEN_ANTERIOR,
  ALERTA_EVENTO_DESCARTADO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_LACUNA_DECLARADA,
  ALERTA_LACUNA_RECUPERADA,
  ALERTA_RELOGIO_SUSPEITO,
];

/**
 * A regressão marcada pelo caixa (`RELOGIO_SUSPEITO` `info`, SYNC 12.4): uma por correção do relógio para trás, sem
 * deduplicação por terminal. Na tela vem somada por terminal e o "Ciente" fecha todas (`alertasAbertos`).
 */
const regressaoMarcada = and(
  eq(alertas.tipo, ALERTA_RELOGIO_SUSPEITO),
  sql`coalesce(${alertas.dados} ->> 'motivo', '') = 'regressao_marcada'`,
)!;

type TerminalControle = typeof terminaisPdv.$inferSelect;
type TerminalEmpresa = typeof terminais.$inferSelect;

const erroSemCredenciais = () =>
  new ErroApi(
    'REGRA_NEGOCIO',
    'O terminal não chegou a concluir a ativação: nenhuma credencial desceu para ele, não há o que anular.',
  );

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const maisRecente = (a: Date | null | undefined, b: Date | null | undefined) =>
  !a ? (b ?? null) : !b ? a : a > b ? a : b;

/** `eventos_recebidos.dependencias`: as do envelope (`agregado_tipo`/`agregado_id`) e os bloqueadores do push. */
function lerDependencias(valor: unknown): {
  aguardando: string[];
  declaradas: Array<{ agregadoTipo: string; agregadoId: string }>;
} {
  const lista = Array.isArray(valor) ? (valor as Array<Record<string, unknown>>) : [];
  const aguardando: string[] = [];
  const declaradas: Array<{ agregadoTipo: string; agregadoId: string }> = [];
  for (const d of lista) {
    if (typeof d?.evento_id_bloqueador === 'string') aguardando.push(d.evento_id_bloqueador);
    else if (typeof d?.agregado_tipo === 'string' && typeof d?.agregado_id === 'string')
      declaradas.push({ agregadoTipo: d.agregado_tipo, agregadoId: d.agregado_id });
  }
  return { aguardando, declaradas };
}

/** `terminais_pdv` não guarda a plataforma (vem só no cabeçalho): ela sai do SO informado na ativação/heartbeat. */
function plataformaDoSo(so: string | null | undefined): 'windows_x64' | 'linux_x64' | null {
  if (!so) return null;
  if (/windows/i.test(so)) return 'windows_x64';
  if (/linux|ubuntu|debian|fedora|mint/i.test(so)) return 'linux_x64';
  return null;
}

export class TerminaisErp {
  constructor(
    private readonly controle: BancoControle,
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
    private readonly ativacao: AtivacaoTerminais,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Leitura

  /** ERP 12.2: listagem com contadores (ativos das lojas filtradas) e os alertas abertos de terminais. */
  async listar(sessao: SessaoErp, filtro: FiltroTerminais): Promise<ListagemTerminais> {
    if (filtro.lojaId) garantirLoja(sessao, filtro.lojaId);
    const doControle = await this.controle.db
      .select()
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.empresaId, sessao.empresa.empresaId),
          isNull(terminaisPdv.excluidoEm),
          filtroLojas(sessao, terminaisPdv.lojaId),
          filtro.lojaId ? eq(terminaisPdv.lojaId, filtro.lojaId) : undefined,
        ),
      )
      .orderBy(terminaisPdv.numeroCaixa, desc(terminaisPdv.ativadoEm));
    const minimas = await this.versoesMinimas(sessao.empresa.empresaId);
    const ids = doControle.map((t) => t.id);
    const lojaIds = [...new Set(doControle.map((t) => t.lojaId))];
    const { daEmpresa, lojasPorId, erros, operadores, abertos } = await this.tenancy
      .cx()
      .consulta(async (db) => {
        const daEmpresa = ids.length
          ? await db.select().from(terminais).where(inArray(terminais.id, ids))
          : [];
        const lojasPorId = lojaIds.length
          ? await db
              .select({ id: lojas.id, codigo: lojas.codigo, nome: lojas.nome })
              .from(lojas)
              .where(inArray(lojas.id, lojaIds))
          : [];
        const erros = ids.length ? await this.contarEventosComErro(db, ids) : new Map<string, number>();
        const operadorIds = [...new Set(daEmpresa.map((t) => t.operadorId).filter((v): v is string => !!v))];
        const operadores = operadorIds.length
          ? await db
              .select({ id: usuarios.id, nome: usuarios.nome })
              .from(usuarios)
              .where(inArray(usuarios.id, operadorIds))
          : [];
        const abertos = await this.alertasAbertos(db, sessao);
        return { daEmpresa, lojasPorId, erros, operadores, abertos };
      });
    const empresaPorId = new Map(daEmpresa.map((t) => [t.id, t]));
    const lojaPorId = new Map(lojasPorId.map((l) => [l.id, l]));
    const operadorPorId = new Map(operadores.map((o) => [o.id, o.nome]));
    const agora = Date.now();
    const todos = doControle.map((t) =>
      this.resumo(t, empresaPorId.get(t.id), {
        loja: lojaPorId.get(t.lojaId),
        eventosComErro: erros.get(t.id) ?? 0,
        operadorNome: operadorPorId.get(empresaPorId.get(t.id)?.operadorId ?? '') ?? null,
        minimas,
        agora,
      }),
    );
    const contadores: Record<StatusConexao, number> = { online: 0, offline: 0, sem_contato: 0 };
    for (const t of todos) if (t.status === 'ativo') contadores[t.conexao]++;
    const versao = filtro.versaoApp?.toLowerCase();
    const itens = todos.filter((t) => {
      const situacao =
        filtro.situacao === 'todos' ||
        (filtro.situacao === 'ativos' && (t.status === 'ativo' || t.status === 'provisionando')) ||
        (filtro.situacao === 'desativando' && t.status === 'desativando') ||
        (filtro.situacao === 'revogados' && t.status === 'revogado');
      if (!situacao) return false;
      if (versao && !(t.versaoApp ?? '').toLowerCase().includes(versao)) return false;
      switch (filtro.conexao) {
        case 'todos':
          return true;
        case 'com_pendencias':
          return t.comPendencias;
        case 'hardware_alterado':
          return t.hardwareAlterado;
        default:
          return t.status !== 'revogado' && t.conexao === filtro.conexao;
      }
    });
    return { itens, contadores, alertas: abertos, geradoEm: new Date().toISOString() };
  }

  /** ERP 12.4: blocos de identificação, sincronização, fiscal, caixa e histórico. */
  async detalhar(sessao: SessaoErp, id: string): Promise<TerminalDetalhe> {
    const t = await this.carregar(sessao, id);
    const minimas = await this.versoesMinimas(sessao.empresa.empresaId);
    const dados = await this.tenancy.cx().consulta(async (db) => {
      const [e] = await db.select().from(terminais).where(eq(terminais.id, id));
      const [loja] = await db
        .select({ id: lojas.id, codigo: lojas.codigo, nome: lojas.nome, tipoEmissao: lojas.tipoEmissao })
        .from(lojas)
        .where(eq(lojas.id, t.lojaId));
      const [caixa] = await db
        .select({ nfceSerie: caixas.nfceSerie })
        .from(caixas)
        .where(eq(caixas.id, t.caixaId));
      const nomes = new Map<string, string>();
      const pessoasIds = [e?.operadorId, t.ativadoPorUsuarioId, t.revogadoPorUsuarioId].filter(
        (v): v is string => !!v,
      );
      if (pessoasIds.length) {
        for (const u of await db
          .select({ id: usuarios.id, nome: usuarios.nome })
          .from(usuarios)
          .where(inArray(usuarios.id, pessoasIds)))
          nomes.set(u.id, u.nome);
      }
      const [venda] = await db
        .select({ ultimo: numeracoes.ultimoNumero })
        .from(numeracoes)
        .where(
          and(eq(numeracoes.caixaId, t.caixaId), eq(numeracoes.tipo, 'venda'), isNull(numeracoes.excluidoEm)),
        );
      const erros = await this.contarEventosComErro(db, [id]);
      const historico = await this.historico(db, id);
      const abertos = await this.alertasAbertos(db, sessao, id);
      return { e, loja, caixa, nomes, venda, erros, historico, abertos };
    });
    const { e, loja, caixa, nomes, venda, erros, historico, abertos } = dados;
    const resumo = this.resumo(t, e, {
      loja,
      eventosComErro: erros.get(id) ?? 0,
      operadorNome: e?.operadorId ? (nomes.get(e.operadorId) ?? null) : null,
      minimas,
      agora: Date.now(),
    });
    return {
      ...resumo,
      sistemaOperacional: e?.sistemaOperacional ?? t.sistemaOperacional,
      idHardware: t.idHardware,
      idHardwarePendente: t.idHardwarePendente,
      hardwarePendente: t.idHardwarePendente
        ? {
            id: t.idHardwarePendente,
            desde: iso(t.hardwarePendenteDesde),
            ip: (t.hardwarePendenteIp as string | null) ?? null,
            sistemaOperacional: t.hardwarePendenteSo,
          }
        : null,
      ultimoIp: (e?.ultimoIp as string | null | undefined) ?? (t.ultimoIp as string | null) ?? null,
      ativadoEm: t.ativadoEm.toISOString(),
      ativadoPorNome: t.ativadoPorUsuarioId ? (nomes.get(t.ativadoPorUsuarioId) ?? null) : null,
      motivoRevogacao: t.motivoRevogacao,
      revogadoPorNome: t.revogadoPorUsuarioId ? (nomes.get(t.revogadoPorUsuarioId) ?? null) : null,
      substituidoPorTerminalId: t.substituidoPorTerminalId,
      ultimoHeartbeatEm: iso(e?.ultimoContatoEm),
      cursorPull: (e?.cursorPull as TerminalDetalhe['cursorPull']) ?? null,
      estadoLocal: e?.estadoLocal ?? null,
      ultimoErro: e?.ultimoErro ?? null,
      tipoEmissao: loja?.tipoEmissao ?? null,
      nfceSerie: caixa?.nfceSerie ?? null,
      nfceUltimoNumero: e?.nfceUltimoNumero ?? null,
      nfceContingenciaMaisAntigaEm: iso(e?.nfceContingenciaMaisAntigaEm),
      certificadoValidade: iso(e?.certificadoValidade),
      sessaoCaixaId: e?.sessaoCaixaId ?? null,
      dinheiroEstimadoGaveta: e?.dinheiroEstimadoGaveta ?? null,
      vendaUltimoNumero: Math.max(venda?.ultimo ?? 0, e?.vendaUltimoNumero ?? 0),
      // Saúde do computador (Central do PDV, G15): o que o heartbeat já gravava, agora na tela.
      discoLivreMb: e?.discoLivreMb ?? null,
      tamanhoBancoMb: e?.tamanhoBancoMb ?? null,
      filaImpressaoPendentes: e?.filaImpressaoPendentes ?? 0,
      desativacaoConfirmadaEm: iso(e?.desativacaoConfirmadaEm),
      historico,
      alertas: abertos,
    };
  }

  /**
   * ERP 12.5 (SYNC 11.4): a fila de decisão do terminal, paginada e filtrável por situação e código, em ordem de
   * sequência, com o resumo do agregado e o que digitar para descartar (lidos do payload: a venda nunca aplicada não
   * existe na nuvem). As ações ficam em `FilaDecisao` (`fila-decisao.ts`).
   */
  async eventosComErro(
    sessao: SessaoErp,
    id: string,
    filtro: FiltroEventosComErro,
  ): Promise<ListagemEventosComErro> {
    await this.carregar(sessao, id);
    const verPayload = sessao.permissoes.has('terminais.gerenciar');
    const { linhas, total, codigos, bloqueadores, numeros } = await this.tenancy.cx().consulta(async (db) => {
      const onde = and(
        eq(eventosRecebidos.terminalId, id),
        filtro.status
          ? eq(eventosRecebidos.status, filtro.status)
          : inArray(eventosRecebidos.status, ['erro', 'retido']),
        filtro.codigo ? eq(eventosRecebidos.erroCodigo, filtro.codigo) : undefined,
      );
      const linhas = await db
        .select()
        .from(eventosRecebidos)
        .where(onde)
        .orderBy(eventosRecebidos.sequenciaTerminal)
        .limit(filtro.tamanho)
        .offset((filtro.pagina - 1) * filtro.tamanho);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(eventosRecebidos)
        .where(onde);
      const codigos = await db
        .select({ codigo: eventosRecebidos.erroCodigo, quantidade: sql<number>`count(*)::int` })
        .from(eventosRecebidos)
        .where(and(eq(eventosRecebidos.terminalId, id), eq(eventosRecebidos.status, 'erro')))
        .groupBy(eventosRecebidos.erroCodigo)
        .orderBy(eventosRecebidos.erroCodigo);
      // O push grava em `dependencias`, além das do envelope, `{evento_id_bloqueador}` de quem segura o retido.
      const ids = [...new Set(linhas.flatMap((l) => lerDependencias(l.dependencias).aguardando))];
      const bloqueadores = ids.length
        ? await db
            .select({
              eventoId: eventosRecebidos.eventoId,
              sequencia: eventosRecebidos.sequenciaTerminal,
              tipo: eventosRecebidos.tipo,
            })
            .from(eventosRecebidos)
            .where(and(eq(eventosRecebidos.terminalId, id), inArray(eventosRecebidos.eventoId, ids)))
        : [];
      return { linhas, total, codigos, bloqueadores, numeros: await numerosDasVendas(db, linhas) };
    });
    const bloqueadorPorId = new Map(bloqueadores.map((b) => [b.eventoId, b]));
    const itens = linhas.map((l): EventoComErro => {
      const deps = lerDependencias(l.dependencias);
      const payload = l.payload as Record<string, unknown> | null;
      const venda = vendaDoPayload(l.tipo, payload);
      const numeroVenda = venda.id ? (numeros.get(venda.id.toLowerCase()) ?? null) : null;
      return {
        id: l.id,
        eventoId: l.eventoId,
        sequencia: l.sequenciaTerminal,
        tipo: l.tipo,
        ocorridoEm: l.ocorridoEm.toISOString(),
        status: l.status as 'erro' | 'retido',
        erroCodigo: l.erroCodigo,
        erro: l.erro,
        agregadoTipo: l.agregadoTipo,
        agregadoId: l.agregadoId,
        tentativas: l.tentativas,
        recebidoEm: l.criadoEm.toISOString(),
        aguardando: deps.aguardando.map((eventoId) => ({
          eventoId,
          sequencia: bloqueadorPorId.get(eventoId)?.sequencia ?? null,
          tipo: bloqueadorPorId.get(eventoId)?.tipo ?? null,
        })),
        dependencias: deps.declaradas,
        payload: verPayload ? l.payload : null,
        resumo: resumoDoAgregado(l.tipo, payload, numeroVenda, verPayload),
        confirmacaoDescarte: confirmacaoDescarte(l.tipo, payload, l.sequenciaTerminal, numeroVenda),
      };
    });
    return {
      itens,
      total,
      pagina: filtro.pagina,
      tamanho: filtro.tamanho,
      codigos: codigos
        .filter((c): c is { codigo: string; quantidade: number } => c.codigo !== null)
        .map((c) => ({ codigo: c.codigo, quantidade: c.quantidade })),
    };
  }

  /**
   * ERP 12.3: caixas da loja que aceitam código. A ocupação vem do controle (`provisionando`/`ativo`, como em
   * `gerarCodigo` e na ativação): o caixa de um terminal `desativando` aparece, com o aviso, embora
   * `caixas.terminal_id` ainda aponte para ele até a confirmação ou a carência.
   */
  async caixasParaAtivacao(sessao: SessaoErp, lojaId: string): Promise<CaixaParaAtivacao[]> {
    garantirLoja(sessao, lojaId);
    const daLoja = await this.tenancy.cx().consulta((db) =>
      db
        .select({ id: caixas.id, numero: caixas.numero, descricao: caixas.descricao })
        .from(caixas)
        .where(
          and(
            eq(caixas.lojaId, lojaId),
            isNull(caixas.excluidoEm),
            eq(caixas.ativo, true),
            eq(caixas.sistema, false),
          ),
        )
        .orderBy(caixas.numero),
    );
    const ocupacao = await this.controle.db
      .select({ id: terminaisPdv.id, caixaId: terminaisPdv.caixaId, status: terminaisPdv.status })
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.empresaId, sessao.empresa.empresaId),
          eq(terminaisPdv.lojaId, lojaId),
          inArray(terminaisPdv.status, ['provisionando', 'ativo', 'desativando']),
        ),
      );
    const ocupados = new Set(ocupacao.filter((o) => o.status !== 'desativando').map((o) => o.caixaId));
    const desativando = new Map(
      ocupacao.filter((o) => o.status === 'desativando').map((o) => [o.caixaId, o.id]),
    );
    return daLoja
      .filter((c) => c.numero >= 1 && !ocupados.has(c.id))
      .map((c) => ({ ...c, terminalDesativandoId: desativando.get(c.id) ?? null }));
  }

  /** ERP 12.2 topo: códigos pendentes (não vencidos) das lojas permitidas e o bloqueio por força bruta. */
  async ativacoesPendentes(sessao: SessaoErp): Promise<AtivacoesPendentes> {
    const linhas = await this.controle.db
      .select()
      .from(ativacoesPdv)
      .where(
        and(
          eq(ativacoesPdv.empresaId, sessao.empresa.empresaId),
          eq(ativacoesPdv.status, 'pendente'),
          sql`${ativacoesPdv.expiraEm} > now()`,
          filtroLojas(sessao, ativacoesPdv.lojaId),
        ),
      )
      .orderBy(ativacoesPdv.expiraEm);
    const lojaIds = [...new Set(linhas.map((l) => l.lojaId))];
    const nomes = lojaIds.length
      ? await this.tenancy
          .cx()
          .consulta((db) =>
            db
              .select({ id: lojas.id, codigo: lojas.codigo, nome: lojas.nome })
              .from(lojas)
              .where(inArray(lojas.id, lojaIds)),
          )
      : [];
    const lojaPorId = new Map(nomes.map((l) => [l.id, `${l.codigo} - ${l.nome}`]));
    const pendentes: AtivacaoPendente[] = linhas.map((a) => ({
      id: a.id,
      codigoMascarado: `••••-••${a.codigoFinal}`,
      lojaId: a.lojaId,
      lojaNome: lojaPorId.get(a.lojaId) ?? null,
      caixaId: a.caixaId,
      numeroCaixa: a.numeroCaixa,
      descricao: a.descricao,
      geradoPor: a.criadoPorNome,
      criadoEm: a.criadoEm.toISOString(),
      expiraEm: a.expiraEm.toISOString(),
      substituiTerminalId: a.substituiTerminalId,
    }));
    return { pendentes, bloqueio: await this.ativacao.estadoBloqueio(sessao.empresa.codigo) };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Ações

  /** Cancelar código pendente (ERP 12.1 `CodigoGerado → Cancelado`). */
  async cancelarAtivacao(sessao: SessaoErp, id: string, origem: OrigemAcao): Promise<void> {
    const [a] = await this.controle.db
      .select()
      .from(ativacoesPdv)
      .where(and(eq(ativacoesPdv.id, id), eq(ativacoesPdv.empresaId, sessao.empresa.empresaId)));
    if (!a) throw ErroApi.naoEncontrado('Código de ativação não encontrado.');
    garantirLoja(sessao, a.lojaId);
    const cancelados = await this.controle.db
      .update(ativacoesPdv)
      .set({ status: 'cancelado', canceladoEm: new Date(), canceladoPorUsuarioId: sessao.usuarioId })
      .where(and(eq(ativacoesPdv.id, id), eq(ativacoesPdv.status, 'pendente')))
      .returning({ id: ativacoesPdv.id });
    if (!cancelados.length) {
      throw new ErroApi('REGRA_NEGOCIO', 'O código já foi usado, venceu ou foi cancelado.');
    }
    await this.tenancy.cx().transacao((tx) =>
      this.auditoria.registrar(tx, origem, {
        acao: 'cancelar',
        entidade: 'ativacoes_pdv',
        registroId: id,
        lojaId: a.lojaId,
        localizacao: `${LOCALIZACAO} › Códigos pendentes`,
        descricao: `Código de ativação ••••-••${a.codigoFinal} do caixa ${a.numeroCaixa} cancelado`,
      }),
    );
  }

  /** "Liberar ativações" (ERP 12.2; SYNC 3.1): zera o bloqueio do código da empresa e fecha o alerta. */
  async liberarAtivacoes(sessao: SessaoErp, origem: OrigemAcao): Promise<AtivacoesPendentes['bloqueio']> {
    const antes = await this.ativacao.estadoBloqueio(sessao.empresa.codigo);
    await this.ativacao.liberarAtivacoes(sessao.empresa.empresaId);
    await this.tenancy.cx().transacao(async (tx) => {
      await resolverAlertaForcaBruta(tx, 'Ativações liberadas no ERP', sessao.usuarioId);
      await this.auditoria.registrar(tx, origem, {
        acao: 'liberacao',
        entidade: 'ativacoes_pdv',
        localizacao: `${LOCALIZACAO} › Liberar ativações`,
        descricao: `Ativações liberadas (${antes.falhas} falha(s) na última hora${antes.bloqueado ? ', estava bloqueado' : ''})`,
        antes,
      });
    });
    return this.ativacao.estadoBloqueio(sessao.empresa.codigo);
  }

  /** Renomear (ERP 12.4): a descrição fica nos dois bancos. */
  async renomear(
    sessao: SessaoErp,
    id: string,
    entrada: { descricao: string | null },
    origem: OrigemAcao,
  ): Promise<TerminalDetalhe> {
    const t = await this.carregar(sessao, id);
    if (t.descricao !== entrada.descricao) {
      await this.controle.db
        .update(terminaisPdv)
        .set({ descricao: entrada.descricao })
        .where(eq(terminaisPdv.id, id));
      await this.tenancy.cx().transacao(async (tx) => {
        await tx.update(terminais).set({ descricao: entrada.descricao }).where(eq(terminais.id, id));
        await this.auditoria.registrar(
          tx,
          { ...origem, lojaId: t.lojaId },
          {
            acao: 'editar',
            entidade: 'terminais',
            registroId: id,
            localizacao: `${LOCALIZACAO} › Renomear`,
            descricao: `Descrição do terminal do caixa ${t.numeroCaixa} alterada`,
            antes: { descricao: t.descricao },
            depois: { descricao: entrada.descricao },
          },
        );
      });
    }
    return this.detalhar(sessao, id);
  }

  /**
   * Revogar (ERP 12.4; SYNC 3.8). Controle primeiro: `aceitar_pendencias` → `desativando` com carência de 7 dias (o
   * terminal continua autenticando para mandar as pendências e recebe o comando `revogar`); `imediato`/`perdido` →
   * `revogado` (401 na próxima chamada). Depois a empresa, na mesma função que a manutenção usa para alcançar o
   * controle. Repetir a mesma revogação só refaz o passo da empresa (idempotente).
   *
   * `perdido` também vale para um terminal já revogado por outro motivo (o furto descoberto depois de uma revogação
   * imediata, da carência ou da desativação confirmada, ou outra revogação que ganhou a corrida): o motivo passa a
   * `perdido_roubado` e a empresa só anula as credenciais. A exceção é a `falha_ativacao`, que nunca recebeu dados.
   */
  async revogar(
    sessao: SessaoErp,
    id: string,
    entrada: RevogarTerminal,
    origem: OrigemAcao,
  ): Promise<ResultadoRevogacao> {
    const t = await this.carregar(sessao, id);
    if (entrada.modo !== 'aceitar_pendencias' && Number(entrada.confirmacaoCaixa) !== t.numeroCaixa) {
      throw erroCampo('confirmacaoCaixa', `Digite ${t.numeroCaixa} (o número do caixa) para confirmar`);
    }
    const motivo = MOTIVOS_REVOGACAO[entrada.modo];
    const perdido = entrada.modo === 'perdido';
    if (perdido && t.motivoRevogacao === MOTIVOS_REVOGACAO.falhaAtivacao) throw erroSemCredenciais();
    if (t.status === 'revogado' && t.motivoRevogacao !== motivo && !perdido) {
      throw new ErroApi('REGRA_NEGOCIO', 'O terminal já está revogado.');
    }
    if (entrada.modo === 'aceitar_pendencias') {
      if (t.status === 'provisionando') {
        throw new ErroApi(
          'REGRA_NEGOCIO',
          'O terminal ainda está concluindo a ativação: use "Revogar imediatamente".',
        );
      }
      if (t.status === 'ativo') {
        await this.controle.db
          .update(terminaisPdv)
          .set({
            status: 'desativando',
            carenciaAte: sql`now() + make_interval(days => ${CARENCIA_DESATIVACAO_DIAS})`,
            revogadoPorUsuarioId: sessao.usuarioId,
            motivoRevogacao: motivo,
          })
          .where(and(eq(terminaisPdv.id, id), eq(terminaisPdv.status, 'ativo')));
      }
    } else {
      if (t.status !== 'revogado') {
        await this.controle.db
          .update(terminaisPdv)
          .set({
            status: 'revogado',
            revogadoEm: new Date(),
            revogadoPorUsuarioId: sessao.usuarioId,
            motivoRevogacao: motivo,
            carenciaAte: null,
          })
          .where(
            and(
              eq(terminaisPdv.id, id),
              inArray(terminaisPdv.status, ['provisionando', 'ativo', 'desativando']),
            ),
          );
      }
      if (perdido) {
        // Já revogado (antes ou por outra revogação nesse meio-tempo): só o motivo muda; a data fica.
        await this.controle.db
          .update(terminaisPdv)
          .set({ motivoRevogacao: motivo })
          .where(
            and(
              eq(terminaisPdv.id, id),
              eq(terminaisPdv.status, 'revogado'),
              sql`coalesce(${terminaisPdv.motivoRevogacao}, '') not in (${motivo}, ${MOTIVOS_REVOGACAO.falhaAtivacao})`,
            ),
          );
      }
    }
    const atual = await this.carregar(sessao, id);
    // Nunca devolver 200 a um "perdido" que não anulou nada (a compensação da ativação ganhou a corrida).
    if (perdido && atual.motivoRevogacao !== motivo) throw erroSemCredenciais();
    // `desativando` por uma substituição cujo novo ainda está `provisionando` (também quando o 1º commit da ativação
    // ganhou a corrida com esta revogação): a compensação o devolveria a `ativo` e desfaria em silêncio o "aceitar
    // pendências". Os modos imediato/perdido já gravaram `revogado`, que a compensação respeita.
    if (entrada.modo === 'aceitar_pendencias' && (await substituicaoEmAndamento(this.controle.db, atual))) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        'O terminal está sendo substituído (o novo ainda conclui a ativação). Aguarde alguns minutos ou use "Revogar imediatamente".',
      );
    }
    const resultado = await this.tenancy.cx().transacao(
      async (tx) => {
        const r = await aplicarEstadoNaEmpresa(tx, this.auditoria, atual, origem, {
          observacao: entrada.observacao,
          localizacao: `${LOCALIZACAO} › Revogar`,
        });
        // O heartbeat também garante o `revogar` enquanto `desativando`; gravado aqui ele já aparece no histórico.
        if (atual.status === 'desativando' && (await this.existeNaEmpresa(tx, id))) {
          await garantirComandoRevogar(tx, id, sessao.usuarioId);
        }
        return r;
      },
      // Todo destino `revogado` libera o caixa (`caixas` tem `fn_versao`): a trava vem antes dos locks de linha.
      { travaVersao: atual.status === 'revogado' },
    );
    return {
      ...resultado,
      status: atual.status as ResultadoRevogacao['status'],
      motivo: atual.motivoRevogacao,
    };
  }

  /** Ressincronizar (ERP 12.4): `ressincronizar` (todos) ou `ressincronizar_fluxo {fluxo}`. */
  async ressincronizar(
    sessao: SessaoErp,
    id: string,
    entrada: RessincronizarTerminal,
    origem: OrigemAcao,
  ): Promise<{ comandoId: string }> {
    const t = await this.carregar(sessao, id);
    if (t.status !== 'ativo') throw new ErroApi('REGRA_NEGOCIO', 'Só um terminal ativo pode ressincronizar.');
    const fluxo = entrada.fluxo;
    return this.comando(t, origem, sessao, {
      tipo: fluxo ? 'ressincronizar_fluxo' : 'ressincronizar',
      parametros: fluxo ? { fluxo } : {},
      descricao: fluxo ? `Ressincronizar o fluxo ${fluxo}` : 'Ressincronizar todos os fluxos',
      localizacao: `${LOCALIZACAO} › Ressincronizar`,
    });
  }

  /** Comando `mensagem` (SYNC 21.1): aviso para o operador no próximo heartbeat. */
  async mensagem(
    sessao: SessaoErp,
    id: string,
    entrada: MensagemTerminal,
    origem: OrigemAcao,
  ): Promise<{ comandoId: string }> {
    const t = await this.carregar(sessao, id);
    if (t.status !== 'ativo' && t.status !== 'desativando') {
      throw new ErroApi('REGRA_NEGOCIO', 'O terminal não está mais em contato com a nuvem.');
    }
    return this.comando(t, origem, sessao, {
      tipo: 'mensagem',
      parametros: { texto: entrada.texto },
      descricao: `Mensagem para o caixa: "${entrada.texto.slice(0, 120)}"`,
      localizacao: `${LOCALIZACAO} › Mensagem`,
    });
  }

  /**
   * Confirmar troca de hardware (ERP 12.4; SYNC 20.5): `id_hardware = id_hardware_pendente` nos dois bancos; o
   * terminal volta a enviar eventos no próximo contato. "Não reconheço" é a revogação imediata. A confirmação vale só
   * para o id que a tela mostrou (com o horário, IP e SO da primeira chamada dele): se outra máquina chamou depois e o
   * pendente mudou, 409 e nada muda.
   */
  async confirmarHardware(
    sessao: SessaoErp,
    id: string,
    entrada: ConfirmarHardware,
    origem: OrigemAcao,
  ): Promise<TerminalDetalhe> {
    const t = await this.carregar(sessao, id);
    if (!t.idHardwarePendente) throw new ErroApi('REGRA_NEGOCIO', 'Não há troca de hardware pendente.');
    if (t.status === 'revogado') throw new ErroApi('REGRA_NEGOCIO', 'O terminal está revogado.');
    const pendenteMudou = () =>
      new ErroApi(
        'CONFLITO',
        'Outra máquina chamou a nuvem com este terminal depois que a tela foi aberta: confira os dados novos antes de confirmar.',
      );
    if (t.idHardwarePendente !== entrada.idHardwarePendente) throw pendenteMudou();
    const novo = entrada.idHardwarePendente;
    const trocados = await this.controle.db
      .update(terminaisPdv)
      .set({
        idHardware: novo,
        idHardwarePendente: null,
        hardwarePendenteDesde: null,
        hardwarePendenteIp: null,
        hardwarePendenteSo: null,
      })
      .where(and(eq(terminaisPdv.id, id), eq(terminaisPdv.idHardwarePendente, novo)))
      .returning({ id: terminaisPdv.id });
    if (!trocados.length) {
      // Outra confirmação do mesmo id ganhou a corrida: o resultado é o pedido. Senão o pendente mudou no meio.
      if ((await this.carregar(sessao, id)).idHardware === novo) return this.detalhar(sessao, id);
      throw pendenteMudou();
    }
    await this.tenancy.cx().transacao(async (tx) => {
      await tx.update(terminais).set({ idHardware: novo }).where(eq(terminais.id, id));
      await this.auditoria.registrar(
        tx,
        { ...origem, lojaId: t.lojaId },
        {
          acao: 'hardware_alterado',
          entidade: 'terminais',
          registroId: id,
          localizacao: `${LOCALIZACAO} › Confirmar troca de hardware`,
          descricao: `Troca de hardware do caixa ${t.numeroCaixa} confirmada`,
          antes: { id_hardware: t.idHardware },
          depois: {
            id_hardware: novo,
            primeira_chamada_em: iso(t.hardwarePendenteDesde),
            ip: (t.hardwarePendenteIp as string | null) ?? null,
            sistema_operacional: t.hardwarePendenteSo,
          },
        },
      );
    });
    return this.detalhar(sessao, id);
  }

  /**
   * Resolver o alerta de token anterior reutilizado (SYNC 3.7; ERP 12.4) depois de conferir a máquina: grava quem
   * resolveu e o que viu, com auditoria. Se a cópia for real, o caminho é revogar o terminal. Resolvido, um novo uso do
   * anterior abre outro alerta (a deduplicação vale só enquanto aberto). Também o "Ciente" do `EVENTO_DESCARTADO`
   * (SYNC 11.4) e do `EVENTO_DIVERGENTE` (8.4 camada 3) do terminal, que senão ficariam abertos para sempre (o terminal
   * vem de `terminalDoAlerta`: `dados.terminal_id` ou a linha recebida) e o das lacunas (SYNC 8.6), declarada ou
   * recuperada, e o do relógio suspeito (`RESOLVIDOS_NA_TELA`); o da regressão marcada fecha junto as anteriores do
   * terminal, que a tela mostra somadas. Os demais alertas de terminal fecham sozinhos.
   */
  async resolverAlerta(
    sessao: SessaoErp,
    id: string,
    alertaId: string,
    entrada: ResolverAlertaTerminal,
    origem: OrigemAcao,
  ): Promise<TerminalDetalhe> {
    const t = await this.carregar(sessao, id);
    await this.tenancy.cx().transacao(async (tx) => {
      const [a] = await tx
        .select()
        .from(alertas)
        .where(
          and(
            eq(alertas.id, alertaId),
            sql`${terminalDoAlerta(alertas)} = ${id}`,
            isNull(alertas.excluidoEm),
          ),
        )
        .for('update');
      if (!a) throw ErroApi.naoEncontrado('Alerta não encontrado.');
      if (!RESOLVIDOS_NA_TELA.includes(a.tipo)) {
        throw new ErroApi('REGRA_NEGOCIO', 'Este alerta fecha sozinho quando a pendência é resolvida.');
      }
      if (a.resolvidoEm) return;
      // A regressão marcada do relógio aparece somada por terminal com o id da mais recente: o "Ciente" vale para ela
      // e para as anteriores do mesmo terminal (as que a tela mostrava). Uma correção que chegou depois fica aberta.
      const marcada =
        a.tipo === ALERTA_RELOGIO_SUSPEITO &&
        (a.dados as { motivo?: unknown } | null)?.motivo === 'regressao_marcada';
      const fechados = await tx
        .update(alertas)
        .set({ resolvidoEm: new Date(), resolvidoPorId: sessao.usuarioId, resolucao: entrada.resolucao })
        .where(
          marcada
            ? and(
                regressaoMarcada,
                eq(alertas.entidade, 'terminais'),
                eq(alertas.registroId, id),
                isNull(alertas.resolvidoEm),
                isNull(alertas.excluidoEm),
                // Pelo banco: o `Date` do JS perde os microssegundos e deixaria a própria linha de fora.
                sql`${alertas.criadoEm} <= (select x.criado_em from alertas x where x.id = ${alertaId})`,
              )
            : eq(alertas.id, alertaId),
        )
        .returning({ id: alertas.id });
      const outros = fechados.length - 1;
      await this.auditoria.registrar(
        tx,
        { ...origem, lojaId: t.lojaId },
        {
          // Ação do catálogo fechado (ERP 17.1): quem resolve conferiu a máquina.
          acao: 'conferir',
          entidade: 'terminais',
          registroId: id,
          localizacao: `${LOCALIZACAO} › Resolver alerta`,
          descricao:
            `Alerta "${a.titulo}" resolvido` +
            `${outros > 0 ? ` (com ${outros} ${outros === 1 ? 'correção anterior' : 'correções anteriores'} do relógio)` : ''}` +
            `: ${entrada.resolucao}`,
          antes: { alerta_id: alertaId, tipo: a.tipo, resolvido_em: null },
          depois: {
            alerta_id: alertaId,
            tipo: a.tipo,
            resolucao: entrada.resolucao,
            ...(outros > 0 ? { alertas_ids: fechados.map((f) => f.id) } : {}),
          },
        },
      );
    });
    return this.detalhar(sessao, id);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Apoio

  /** Terminal da empresa da sessão, numa loja permitida. */
  private async carregar(sessao: SessaoErp, id: string): Promise<TerminalControle> {
    const [t] = await this.controle.db
      .select()
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.id, id),
          eq(terminaisPdv.empresaId, sessao.empresa.empresaId),
          isNull(terminaisPdv.excluidoEm),
        ),
      );
    if (!t) throw ErroApi.naoEncontrado('Terminal não encontrado.');
    garantirLoja(sessao, t.lojaId);
    return t;
  }

  private async existeNaEmpresa(tx: DbEmpresa, id: string): Promise<boolean> {
    const [e] = await tx.select({ id: terminais.id }).from(terminais).where(eq(terminais.id, id));
    return !!e;
  }

  private async comando(
    t: TerminalControle,
    origem: OrigemAcao,
    sessao: SessaoErp,
    c: {
      tipo: 'ressincronizar' | 'ressincronizar_fluxo' | 'mensagem';
      parametros: Record<string, unknown>;
      descricao: string;
      localizacao: string;
    },
  ): Promise<{ comandoId: string }> {
    return this.tenancy.cx().transacao(async (tx) => {
      if (!(await this.existeNaEmpresa(tx, t.id)))
        throw new ErroApi('REGRA_NEGOCIO', 'O terminal ainda está concluindo a ativação.');
      const comandoId = await enfileirarComando(tx, t.id, {
        tipo: c.tipo,
        parametros: c.parametros,
        usuarioId: sessao.usuarioId,
      });
      await this.auditoria.registrar(
        tx,
        { ...origem, lojaId: t.lojaId },
        {
          acao: 'criar',
          entidade: 'comandos_terminal',
          registroId: comandoId,
          localizacao: c.localizacao,
          descricao: `${c.descricao} (caixa ${t.numeroCaixa})`,
          depois: { terminal_id: t.id, tipo: c.tipo, parametros: c.parametros },
        },
      );
      return { comandoId };
    });
  }

  private resumo(
    t: TerminalControle,
    e: TerminalEmpresa | undefined,
    extra: {
      loja: { codigo: number; nome: string } | undefined;
      eventosComErro: number;
      operadorNome: string | null;
      minimas: Map<string, string>;
      agora: number;
    },
  ): TerminalResumo {
    const contato = maisRecente(t.ultimoContatoEm, e?.ultimoContatoEm);
    const eventosPendentes = e?.eventosPendentes ?? 0;
    const so = e?.sistemaOperacional ?? t.sistemaOperacional;
    const plataforma = plataformaDoSo(so);
    const versaoMinima = plataforma ? (extra.minimas.get(plataforma) ?? null) : null;
    const versaoApp = e?.versaoApp ?? t.versaoApp;
    return {
      id: t.id,
      status: t.status as TerminalResumo['status'],
      lojaId: t.lojaId,
      lojaCodigo: extra.loja?.codigo ?? null,
      lojaNome: extra.loja?.nome ?? null,
      caixaId: t.caixaId,
      numeroCaixa: t.numeroCaixa,
      descricao: t.descricao,
      nomeMaquina: e?.nomeMaquina ?? t.nomeMaquina,
      ultimoContatoEm: iso(contato),
      conexao: statusConexao(contato, extra.agora),
      comPendencias:
        t.status !== 'revogado' && comPendencias({ ultimoContatoEm: contato, eventosPendentes }, extra.agora),
      hardwareAlterado: t.status !== 'revogado' && !!t.idHardwarePendente,
      ultimoPullEm: iso(e?.ultimoPullEm),
      ultimoPushEm: iso(e?.ultimoPushEm),
      eventosPendentes,
      eventosComErro: extra.eventosComErro,
      nfceContingenciaPendentes: e?.nfceContingenciaPendentes ?? 0,
      desvioRelogioMs: e?.desvioRelogioMs ?? null,
      relogioConfiavel: e?.relogioConfiavel ?? null,
      versaoApp,
      versaoMinima,
      abaixoDaMinima: !!versaoMinima && !!versaoApp && compararVersoes(versaoApp, versaoMinima) < 0,
      operadorNome: extra.operadorNome,
      carenciaAte: iso(t.carenciaAte),
      revogadoEm: iso(t.revogadoEm),
    };
  }

  /** Versão mínima publicada por plataforma, no canal da empresa (ERP 19.5; SYNC 17.3). */
  private async versoesMinimas(empresaId: string): Promise<Map<string, string>> {
    const [e] = await this.controle.db
      .select({ canal: empresas.canalPdv })
      .from(empresas)
      .where(eq(empresas.id, empresaId));
    const linhas = await this.controle.db
      .select({ plataforma: versoesAppPdv.plataforma, versao: versoesAppPdv.versaoApp })
      .from(versoesAppPdv)
      .where(
        and(
          eq(versoesAppPdv.canal, e?.canal ?? 'estavel'),
          eq(versoesAppPdv.versaoMinima, true),
          isNull(versoesAppPdv.excluidoEm),
          sql`${versoesAppPdv.publicadaEm} is not null`,
        ),
      );
    const minimas = new Map<string, string>();
    for (const l of linhas) {
      const atual = minimas.get(l.plataforma);
      if (!atual || compararVersoes(l.versao, atual) > 0) minimas.set(l.plataforma, l.versao);
    }
    return minimas;
  }

  private async contarEventosComErro(db: DbEmpresa, ids: string[]): Promise<Map<string, number>> {
    const linhas = await db
      .select({ terminalId: eventosRecebidos.terminalId, n: sql<number>`count(*)::int` })
      .from(eventosRecebidos)
      .where(
        and(inArray(eventosRecebidos.terminalId, ids), inArray(eventosRecebidos.status, ['erro', 'retido'])),
      )
      .groupBy(eventosRecebidos.terminalId);
    return new Map(linhas.map((l) => [l.terminalId, l.n]));
  }

  /**
   * Alertas abertos de terminais (D20, token anterior reutilizado, lacunas, relógio), de força bruta na ativação e da
   * fila de decisão (SYNC 11.3–11.4), das lojas permitidas (ou sem loja); com `terminalId` (o detalhe), só os dele. Os
   * filtros de loja e de terminal vão no SQL, antes do limite de cada grupo: senão os alertas de outras lojas ou de
   * outros terminais ocupariam as vagas e um crítico mais antigo sumiria da tela (e o botão que o resolve junto). Os da
   * fila são por evento (`entidade = 'eventos_recebidos'`) e trazem o terminal em `dados.terminal_id`: o
   * `EVENTO_DESCARTADO` (crítico, ERP 12.5: "venda nunca é descartada sem gerar alerta") e o `EVENTO_DIVERGENTE`
   * (crítico, SYNC 8.4 camada 3) vêm um a um, até o "Ciente"; os `EVENTO_COM_ERRO` vêm somados por terminal ("N eventos
   * com erro", com o id e a mensagem do mais recente), para centenas de eventos não esconderem os outros alertas. Pelo
   * mesmo motivo, a regressão marcada do relógio (`RELOGIO_SUSPEITO` `info`, uma por correção para trás, C16) vem
   * somada por terminal com o id da mais recente: o "Ciente" dela fecha todas (`resolverAlerta`). Cada grupo tem o seu
   * limite.
   */
  private async alertasAbertos(
    db: DbEmpresa,
    sessao: SessaoErp,
    terminalId?: string,
  ): Promise<AlertaTerminal[]> {
    const doTerminal = sql<string>`${alertas.dados}->>'terminal_id'`;
    const abertos = and(isNull(alertas.resolvidoEm), isNull(alertas.excluidoEm));
    const abertosDaFila = (...tipos: string[]) =>
      and(
        inArray(alertas.tipo, tipos),
        eq(alertas.entidade, 'eventos_recebidos'),
        abertos,
        filtroLojas(sessao, alertas.lojaId),
        terminalId ? sql`${doTerminal} = ${terminalId}` : undefined,
      );
    // Os de terminal e o de força bruta (sem loja: o código de ativação é da empresa).
    const lojasOuSemLoja =
      sessao.lojas === null ? undefined : or(isNull(alertas.lojaId), filtroLojas(sessao, alertas.lojaId));
    const doTerminalPedido = terminalId
      ? and(eq(alertas.entidade, 'terminais'), eq(alertas.registroId, terminalId))
      : undefined;
    const umAUm = await db
      .select({ ...getTableColumns(alertas), terminalId: terminalDoAlerta(alertas) })
      .from(alertas)
      .where(
        and(
          abertosDaFila(ALERTA_EVENTO_DESCARTADO, ALERTA_EVENTO_DIVERGENTE),
          terminalId ? sql`${terminalDoAlerta(alertas)} = ${terminalId}` : undefined,
        ),
      )
      .orderBy(desc(alertas.criadoEm))
      .limit(50);
    const comErro = await db
      .select({
        terminalId: doTerminal,
        numeroCaixa: sql<number | null>`max(${caixas.numero})`,
        quantidade: sql<number>`count(*)::int`,
        critico: sql<boolean>`bool_or(${alertas.severidade} = 'critico')`,
        criadoEm: sql<string>`max(${alertas.criadoEm})`,
        id: sql<string>`(array_agg(${alertas.id} order by ${alertas.criadoEm} desc))[1]`,
        titulo: sql<string>`(array_agg(${alertas.titulo} order by ${alertas.criadoEm} desc))[1]`,
        mensagem: sql<string | null>`(array_agg(${alertas.mensagem} order by ${alertas.criadoEm} desc))[1]`,
      })
      .from(alertas)
      .leftJoin(terminais, sql`${terminais.id}::text = ${doTerminal}`)
      .leftJoin(caixas, eq(caixas.id, terminais.caixaId))
      .where(abertosDaFila(ALERTA_EVENTO_COM_ERRO))
      .groupBy(doTerminal)
      .orderBy(desc(sql`max(${alertas.criadoEm})`))
      .limit(50);
    const regressoes = await db
      .select({
        terminalId: sql<string>`${alertas.registroId}::text`,
        numeroCaixa: sql<number | null>`max(${caixas.numero})`,
        quantidade: sql<number>`count(*)::int`,
        criadoEm: sql<string>`max(${alertas.criadoEm})`,
        id: sql<string>`(array_agg(${alertas.id} order by ${alertas.criadoEm} desc))[1]`,
        titulo: sql<string>`(array_agg(${alertas.titulo} order by ${alertas.criadoEm} desc))[1]`,
        mensagem: sql<string | null>`(array_agg(${alertas.mensagem} order by ${alertas.criadoEm} desc))[1]`,
      })
      .from(alertas)
      .leftJoin(terminais, eq(terminais.id, alertas.registroId))
      .leftJoin(caixas, eq(caixas.id, terminais.caixaId))
      .where(
        and(regressaoMarcada, eq(alertas.entidade, 'terminais'), abertos, lojasOuSemLoja, doTerminalPedido),
      )
      .groupBy(alertas.registroId)
      .orderBy(desc(sql`max(${alertas.criadoEm})`))
      .limit(50);
    const linhas = await db
      .select()
      .from(alertas)
      .where(
        and(
          inArray(alertas.tipo, [
            ALERTA_EVENTOS_NAO_RESOLVIDOS,
            ALERTA_FORCA_BRUTA,
            ALERTA_TOKEN_ANTERIOR,
            ALERTA_LACUNA_DECLARADA,
            ALERTA_LACUNA_RECUPERADA,
            ALERTA_RELOGIO_SUSPEITO,
            ALERTA_RELOGIO_DESVIO,
          ]),
          not(regressaoMarcada),
          abertos,
          lojasOuSemLoja,
          doTerminalPedido,
        ),
      )
      .orderBy(desc(alertas.criadoEm))
      .limit(50);
    const doTerminalOuForcaBruta = linhas.map((a) => ({
      id: a.id,
      tipo: a.tipo,
      severidade: a.severidade as AlertaTerminal['severidade'],
      titulo: a.titulo,
      mensagem: a.mensagem,
      terminalId: a.entidade === 'terminais' ? a.registroId : null,
      criadoEm: a.criadoEm.toISOString(),
    }));
    const caixa = (n: number | null) => (n === null ? '?' : String(n).padStart(2, '0'));
    return [
      ...umAUm.map((a): AlertaTerminal => ({
        id: a.id,
        tipo: a.tipo,
        severidade: a.severidade as AlertaTerminal['severidade'],
        titulo: a.titulo,
        mensagem: a.mensagem,
        terminalId: a.terminalId,
        criadoEm: a.criadoEm.toISOString(),
      })),
      ...comErro.map((g): AlertaTerminal => ({
        id: g.id,
        tipo: ALERTA_EVENTO_COM_ERRO,
        severidade: g.critico ? 'critico' : 'aviso',
        titulo:
          g.quantidade === 1 ? g.titulo : `Caixa ${caixa(g.numeroCaixa)}: ${g.quantidade} eventos com erro`,
        mensagem: g.quantidade === 1 ? g.mensagem : `O mais recente: ${g.mensagem ?? 'sem mensagem.'}`,
        terminalId: g.terminalId,
        criadoEm: new Date(g.criadoEm).toISOString(),
      })),
      ...regressoes.map((g): AlertaTerminal => ({
        id: g.id,
        tipo: ALERTA_RELOGIO_SUSPEITO,
        severidade: 'info',
        titulo:
          g.quantidade === 1
            ? g.titulo
            : `Caixa ${caixa(g.numeroCaixa)}: relógio do computador voltou ${g.quantidade} vezes`,
        mensagem:
          g.quantidade === 1
            ? g.mensagem
            : `A mais recente: ${g.mensagem ?? 'sem mensagem.'} O "Ciente" vale para todas.`,
        terminalId: g.terminalId,
        criadoEm: new Date(g.criadoEm).toISOString(),
      })),
      ...doTerminalOuForcaBruta,
    ].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  }

  /** Linha do tempo (ERP 12.4): auditoria do terminal e comandos enviados, do mais recente ao mais antigo. */
  private async historico(db: DbEmpresa, id: string): Promise<EventoHistoricoTerminal[]> {
    const aud = await db
      .select({
        em: tabelaAuditoria.ocorridoEm,
        acao: tabelaAuditoria.acao,
        descricao: tabelaAuditoria.descricao,
        usuarioNome: tabelaAuditoria.usuarioNome,
      })
      .from(tabelaAuditoria)
      .where(
        and(
          eq(tabelaAuditoria.registroId, id),
          inArray(tabelaAuditoria.entidade, ['terminais', 'terminais_pdv']),
        ),
      )
      .orderBy(desc(tabelaAuditoria.ocorridoEm))
      .limit(100);
    const cmds = await db
      .select({
        em: comandosTerminal.criadoEm,
        tipo: comandosTerminal.tipo,
        status: comandosTerminal.status,
        parametros: comandosTerminal.parametros,
        usuarioNome: usuarios.nome,
      })
      .from(comandosTerminal)
      .leftJoin(usuarios, eq(usuarios.id, comandosTerminal.criadoPorId))
      .where(eq(comandosTerminal.terminalId, id))
      .orderBy(desc(comandosTerminal.criadoEm))
      .limit(50);
    const titulos: Record<string, string> = {
      terminal_ativado: 'Ativação',
      terminal_revogado: 'Revogação',
      hardware_alterado: 'Troca de hardware',
      token_anterior_reutilizado: 'Token anterior reutilizado',
      conferir: 'Alerta resolvido',
      evento_reprocessado: 'Reprocessamento de eventos',
      editar: 'Alteração',
    };
    return [
      ...aud.map((a): EventoHistoricoTerminal => ({
        em: a.em.toISOString(),
        tipo: 'auditoria',
        titulo: titulos[a.acao] ?? a.acao,
        descricao: a.descricao,
        usuarioNome: a.usuarioNome,
        situacao: null,
      })),
      ...cmds.map((c): EventoHistoricoTerminal => ({
        em: c.em.toISOString(),
        tipo: 'comando',
        titulo: `Comando ${c.tipo}`,
        descricao:
          c.tipo === 'ressincronizar_fluxo'
            ? `Fluxo ${String((c.parametros as { fluxo?: string }).fluxo ?? '')}`
            : c.tipo === 'mensagem'
              ? String((c.parametros as { texto?: string }).texto ?? '')
              : null,
        usuarioNome: c.usuarioNome,
        situacao: c.status,
      })),
    ].sort((a, b) => b.em.localeCompare(a.em));
  }
}
