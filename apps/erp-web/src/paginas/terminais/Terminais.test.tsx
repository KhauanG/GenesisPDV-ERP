import type {
  EventoComErro,
  ListagemEventosComErro,
  ListagemTerminais,
  ResultadoReprocessamento,
  TerminalDetalhe,
  TerminalResumo,
} from '@genesis/shared';
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { avisoSalto, DetalheTerminal } from './DetalheTerminal';
import { DialogoRevogar } from './DialogoRevogar';
import { mensagemReprocessamento } from './FilaDecisao';
import { ListagemTerminais as Listagem } from './ListagemTerminais';
import { ModalGerarCodigo } from './ModalGerarCodigo';
import {
  DesvioRelogio,
  dicaDiscoLivre,
  dicaFilaImpressao,
  DiscoLivre,
  FilaImpressao,
  haQuanto,
  rotuloTerminal,
  tamanhoMb,
} from './rotulos';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '01928f3a-0000-7000-8000-0000000000a1';
const CAIXA = '01928f3a-0000-7000-8000-0000000000c2';
const T1 = '01928f3a-0000-7000-8000-0000000000f1';
const T2 = '01928f3a-0000-7000-8000-0000000000f2';
const ATIVACAO = '01928f3a-0000-7000-8000-0000000000d1';
const minAtras = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const terminal = (extra: Partial<TerminalResumo>): TerminalResumo => ({
  id: T1,
  status: 'ativo',
  lojaId: LOJA,
  lojaCodigo: 1,
  lojaNome: 'Loja 1 - Ice Beer Hermes',
  caixaId: CAIXA,
  numeroCaixa: 2,
  descricao: 'PC do balcão',
  nomeMaquina: 'CAIXA-02',
  ultimoContatoEm: minAtras(1),
  conexao: 'online',
  comPendencias: false,
  hardwareAlterado: false,
  ultimoPullEm: minAtras(1),
  ultimoPushEm: null,
  eventosPendentes: 0,
  eventosComErro: 0,
  nfceContingenciaPendentes: 0,
  desvioRelogioMs: 30_000,
  relogioConfiavel: true,
  versaoApp: '1.0.0',
  versaoMinima: null,
  abaixoDaMinima: false,
  operadorNome: null,
  carenciaAte: null,
  revogadoEm: null,
  ...extra,
});

const LISTA: ListagemTerminais = {
  itens: [
    terminal({ operadorNome: 'MARIA' }),
    terminal({
      id: T2,
      numeroCaixa: 3,
      descricao: null,
      conexao: 'offline',
      ultimoContatoEm: minAtras(180),
      comPendencias: true,
      eventosPendentes: 4,
      eventosComErro: 2,
      versaoApp: '0.9.0',
      versaoMinima: '1.0.0',
      abaixoDaMinima: true,
      hardwareAlterado: true,
      // Computador 6 min adiantado (desvio = servidor − local) e sem amostra confiável no boot.
      desvioRelogioMs: -6 * 60_000,
      relogioConfiavel: false,
    }),
  ],
  contadores: { online: 1, offline: 1, sem_contato: 0 },
  alertas: [
    {
      id: '01928f3a-0000-7000-8000-0000000000b1',
      tipo: 'TERMINAL_DESATIVADO_COM_EVENTOS',
      severidade: 'critico',
      titulo: 'Terminal do caixa 03 saiu com 2 evento(s) sem resolver',
      mensagem: 'Resolva na aba "Eventos com erro".',
      terminalId: T2,
      criadoEm: minAtras(5),
    },
  ],
  geradoEm: new Date().toISOString(),
};

const ATIVACOES = {
  pendentes: [
    {
      id: ATIVACAO,
      codigoMascarado: '••••-••RD',
      lojaId: LOJA,
      lojaNome: '1 - Loja 1 - Ice Beer Hermes',
      caixaId: CAIXA,
      numeroCaixa: 4,
      descricao: null,
      geradoPor: 'MARIA SILVA',
      criadoEm: minAtras(10),
      expiraEm: new Date(Date.now() + 3_600_000).toISOString(),
      substituiTerminalId: null,
    },
  ],
  bloqueio: { bloqueado: true, falhas: 20, limite: 20, ate: new Date(Date.now() + 1_800_000).toISOString() },
};

const PERMISSOES = ['terminais.ver', 'terminais.ativar', 'terminais.revogar', 'terminais.gerenciar'];

const ERRO: EventoComErro = {
  id: '01928f3a-0000-7000-8000-00000000e101',
  eventoId: '01928f3a-0000-7000-8000-00000000e001',
  sequencia: 1,
  tipo: 'caixa.aberto',
  ocorridoEm: minAtras(30),
  status: 'erro',
  erroCodigo: 'PAYLOAD_INVALIDO',
  erro: 'payload_sha256 divergente',
  agregadoTipo: 'sessao_caixa',
  agregadoId: '01928f3a-0000-7000-8000-00000000a001',
  tentativas: 1,
  recebidoEm: minAtras(29),
  aguardando: [],
  dependencias: [],
  payload: null,
  resumo: null,
  confirmacaoDescarte: '1',
};

const RETIDO: EventoComErro = {
  ...ERRO,
  id: '01928f3a-0000-7000-8000-00000000e102',
  eventoId: '01928f3a-0000-7000-8000-00000000e002',
  sequencia: 2,
  tipo: 'venda.finalizada',
  status: 'retido',
  erroCodigo: 'DEPENDENCIA_PENDENTE',
  erro: 'Aguardando dependência com erro',
  agregadoTipo: 'venda',
  aguardando: [{ eventoId: ERRO.eventoId, sequencia: 1, tipo: 'caixa.aberto' }],
  dependencias: [{ agregadoTipo: 'sessao_caixa', agregadoId: ERRO.agregadoId }],
  resumo: 'Venda L01-C02-000123 · R$ 71,58 · 4 itens',
  confirmacaoDescarte: 'L01-C02-000123',
};

const listagem = (
  itens: EventoComErro[],
  codigos = [{ codigo: 'PAYLOAD_INVALIDO', quantidade: 1 }],
): ListagemEventosComErro => ({ itens, total: itens.length, pagina: 1, tamanho: 50, codigos });

describe('rotulos dos terminais', () => {
  it('"há N" a partir do último contato e o rótulo Loja · Caixa', () => {
    const agora = Date.parse('2026-10-30T12:00:00Z');
    expect(haQuanto(null, agora)).toBe('nunca');
    expect(haQuanto('2026-10-30T11:59:30Z', agora)).toBe('agora');
    expect(haQuanto('2026-10-30T11:57:00Z', agora)).toBe('há 3 min');
    expect(haQuanto('2026-10-30T09:00:00Z', agora)).toBe('há 3 h');
    expect(haQuanto('2026-10-28T12:00:00Z', agora)).toBe('há 2 dias');
    expect(rotuloTerminal({ lojaCodigo: 1, lojaNome: 'Loja 1 - Ice Beer Hermes', numeroCaixa: 2 })).toBe(
      'Loja 1 - Ice Beer Hermes · Caixa 02',
    );
  });

  it('<DesvioRelogio>: até 2 min só o valor; acima, âmbar (aviso); acima de 5 min, vermelho (crítico)', () => {
    const nivel = (desvioMs: number | null) => {
      const { unmount } = render(
        <MantineProvider>
          <div data-testid="desvio">
            <DesvioRelogio desvioMs={desvioMs} confiavel />
          </div>
        </MantineProvider>,
      );
      const celula = screen.getByTestId('desvio');
      const selo = celula.querySelector<HTMLElement>('[data-nivel]');
      // A cor do selo (Mantine grava `--badge-bg: var(--mantine-color-<cor>-light)`); o valor normal não tem selo.
      const cor =
        /--mantine-color-(\w+)-light\)/.exec(selo?.style.getPropertyValue('--badge-bg') ?? '')?.[1] ?? null;
      const r = [selo?.getAttribute('data-nivel') ?? null, cor, celula.textContent];
      unmount();
      return r;
    };
    expect(nivel(null)).toEqual([null, null, '—']);
    expect(nivel(2 * 60_000)).toEqual(['normal', null, '2 min']);
    expect(nivel(-3 * 60_000)).toEqual(['aviso', 'orange', '3 min adiantado']);
    expect(nivel(5 * 60_000)).toEqual(['aviso', 'orange', '5 min atrasado']);
    expect(nivel(5 * 60_000 + 1_000)).toEqual(['critico', 'red', '5 min atrasado']);
    // A partir de 48 h em dias, como o título do alerta `RELOGIO_DESVIO` (o mesmo `duracaoLegivel` do shared).
    expect(nivel(72 * 3_600_000)).toEqual(['critico', 'red', '3 dias atrasado']);
  });
});

