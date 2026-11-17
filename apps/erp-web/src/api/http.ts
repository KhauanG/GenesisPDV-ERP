import type { ErroApi, ExportacaoEmTarefa } from '@genesis/shared';
import { gravarLocal, lerLocal } from '../util/armazenamento';
import { caminhoSemDesvio } from './caminho';

/** Erro de uma chamada à API, já no envelope padrão `{ codigo, mensagem, campos }` (ERP 1.8). */
export class ErroRequisicao extends Error {
  constructor(
    readonly status: number,
    readonly corpo: ErroApi,
  ) {
    super(corpo.mensagem);
    this.name = 'ErroRequisicao';
  }

  get codigo(): ErroApi['codigo'] {
    return this.corpo.codigo;
  }

  get campos(): Record<string, string[]> | undefined {
    return this.corpo.campos;
  }
}

export interface SessaoToken {
  tokenAcesso: string;
  expiraEm: string;
}

export interface OpcoesCliente {
  /** Prefixo das rotas: `/api` (ERP) ou `/api/plataforma` (painel). */
  base: string;
  caminhoRefresh: string;
  caminhoLogout: string;
  /** Nome da trava entre abas (Web Locks): só uma aba gira o refresh token por vez (o logout também a usa). */
  nomeTrava: string;
  /**
   * Marcador (`localStorage`, sem segredo) de "Sair" ainda não confirmado pelo servidor: enquanto existir, nenhuma aba
   * renova a sessão pelo cookie (README do ERP › decisão 82).
   */
  chaveSaidaPendente: string;
}

export interface Ouvintes {
  /** Refresh recusado: a sessão acabou (logout em outra aba, inatividade, reuso, usuário desativado…). */
  aoExpirar?: () => void;
  /** 403 TROCA_SENHA_OBRIGATORIA: a senha provisória precisa ser trocada antes de qualquer outra tela. */
  aoTrocaSenhaObrigatoria?: () => void;
  aoRenovar?: (resposta: unknown) => void;
}

export interface OpcoesRequisicao {
  /** Rotas de sessão (login/refresh/logout) não tentam renovar o token num 401. */
  semRenovar?: boolean;
  sinal?: AbortSignal;
  /** Resposta como arquivo (`Blob` + nome do `Content-Disposition`) em vez de JSON. */
  binario?: boolean;
  /** Com `binario`: o `202` (a exportação que virou tarefa, F2-B29) volta como o JSON dela, não como arquivo. */
  aceitaTarefa?: boolean;
}

export interface ArquivoBaixado {
  blob: Blob;
  nome: string;
}

/** Nome do arquivo no `Content-Disposition` (`filename*=UTF-8''…` tem prioridade, RFC 6266). */
export function nomeDoArquivo(cabecalho: string | null, padrao: string): string {
  if (!cabecalho) return padrao;
  const estendido = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cabecalho);
  if (estendido) {
    try {
      return decodeURIComponent(estendido[1]!.trim());
    } catch {
      // nome malformado: tenta o simples
    }
  }
  const simples = /filename\s*=\s*"?([^";]+)"?/i.exec(cabecalho);
  return simples ? simples[1]!.trim() : padrao;
}

/** Caminho que o navegador desviaria para outra rota (README do ERP › decisão 85): nada é enviado, vira "não encontrado". */
const CAMINHO_INVALIDO: ErroApi = { codigo: 'NAO_ENCONTRADO', mensagem: 'Endereço não encontrado.' };

const SEM_CONEXAO: ErroApi = {
  codigo: 'ERRO_INTERNO',
  mensagem: 'Não foi possível falar com o servidor. Verifique a conexão e tente novamente.',
};

async function lerErro(res: Response): Promise<ErroApi> {
  try {
    const corpo = (await res.json()) as Partial<ErroApi>;
    if (corpo && typeof corpo.codigo === 'string' && typeof corpo.mensagem === 'string')
      return corpo as ErroApi;
  } catch {
    // corpo não é JSON (proxy, HTML de erro…)
  }
  return {
    codigo: res.status >= 500 ? 'ERRO_INTERNO' : 'VALIDACAO',
    mensagem: `Erro ${res.status} na requisição.`,
  };
}

/**
 * Cliente HTTP da API com o token de acesso só em memória (nunca em `localStorage`, ERP 4.1) e renovação pelo
 * cookie `httpOnly` de refresh: um 401 dispara uma única renovação (compartilhada entre chamadas simultâneas e
 * serializada entre abas) e repete a chamada; a renovação também é agendada 1 minuto antes de o token vencer.
 */
