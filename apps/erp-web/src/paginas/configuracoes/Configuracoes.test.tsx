import type { AtalhoPdv, ValorConfiguracao } from '@genesis/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTiposProdutoHabilitados } from '../../api/produtos';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { CamposConfiguracoes, paraCatalogo } from './CamposConfiguracoes';
import { TabelaAtalhos, validarAtalhos } from './Configuracoes';
import { ABA_GERAL, type RotuloConfiguracao } from './rotulos';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '01928f3a-0000-7000-8000-0000000000f1';
const ITENS: RotuloConfiguracao[] = [
  { chave: 'pdv.fechamento_cego', rotulo: 'Fechamento cego', tipo: 'bool', bloco: 'Avançado' },
  {
    chave: 'pdv.valor_limite_sangria',
    rotulo: 'Valor limite de sangria',
    tipo: 'dinheiro',
    bloco: 'Avançado',
  },
];
const valor = (chave: string, v: Partial<ValorConfiguracao>): ValorConfiguracao => ({
  chave,
  valor: null,
  padrao: null,
  loja: true,
  pdv: true,
  segredo: false,
  lojasSobrepondo: 0,
  ...v,
});

describe('paraCatalogo', () => {
  it('converte os valores da tela para o formato do catálogo', () => {
    expect(paraCatalogo('dinheiro', 1500)).toBe('1500.00');
    expect(paraCatalogo('pct', 3.5)).toBe('3.5');
    expect(paraCatalogo('int', '7')).toBe(7);
    expect(paraCatalogo('dinheiro', '')).toBeNull();
  });
});

describe('<CamposConfiguracoes>', () => {
  it('empresa: grava só as chaves alteradas; 🏬 quando uma loja sobrepõe', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) =>
        url.pathname === '/api/configuracoes'
          ? metodo === 'GET'
            ? {
                corpo: [
                  valor('pdv.fechamento_cego', { valor: true, padrao: true }),
                  valor('pdv.valor_limite_sangria', {
                    valor: '1500.00',
                    valorEmpresa: '1500.00',
                    lojasSobrepondo: 1,
                  }),
                ],
              }
            : { corpo: [] }
          : undefined,
    );
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} />);
    expect(await screen.findByLabelText('Sobreposto por loja')).toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: 'Fechamento cego' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: null,
      valores: { 'pdv.fechamento_cego': false },
    });
  });

  it('loja: "Herdar da empresa" manda nulo; "Personalizar" manda o valor da loja', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) =>
        url.pathname === '/api/configuracoes'
          ? metodo === 'GET'
            ? {
                corpo: [
                  valor('pdv.fechamento_cego', { valor: false, padrao: true, valorLoja: false }),
                  valor('pdv.valor_limite_sangria', { valor: '1500.00', valorEmpresa: '1500.00' }),
                ],
              }
            : { corpo: [] }
          : undefined,
    );
    renderizarComSessao(<CamposConfiguracoes itens={ITENS} lojaId={LOJA} />);
    const campoSangria = await screen.findByRole('textbox', { name: 'Valor limite de sangria' });
    expect(campoSangria).toBeDisabled();
    expect(campoSangria).toHaveValue('R$ 1.500,00');
    // Linhas: fechamento cego (personalizado) e sangria (herdando).
    const herdar = screen.getAllByText('Herdar da empresa');
    const personalizar = screen.getAllByText('Personalizar');
    await u.click(herdar[0]!);
    await u.click(personalizar[1]!);
    await u.clear(campoSangria);
    await u.type(campoSangria, '800');
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: LOJA,
      valores: { 'pdv.fechamento_cego': null, 'pdv.valor_limite_sangria': '800.00' },
    });
  });
});

describe('<CamposConfiguracoes>: tolerância da conferência (D47, ajustável pelo dono)', () => {
  const TOTAL = 'estoque.tolerancia_conferencia_total_pct';
  const ITEM = 'estoque.tolerancia_conferencia_item_pct';
  const itens = ABA_GERAL.filter((i) => i.chave === TOTAL || i.chave === ITEM);

  it('as duas chaves estão na aba Geral (bloco Estoque), também nos Parâmetros da loja', () => {
    expect(itens.map((i) => [i.chave, i.tipo, i.bloco])).toEqual([
      [TOTAL, 'pct', 'Estoque'],
      [ITEM, 'pct', 'Estoque'],
    ]);
  });

  it('empresa e loja: o percentual é editável e vai no formato do catálogo', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) =>
        url.pathname === '/api/configuracoes'
          ? metodo === 'GET'
            ? {
                corpo: [
                  valor(TOTAL, { valor: '1', padrao: '1', valorEmpresa: '1' }),
                  valor(ITEM, { valor: '5', padrao: '5', valorEmpresa: '5' }),
                ],
              }
            : { corpo: [] }
          : undefined,
    );
    const { unmount } = renderizarComSessao(<CamposConfiguracoes itens={itens} />);
    const total = await screen.findByRole('textbox', { name: 'Conferência: tolerância total (%)' });
    expect(total).toBeEnabled();
    await u.clear(total);
    await u.type(total, '2,5');
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: null,
      valores: { [TOTAL]: '2.5' },
    });
    unmount();

    // Na loja (o CD usa o da empresa): "Personalizar" e o valor próprio.
    renderizarComSessao(<CamposConfiguracoes itens={itens} lojaId={LOJA} />);
    const item = await screen.findByRole('textbox', { name: 'Conferência: tolerância por item (%)' });
    expect(item).toBeDisabled();
    await u.click(screen.getAllByText('Personalizar')[1]!);
    await u.clear(item);
    await u.type(item, '3');
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.filter((c) => c.metodo === 'PUT')).toHaveLength(2));
    expect(chamadas.filter((c) => c.metodo === 'PUT')[1]!.corpo).toEqual({
      lojaId: LOJA,
      valores: { [ITEM]: '3' },
    });
  });
});