describe('saúde do computador (Central do PDV G15; PDV 32.2)', () => {
  /** Nível (`data-nivel`), cor do selo (a que o Mantine grava) e o texto, como no teste do relógio. */
  const ler = (no: ReactNode) => {
    const { unmount } = render(
      <MantineProvider>
        <div data-testid="saude">{no}</div>
      </MantineProvider>,
    );
    const celula = screen.getByTestId('saude');
    const selo = celula.querySelector<HTMLElement>('[data-nivel]');
    const cor =
      /--mantine-color-(\w+)-light\)/.exec(selo?.style.getPropertyValue('--badge-bg') ?? '')?.[1] ?? null;
    const r = [selo?.getAttribute('data-nivel') ?? null, cor, selo?.textContent ?? celula.textContent];
    unmount();
    return r;
  };

  it('tamanhoMb: MB até 1023, GB com uma casa a partir de 1024; sem valor, —', () => {
    expect(tamanhoMb(null)).toBe('—');
    expect(tamanhoMb(0)).toBe('0 MB');
    expect(tamanhoMb(412)).toBe('412 MB');
    expect(tamanhoMb(1023)).toBe('1023 MB');
    expect(tamanhoMb(1024)).toBe('1,0 GB');
    expect(tamanhoMb(48_210)).toBe('47,1 GB');
  });

  it('<DiscoLivre>: a partir de 1 GB só o valor; abaixo, âmbar "pouco espaço"; abaixo de 200 MB, vermelho', () => {
    expect(ler(<DiscoLivre mb={null} />)).toEqual([null, null, '—']);
    expect(ler(<DiscoLivre mb={1024} />)).toEqual(['normal', null, '1,0 GB']);
    expect(ler(<DiscoLivre mb={1023} />)).toEqual(['aviso', 'orange', '1023 MB · pouco espaço']);
    expect(ler(<DiscoLivre mb={200} />)).toEqual(['aviso', 'orange', '200 MB · pouco espaço']);
    expect(ler(<DiscoLivre mb={199} />)).toEqual(['critico', 'red', '199 MB · quase cheio']);
    // Revogado: o último valor, sem selo nem cor (não há mais o que resolver).
    expect(ler(<DiscoLivre mb={150} modo="sem_cor" />)).toEqual([null, null, '150 MB']);
    // Sem heartbeat há mais de 24 h: o mesmo selo, cinza (o dado é de dias atrás).
    expect(ler(<DiscoLivre mb={150} modo="antigo" />)).toEqual(['critico', 'gray', '150 MB · quase cheio']);
  });

  it('dicaDiscoLivre: o que fazer nas duas faixas, com as frases do Painel; dado antigo não manda agir', () => {
    expect(dicaDiscoLivre(null)).toBeNull();
    expect(dicaDiscoLivre(1024)).toBeNull();
    const aviso = dicaDiscoLivre(850)!;
    expect(aviso).toContain('Libere espaço: apague arquivos que não são do caixa (downloads, fotos, vídeos)');
    expect(aviso).toContain(
      'Abaixo de 200 MB o caixa não abre caixa novo; o supervisor pode liberar a abertura por 1 h.',
    );
    const critico = dicaDiscoLivre(150)!;
    expect(critico).toContain('Abrir caixa novo está bloqueado no caixa (a venda em curso continua).');
    expect(critico).toContain('O supervisor pode liberar a abertura do caixa por 1 h.');
    // Nunca "programas": o driver da impressora, o TEF e o acesso remoto do suporte são programas.
    for (const dica of [aviso, critico]) expect(dica).not.toMatch(/programa/i);
    expect(dicaDiscoLivre(150, 'antigo')).toMatch(
      /^Dado antigo: o caixa não manda heartbeat há mais de 24 h/,
    );
    expect(dicaDiscoLivre(150, 'sem_cor')).toBeNull();
  });

  it('<FilaImpressao>: nenhum comprovante é normal; qualquer um é âmbar "não impresso", nunca vermelho', () => {
    expect(ler(<FilaImpressao pendentes={0} />)).toEqual(['normal', null, 'Nenhum']);
    // "não impresso", não "esperando": o número inclui os que falharam (impressora travada).
    expect(ler(<FilaImpressao pendentes={1} />)).toEqual(['aviso', 'orange', '1 comprovante não impresso']);
    expect(ler(<FilaImpressao pendentes={7} />)).toEqual(['aviso', 'orange', '7 comprovantes não impressos']);
    expect(ler(<FilaImpressao pendentes={3} modo="sem_cor" />)).toEqual([
      null,
      null,
      '3 comprovantes não impressos',
    ]);
    expect(ler(<FilaImpressao pendentes={3} modo="antigo" />)).toEqual([
      'aviso',
      'gray',
      '3 comprovantes não impressos',
    ]);
    expect(dicaFilaImpressao(0)).toBeNull();
    expect(dicaFilaImpressao(2)).toMatch(/Central do PDV › 3 Impressora e gaveta \(F7\)/);
    expect(dicaFilaImpressao(2, 'antigo')).toMatch(/^Dado antigo/);
  });
});

describe('substituição (ERP 12.4; SYNC 13.3)', () => {
  it('sem desativação confirmada mostra a faixa reservada ao terminal antigo', () => {
    const base = { ...terminal({}), vendaUltimoNumero: 500, desativacaoConfirmadaEm: null } as Parameters<
      typeof avisoSalto
    >[0];
    expect(avisoSalto(base)).toBe(
      'Números 000501–001500 do Caixa 02 ficam reservados ao terminal antigo (salto de segurança, sem confirmação de desativação).',
    );
    expect(avisoSalto({ ...base, desativacaoConfirmadaEm: new Date().toISOString() })).toBeNull();
  });
});

