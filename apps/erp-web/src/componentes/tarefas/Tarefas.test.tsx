import type { RespostaTarefas, TarefaUsuario } from '@genesis/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErroRequisicao } from '../../api/http';
import { renderizarComSessao, rotasSessao, simularApi, type RespostaFalsa } from '../../teste/utilidades';
import { AndamentoTarefa } from './AndamentoTarefa';
import { IconeTarefas } from './IconeTarefas';
import {
  INTERVALO_APOS_ERRO_MS,
  INTERVALO_LISTA_TAREFAS_MS,
  INTERVALO_TAREFA_MS,
  intervaloListaTarefas,
  intervaloTarefa,
  useTarefa,
} from './tarefas';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Relógio falso só dos temporizadores (o intervalo das consultas), andando também com o relógio real para o
 * Testing Library e o Mantine; o teste avança o intervalo na hora, sem esperar.
 */
function relogioFalso() {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  return {
    usuario: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }),
    avancar: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
  };
}

const ERRO_500 = { status: 500, corpo: { codigo: 'ERRO_INTERNO', mensagem: 'Falhou' } } as const;

const base: Omit<TarefaUsuario, 'id' | 'tipo' | 'status'> = {
  progressoPct: 0,
  mensagem: null,
  resultado: null,
  erro: null,
  criadoEm: '2026-11-07T13:00:00.000Z',
  concluidaEm: null,
  download: null,
  downloadExpirado: false,
};

const LISTA: RespostaTarefas = {
  pendentes: 1,
  itens: [
    {
      ...base,
      id: 't-importacao',
      tipo: 'importacao_produtos',
      status: 'executando',
      progressoPct: 40,
      mensagem: 'Linha 400 de 1.000',
    },
    {
      ...base,
      id: 't-exportacao',
      tipo: 'exportar_relatorio',
      status: 'concluida',
      progressoPct: 100,
      resultado: { nomeArquivo: 'Relatorio_Teste.xlsx', linhas: 120_000 },
      download: 'http://s3/Relatorio_Teste.xlsx',
    },
    {
      ...base,
      id: 't-falhou',
      tipo: 'importar_xml_nfe',
      status: 'falhou',
      erro: 'Você não tem mais acesso ao estoque de destino.',
    },
    {
      ...base,
      id: 't-expirada',
      tipo: 'exportar_relatorio',
      status: 'concluida',
      progressoPct: 100,
      downloadExpirado: true,
    },
  ],
};

function montar({
  permissoes = ['relatorios.exportar'],
  lista = LISTA as RespostaTarefas | null | (() => RespostaFalsa),
} = {}) {
  const api = simularApi(...rotasSessao({ permissoes }), ({ url }) =>
    url.pathname === '/api/tarefas'
      ? typeof lista === 'function'
        ? lista()
        : lista
          ? { corpo: lista }
          : ERRO_500
      : undefined,
  );
  const r = renderizarComSessao(
    <>
      <span>cabeçalho</span>
      <IconeTarefas />
    </>,
  );
  const consultas = () => api.chamadas.filter((c) => c.url.pathname === '/api/tarefas').length;
  return { ...r, consultas };
}