export function criarCliente(opcoes: OpcoesCliente) {
  let token: string | null = null;
  let agendamento: ReturnType<typeof setTimeout> | undefined;
  let renovando: Promise<unknown | null> | null = null;
  let ouvintes: Ouvintes = {};

  function agendar(expiraEm: string) {
    clearTimeout(agendamento);
    const ms = new Date(expiraEm).getTime() - Date.now() - 60_000;
    if (Number.isFinite(ms) && ms > 0) {
      agendamento = setTimeout(() => void renovar(), Math.min(ms, 2 ** 31 - 1));
    }
  }

  function instalar(s: SessaoToken) {
    token = s.tokenAcesso;
    agendar(s.expiraEm);
  }

  /** Sessão nova (login, troca de senha): o cookie foi trocado pelo servidor, a saída anterior não importa mais. */
  function definirSessao(s: SessaoToken) {
    gravarLocal(opcoes.chaveSaidaPendente, null);
    instalar(s);
  }

  function saidaPendente(): boolean {
    return lerLocal(opcoes.chaveSaidaPendente) !== null;
  }

  function limpar() {
    token = null;
    clearTimeout(agendamento);
  }

  async function chamarRefresh(): Promise<unknown | null> {
    const executar = async () => {
      const res = await fetch(opcoes.base + opcoes.caminhoRefresh, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    };
    return comTrava(executar);
  }

  /**
   * Renova a sessão pelo cookie. Devolve a resposta do refresh ou `null` se não houver sessão válida. Com a saída
   * pendente não renova, e a resposta que chega depois de um "Sair" é descartada (o token não volta à memória).
   */
  function renovar(): Promise<unknown | null> {
    if (saidaPendente()) {
      limpar();
      return Promise.resolve(null);
    }
    renovando ??= chamarRefresh()
      .catch(() => null)
      .then((r) => {
        const s = r as Partial<SessaoToken> | null;
        if (s?.tokenAcesso && s.expiraEm && !saidaPendente()) {
          instalar(s as SessaoToken);
          ouvintes.aoRenovar?.(r);
          return r;
        }
        limpar();
        return null;
      })
      .finally(() => {
        renovando = null;
      });
    return renovando;
  }

  /** Executa `fn` dentro da trava entre abas do refresh (Web Locks; sem elas, direto). */
  function comTrava<T>(fn: () => Promise<T>): Promise<T> {
    const travas = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return travas ? travas.request(opcoes.nomeTrava, fn) : fn();
  }

  /**
   * POST do logout dentro da trava, depois da renovação em andamento desta aba (sai com o cookie atual, não com um que
   * está sendo girado). Com `soSePendente`, confere o marcador dentro da trava, logo antes do fetch, e não chama o
   * servidor se ele já não existe (devolve `false`). Só um 2xx apaga o marcador (devolve `true`); falha de rede ou de
   * servidor lança `ErroRequisicao` e o marcador fica. Com o fetch, o token sai da memória em qualquer caso.
   */
  async function chamarLogout(soSePendente: boolean): Promise<boolean> {
    if (soSePendente && !saidaPendente()) return false;
    clearTimeout(agendamento);
    await renovando;
    let res: Response | null;
    try {
      res = await comTrava(async (): Promise<Response | null> =>
        soSePendente && !saidaPendente()
          ? null
          : fetch(opcoes.base + opcoes.caminhoLogout, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: '{}',
            }),
      );
    } catch {
      limpar();
      throw new ErroRequisicao(0, SEM_CONEXAO);
    }
    if (!res) return false;
    limpar();
    if (!res.ok) throw new ErroRequisicao(res.status, await lerErro(res));
    gravarLocal(opcoes.chaveSaidaPendente, null);
    return true;
  }

  /**
   * Logout confirmado do "Sair" (ERP 4.4; README do ERP › decisão 82): grava o marcador de saída pendente e chama o
   * logout (`chamarLogout`). Só um 2xx apaga o marcador; falha lança `ErroRequisicao` e o marcador fica.
   */
  async function encerrarSessao(): Promise<void> {
    gravarLocal(opcoes.chaveSaidaPendente, '1');
    await chamarLogout(false);
  }

  /**
   * Nova tentativa do logout que falhou (ao abrir, a cada 30 s, quando a conexão volta, no botão do aviso e antes do
   * login). Ao contrário do `encerrarSessao()`, **nunca grava o marcador** e só chama o servidor se ele ainda existe,
   * conferido dentro da trava: sem ele, outra aba já concluiu a saída ou entrou de novo, e o cookie do navegador é o
   * da sessão nova, que um logout derrubaria. `true`: o servidor confirmou; `false`: não havia mais saída pendente.
   */
  function repetirSaida(): Promise<boolean> {
    return chamarLogout(true);
  }

  /**
   * Login (sessão nova): o POST e o `definirSessao` (que apaga o marcador) ficam dentro da trava, então a nova
   * tentativa do logout de outra aba não cruza com ele — nem sai com o cookie novo antes de o marcador sumir, nem
   * tem a resposta (que apaga o cookie) chegando depois do cookie novo.
   */
  function abrirSessao<T extends SessaoToken>(caminho: string, dados: unknown): Promise<T> {
    return comTrava(async () => {
      const r = await requisitar<T>('POST', caminho, dados, { semRenovar: true });
      definirSessao(r);
      return r;
    });
  }

  async function requisitar<T>(
    metodo: string,
    caminho: string,
    corpo?: unknown,
    op: OpcoesRequisicao = {},
    repetida = false,
  ): Promise<T> {
    // A rota chamada é a que o caminho diz: sem segmento de ponto nem separador escondido que o navegador resolveria.
    if (!caminhoSemDesvio(caminho)) throw new ErroRequisicao(404, CAMINHO_INVALIDO);
    const cabecalhos: Record<string, string> = { Accept: op.binario ? '*/*' : 'application/json' };
    // FormData (upload): o navegador define o `multipart/form-data` com o boundary.
    const formulario = typeof FormData !== 'undefined' && corpo instanceof FormData;
    if (corpo !== undefined && !formulario) cabecalhos['Content-Type'] = 'application/json';
    if (token) cabecalhos.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(opcoes.base + caminho, {
        method: metodo,
        headers: cabecalhos,
        body: corpo === undefined ? undefined : formulario ? (corpo as FormData) : JSON.stringify(corpo),
        credentials: 'same-origin',
        signal: op.sinal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ErroRequisicao(0, SEM_CONEXAO);
    }
    if (res.status === 401 && !op.semRenovar && !repetida) {
      if (await renovar()) return requisitar<T>(metodo, caminho, corpo, op, true);
      ouvintes.aoExpirar?.();
    }
    if (!res.ok) {
      const erro = new ErroRequisicao(res.status, await lerErro(res));
      if (erro.codigo === 'TROCA_SENHA_OBRIGATORIA') ouvintes.aoTrocaSenhaObrigatoria?.();
      if (res.status === 401 && repetida) ouvintes.aoExpirar?.();
      throw erro;
    }
    if (op.binario && op.aceitaTarefa && res.status === 202) return (await res.json()) as T;
    if (op.binario) {
      const nome = nomeDoArquivo(
        res.headers.get('Content-Disposition'),
        caminho.split('?')[0]!.split('/').pop()!,
      );
      return { blob: await res.blob(), nome } as T;
    }
    if (res.status === 204) return undefined as T;
    const texto = await res.text();
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  return {
    get: <T>(caminho: string, op?: OpcoesRequisicao) => requisitar<T>('GET', caminho, undefined, op),
    post: <T>(caminho: string, corpo?: unknown, op?: OpcoesRequisicao) =>
      requisitar<T>('POST', caminho, corpo ?? {}, op),
    put: <T>(caminho: string, corpo: unknown, op?: OpcoesRequisicao) =>
      requisitar<T>('PUT', caminho, corpo, op),
    patch: <T>(caminho: string, corpo: unknown, op?: OpcoesRequisicao) =>
      requisitar<T>('PATCH', caminho, corpo, op),
    del: <T = void>(caminho: string, op?: OpcoesRequisicao) =>
      requisitar<T>('DELETE', caminho, undefined, op),
    /** POST multipart (upload de planilha da importação, ERP 8.6). */
    enviar: <T>(caminho: string, formulario: FormData, op?: OpcoesRequisicao) =>
      requisitar<T>('POST', caminho, formulario, op),
    /** GET de um arquivo (exportações): mesma autenticação e renovação das demais chamadas. */
    baixar: (caminho: string, op?: Omit<OpcoesRequisicao, 'binario'>) =>
      requisitar<ArquivoBaixado>('GET', caminho, undefined, { ...op, binario: true }),
    /**
     * GET da exportação de relatório (ERP 3.5; F2-B29): o arquivo, quando a API responde na hora (`200`), ou a tarefa
     * (`202 { tarefaId, linhas }`), que o ícone Tarefas acompanha.
     */
    baixarOuTarefa: (caminho: string, op?: Omit<OpcoesRequisicao, 'binario' | 'aceitaTarefa'>) =>
      requisitar<ArquivoBaixado | ExportacaoEmTarefa>('GET', caminho, undefined, {
        ...op,
        binario: true,
        aceitaTarefa: true,
      }),
    renovar,
    definirSessao,
    limpar,
    encerrarSessao,
    repetirSaida,
    abrirSessao,
    saidaPendente,
    /**
     * Outra aba apagou o marcador (concluiu a saída ou entrou de novo): o evento `storage` só chega às outras abas.
     * Devolve a função que desliga o ouvinte.
     */
    aoConcluirSaidaEmOutraAba(fn: () => void) {
      if (typeof window === 'undefined') return () => undefined;
      const ouvinte = (ev: StorageEvent) => {
        if ((ev.key === opcoes.chaveSaidaPendente || ev.key === null) && !saidaPendente()) fn();
      };
      window.addEventListener('storage', ouvinte);
      return () => window.removeEventListener('storage', ouvinte);
    },
    temToken: () => token !== null,
    ouvir(o: Ouvintes) {
      ouvintes = o;
      return () => {
        if (ouvintes === o) ouvintes = {};
      };
    },
  };
}

export type ClienteApi = ReturnType<typeof criarCliente>;

/** Monta a query string sem os valores vazios. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