describe('<ListagemTerminais> (ERP 12.2)', () => {
  it('contadores, colunas, badges, alerta da D20, códigos pendentes e "Liberar ativações"', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/terminais' ? { corpo: LISTA } : undefined),
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === '/api/terminais/ativacoes' ? { corpo: ATIVACOES } : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/terminais/ativacoes/liberar'
          ? { corpo: { bloqueado: false, falhas: 0, limite: 20, ate: null } }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'DELETE' && url.pathname === `/api/terminais/ativacoes/${ATIVACAO}`
          ? { status: 204 }
          : undefined,
    );
    renderizarComSessao(<Listagem />);
    expect(await screen.findByRole('link', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' })).toHaveAttribute(
      'href',
      `/cadastros/pdvs/${T1}`,
    );
    expect(screen.getByTestId('contador-online')).toHaveTextContent('1');
    expect(screen.getByTestId('contador-offline')).toHaveTextContent('1');
    expect(screen.getByTestId('contador-sem_contato')).toHaveTextContent('0');
    const linha = screen.getByRole('link', { name: 'Loja 1 - Ice Beer Hermes · Caixa 03' }).closest('tr')!;
    expect(within(linha).getByText('Offline')).toBeInTheDocument();
    expect(within(linha).getByText('há 3 h')).toBeInTheDocument();
    expect(within(linha).getByText('Com pendências')).toBeInTheDocument();
    expect(within(linha).getByText('Hardware alterado')).toBeInTheDocument();
    expect(within(linha).getByText('desatualizado')).toBeInTheDocument();
    expect(within(linha).getByText('CAIXA-02')).toBeInTheDocument();
    // Coluna "Relógio" (SYNC 21.2): vermelho acima de 5 min, com o sentido; até 2 min, só o valor.
    expect(screen.getByRole('columnheader', { name: 'Relógio' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId(`relogio-${T2}`))
        .getByText('6 min adiantado')
        .closest('[data-nivel]'),
    ).toHaveAttribute('data-nivel', 'critico');
    expect(screen.getByTestId(`relogio-${T1}`).querySelector('[data-nivel]')).toHaveAttribute(
      'data-nivel',
      'normal',
    );
    expect(within(screen.getByTestId(`relogio-${T2}`)).getByText('hora não confirmada')).toBeInTheDocument();
    expect(screen.getByTestId(`relogio-${T1}`)).toHaveTextContent('30 s');
    expect(screen.getByTestId(`relogio-${T1}`)).not.toHaveTextContent('hora não confirmada');
    expect(screen.getByText('MARIA')).toBeInTheDocument();
    expect(screen.getByText('Terminal do caixa 03 saiu com 2 evento(s) sem resolver')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver eventos do terminal' })).toHaveAttribute(
      'href',
      `/cadastros/pdvs/${T2}?aba=eventos`,
    );
    expect(await screen.findByText('••••-••RD')).toBeInTheDocument();
    expect(screen.getByText('Ativações temporariamente bloqueadas')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Liberar ativações' }));
    await u.click(await screen.findByRole('button', { name: 'Liberar' }));
    await waitFor(() =>
      expect(
        chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/terminais/ativacoes/liberar'),
      ).toBe(true),
    );
    const pendente = screen.getByText('••••-••RD').closest('tr')!;
    await u.click(within(pendente).getByRole('button', { name: 'Cancelar' }));
    await u.click(await screen.findByRole('button', { name: 'Cancelar código' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'DELETE')).toBe(true));
  });

  it('filtros vão para a API (situação padrão Ativos)', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['terminais.ver'] }),
      ({ url }) => (url.pathname === '/api/terminais' ? { corpo: { ...LISTA, alertas: [] } } : undefined),
      ({ url }) =>
        url.pathname === '/api/terminais/ativacoes'
          ? { corpo: { pendentes: [], bloqueio: { bloqueado: false, falhas: 0, limite: 20, ate: null } } }
          : undefined,
    );
    renderizarComSessao(<Listagem />);
    await screen.findByRole('link', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' });
    const primeira = chamadas.find((c) => c.url.pathname === '/api/terminais')!;
    expect(primeira.url.searchParams.get('situacao')).toBe('ativos');
    expect(screen.queryByRole('button', { name: 'Gerar código de ativação' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('combobox', { name: 'Conexão' }));
    await u.click(await screen.findByRole('option', { name: 'Com pendências', hidden: true }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/terminais' && c.url.searchParams.get('conexao') === 'com_pendencias',
        ),
      ).toBe(true),
    );
  });
});

describe('<ModalGerarCodigo> (ERP 12.3)', () => {
  it('sugere o primeiro caixa livre e mostra o código uma vez com o código da empresa', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({
        permissoes: PERMISSOES,
        lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
      }),
      ({ url }) =>
        url.pathname === '/api/terminais/caixas-livres' && url.searchParams.get('lojaId') === LOJA
          ? { corpo: [{ id: CAIXA, numero: 2, descricao: 'Balcão', terminalDesativandoId: null }] }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/terminais/ativacoes'
          ? {
              status: 201,
              corpo: { codigo: 'K7QM-2XRD', expiraEm: new Date().toISOString(), ativacaoId: ATIVACAO },
            }
          : undefined,
    );
    renderizarComSessao(<ModalGerarCodigo aberto aoFechar={() => undefined} />);
    await u.click(await screen.findByRole('combobox', { name: /^Loja/ }));
    await u.click(await screen.findByRole('option', { name: '1 - Loja 1 - Ice Beer Hermes', hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Caixa/ })).toHaveValue('Caixa 02 – Balcão'),
    );
    await u.type(screen.getByRole('textbox', { name: 'Descrição' }), 'PC novo');
    await u.click(screen.getByRole('radio', { name: '72 h' }));
    await u.click(screen.getByRole('button', { name: 'Gerar código' }));
    expect(await screen.findByTestId('codigo-ativacao')).toHaveTextContent('K7QM-2XRD');
    expect(screen.getByText('100001')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname === '/api/terminais/ativacoes')!.corpo).toEqual({
      lojaId: LOJA,
      caixaId: CAIXA,
      descricao: 'PC novo',
      validadeHoras: 72,
      substituiTerminalId: null,
    });
  });
});

describe('<DialogoRevogar> (ERP 12.4)', () => {
  it('imediato só libera o botão com o nº do caixa digitado e manda a confirmação', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao({ permissoes: PERMISSOES }), ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === `/api/terminais/${T1}/revogar` ? { corpo: {} } : undefined,
    );
    const fechar = vi.fn();
    renderizarComSessao(<DialogoRevogar terminal={terminal({})} modo="imediato" aoFechar={fechar} />);
    const botao = await screen.findByRole('button', { name: 'Revogar agora' });
    expect(botao).toBeDisabled();
    await u.type(screen.getByRole('textbox', { name: /Digite 2/ }), '3');
    expect(botao).toBeDisabled();
    await u.clear(screen.getByRole('textbox', { name: /Digite 2/ }));
    await u.type(screen.getByRole('textbox', { name: /Digite 2/ }), '2');
    expect(botao).toBeEnabled();
    await u.click(botao);
    await waitFor(() => expect(fechar).toHaveBeenCalled());
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/revogar'))!.corpo).toEqual({
      modo: 'imediato',
      confirmacaoCaixa: 2,
      observacao: null,
    });
  });
});

describe('<ModalGerarCodigo> sem lojas.ver e com terminal em desativação', () => {
  const sessao = () =>
    rotasSessao({
      permissoes: ['terminais.ver', 'terminais.ativar'],
      lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
    });
  const escolherLoja = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.click(await screen.findByRole('combobox', { name: /^Loja/ }));
    await u.click(await screen.findByRole('option', { name: '1 - Loja 1 - Ice Beer Hermes', hidden: true }));
  };

  it('o caixa de um terminal em desativação aparece com o aviso do salto', async () => {
    const u = userEvent.setup();
    simularApi(...sessao(), ({ url }) =>
      url.pathname === '/api/terminais/caixas-livres'
        ? { corpo: [{ id: CAIXA, numero: 2, descricao: null, terminalDesativandoId: T2 }] }
        : undefined,
    );
    renderizarComSessao(<ModalGerarCodigo aberto aoFechar={() => undefined} />);
    await escolherLoja(u);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Caixa/ })).toHaveValue(
        'Caixa 02 (terminal em desativação)',
      ),
    );
    expect(screen.getByText(/O terminal deste caixa está em desativação/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gerar código' })).toBeEnabled();
  });

  it('erro ao listar os caixas aparece no campo em vez de um Select vazio', async () => {
    const u = userEvent.setup();
    simularApi(...sessao(), ({ url }) =>
      url.pathname === '/api/terminais/caixas-livres'
        ? {
            status: 403,
            corpo: { codigo: 'SEM_PERMISSAO', mensagem: 'A loja está fora das suas lojas permitidas.' },
          }
        : undefined,
    );
    renderizarComSessao(<ModalGerarCodigo aberto aoFechar={() => undefined} />);
    await escolherLoja(u);
    expect(await screen.findByText('A loja está fora das suas lojas permitidas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gerar código' })).toBeDisabled();
  });
});

