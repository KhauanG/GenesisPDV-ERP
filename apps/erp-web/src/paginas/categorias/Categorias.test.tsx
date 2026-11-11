/**
 * Produtos › Categorias (ERP 8.4; F2-B44; README do ERP › decisão 78): arrastar "Cervejas long neck" para dentro de
 * "Cervejas" (o `mover` com a ordem do fim) e depois para a faixa antes de "Lata" (o `reordenar` com a lista inteira das
 * irmãs e a versão de cada uma); a recusa do ciclo sem chamar a API; "Subir" pelo ⋮; o 409 do reordenar avisa e
 * recarrega; a faixa de outro nível (o `mover` sem ordem e depois o `reordenar` com a versão que o mover devolveu; o
 * 409 do segundo passo); sem `categorias.editar` não se arrasta; a imagem da categoria vai no Gravar; e o painel aberto
 * com a árvore recarregada numa versão nova (a soltura daqui mantém o digitado e leva a versão; outro usuário: sem nada
 * digitado adota, com algo digitado avisa e o Gravar dá 409).
 */
import type { ArquivoInfo, CategoriaNo } from '@genesis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { Categorias } from './Categorias';

afterEach(() => vi.unstubAllGlobals());

const C = '0190a000-0000-7000-8000-0000000000c1';
const V = '0190a000-0000-7000-8000-0000000000c2';
const LN = '0190a000-0000-7000-8000-0000000000c3';
const LT = '0190a000-0000-7000-8000-0000000000c4';
const IMG = '0190a000-0000-7000-8000-0000000000f1';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

const no = (id: string, nome: string, pai: string | null, ordem: number, versao = 1): CategoriaNo => ({
  id,
  nome,
  categoriaPaiId: pai,
  caminhoNomes: pai ? `Cervejas > ${nome}` : nome,
  nivel: pai ? 2 : 1,
  ordem,
  ativa: true,
  exibePdv: true,
  exibeMenuDigital: false,
  exibeTotem: false,
  exibeSite: false,
  cor: null,
  imagemArquivoId: null,
  produtos: 0,
  versao,
});

/** Um `dataTransfer` mínimo (o jsdom não tem). */
const transferencia = () => {
  const dados = new Map<string, string>();
  return {
    setData: (t: string, v: string) => dados.set(t, v),
    getData: (t: string) => dados.get(t) ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
    files: [],
    types: [],
  };
};

/** Arrasta a linha da categoria `de` e solta no elemento `alvo()` (pego depois do dragStart: as faixas surgem nele). */
function arrastar(de: string, alvo: () => HTMLElement) {
  const dt = transferencia();
  fireEvent.dragStart(screen.getByTestId(`categoria-${de}`), { dataTransfer: dt });
  const el = alvo();
  fireEvent.dragOver(el, { dataTransfer: dt });
  fireEvent.drop(el, { dataTransfer: dt });
}

const PERMISSOES = ['categorias.ver', 'categorias.editar'];