describe('<CamposConfiguracoes>: chaves de tipo de produto (F2-B1)', () => {
  /** Mostra a lista guardada do cadastro de produtos, no mesmo QueryClient da tela de configurações. */
  function SondaTipos() {
    return <div data-testid="tipos">{useTiposProdutoHabilitados().join(',')}</div>;
  }

  it('gravar produtos.variacoes_habilitadas relê os tipos que o cadastro oferece', async () => {
    const u = userEvent.setup();
    let ligada = false;
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) => {
        if (url.pathname === '/api/produtos/tipos-habilitados') {
          return { corpo: { tipos: ligada ? ['simples', 'com_variacoes'] : ['simples'] } };
        }
        // Todos os caixas já com a guarda das variações (F2-B34): grava sem perguntar.
        if (url.pathname === '/api/configuracoes/terminais-sem-guarda-variacoes') {
          return { corpo: { versaoMinima: '0.11.0', terminais: [], outrasLojas: 0 } };
        }
        if (url.pathname !== '/api/configuracoes') return undefined;
        if (metodo === 'GET') {
          return { corpo: [valor('produtos.variacoes_habilitadas', { valor: ligada, padrao: false })] };
        }
        ligada = true;
        return { corpo: [] };
      },
    );
    renderizarComSessao(
      <>
        <CamposConfiguracoes
          itens={[
            {
              chave: 'produtos.variacoes_habilitadas',
              rotulo: 'Cadastrar produtos "Com variações"',
              tipo: 'bool',
              bloco: 'Produtos',
            },
          ]}
        />
        <SondaTipos />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('tipos')).toHaveTextContent(/^simples$/));
    await u.click(await screen.findByRole('switch', { name: 'Cadastrar produtos "Com variações"' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    // Sem a invalidação, o staleTime de 5 min seguraria a lista antiga.
    await waitFor(() => expect(screen.getByTestId('tipos')).toHaveTextContent('simples,com_variacoes'));
    expect(chamadas.filter((c) => c.url.pathname === '/api/produtos/tipos-habilitados')).toHaveLength(2);
  });

  it('gravar outra chave não relê os tipos', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) => {
        if (url.pathname === '/api/produtos/tipos-habilitados') return { corpo: { tipos: ['simples'] } };
        if (url.pathname !== '/api/configuracoes') return undefined;
        return metodo === 'GET'
          ? { corpo: [valor('pdv.fechamento_cego', { valor: true, padrao: true })] }
          : { corpo: [] };
      },
    );
    renderizarComSessao(
      <>
        <CamposConfiguracoes itens={ITENS} />
        <SondaTipos />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('tipos')).toHaveTextContent(/^simples$/));
    await u.click(await screen.findByRole('switch', { name: 'Fechamento cego' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    await waitFor(() =>
      expect(chamadas.filter((c) => c.url.pathname === '/api/configuracoes')).toHaveLength(3),
    );
    expect(chamadas.filter((c) => c.url.pathname === '/api/produtos/tipos-habilitados')).toHaveLength(1);
  });
});