const DETALHE = (extra: Partial<TerminalDetalhe> = {}): TerminalDetalhe => ({
  ...terminal({}),
  sistemaOperacional: 'Windows 11 Pro',
  idHardware: 'A'.repeat(64),
  idHardwarePendente: null,
  hardwarePendente: null,
  ultimoIp: '10.0.0.2',
  ativadoEm: minAtras(600),
  ativadoPorNome: 'MARIA SILVA',
  motivoRevogacao: null,
  revogadoPorNome: null,
  substituidoPorTerminalId: null,
  ultimoHeartbeatEm: minAtras(1),
  cursorPull: { configuracao: 10 },
  desvioRelogioMs: 0,
  estadoLocal: 'ativo',
  ultimoErro: null,
  tipoEmissao: 'nfce',
  nfceSerie: 2,
  nfceUltimoNumero: null,
  nfceContingenciaMaisAntigaEm: null,
  certificadoValidade: null,
  sessaoCaixaId: null,
  dinheiroEstimadoGaveta: null,
  vendaUltimoNumero: 500,
  discoLivreMb: null,
  tamanhoBancoMb: null,
  filaImpressaoPendentes: 0,
  desativacaoConfirmadaEm: null,
  historico: [],
  alertas: [],
  ...extra,
});

function renderizarDetalhe(
  detalhe: TerminalDetalhe,
  permissoes: string[],
  extra: Parameters<typeof simularApi> = [],
  aba = '',
) {
  const api = simularApi(
    ...rotasSessao({
      permissoes,
      lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
    }),
    ({ url, metodo }) =>
      metodo === 'GET' && url.pathname === `/api/terminais/${T1}` ? { corpo: detalhe } : undefined,
    ...extra,
  );
  renderizarComSessao(<DetalheTerminal />, `/cadastros/pdvs/${T1}${aba}`, 'cadastros/pdvs/:id');
  return api;
}

