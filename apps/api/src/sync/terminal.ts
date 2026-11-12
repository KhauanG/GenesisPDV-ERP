/**
 * Autenticação do token do terminal e regras de estado (SYNC 2.2, 3.6, 3.8; MD 2.3, 2.4). O token é
 * `<terminal_id>.<segredo>`: a API acha a linha em `genesis_control.terminais_pdv`, compara o SHA-256 do segredo em
 * tempo constante e só então resolve o banco da empresa. O nome do banco nunca é exposto ao PDV.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { terminaisPdv } from '../database/controle/schema.js';
import { iguaisTempoConstante, sha256Hex } from '../seguranca/tokens.js';
import type { ContextoEmpresa } from '../tenancy/contexto.js';
import type { EmpresaResolvida, ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import { ErroSync } from './erros.js';

export const PROTOCOLO_ATUAL = 1;
export const PROTOCOLO_MINIMO = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export type EndpointSync =
  | 'estado'
  | 'pull'
  | 'push'
  | 'heartbeat'
  | 'token'
  | 'eventos-status'
  | 'recuperar'
  | 'consulta-saldos'
  | 'arquivos';

/**
 * SYNC 3.7: o anterior só conta como reutilizado quando o atual já funcionou há mais que isso. Absorve a corrida do
 * próprio PDV (uma chamada recusada com o novo antes do commit da renovação cai para o anterior enquanto outra já usou
 * o novo); uma cópia que segue chamando é pega na chamada seguinte.
 */
export const MARGEM_TOKEN_ANTERIOR_MS = 30_000;

/**
 * Push, renovação de token, recuperação e as consultas online exigem o hardware registrado (SYNC 20.5; PDV 5.3): 409,
 * nada é gravado nem devolvido. O `recuperar` (22.2; Fase 1C, C17) entrega os payloads do terminal (vendas, CPF na
 * nota, quem retirou a sangria): uma cópia do token em outra máquina não os lê, e a reidratação só serve ao push, que
 * já exige o hardware. A consulta de saldos das outras lojas (F2-B35) mostra o estoque da empresa inteira: só o caixa
 * registrado a usa. As imagens do catálogo (`arquivos`, F2-B45) não exigem: são os mesmos cadastros que o pull entrega.
 */
const ENDPOINTS_COM_HARDWARE: ReadonlySet<EndpointSync> = new Set([
  'push',
  'token',
  'recuperar',
  'consulta-saldos',
]);

export function exigirHardware(t: TerminalAutenticado, endpoint: EndpointSync): void {
  if (!t.hardwareConfere && ENDPOINTS_COM_HARDWARE.has(endpoint)) {
    throw new ErroSync('HARDWARE_ALTERADO', 'Hardware alterado — aguardando aprovação no ERP.');
  }
}

export interface CabecalhosSync {
  protocolo: number;
  versaoApp: string;
  plataforma: 'windows_x64' | 'linux_x64';
  requisicaoId: string;
  horaLocal: string;
  idHardware: string;
}

/**
 * Substituição em andamento (SYNC 3.4): o 1º commit da ativação do novo já pôs o antigo em `desativando`, mas o novo
 * ainda está `provisionando` (a etapa da empresa não concluiu). Até ela concluir, o antigo continua sendo o terminal
 * do caixa: a compensação o devolveria a `ativo` só no controle, e um `desativando`/`revogar` entregue nesse meio-tempo
 * deixaria o PDV preso na desativação (o estado local só avança).
 */
export async function substituicaoEmAndamento(
  db: BancoControle['db'],
  t: Pick<typeof terminaisPdv.$inferSelect, 'status' | 'substituidoPorTerminalId'>,
): Promise<boolean> {
  if (t.status !== 'desativando' || !t.substituidoPorTerminalId) return false;
  const [novo] = await db
    .select({ status: terminaisPdv.status })
    .from(terminaisPdv)
    .where(eq(terminaisPdv.id, t.substituidoPorTerminalId));
  return novo?.status === 'provisionando';
}