describe('<CamposConfiguracoes>: caixas sem a guarda das variações (F2-B34; D44)', () => {
  const VARIACOES: RotuloConfiguracao[] = [
    {
      chave: 'produtos.variacoes_habilitadas',
      rotulo: 'Cadastrar produtos "Com variações"',
      tipo: 'bool',
      bloco: 'Produtos',
    },
  ];

  function montar(terminais: unknown) {
    return simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) => {
        if (url.pathname === '/api/produtos/tipos-habilitados') return { corpo: { tipos: ['simples'] } };
        if (url.pathname === '/api/configuracoes/terminais-sem-guarda-variacoes') return terminais as never;
        if (url.pathname !== '/api/configuracoes') return undefined;
        return metodo === 'GET'
          ? {
              corpo: [
                valor('produtos.variacoes_habilitadas', {
                  valor: false,
                  padrao: false,
                  loja: false,
                  pdv: false,
                }),
              ],
            }
          : { corpo: [] };
      },
    );
  }

  it('ligar com caixa antigo mostra os caixas; Cancelar não grava e "Gravar mesmo assim" grava', async () => {
    const u = userEvent.setup();
    const { chamadas } = montar({
      corpo: {
        versaoMinima: '0.11.0',
        terminais: [
          { id: 't1', lojaNome: 'Loja 1', numeroCaixa: 2, descricao: 'Balcão', versaoApp: '0.10.0' },
          { id: 't2', lojaNome: 'Petiscaria 2', numeroCaixa: 1, descricao: null, versaoApp: null },
        ],
        outrasLojas: 3,
      },
    });
    renderizarComSessao(<CamposConfiguracoes itens={VARIACOES} />);
    await u.click(await screen.findByRole('switch', { name: 'Cadastrar produtos "Com variações"' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText(/anterior à versão 0\.11\.0/)).toBeInTheDocument();
    expect(screen.getByText('Loja 1 – caixa 02 (Balcão): versão 0.10.0')).toBeInTheDocument();
    expect(screen.getByText('Petiscaria 2 – caixa 01: versão desconhecida')).toBeInTheDocument();
    expect(screen.getByText('E mais 3 caixa(s) de outras lojas, fora do seu acesso')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText(/anterior à versão/)).not.toBeInTheDocument());
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);

    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    await u.click(await screen.findByRole('button', { name: 'Gravar mesmo assim' }));
    await waitFor(() => expect(chamadas.filter((c) => c.metodo === 'PUT')).toHaveLength(1));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      lojaId: null,
      valores: { 'produtos.variacoes_habilitadas': true },
    });
  });

  it('só caixas antigos de lojas fora do acesso: avisa pela contagem', async () => {
    const u = userEvent.setup();
    const { chamadas } = montar({ corpo: { versaoMinima: '0.11.0', terminais: [], outrasLojas: 2 } });
    renderizarComSessao(<CamposConfiguracoes itens={VARIACOES} />);
    await u.click(await screen.findByRole('switch', { name: 'Cadastrar produtos "Com variações"' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('2 caixa(s) de outras lojas, fora do seu acesso')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
  });

  it('a consulta que falha avisa e deixa gravar', async () => {
    const u = userEvent.setup();
    const { chamadas } = montar({ status: 500, corpo: { codigo: 'ERRO_INTERNO', mensagem: 'Falhou' } });
    renderizarComSessao(<CamposConfiguracoes itens={VARIACOES} />);
    await u.click(await screen.findByRole('switch', { name: 'Cadastrar produtos "Com variações"' }));
    await u.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText(/Não foi possível conferir a versão do PDV/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Gravar mesmo assim' }));
    await waitFor(() => expect(chamadas.filter((c) => c.metodo === 'PUT')).toHaveLength(1));
    const consultas = () =>
      chamadas.filter((c) => c.url.pathname === '/api/configuracoes/terminais-sem-guarda-variacoes').length;
    expect(consultas()).toBe(1);
  });
});

describe('Atalhos do PDV', () => {
  it('validarAtalhos: tecla inválida e tecla repetida entre habilitados', () => {
    const r = validarAtalhos([
      { acao: 'pesquisar_produto', tecla: 'f2', habilitado: true, ordem: 1 },
      { acao: 'remover_item', tecla: 'F2', habilitado: true, ordem: 2 },
      { acao: 'tipo_preco', tecla: 'F2', habilitado: false, ordem: 3 },
      { acao: 'gelada', tecla: 'Shift+G', habilitado: true, ordem: 4 },
    ]);
    expect(r.map((l) => l.erro)).toEqual([
      undefined,
      'Tecla já usada em Pesquisar produto',
      undefined,
      expect.stringContaining('inválida'),
    ]);
    expect(r[0]!.tecla).toBe('F2');
  });

  it('não grava com tecla repetida e mostra o erro na linha', async () => {
    const u = userEvent.setup();
    const atalhos: AtalhoPdv[] = [
      { id: 'a', acao: 'pesquisar_produto', tecla: 'F2', habilitado: true, ordem: 1 },
      { id: 'b', acao: 'remover_item', tecla: 'F4', habilitado: true, ordem: 2 },
    ];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver', 'configuracoes.editar'] }),
      ({ url, metodo }) =>
        url.pathname === '/api/atalhos-pdv' && metodo === 'GET' ? { corpo: atalhos } : undefined,
    );
    renderizarComSessao(<TabelaAtalhos />);
    const campo = await screen.findByRole('textbox', { name: 'Tecla de Remover item' });
    await u.clear(campo);
    await u.type(campo, 'F2');
    await u.click(screen.getByRole('button', { name: 'Gravar atalhos' }));
    expect(await screen.findByText('Tecla já usada em Pesquisar produto')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
  });
});