describe('<DetalheTerminal> (ERP 12.4)', () => {
  it('ações conforme as permissões; Substituir abre o modal travado no caixa, com o aviso, e manda substituiTerminalId', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(DETALHE(), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/terminais/ativacoes'
          ? {
              status: 201,
              corpo: { codigo: 'K7QM-2XRD', expiraEm: new Date().toISOString(), ativacaoId: ATIVACAO },
            }
          : undefined,
    ]);
    await screen.findByRole('heading', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' });
    for (const nome of ['Revogar', 'Substituir terminal', 'Ressincronizar', 'Enviar mensagem', 'Renomear']) {
      expect(screen.getByRole('button', { name: nome })).toBeInTheDocument();
    }
    await u.click(screen.getByRole('button', { name: 'Substituir terminal' }));
    expect(await screen.findByText(/Números 000501–001500 do Caixa 02/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^Caixa/ })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Gerar código' }));
    expect(await screen.findByTestId('codigo-ativacao')).toHaveTextContent('K7QM-2XRD');
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/terminais/ativacoes')!.corpo,
    ).toMatchObject({
      lojaId: LOJA,
      caixaId: CAIXA,
      substituiTerminalId: T1,
    });
    expect(chamadas.some((c) => c.url.pathname.includes('caixas-livres'))).toBe(false);
  });

  it('alerta de token anterior: "Máquina conferida" manda a resolução; "Revogar terminal" abre a revogação', async () => {
    const u = userEvent.setup();
    const alerta = {
      id: '01928f3a-0000-7000-8000-0000000000c1',
      tipo: 'TOKEN_ANTERIOR_REUTILIZADO',
      severidade: 'critico' as const,
      titulo: 'Token antigo do caixa 02 usado depois da renovação',
      mensagem: 'Pode haver uma cópia do terminal.',
      terminalId: T1,
      criadoEm: minAtras(5),
    };
    const { chamadas } = renderizarDetalhe(DETALHE({ alertas: [alerta] }), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/terminais/${T1}/alertas/${alerta.id}/resolver`
          ? { corpo: DETALHE() }
          : undefined,
    ]);
    expect(await screen.findByText(alerta.titulo)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Máquina conferida' }));
    const resolver = await screen.findByRole('button', { name: 'Resolver' });
    expect(resolver).toBeDisabled();
    await u.type(screen.getByLabelText(/O que foi verificado/), '  Backup restaurado na mesma máquina ');
    await u.click(resolver);
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/alertas/${alerta.id}/resolver`)?.corpo,
      ).toEqual({ resolucao: 'Backup restaurado na mesma máquina' }),
    );

    await u.click(screen.getByRole('button', { name: 'Revogar terminal' }));
    expect(
      await screen.findByDisplayValue('Token anterior usado: possível cópia do terminal'),
    ).toBeInTheDocument();
  });

  it('alerta de token anterior com só terminais.ver: sem ações', async () => {
    renderizarDetalhe(
      DETALHE({
        alertas: [
          {
            id: '01928f3a-0000-7000-8000-0000000000c2',
            tipo: 'TOKEN_ANTERIOR_REUTILIZADO',
            severidade: 'critico',
            titulo: 'Token antigo usado',
            mensagem: null,
            terminalId: T1,
            criadoEm: minAtras(5),
          },
        ],
      }),
      ['terminais.ver'],
    );
    expect(await screen.findByText('Token antigo usado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Máquina conferida' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revogar terminal' })).not.toBeInTheDocument();
  });

  it('saúde do computador (G15): disco, banco e fila do último heartbeat, com as cores do Painel do PDV', async () => {
    renderizarDetalhe(
      DETALHE({
        discoLivreMb: 150,
        tamanhoBancoMb: 412,
        filaImpressaoPendentes: 2,
        ultimoHeartbeatEm: minAtras(3),
      }),
      ['terminais.ver'],
    );
    const bloco = (await screen.findByText('Saúde do computador')).closest<HTMLElement>(
      '.mantine-Paper-root',
    )!;
    const disco = within(bloco).getByText('150 MB · quase cheio');
    expect(disco.closest('[data-nivel]')).toHaveAttribute('data-nivel', 'critico');
    // O que fazer fica numa linha própria embaixo do campo, fora da linha do rótulo (que não quebra).
    const dicaDisco = within(bloco).getByText(/Abrir caixa novo está bloqueado no caixa/);
    expect(within(bloco).getByText('Disco livre').parentElement).not.toContainElement(dicaDisco);
    expect(within(bloco).getByText('Disco livre').parentElement!.parentElement).toContainElement(dicaDisco);
    expect(within(bloco).getByText('412 MB')).toBeInTheDocument();
    expect(within(bloco).getByText('2 comprovantes não impressos').closest('[data-nivel]')).toHaveAttribute(
      'data-nivel',
      'aviso',
    );
    const dicaFila = within(bloco).getByText(/Central do PDV › 3 Impressora e gaveta \(F7\)/);
    expect(within(bloco).getByText('Fila de impressão').parentElement).not.toContainElement(dicaFila);
    // A fila vem em todo heartbeat; o disco e o banco, só quando o caixa mediu (o anterior não é apagado).
    expect(within(bloco).getByTestId('saude-origem')).toHaveTextContent(
      'Fila do último heartbeat (há 3 min); disco e banco da última medida.',
    );
    // Fora do grid dos quatro blocos, na largura toda (como o Histórico).
    expect(bloco.closest('.mantine-SimpleGrid-root')).toBeNull();
  });

  it('saúde do computador: faixa âmbar com o que fazer e heartbeat de menos de 1 min', async () => {
    renderizarDetalhe(DETALHE({ discoLivreMb: 850, ultimoHeartbeatEm: new Date().toISOString() }), [
      'terminais.ver',
    ]);
    const bloco = (await screen.findByText('Saúde do computador')).closest<HTMLElement>(
      '.mantine-Paper-root',
    )!;
    expect(within(bloco).getByText('850 MB · pouco espaço').closest('[data-nivel]')).toHaveAttribute(
      'data-nivel',
      'aviso',
    );
    expect(
      within(bloco).getByText(
        /^Libere espaço: apague arquivos que não são do caixa \(downloads, fotos, vídeos\)/,
      ),
    ).toHaveTextContent(
      'Abaixo de 200 MB o caixa não abre caixa novo; o supervisor pode liberar a abertura por 1 h.',
    );
    expect(within(bloco).getByTestId('saude-origem')).toHaveTextContent(
      'Fila do último heartbeat (há menos de 1 min); disco e banco da última medida.',
    );
  });

  it('saúde do computador sem heartbeat há mais de 24 h: selos cinza e "dado antigo" no lugar do que fazer', async () => {
    renderizarDetalhe(
      DETALHE({
        conexao: 'sem_contato',
        ultimoContatoEm: minAtras(10 * 24 * 60),
        ultimoHeartbeatEm: minAtras(10 * 24 * 60),
        discoLivreMb: 150,
        filaImpressaoPendentes: 2,
      }),
      ['terminais.ver'],
    );
    const bloco = (await screen.findByText('Saúde do computador')).closest<HTMLElement>(
      '.mantine-Paper-root',
    )!;
    expect(within(bloco).getByText('150 MB · quase cheio').closest('[data-nivel]')).toHaveAttribute(
      'data-antigo',
      'true',
    );
    expect(
      within(bloco).getAllByText(/^Dado antigo: o caixa não manda heartbeat há mais de 24 h/),
    ).toHaveLength(2);
    expect(within(bloco).queryByText(/Abrir caixa novo está bloqueado/)).toBeNull();
    expect(within(bloco).queryByText(/imprima de novo/)).toBeNull();
    expect(within(bloco).getByTestId('saude-origem')).toHaveTextContent(
      'Fila do último heartbeat (há 10 dias)',
    );
  });

  it('saúde do computador sem os campos (caixa que nunca informou) e no revogado, sem cor', async () => {
    renderizarDetalhe(DETALHE({ ultimoHeartbeatEm: null }), ['terminais.ver']);
    let bloco = (await screen.findByText('Saúde do computador')).closest<HTMLElement>('.mantine-Paper-root')!;
    expect(within(bloco).getByText('Disco livre').parentElement).toHaveTextContent('Disco livre—');
    expect(within(bloco).getByText('Banco do caixa').parentElement).toHaveTextContent('Banco do caixa—');
    expect(within(bloco).getByText('Nenhum')).toHaveAttribute('data-nivel', 'normal');
    expect(within(bloco).getByTestId('saude-origem')).toHaveTextContent(
      'O caixa ainda não mandou heartbeat.',
    );
    cleanup();

    renderizarDetalhe(
      DETALHE({
        status: 'revogado',
        motivoRevogacao: 'revogado_imediato',
        revogadoEm: minAtras(60),
        discoLivreMb: 150,
        tamanhoBancoMb: 2_048,
        filaImpressaoPendentes: 4,
      }),
      ['terminais.ver'],
    );
    bloco = (await screen.findByText('Saúde do computador')).closest<HTMLElement>('.mantine-Paper-root')!;
    expect(within(bloco).getByText('150 MB')).not.toHaveAttribute('data-nivel');
    expect(within(bloco).getByText('2,0 GB')).toBeInTheDocument();
    expect(within(bloco).getByText('4 comprovantes não impressos')).not.toHaveAttribute('data-nivel');
    expect(bloco.querySelector('[data-nivel]')).toBeNull();
  });

  it('só terminais.ver: nenhuma ação', async () => {
    renderizarDetalhe(DETALHE({ hardwareAlterado: true }), ['terminais.ver']);
    await screen.findByRole('heading', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' });
    for (const nome of [
      'Revogar',
      'Substituir terminal',
      'Ressincronizar',
      'Enviar mensagem',
      'Renomear',
      'Não reconheço',
    ]) {
      expect(screen.queryByRole('button', { name: nome })).not.toBeInTheDocument();
    }
  });

  it('hardware alterado: mostra a primeira chamada da outra máquina e confirma o id exibido; 409 recarrega', async () => {
    const u = userEvent.setup();
    const h1 = 'C'.repeat(58) + '123456';
    const pendente = (id: string, ip: string) =>
      DETALHE({
        hardwareAlterado: true,
        idHardwarePendente: id,
        hardwarePendente: { id, desde: minAtras(30), ip, sistemaOperacional: 'Ubuntu 24.04' },
      });
    let detalhe = pendente(h1, '203.0.113.7');
    let confirmacoes = 0;
    const { chamadas } = simularApi(
      ...rotasSessao({
        permissoes: PERMISSOES,
        lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
      }),
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/terminais/${T1}` ? { corpo: detalhe } : undefined,
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/terminais/${T1}/hardware/confirmar`) return undefined;
        confirmacoes++;
        // Outra máquina chamou depois que a tela abriu: a API recusa e a tela recarrega com o pendente novo.
        detalhe = pendente('D'.repeat(64), '198.51.100.9');
        return {
          status: 409,
          corpo: { codigo: 'CONFLITO', mensagem: 'Outra máquina chamou a nuvem com este terminal.' },
        };
      },
    );
    renderizarComSessao(<DetalheTerminal />, `/cadastros/pdvs/${T1}`, 'cadastros/pdvs/:id');
    const dados = await screen.findByTestId('hardware-pendente');
    // Os dados exibidos são os da primeira chamada da outra máquina, não o IP/SO da máquina registrada.
    expect(dados).toHaveTextContent('IP 203.0.113.7');
    expect(dados).toHaveTextContent('Ubuntu 24.04');
    expect(dados).toHaveTextContent('CCCCCC…123456');
    expect(dados).not.toHaveTextContent('10.0.0.2');
    await u.click(screen.getByRole('button', { name: 'Confirmar troca de hardware' }));
    const modal = await screen.findByRole('dialog', { name: 'Confirmar troca de hardware' });
    expect(within(modal).getByTestId('hardware-pendente')).toHaveTextContent('IP 203.0.113.7');
    await u.click(within(modal).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(confirmacoes).toBe(1));
    expect(chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/hardware/confirmar`)?.corpo).toEqual(
      { idHardwarePendente: h1 },
    );
    expect(await screen.findByText('Outra máquina chamou a nuvem com este terminal.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('hardware-pendente')).toHaveTextContent('IP 198.51.100.9'));
  });

  it('"Não reconheço" abre a revogação imediata com a observação; aceitar pendências não pede o caixa', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(DETALHE({ hardwareAlterado: true }), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/terminais/${T1}/revogar`
          ? {
              corpo: {
                status: 'desativando',
                motivo: 'aceitar_pendencias',
                alterado: true,
                pinsAnulados: 0,
                senhasClienteAnuladas: 0,
                alertaEventos: false,
              },
            }
          : undefined,
    ]);
    await u.click(await screen.findByRole('button', { name: 'Não reconheço' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Revogar imediatamente' });
    expect(within(dialogo).getByRole('textbox', { name: /Observação/ })).toHaveValue(
      'Não reconheço a troca de hardware',
    );
    await u.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));

    await u.click(screen.getByRole('button', { name: 'Revogar' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Revogar – aceitar pendências' }));
    const aceitar = await screen.findByRole('dialog', { name: 'Revogar – aceitar pendências' });
    expect(within(aceitar).queryByRole('textbox', { name: /Digite 2/ })).not.toBeInTheDocument();
    await u.click(within(aceitar).getByRole('button', { name: 'Revogar aceitando pendências' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/revogar'))?.corpo).toEqual(
        {
          modo: 'aceitar_pendencias',
          observacao: null,
        },
      ),
    );
  });

  it('revogado por outro motivo ainda vira "perdido/roubado" (furto descoberto depois)', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(
      DETALHE({ status: 'revogado', motivoRevogacao: 'revogado_imediato', revogadoEm: minAtras(60) }),
      PERMISSOES,
      [
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === `/api/terminais/${T1}/revogar`
            ? {
                corpo: {
                  status: 'revogado',
                  motivo: 'perdido_roubado',
                  alterado: true,
                  pinsAnulados: 3,
                  senhasClienteAnuladas: 1,
                  alertaEventos: false,
                },
              }
            : undefined,
      ],
    );
    await u.click(await screen.findByRole('button', { name: 'Perdido/roubado' }));
    const item = await screen.findByRole('menuitem', { name: 'Terminal perdido/roubado' });
    expect(screen.queryByRole('menuitem', { name: 'Revogar imediatamente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Substituir terminal' })).not.toBeInTheDocument();
    await u.click(item);
    const dialogo = await screen.findByRole('dialog', { name: 'Terminal perdido/roubado' });
    expect(within(dialogo).getByText(/já está revogado/)).toBeInTheDocument();
    await u.type(within(dialogo).getByRole('textbox', { name: /Digite 2/ }), '2');
    await u.click(within(dialogo).getByRole('button', { name: 'Revogar e anular PINs' }));
    expect(await screen.findByText(/3 PIN\(s\) e 1 senha\(s\) de cliente anulados/)).toBeInTheDocument();
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/revogar'))!.corpo).toEqual({
      modo: 'perdido',
      confirmacaoCaixa: 2,
      observacao: null,
    });
  });

  it('perdido/roubado já aplicado: sem menu de revogação', async () => {
    renderizarDetalhe(DETALHE({ status: 'revogado', motivoRevogacao: 'perdido_roubado' }), PERMISSOES);
    await screen.findByRole('heading', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' });
    expect(screen.queryByRole('button', { name: 'Perdido/roubado' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revogar' })).not.toBeInTheDocument();
  });

  it('aba Eventos com erro: o retido diz qual evento o segura; sem terminais.gerenciar não há ações nem payload', async () => {
    renderizarDetalhe(
      DETALHE({ eventosComErro: 2 }),
      ['terminais.ver'],
      [
        ({ url }) =>
          url.pathname === `/api/terminais/${T1}/eventos-erro`
            ? { corpo: listagem([ERRO, RETIDO]) }
            : undefined,
      ],
      '?aba=eventos',
    );
    expect(await screen.findByText('Aguardando o evento nº 1 (caixa.aberto)')).toBeInTheDocument();
    expect(screen.getByText('PAYLOAD_INVALIDO: payload_sha256 divergente')).toBeInTheDocument();
    // ERP 12.5: o resumo do agregado no lugar do tipo e id.
    expect(screen.getByText('Venda L01-C02-000123 · R$ 71,58 · 4 itens')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ações do evento/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reprocessar todos com o código' })).not.toBeInTheDocument();
  });

  it('Reprocessar: confirma, chama a API e mostra o desfecho com os dependentes', async () => {
    const u = userEvent.setup();
    const resultado: ResultadoReprocessamento = {
      eventoId: ERRO.eventoId,
      sequencia: 1,
      tipo: 'caixa.aberto',
      status: 'aplicado',
      erroCodigo: null,
      erro: null,
      numero: null,
      dependentes: [
        {
          eventoId: RETIDO.eventoId,
          sequencia: 2,
          tipo: 'venda.finalizada',
          status: 'aplicado',
          erroCodigo: null,
          erro: null,
        },
      ],
    };
    const { chamadas } = renderizarDetalhe(
      DETALHE({ eventosComErro: 2 }),
      PERMISSOES,
      [
        ({ url }) =>
          url.pathname === `/api/terminais/${T1}/eventos-erro`
            ? { corpo: listagem([ERRO, RETIDO]) }
            : undefined,
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === `/api/eventos-recebidos/${ERRO.id}/reprocessar`
            ? { corpo: resultado }
            : undefined,
      ],
      '?aba=eventos',
    );
    await u.click(await screen.findByRole('button', { name: 'Ações do evento 1' }));
    const item = await screen.findByRole('menuitem', { name: 'Reprocessar' });
    // Só o NUMERO_VENDA_DUPLICADO aceita "Aplicar com novo número".
    expect(screen.queryByRole('menuitem', { name: 'Aplicar com novo número' })).not.toBeInTheDocument();
    await u.click(item);
    const dialogo = await screen.findByRole('dialog', { name: 'Reprocessar o evento nº 1' });
    await u.click(within(dialogo).getByRole('button', { name: 'Reprocessar' }));
    expect(
      await screen.findByText('Evento nº 1 aplicado. 1 de 1 evento(s) que dependiam dele aplicados.'),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/reprocessar'))).toBe(true);
  });

  it('Descartar: exige a justificativa e o número exibido da venda e manda os dois', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(
      DETALHE({ eventosComErro: 1 }),
      PERMISSOES,
      [
        ({ url }) =>
          url.pathname === `/api/terminais/${T1}/eventos-erro` ? { corpo: listagem([RETIDO]) } : undefined,
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === `/api/eventos-recebidos/${RETIDO.id}/descartar`
            ? { corpo: { eventoId: RETIDO.eventoId, dependentes: [] } }
            : undefined,
      ],
      '?aba=eventos',
    );
    await u.click(await screen.findByRole('button', { name: 'Ações do evento 2' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Descartar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Descartar o evento nº 2' });
    const botao = within(dialogo).getByRole('button', { name: 'Descartar' });
    expect(botao).toBeDisabled();
    await u.type(within(dialogo).getByRole('textbox', { name: /Justificativa/ }), 'Venda de treinamento');
    // Justificativa suficiente, mas falta o número.
    expect(botao).toBeDisabled();
    await u.type(
      within(dialogo).getByRole('textbox', { name: 'Digite L01-C02-000123 para confirmar' }),
      '123',
    );
    await u.click(botao);
    expect(await screen.findByText('Evento descartado.')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/descartar'))!.corpo).toEqual({
      justificativa: 'Venda de treinamento',
      confirmacao: '123',
    });
  });

  it('a ação que esvazia a última página volta para a anterior, que ainda tem eventos', async () => {
    const u = userEvent.setup();
    let descartado = false;
    const { chamadas } = renderizarDetalhe(
      DETALHE({ eventosComErro: 51 }),
      PERMISSOES,
      [
        ({ url }) => {
          if (url.pathname !== `/api/terminais/${T1}/eventos-erro`) return undefined;
          const pagina = Number(url.searchParams.get('pagina'));
          const total = descartado ? 50 : 51;
          const itens = pagina === 1 ? [ERRO] : descartado ? [] : [RETIDO];
          return { corpo: { ...listagem(itens), total, pagina } };
        },
        ({ url, metodo }) => {
          if (metodo !== 'POST' || url.pathname !== `/api/eventos-recebidos/${RETIDO.id}/descartar`) {
            return undefined;
          }
          descartado = true;
          return { corpo: { eventoId: RETIDO.eventoId, dependentes: [] } };
        },
      ],
      '?aba=eventos',
    );
    await screen.findByRole('button', { name: 'Ações do evento 1' });
    await u.click(screen.getByRole('button', { name: '2' }));
    await u.click(await screen.findByRole('button', { name: 'Ações do evento 2' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Descartar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Descartar o evento nº 2' });
    await u.type(within(dialogo).getByRole('textbox', { name: /Justificativa/ }), 'Venda de treinamento');
    await u.type(
      within(dialogo).getByRole('textbox', { name: 'Digite L01-C02-000123 para confirmar' }),
      '123',
    );
    await u.click(within(dialogo).getByRole('button', { name: 'Descartar' }));
    // A página 2 voltou vazia (total 50): a tela pede a 1 em vez de dizer que a fila está vazia.
    expect(await screen.findByRole('button', { name: 'Ações do evento 1' })).toBeInTheDocument();
    expect(screen.queryByText('Nenhum evento com erro ou retido.')).not.toBeInTheDocument();
    const paginas = chamadas
      .filter((c) => c.url.pathname === `/api/terminais/${T1}/eventos-erro`)
      .map((c) => c.url.searchParams.get('pagina'));
    expect(paginas.slice(-2)).toEqual(['2', '1']);
  });

  it('Descartar o que outra pessoa já resolveu (409): fecha o diálogo e recarrega a fila', async () => {
    const u = userEvent.setup();
    let resolvido = false;
    const { chamadas } = renderizarDetalhe(
      DETALHE({ eventosComErro: 1 }),
      PERMISSOES,
      [
        ({ url }) =>
          url.pathname === `/api/terminais/${T1}/eventos-erro`
            ? { corpo: listagem(resolvido ? [] : [RETIDO]) }
            : undefined,
        ({ url, metodo }) => {
          if (metodo !== 'POST' || !url.pathname.endsWith('/descartar')) return undefined;
          resolvido = true;
          return {
            status: 409,
            corpo: {
              codigo: 'CONFLITO',
              mensagem: 'O evento já foi resolvido (situação atual: aplicado). Atualize a lista.',
            },
          };
        },
      ],
      '?aba=eventos',
    );
    await u.click(await screen.findByRole('button', { name: 'Ações do evento 2' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Descartar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Descartar o evento nº 2' });
    await u.type(within(dialogo).getByRole('textbox', { name: /Justificativa/ }), 'Venda de treinamento');
    await u.type(
      within(dialogo).getByRole('textbox', { name: 'Digite L01-C02-000123 para confirmar' }),
      '123',
    );
    const antes = chamadas.filter((c) => c.url.pathname.endsWith('/eventos-erro')).length;
    await u.click(within(dialogo).getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByText(/O evento já foi resolvido/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Descartar o evento nº 2' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Nenhum evento com erro ou retido.')).toBeInTheDocument();
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/eventos-erro')).length).toBeGreaterThan(antes);
  });

  it('alertas da fila no detalhe: "Ver eventos com erro" abre a aba; o descartado tem "Ciente"', async () => {
    const u = userEvent.setup();
    const descartado = {
      id: '01928f3a-0000-7000-8000-0000000000c3',
      tipo: 'EVENTO_DESCARTADO',
      severidade: 'critico' as const,
      titulo: 'Caixa 02: evento venda.finalizada descartado',
      mensagem:
        'Venda L01-C02-000123 · R$ 71,58. O evento nº 2 foi descartado por MARIA SILVA: venda de teste.',
      terminalId: T1,
      criadoEm: minAtras(5),
    };
    const comErro = {
      ...descartado,
      id: '01928f3a-0000-7000-8000-0000000000c4',
      tipo: 'EVENTO_COM_ERRO',
      titulo: 'Caixa 02: 3 eventos com erro',
      mensagem: 'O mais recente: o evento nº 7 do caixa 02 não foi aplicado.',
    };
    const { chamadas } = renderizarDetalhe(DETALHE({ alertas: [descartado, comErro] }), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/terminais/${T1}/alertas/${descartado.id}/resolver`
          ? { corpo: DETALHE({ alertas: [comErro] }) }
          : undefined,
      ({ url }) =>
        url.pathname === `/api/terminais/${T1}/eventos-erro` ? { corpo: listagem([ERRO]) } : undefined,
    ]);
    expect(await screen.findByText(descartado.titulo)).toBeInTheDocument();
    expect(screen.getByText(comErro.titulo)).toBeInTheDocument();
    // Só o descartado se resolve na tela; o com erro fecha ao reprocessar ou descartar.
    expect(screen.getAllByRole('button', { name: 'Ciente' })).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Ciente' }));
    await u.type(await screen.findByLabelText(/O que foi verificado/), 'Venda conferida com o operador');
    await u.click(screen.getByRole('button', { name: 'Resolver' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/alertas/${descartado.id}/resolver`)
          ?.corpo,
      ).toEqual({ resolucao: 'Venda conferida com o operador' }),
    );
    await u.click(screen.getAllByRole('button', { name: 'Ver eventos com erro' })[0]!);
    expect(await screen.findByRole('button', { name: 'Ações do evento 1' })).toBeInTheDocument();
  });

  it('alerta de evento descartado com só terminais.ver: sem "Ciente"', async () => {
    renderizarDetalhe(
      DETALHE({
        alertas: [
          {
            id: '01928f3a-0000-7000-8000-0000000000c5',
            tipo: 'EVENTO_DESCARTADO',
            severidade: 'critico',
            titulo: 'Caixa 02: evento caixa.sangria descartado',
            mensagem: null,
            terminalId: T1,
            criadoEm: minAtras(5),
          },
        ],
      }),
      ['terminais.ver'],
    );
    expect(await screen.findByText('Caixa 02: evento caixa.sangria descartado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ciente' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver eventos com erro' })).toBeInTheDocument();
  });

  it('evento divergente (SYNC 8.4) no detalhe: só o "Ciente", sem a fila de eventos', async () => {
    const u = userEvent.setup();
    const divergente = {
      id: '01928f3a-0000-7000-8000-0000000000c6',
      tipo: 'EVENTO_DIVERGENTE',
      severidade: 'critico' as const,
      titulo: 'Evento venda.finalizada recebido de novo com conteúdo diferente',
      mensagem: 'Terminal 2: o evento 01928f3a-0000-7000-8000-00000000e001 chegou com outro conteúdo.',
      terminalId: T1,
      criadoEm: minAtras(5),
    };
    const { chamadas } = renderizarDetalhe(DETALHE({ alertas: [divergente] }), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/terminais/${T1}/alertas/${divergente.id}/resolver`
          ? { corpo: DETALHE({ alertas: [] }) }
          : undefined,
    ]);
    expect(await screen.findByText(divergente.titulo)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver eventos com erro' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Ciente' }));
    expect(await screen.findByText(/caixa conferido com o suporte/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/O que foi verificado/), 'Banco do caixa restaurado pelo suporte');
    await u.click(screen.getByRole('button', { name: 'Resolver' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/alertas/${divergente.id}/resolver`)
          ?.corpo,
      ).toEqual({ resolucao: 'Banco do caixa restaurado pelo suporte' }),
    );
  });

  it('lacuna declarada (SYNC 8.6) no detalhe: só o "Ciente", com o exemplo da perda conferida', async () => {
    const u = userEvent.setup();
    const lacuna = {
      id: '01928f3a-0000-7000-8000-0000000000c7',
      tipo: 'LACUNA_DECLARADA',
      severidade: 'critico' as const,
      titulo: 'Caixa 02: lacuna de 2 evento(s) declarada (nº 1048 a 1049)',
      mensagem: 'O caixa declarou perdidos os eventos nº 1048 a 1049 (eventos perdidos no banco do caixa).',
      terminalId: T1,
      criadoEm: minAtras(5),
    };
    const { chamadas } = renderizarDetalhe(DETALHE({ alertas: [lacuna] }), PERMISSOES, [
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/terminais/${T1}/alertas/${lacuna.id}/resolver`
          ? { corpo: DETALHE({ alertas: [] }) }
          : undefined,
    ]);
    expect(await screen.findByText(lacuna.titulo)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver eventos com erro' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Ciente' }));
    expect(await screen.findByText(/vendas da faixa conferidas com o operador/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/O que foi verificado/), 'Vendas lançadas à parte');
    await u.click(screen.getByRole('button', { name: 'Resolver' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/alertas/${lacuna.id}/resolver`)?.corpo,
      ).toEqual({ resolucao: 'Vendas lançadas à parte' }),
    );
  });

  it('relógio (SYNC 12.4): o suspeito por evento tem "Ciente"; o desvio do heartbeat fecha sozinho', async () => {
    const u = userEvent.setup();
    const suspeito = {
      id: '01928f3a-0000-7000-8000-0000000000c8',
      tipo: 'RELOGIO_SUSPEITO',
      severidade: 'aviso' as const,
      titulo: 'Caixa 02: relógio adiantado (evento no futuro)',
      mensagem: 'O evento nº 12 (venda.finalizada) chegou com a hora 3 h à frente da nuvem.',
      terminalId: T1,
      criadoEm: minAtras(5),
    };
    const desvio = {
      id: '01928f3a-0000-7000-8000-0000000000c9',
      tipo: 'RELOGIO_DESVIO',
      severidade: 'critico' as const,
      titulo: 'Caixa 02: relógio do computador 3 h adiantado',
      mensagem: 'O alerta fecha sozinho quando o desvio voltar a até 2 min.',
      terminalId: T1,
      criadoEm: minAtras(2),
    };
    const { chamadas } = renderizarDetalhe(
      DETALHE({ alertas: [desvio, suspeito], desvioRelogioMs: -3 * 3_600_000 }),
      PERMISSOES,
      [
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === `/api/terminais/${T1}/alertas/${suspeito.id}/resolver`
            ? { corpo: DETALHE({ alertas: [desvio] }) }
            : undefined,
      ],
    );
    expect(await screen.findByText(desvio.titulo)).toBeInTheDocument();
    expect(screen.getByText(suspeito.titulo)).toBeInTheDocument();
    // Só o suspeito tem o botão; o campo do bloco Sincronização mostra o desvio em vermelho, com o sentido.
    expect(screen.getAllByRole('button', { name: 'Ciente' })).toHaveLength(1);
    expect(screen.getByText('3 h adiantado').closest('[data-nivel]')).toHaveAttribute(
      'data-nivel',
      'critico',
    );
    await u.click(screen.getByRole('button', { name: 'Ciente' }));
    expect(await screen.findByText(/data, hora e fuso do computador acertados/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/O que foi verificado/), 'Relógio acertado');
    await u.click(screen.getByRole('button', { name: 'Resolver' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.url.pathname === `/api/terminais/${T1}/alertas/${suspeito.id}/resolver`)
          ?.corpo,
      ).toEqual({ resolucao: 'Relógio acertado' }),
    );
  });

  it('Aplicar com novo número e Reprocessar todos com o código', async () => {
    const u = userEvent.setup();
    const duplicado: EventoComErro = {
      ...RETIDO,
      status: 'erro',
      erroCodigo: 'NUMERO_VENDA_DUPLICADO',
      erro: 'Número L01-C02-000123 já usado por outra venda.',
      aguardando: [],
    };
    const { chamadas } = renderizarDetalhe(
      DETALHE({ eventosComErro: 1 }),
      PERMISSOES,
      [
        ({ url }) =>
          url.pathname === `/api/terminais/${T1}/eventos-erro`
            ? { corpo: listagem([duplicado], [{ codigo: 'NUMERO_VENDA_DUPLICADO', quantidade: 1 }]) }
            : undefined,
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === `/api/eventos-recebidos/${duplicado.id}/aplicar-novo-numero`
            ? {
                corpo: {
                  eventoId: duplicado.eventoId,
                  sequencia: 2,
                  tipo: 'venda.finalizada',
                  status: 'aplicado',
                  erroCodigo: null,
                  erro: null,
                  dependentes: [],
                  numero: { original: 'L01-C02-000123', novo: 'L01-C02-9000001' },
                } satisfies ResultadoReprocessamento,
              }
            : undefined,
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === '/api/eventos-recebidos/reprocessar-lote'
            ? { status: 202, corpo: { tarefaId: 'tarefa-1', quantidade: 1 } }
            : undefined,
      ],
      '?aba=eventos',
    );
    await u.click(await screen.findByRole('button', { name: 'Ações do evento 2' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Aplicar com novo número' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Aplicar com novo número o evento nº 2' });
    await u.click(within(dialogo).getByRole('button', { name: 'Aplicar com novo número' }));
    expect(
      await screen.findByText('Evento nº 2 aplicado como L01-C02-9000001 (número do caixa L01-C02-000123).'),
    ).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Reprocessar todos com o código' }));
    await u.click(await screen.findByRole('menuitem', { name: 'NUMERO_VENDA_DUPLICADO (1)' }));
    const lote = await screen.findByRole('dialog', { name: 'Reprocessar todos com NUMERO_VENDA_DUPLICADO' });
    await u.click(within(lote).getByRole('button', { name: 'Reprocessar todos' }));
    expect(
      await screen.findByText('Tarefa criada: 1 evento(s) com NUMERO_VENDA_DUPLICADO serão reprocessados.'),
    ).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/reprocessar-lote'))!.corpo).toEqual({
      terminalId: T1,
      codigo: 'NUMERO_VENDA_DUPLICADO',
    });
  });
});

describe('mensagemReprocessamento', () => {
  it('diz o que ficou retido ou com erro entre os dependentes', () => {
    expect(
      mensagemReprocessamento({
        eventoId: 'a',
        sequencia: 5,
        tipo: 'caixa.aberto',
        status: 'aplicado',
        erroCodigo: null,
        erro: null,
        numero: null,
        dependentes: [
          {
            eventoId: 'b',
            sequencia: 6,
            tipo: 'venda.finalizada',
            status: 'aplicado',
            erroCodigo: null,
            erro: null,
          },
          {
            eventoId: 'c',
            sequencia: 7,
            tipo: 'venda.finalizada',
            status: 'erro',
            erroCodigo: 'REFERENCIA_INEXISTENTE',
            erro: 'x',
          },
        ],
      }),
    ).toBe('Evento nº 5 aplicado. 1 de 2 evento(s) que dependiam dele aplicados (nº 7 continua com erro).');
    expect(
      mensagemReprocessamento({
        eventoId: 'a',
        sequencia: 5,
        tipo: 'venda.finalizada',
        status: 'erro',
        erroCodigo: 'REFERENCIA_INEXISTENTE',
        erro: 'Produto inexistente.',
        numero: null,
        dependentes: [],
      }),
    ).toBe('Evento nº 5 continua com erro REFERENCIA_INEXISTENTE: Produto inexistente.');
  });
});