describe('consulta econômica das tarefas (F2-B30)', () => {
  const semConexao = new ErroRequisicao(0, { codigo: 'ERRO_INTERNO', mensagem: 'Sem conexão' });
  const erro502 = new ErroRequisicao(502, { codigo: 'ERRO_INTERNO', mensagem: 'Erro 502' });
  const naoEncontrada = new ErroRequisicao(404, { codigo: 'NAO_ENCONTRADO', mensagem: 'Não encontrada' });
  const semPermissao = new ErroRequisicao(403, { codigo: 'SEM_PERMISSAO', mensagem: 'Sem permissão' });

  it('a lista só se repete com tarefa em andamento ou com o painel aberto; depois de falha passageira, mais devagar', () => {
    const vazia: RespostaTarefas = { pendentes: 0, itens: [] };
    expect(intervaloListaTarefas(undefined, false, null)).toBe(false);
    expect(intervaloListaTarefas(vazia, false, null)).toBe(false);
    expect(intervaloListaTarefas(vazia, true, null)).toBe(INTERVALO_LISTA_TAREFAS_MS);
    expect(intervaloListaTarefas(LISTA, false, null)).toBe(INTERVALO_LISTA_TAREFAS_MS);
    // Falha passageira (sem conexão, 5xx) com a última lista em andamento: continua, a cada 15 s.
    expect(intervaloListaTarefas(LISTA, false, semConexao)).toBe(INTERVALO_APOS_ERRO_MS);
    expect(intervaloListaTarefas(vazia, true, erro502)).toBe(INTERVALO_APOS_ERRO_MS);
    expect(intervaloListaTarefas(vazia, false, erro502)).toBe(false);
    // A recusa (4xx) e a primeira consulta que falha (sem lista nenhuma) não se repetem.
    expect(intervaloListaTarefas(LISTA, true, semPermissao)).toBe(false);
    expect(intervaloListaTarefas(undefined, true, erro502)).toBe(false);
  });

  it('a tarefa de uma tela se repete até terminar; depois de falha passageira, mais devagar; a recusa para', () => {
    const executando = LISTA.itens[0]!;
    const concluida = LISTA.itens[1]!;
    expect(intervaloTarefa(undefined, null)).toBe(INTERVALO_TAREFA_MS);
    expect(intervaloTarefa(executando, null)).toBe(INTERVALO_TAREFA_MS);
    expect(intervaloTarefa(concluida, null)).toBe(false);
    expect(intervaloTarefa(executando, semConexao)).toBe(INTERVALO_APOS_ERRO_MS);
    expect(intervaloTarefa(undefined, erro502)).toBe(INTERVALO_APOS_ERRO_MS);
    expect(intervaloTarefa(executando, naoEncontrada)).toBe(false);
    expect(intervaloTarefa(executando, semPermissao)).toBe(false);
  });
});

/** Uma tela que acompanha a tarefa (o mesmo da Importação, do upload de NF-e e da exportação do relatório). */
function TelaComTarefa({ tarefaId }: { tarefaId: string }) {
  const tarefa = useTarefa(tarefaId);
  return (
    <AndamentoTarefa
      tarefa={tarefa.data}
      erroConsulta={tarefa.error}
      aoTentarNovamente={() => void tarefa.refetch()}
      tentando={tarefa.isFetching}
      rotulo="importação"
    >
      <p>Importação concluída</p>
    </AndamentoTarefa>
  );
}

function montarTela(respostas: RespostaFalsa[]) {
  const api = simularApi(...rotasSessao({ permissoes: ['produtos.importar'] }), ({ url }) => {
    if (url.pathname !== '/api/tarefas/t-tela') return undefined;
    // Cada consulta leva a próxima resposta; a última se repete.
    return respostas.length > 1 ? respostas.shift() : respostas[0];
  });
  renderizarComSessao(<TelaComTarefa tarefaId="t-tela" />);
  const consultas = () => api.chamadas.filter((c) => c.url.pathname === '/api/tarefas/t-tela').length;
  return { consultas };
}

const EXECUTANDO = { corpo: LISTA.itens[0] };
const CONCLUIDA = {
  corpo: { ...LISTA.itens[0]!, status: 'concluida', progressoPct: 100, mensagem: null },
};