/** Terminal autenticado de uma requisição `/sync/*`. */
export interface TerminalAutenticado {
  terminalId: string;
  /**
   * O status efetivo para o PDV: o `desativando` de uma substituição em andamento vale como `ativo`
   * (`substituicaoEmAndamento`), sem `revogar` e sem confirmação de desativação.
   */
  status: 'ativo' | 'desativando';
  /** `desativando` no controle por uma substituição cujo novo ainda está `provisionando`. */
  substituicaoEmAndamento: boolean;
  lojaId: string;
  caixaId: string;
  numeroCaixa: number;
  carenciaAte: Date | null;
  tokenEmitidoEm: Date;
  /** SHA-256 do segredo apresentado (a renovação confere que ainda é o atual, sob a trava da linha). */
  hashToken: string;
  /** Autenticado pelo `token_hash_anterior` (janela de 7 dias da rotação, SYNC 3.7). */
  porTokenAnterior: boolean;
  /** Anterior usado depois que o atual já funcionou (`token_atual_usado_em`): indício de cópia, gera alerta. */
  tokenAnteriorReutilizado: boolean;
  /** `false` quando o `X-Genesis-Id-Hardware` diverge do registrado (SYNC 20.5): nenhum segredo desce. */
  hardwareConfere: boolean;
  empresa: EmpresaResolvida;
  contexto: ContextoEmpresa;
  cabecalhos: CabecalhosSync;
  ip: string | null;
}

/** Cabeçalhos obrigatórios do protocolo (SYNC 2.2). */
export function lerCabecalhos(cabecalhos: IncomingHttpHeaders): CabecalhosSync {
  const h = (nome: string) => {
    const v = cabecalhos[nome];
    return typeof v === 'string' ? v.trim() : '';
  };
  const faltando: string[] = [];
  const protocolo = Number(h('x-genesis-protocolo'));
  if (!Number.isInteger(protocolo) || protocolo < 1) faltando.push('X-Genesis-Protocolo');
  const versaoApp = h('x-genesis-app-versao');
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(versaoApp)) faltando.push('X-Genesis-App-Versao');
  const plataforma = h('x-genesis-plataforma');
  if (plataforma !== 'windows_x64' && plataforma !== 'linux_x64') faltando.push('X-Genesis-Plataforma');
  const requisicaoId = h('x-requisicao-id').toLowerCase();
  if (!UUID.test(requisicaoId)) faltando.push('X-Requisicao-Id');
  const horaLocal = h('x-genesis-hora-local');
  if (!horaLocal || Number.isNaN(Date.parse(horaLocal))) faltando.push('X-Genesis-Hora-Local');
  const idHardware = h('x-genesis-id-hardware');
  if (!/^[0-9A-Za-z]{16,128}$/.test(idHardware)) faltando.push('X-Genesis-Id-Hardware');
  if (faltando.length) {
    throw ErroSync.invalida('Cabeçalhos do protocolo ausentes ou inválidos.', { cabecalhos: faltando });
  }
  if (protocolo < PROTOCOLO_MINIMO) {
    throw new ErroSync('PROTOCOLO_NAO_SUPORTADO', 'Atualize o aplicativo do PDV.', {
      protocolo_minimo: PROTOCOLO_MINIMO,
    });
  }
  return {
    protocolo,
    versaoApp,
    plataforma: plataforma as CabecalhosSync['plataforma'],
    requisicaoId,
    horaLocal,
    idHardware,
  };
}