describe('<Categorias> arrastar e soltar (F2-B44)', () => {
  it('"Cervejas long neck" arrastada para dentro de "Cervejas" e depois reordenada antes de "Lata"', async () => {
    let arvore = [
      no(C, 'Cervejas', null, 10, 4),
      no(V, 'Vinhos', null, 20),
      no(LN, 'Cervejas long neck', null, 30, 7),
      no(LT, 'Lata', C, 10, 2),
    ];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/categorias/${LN}/mover`) return undefined;
        arvore = arvore.map((n) => (n.id === LN ? { ...no(LN, 'Cervejas long neck', C, 20, 8) } : n));
        return { corpo: arvore.find((n) => n.id === LN) };
      },
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== '/api/categorias/reordenar') return undefined;
        arvore = arvore.map((n) =>
          n.id === LN ? { ...n, ordem: 10, versao: 9 } : n.id === LT ? { ...n, ordem: 20, versao: 3 } : n,
        );
        return { corpo: arvore };
      },
    );
    renderizarComSessao(<Categorias />);
    await screen.findByTestId('categoria-Cervejas long neck');

    // Para dentro de "Cervejas": só o mover, para o fim das filhas (a Lata está na 10).
    arrastar('Cervejas long neck', () => screen.getByTestId('categoria-Cervejas'));
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname === `/api/categorias/${LN}/mover`)?.corpo).toEqual({
        versao: 7,
        categoriaPaiId: C,
        ordem: 20,
      }),
    );
    expect(chamadas.some((c) => c.url.pathname === '/api/categorias/reordenar')).toBe(false);
    // A árvore recarrega e abre o pai novo: a long neck aparece dentro de Cervejas, depois da Lata.
    expect(await screen.findByText('Categoria movida')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('categoria-Lata')).toBeInTheDocument());

    // Para a faixa antes de "Lata": as irmãs inteiras na ordem nova, com a versão de cada uma.
    arrastar('Cervejas long neck', () => screen.getByTestId('soltar-antes-Lata'));
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname === '/api/categorias/reordenar')?.corpo).toEqual({
        categoriaPaiId: C,
        itens: [
          { id: LN, versao: 8 },
          { id: LT, versao: 2 },
        ],
      }),
    );
    expect(await screen.findByText('Ordem gravada')).toBeInTheDocument();
  }, 30_000);

  it('soltar "Cervejas" dentro da própria filha é recusado sem chamar a API; "Subir" reordena pelo ⋮', async () => {
    const u = userEvent.setup();
    const arvore = [no(C, 'Cervejas', null, 10), no(V, 'Vinhos', null, 20), no(LT, 'Lata', C, 10)];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/categorias/reordenar'
          ? {
              status: 409,
              corpo: {
                codigo: 'CONFLITO_VERSAO',
                mensagem: 'Registro alterado por outro usuário. Recarregue e tente de novo.',
              },
            }
          : undefined,
    );
    renderizarComSessao(<Categorias />);
    await screen.findByTestId('categoria-Cervejas');
    await u.click(screen.getAllByLabelText('Expandir')[0]!);
    arrastar('Cervejas', () => screen.getByTestId('categoria-Lata'));
    expect(
      await screen.findByText('Não é possível mover a categoria para dentro dela mesma.'),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname.startsWith('/api/categorias'))).toBe(
      false,
    );

    // "Subir" em Vinhos: a lista das raízes com Vinhos primeiro; o 409 avisa e a árvore recarrega.
    const leituras = () => chamadas.filter((c) => c.url.pathname === '/api/categorias/arvore').length;
    const antes = leituras();
    await u.click(screen.getByLabelText('Ações de Vinhos'));
    await u.click(await screen.findByRole('menuitem', { name: 'Subir' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname === '/api/categorias/reordenar')?.corpo).toEqual({
        categoriaPaiId: null,
        itens: [
          { id: V, versao: 1 },
          { id: C, versao: 1 },
        ],
      }),
    );
    expect(await screen.findByText(/Registro alterado por outro usuário/)).toBeInTheDocument();
    await waitFor(() => expect(leituras()).toBeGreaterThan(antes));
  }, 30_000);

  it('soltar na faixa de outro nível: o mover (sem ordem) e depois o reordenar com a versão que o mover devolveu', async () => {
    let arvore = [
      no(C, 'Cervejas', null, 10, 4),
      no(V, 'Vinhos', null, 20),
      no(LN, 'Cervejas long neck', null, 30, 7),
      no(LT, 'Lata', C, 10, 2),
    ];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/categorias/${LN}/mover`) return undefined;
        arvore = arvore.map((n) => (n.id === LN ? no(LN, 'Cervejas long neck', C, 30, 8) : n));
        return { corpo: arvore.find((n) => n.id === LN) };
      },
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== '/api/categorias/reordenar') return undefined;
        arvore = arvore.map((n) =>
          n.id === LN ? { ...n, ordem: 10, versao: 9 } : n.id === LT ? { ...n, ordem: 20, versao: 3 } : n,
        );
        return { corpo: arvore };
      },
    );
    const u = userEvent.setup();
    renderizarComSessao(<Categorias />);
    await screen.findByTestId('categoria-Cervejas');
    await u.click(screen.getAllByLabelText('Expandir')[0]!);
    // A long neck ainda é raiz (versão 7) e vai para antes da Lata, filha de Cervejas.
    arrastar('Cervejas long neck', () => screen.getByTestId('soltar-antes-Lata'));
    expect(await screen.findByText('Categoria movida')).toBeInTheDocument();
    const gravacoes = chamadas.filter(
      (c) => c.metodo === 'POST' && c.url.pathname.startsWith('/api/categorias'),
    );
    expect(gravacoes.map((c) => c.url.pathname)).toEqual([
      `/api/categorias/${LN}/mover`,
      '/api/categorias/reordenar',
    ]);
    expect(gravacoes[0]!.corpo).toEqual({ versao: 7, categoriaPaiId: C });
    // A versão da arrastada no reordenar é a 8, a que o mover devolveu (a árvore carregada ainda dizia 7).
    expect(gravacoes[1]!.corpo).toEqual({
      categoriaPaiId: C,
      itens: [
        { id: LN, versao: 8 },
        { id: LT, versao: 2 },
      ],
    });
  }, 30_000);

  it('o 409 do reordenar depois do mover avisa e recarrega a árvore (a categoria fica no pai novo)', async () => {
    let arvore = [
      no(C, 'Cervejas', null, 10, 4),
      no(LN, 'Cervejas long neck', null, 30, 7),
      no(LT, 'Lata', C, 10, 2),
    ];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/categorias/${LN}/mover`) return undefined;
        arvore = arvore.map((n) => (n.id === LN ? no(LN, 'Cervejas long neck', C, 30, 8) : n));
        return { corpo: arvore.find((n) => n.id === LN) };
      },
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/categorias/reordenar'
          ? {
              status: 409,
              corpo: {
                codigo: 'CONFLITO_VERSAO',
                mensagem: 'Registro alterado por outro usuário. Recarregue e tente de novo.',
              },
            }
          : undefined,
    );
    const u = userEvent.setup();
    renderizarComSessao(<Categorias />);
    await screen.findByTestId('categoria-Cervejas');
    await u.click(screen.getAllByLabelText('Expandir')[0]!);
    const leituras = () => chamadas.filter((c) => c.url.pathname === '/api/categorias/arvore').length;
    const antes = leituras();
    arrastar('Cervejas long neck', () => screen.getByTestId('soltar-antes-Lata'));
    expect(await screen.findByText(/Registro alterado por outro usuário/)).toBeInTheDocument();
    await waitFor(() => expect(leituras()).toBeGreaterThan(antes));
    // Recarregada, a long neck aparece dentro de Cervejas (o mover já tinha gravado).
    await waitFor(() =>
      expect(
        within(screen.getByTestId('categoria-Cervejas').parentElement!).getByTestId(
          'categoria-Cervejas long neck',
        ),
      ).toBeInTheDocument(),
    );
  }, 30_000);

  it('sem categorias.editar não se arrasta nem há faixas', async () => {
    simularApi(...rotasSessao({ permissoes: ['categorias.ver'] }), ({ url }) =>
      url.pathname === '/api/categorias/arvore' ? { corpo: [no(C, 'Cervejas', null, 10)] } : undefined,
    );
    renderizarComSessao(<Categorias />);
    const linha = await screen.findByTestId('categoria-Cervejas');
    expect(linha.getAttribute('draggable')).toBe('false');
    fireEvent.dragStart(linha, { dataTransfer: transferencia() });
    expect(screen.queryByTestId('soltar-antes-Cervejas')).toBeNull();
  });
});

describe('<Categorias> imagem da categoria (F2-B44)', () => {
  it('a imagem enviada no painel vai no Gravar', async () => {
    const u = userEvent.setup();
    const info: ArquivoInfo = {
      id: IMG,
      categoria: 'imagem_categoria',
      entidade: 'categorias',
      lojaId: null,
      nomeOriginal: 'cervejas.png',
      tipoMime: 'image/png',
      tamanhoBytes: 12,
      sha256: 'a'.repeat(64),
      variantes: {},
      criadoEm: '2026-11-11T12:00:00.000Z',
    };
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) =>
        url.pathname === '/api/categorias/arvore' ? { corpo: [no(C, 'Cervejas', null, 10)] } : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/arquivos' ? { status: 201, corpo: info } : undefined,
      ({ url }) =>
        url.pathname === `/api/arquivos/${IMG}/conteudo`
          ? { arquivo: { conteudo: 'webp', cabecalhos: { 'Content-Type': 'image/webp' } } }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'PUT' && url.pathname === `/api/categorias/${C}`
          ? { corpo: { ...no(C, 'Cervejas', null, 10, 2), imagemArquivoId: IMG } }
          : undefined,
    );
    const { container } = renderizarComSessao(<Categorias />);
    await u.click(await screen.findByText('Cervejas'));
    const painel = (await screen.findByText('Configurar: Cervejas')).closest(
      'div.mantine-Paper-root',
    ) as HTMLElement;
    await u.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([Uint8Array.from(PNG)], 'cervejas.png', { type: 'image/png' }),
    );
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')?.url.search,
      ).toBe('?destino=categoria_imagem'),
    );
    await u.click(within(painel).getByRole('button', { name: 'Gravar' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.metodo === 'PUT')?.corpo).toMatchObject({
        nome: 'Cervejas',
        imagemArquivoId: IMG,
        versao: 1,
      }),
    );
  }, 30_000);
});

describe('<Categorias> painel aberto e a árvore recarregada com versão nova (F2-B44)', () => {
  const G = '0190a000-0000-7000-8000-0000000000c5';
  const conflito = {
    status: 409,
    corpo: { codigo: 'CONFLITO_VERSAO', mensagem: 'Registro alterado por Ana. Recarregue e tente de novo.' },
  };

  /** Abre "Lata" (filha de Cervejas) no painel e devolve o painel. */
  async function abrirLata(u: ReturnType<typeof userEvent.setup>) {
    await screen.findByTestId('categoria-Cervejas');
    await u.click(screen.getAllByLabelText('Expandir')[0]!);
    await u.click(await screen.findByText('Lata'));
    return (await screen.findByText('Configurar: Cervejas > Lata')).closest(
      'div.mantine-Paper-root',
    ) as HTMLElement;
  }
  const subir = async (u: ReturnType<typeof userEvent.setup>, nome: string) => {
    await u.click(screen.getByLabelText(`Ações de ${nome}`));
    await u.click(await screen.findByRole('menuitem', { name: 'Subir' }));
  };

  it('com o nome digitado, a soltura daqui leva a ordem e a versão novas sem apagar o nome; o Gravar não dá 409', async () => {
    let arvore = [no(C, 'Cervejas', null, 10), no(LT, 'Lata', C, 10, 2), no(G, 'Garrafa', C, 20)];
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== '/api/categorias/reordenar') return undefined;
        arvore = arvore.map((n) =>
          n.id === G ? { ...n, ordem: 10, versao: 2 } : n.id === LT ? { ...n, ordem: 20, versao: 3 } : n,
        );
        return { corpo: arvore };
      },
      ({ url, metodo, corpo }) =>
        metodo === 'PUT' && url.pathname === `/api/categorias/${LT}`
          ? (corpo as { versao: number }).versao === 3
            ? { corpo: { ...no(LT, 'Latão', C, 20, 4) } }
            : conflito
          : undefined,
    );
    const u = userEvent.setup();
    renderizarComSessao(<Categorias />);
    const painel = await abrirLata(u);
    const nome = within(painel).getByLabelText(/Nome/);
    await u.clear(nome);
    await u.type(nome, 'Latão');

    // "Subir" na Garrafa: o reordenar dá a ordem 20 e a versão 3 à Lata, que está aberta e com o nome mudado.
    await subir(u, 'Garrafa');
    expect(await screen.findByText('Ordem gravada')).toBeInTheDocument();
    await waitFor(() => expect(within(painel).getByLabelText('Ordem')).toHaveValue('20'));
    expect(within(painel).getByLabelText(/Nome/)).toHaveValue('Latão');
    expect(screen.queryByTestId('categoria-defasada')).toBeNull();

    await u.click(within(painel).getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('Categoria gravada')).toBeInTheDocument();
    expect(chamadas.find((c) => c.metodo === 'PUT')?.corpo).toMatchObject({
      nome: 'Latão',
      ordem: 20,
      versao: 3,
    });
  }, 30_000);

  it('a categoria alterada em outro lugar: sem nada digitado o painel a adota; com algo digitado mantém e avisa', async () => {
    let arvore = [no(C, 'Cervejas', null, 10), no(V, 'Vinhos', null, 20), no(LT, 'Lata', C, 10, 2)];
    /** O que "outro usuário" grava na Lata antes da próxima leitura da árvore. */
    const outroUsuario = (nome: string, versao: number) =>
      (arvore = arvore.map((n) => (n.id === LT ? { ...n, nome, versao } : n)));
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ({ url }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== '/api/categorias/reordenar') return undefined;
        const raizes = arvore.filter((n) => !n.categoriaPaiId);
        arvore = arvore.map((n) =>
          raizes.includes(n) ? { ...n, ordem: n.ordem === 10 ? 20 : 10, versao: n.versao + 1 } : n,
        );
        return { corpo: arvore };
      },
      ({ url, metodo, corpo }) =>
        metodo === 'PUT' && url.pathname === `/api/categorias/${LT}`
          ? (corpo as { versao: number }).versao === 4
            ? { corpo: { ...arvore.find((n) => n.id === LT)!, versao: 5 } }
            : conflito
          : undefined,
    );
    const u = userEvent.setup();
    renderizarComSessao(<Categorias />);
    const painel = await abrirLata(u);

    // Sem nada digitado: a versão nova (de outro usuário) entra no painel sem aviso.
    outroUsuario('Lata 350', 3);
    await subir(u, 'Vinhos');
    await waitFor(() => expect(within(painel).getByLabelText(/Nome/)).toHaveValue('Lata 350'));
    expect(screen.queryByTestId('categoria-defasada')).toBeNull();

    // Com o nome digitado: a versão nova de outro usuário não apaga o que foi digitado; o painel avisa.
    const nome = within(painel).getByLabelText(/Nome/);
    await u.clear(nome);
    await u.type(nome, 'Latinha');
    outroUsuario('Lata 473', 4);
    await subir(u, 'Cervejas');
    expect(await screen.findByTestId('categoria-defasada')).toBeInTheDocument();
    expect(within(painel).getByLabelText(/Nome/)).toHaveValue('Latinha');

    // O Gravar manda a versão em que o formulário se baseia: a API recusa com quem alterou.
    await u.click(within(painel).getByRole('button', { name: 'Gravar' }));
    expect(await within(painel).findByText(/Registro alterado por Ana/)).toBeInTheDocument();
    expect(chamadas.filter((c) => c.metodo === 'PUT').at(-1)?.corpo).toMatchObject({
      nome: 'Latinha',
      versao: 3,
    });

    // "Descartar e carregar a versão nova": o formulário passa à versão 4, e o Gravar segue.
    await u.click(within(painel).getByRole('button', { name: 'Descartar e carregar a versão nova' }));
    expect(within(painel).getByLabelText(/Nome/)).toHaveValue('Lata 473');
    expect(screen.queryByTestId('categoria-defasada')).toBeNull();
    await u.click(within(painel).getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('Categoria gravada')).toBeInTheDocument();
    expect(chamadas.filter((c) => c.metodo === 'PUT').at(-1)?.corpo).toMatchObject({
      nome: 'Lata 473',
      versao: 4,
    });
  }, 30_000);
});