describe('tarefa acompanhada na tela: a falha passageira não congela a barra (F2-B30)', () => {
  it('executando → 500 → concluída: avisa com a barra no último andamento e chega ao resultado sozinha', async () => {
    const { avancar } = relogioFalso();
    const { consultas } = montarTela([EXECUTANDO, ERRO_500, CONCLUIDA]);
    expect(await screen.findByText(/Linha 400 de 1\.000/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progresso da importação' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(consultas()).toBe(1);

    await avancar(INTERVALO_TAREFA_MS);
    const aviso = await screen.findByRole('alert');
    expect(within(aviso).getByText('Não foi possível acompanhar a importação')).toBeInTheDocument();
    expect(within(aviso).getByText(/O andamento abaixo é o último recebido/)).toBeInTheDocument();
    // A barra continua, no último andamento conhecido.
    expect(screen.getByRole('progressbar', { name: 'Progresso da importação' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(screen.getByText(/Linha 400 de 1\.000/)).toBeInTheDocument();
    expect(consultas()).toBe(2);

    // Depois da falha, mais devagar: nada no intervalo normal, a próxima no de erro.
    await avancar(INTERVALO_TAREFA_MS);
    expect(consultas()).toBe(2);
    await avancar(INTERVALO_APOS_ERRO_MS - INTERVALO_TAREFA_MS);
    expect(await screen.findByText('Importação concluída')).toBeInTheDocument();
    expect(consultas()).toBe(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Terminou: não consulta mais.
    await avancar(INTERVALO_APOS_ERRO_MS * 2);
    expect(consultas()).toBe(3);
  });

  it('o "Tentar novamente" do aviso consulta na hora', async () => {
    const { usuario } = relogioFalso();
    const { consultas } = montarTela([EXECUTANDO, ERRO_500, CONCLUIDA]);
    expect(await screen.findByText(/Linha 400 de 1\.000/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(INTERVALO_TAREFA_MS));
    const botao = await screen.findByRole('button', { name: 'Tentar novamente' });
    await waitFor(() => expect(botao).toBeEnabled());
    await usuario.click(botao);
    expect(await screen.findByText('Importação concluída')).toBeInTheDocument();
    expect(consultas()).toBe(3);
  });

  it('a recusa da API (404: tarefa inexistente) avisa e não se repete', async () => {
    const { avancar } = relogioFalso();
    const { consultas } = montarTela([
      EXECUTANDO,
      { status: 404, corpo: { codigo: 'NAO_ENCONTRADO', mensagem: 'Tarefa não encontrada.' } },
    ]);
    expect(await screen.findByText(/Linha 400 de 1\.000/)).toBeInTheDocument();
    await avancar(INTERVALO_TAREFA_MS);
    const aviso = await screen.findByRole('alert');
    expect(within(aviso).getByText('Tarefa não encontrada.')).toBeInTheDocument();
    expect(within(aviso).queryByText(/tenta de novo sozinha/)).not.toBeInTheDocument();
    await avancar(INTERVALO_APOS_ERRO_MS * 2);
    expect(consultas()).toBe(2);
  });
});

describe('ícone Tarefas do cabeçalho (ERP 3.6; F2-B30)', () => {
  it('conta as em andamento e o painel mostra o andamento, a falha, o link e o arquivo expirado', async () => {
    const usuario = userEvent.setup();
    montar();
    const icone = await screen.findByRole('button', { name: 'Tarefas: 1 em andamento' });
    await usuario.click(icone);
    const painel = await screen.findByRole('region', { name: 'Painel de tarefas' });

    const importacao = within(painel).getByTestId('tarefa-t-importacao');
    expect(within(importacao).getByText('Importação de produtos')).toBeInTheDocument();
    expect(within(importacao).getByText('Executando')).toBeInTheDocument();
    expect(
      within(importacao).getByRole('progressbar', { name: 'Progresso: Importação de produtos' }),
    ).toHaveAttribute('aria-valuenow', '40');
    expect(within(importacao).getByText('Linha 400 de 1.000')).toBeInTheDocument();
    expect(within(importacao).queryByRole('link')).not.toBeInTheDocument();

    const exportacao = within(painel).getByTestId('tarefa-t-exportacao');
    expect(within(exportacao).getByText(/Relatorio_Teste\.xlsx · 120\.000 linha\(s\)/)).toBeInTheDocument();
    expect(within(exportacao).getByRole('link', { name: /Baixar arquivo/ })).toHaveAttribute(
      'href',
      'http://s3/Relatorio_Teste.xlsx',
    );

    const falhou = within(painel).getByTestId('tarefa-t-falhou');
    expect(within(falhou).getByText('Falhou')).toBeInTheDocument();
    expect(within(falhou).getByText('Você não tem mais acesso ao estoque de destino.')).toBeInTheDocument();

    const expirada = within(painel).getByTestId('tarefa-t-expirada');
    expect(within(expirada).getByText('O arquivo expirou e não pode mais ser baixado.')).toBeInTheDocument();
    expect(within(expirada).queryByRole('link')).not.toBeInTheDocument();
  });

  it('sem tarefa: o ícone sem contador e o painel vazio', async () => {
    const usuario = userEvent.setup();
    montar({ lista: { pendentes: 0, itens: [] } });
    await usuario.click(await screen.findByRole('button', { name: 'Tarefas' }));
    expect(await screen.findByText(/Nenhuma tarefa ainda/)).toBeInTheDocument();
  });

  it('quem não tem permissão que cria tarefa não vê o ícone e o ERP nem consulta', async () => {
    const { consultas } = montar({ permissoes: ['produtos.ver'] });
    expect(await screen.findByText('cabeçalho')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tarefas/ })).not.toBeInTheDocument();
    expect(consultas()).toBe(0);
  });

  it('a primeira consulta que falha não se repete sozinha; o "Tentar novamente" do painel consulta uma vez', async () => {
    const { usuario, avancar } = relogioFalso();
    const { consultas } = montar({ lista: null });
    const icone = await screen.findByRole('button', { name: 'Tarefas' });
    await waitFor(() => expect(consultas()).toBe(1));
    // Painel fechado e sem lista nenhuma: o tempo passa e nada se repete.
    await avancar(INTERVALO_APOS_ERRO_MS * 2);
    expect(consultas()).toBe(1);

    // Abrir o painel já consulta (a 2ª); o "Tentar novamente" faz exatamente mais uma.
    await usuario.click(icone);
    expect(await screen.findByText('Não foi possível carregar as tarefas.')).toBeInTheDocument();
    const botao = screen.getByRole('button', { name: 'Tentar novamente' });
    await waitFor(() => expect(botao).toBeEnabled());
    const antes = consultas();
    expect(antes).toBe(2);
    await usuario.click(botao);
    await waitFor(() => expect(consultas()).toBe(antes + 1));
  });

  it('a falha passageira com tarefa em andamento: continua consultando, mais devagar, e avisa quando ela termina', async () => {
    const { usuario, avancar } = relogioFalso();
    let fase: 'andamento' | 'fora' | 'terminou' = 'andamento';
    const concluida: RespostaTarefas = {
      pendentes: 0,
      itens: [{ ...LISTA.itens[0]!, status: 'concluida', progressoPct: 100, mensagem: null }],
    };
    const { consultas } = montar({
      lista: () =>
        fase === 'andamento' ? { corpo: LISTA } : fase === 'fora' ? ERRO_500 : { corpo: concluida },
    });
    expect(await screen.findByRole('button', { name: 'Tarefas: 1 em andamento' })).toBeInTheDocument();
    expect(consultas()).toBe(1);

    // A API cai: a 2ª consulta falha, e a próxima vem só no intervalo de erro (não no de 5 s).
    fase = 'fora';
    await avancar(INTERVALO_LISTA_TAREFAS_MS);
    await waitFor(() => expect(consultas()).toBe(2));
    await avancar(INTERVALO_LISTA_TAREFAS_MS);
    expect(consultas()).toBe(2);

    // O painel avisa, mostrando a última lista, com "Tentar novamente".
    await usuario.click(screen.getByRole('button', { name: 'Tarefas: 1 em andamento' }));
    expect(
      await screen.findByText('Não foi possível atualizar as tarefas: a lista abaixo é a última recebida.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tarefa-t-importacao')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Tarefas: 1 em andamento' }));

    // A API volta e a tarefa terminou: a próxima consulta (sozinha) traz a lista nova e a notificação.
    fase = 'terminou';
    await avancar(INTERVALO_APOS_ERRO_MS);
    expect(await screen.findByText('Importação de produtos: concluída')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Tarefas' })).toBeInTheDocument();
  });
});