export class AutenticacaoTerminal {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
  ) {}

  async autenticar(req: RequisicaoGenesis, endpoint: EndpointSync): Promise<TerminalAutenticado> {
    const cabecalhos = lerCabecalhos(req.headers);
    const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
    const partes = m?.[1]?.match(TOKEN);
    if (!partes) throw ErroSync.token();
    const [, terminalId, segredo] = partes as unknown as [string, string, string];
    const [t] = await this.controle.db.select().from(terminaisPdv).where(eq(terminaisPdv.id, terminalId));
    if (!t || t.excluidoEm) throw ErroSync.token();
    const hash = sha256Hex(segredo);
    const atual = iguaisTempoConstante(hash, t.tokenHash);
    const anterior =
      !atual &&
      t.tokenHashAnterior !== null &&
      t.tokenAnteriorValidoAte !== null &&
      t.tokenAnteriorValidoAte > new Date() &&
      iguaisTempoConstante(hash, t.tokenHashAnterior);
    if (!atual && !anterior) throw ErroSync.token();

    if (t.status === 'revogado') {
      throw new ErroSync('TERMINAL_REVOGADO', 'Este terminal foi desativado no ERP.', {
        revogado_em: t.revogadoEm?.toISOString() ?? null,
      });
    }
    if (t.status === 'provisionando') throw ErroSync.manutencao(30);

    const empresa = await this.resolvedor.porId(t.empresaId);
    if (!empresa || empresa.excluida) throw ErroSync.token();
    this.verificarEmpresa(empresa, endpoint);

    const hardwareConfere = t.idHardware === null || t.idHardware === cabecalhos.idHardware;
    const ip = req.ip ?? null;
    await this.registrarContato(t, cabecalhos, hardwareConfere, atual, ip);
    const emSubstituicao = await substituicaoEmAndamento(this.controle.db, t);
    // O 409 de hardware (push e renovação) sai em `exigirHardware`, depois do alerta do token anterior: o clone com o
    // token antigo em outra máquina é justamente o caso que o alerta precisa pegar.
    return {
      terminalId: t.id,
      status: emSubstituicao ? 'ativo' : (t.status as 'ativo' | 'desativando'),
      substituicaoEmAndamento: emSubstituicao,
      lojaId: t.lojaId,
      caixaId: t.caixaId,
      numeroCaixa: t.numeroCaixa,
      carenciaAte: t.carenciaAte,
      tokenEmitidoEm: t.tokenEmitidoEm,
      hashToken: hash,
      porTokenAnterior: anterior,
      tokenAnteriorReutilizado:
        anterior &&
        t.tokenAtualUsadoEm !== null &&
        t.tokenAtualUsadoEm.getTime() < Date.now() - MARGEM_TOKEN_ANTERIOR_MS,
      hardwareConfere,
      empresa,
      contexto: this.resolvedor.contexto(empresa),
      cabecalhos,
      ip,
    };
  }

  /**
   * Empresa por status (MD 2.3): suspensa ainda aceita push (os dados são do cliente) e a recuperação (22.2), que
   * existe para o push de um banco restaurado não perder nem duplicar nada.
   */
  private verificarEmpresa(e: EmpresaResolvida, endpoint: EndpointSync): void {
    if (e.status === 'migrando' || e.emManutencao) throw ErroSync.manutencao();
    if (e.status === 'ativa') return;
    if (e.status === 'cancelada') {
      throw new ErroSync('EMPRESA_CANCELADA', 'O contrato desta empresa foi cancelado.');
    }
    if (e.status === 'suspensa' && (endpoint === 'push' || endpoint === 'recuperar')) return;
    throw new ErroSync('EMPRESA_SUSPENSA', 'Acesso suspenso. Entre em contato com o suporte Genesis.', {
      ...(e.status === 'suspensa' && e.motivoStatus ? { motivo: e.motivoStatus } : {}),
    });
  }

  /**
   * Hardware divergente grava `id_hardware_pendente` (nunca troca `id_hardware`, SYNC 20.5) e, na primeira chamada
   * com aquele id, quando e de que IP ela veio (`hardware_pendente_desde`/`_ip`; o SO vem do primeiro heartbeat dela):
   * é o que o ERP mostra ao confirmar a troca. O contato e o IP do terminal ficam com a máquina registrada: a chamada
   * de outra máquina não os sobrescreve. O primeiro uso do token atual marca `token_atual_usado_em` (rotação, SYNC
   * 3.7). Contato no controle no máximo 1×/min (MD 2.4).
   */
  private async registrarContato(
    t: typeof terminaisPdv.$inferSelect,
    c: CabecalhosSync,
    hardwareConfere: boolean,
    tokenAtual: boolean,
    ip: string | null,
  ): Promise<void> {
    const agora = Date.now();
    const contatoVelho = !t.ultimoContatoEm || agora - t.ultimoContatoEm.getTime() > 60_000;
    const mudancas: Partial<typeof terminaisPdv.$inferInsert> = {};
    if (hardwareConfere && contatoVelho)
      Object.assign(mudancas, { ultimoContatoEm: new Date(agora), ultimoIp: ip });
    if (!hardwareConfere && t.idHardwarePendente !== c.idHardware) {
      Object.assign(mudancas, {
        idHardwarePendente: c.idHardware,
        hardwarePendenteDesde: sql`now()`,
        hardwarePendenteIp: ip,
        hardwarePendenteSo: null,
      });
    }
    if (tokenAtual && !t.tokenAtualUsadoEm) mudancas.tokenAtualUsadoEm = new Date(agora);
    if (Object.keys(mudancas).length === 0) return;
    await this.controle.db.update(terminaisPdv).set(mudancas).where(eq(terminaisPdv.id, t.id));
  }
}
