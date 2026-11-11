/**
 * Foto e imagens do produto (F2-B44; ERP 8.2.6; README do ERP › decisão 78): o bloco "Foto e imagens" envia a foto e
 * as outras imagens pelo `<UploadArquivo>` (`POST /api/arquivos?destino=produto_foto`), a galeria reordena e remove, e
 * o Gravar manda a foto e a lista inteira; a cópia (Duplicar) sai sem imagens; o erro da API na galeria cai no campo.
 */
import type { ArquivoInfo, ProdutoDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { errosParaFormulario, paraCorpo, paraValores, produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const FOTO = '0190a000-0000-7000-8000-0000000000f0';
const arq = (n: number) => `0190a000-0000-7000-8000-0000000000f${n}`;
const PERMISSOES = ['produtos.ver', 'produtos.criar', 'produtos.editar'];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const png = (nome: string) => new File([Uint8Array.from(PNG)], nome, { type: 'image/png' });

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

function renderizar(url: string) {
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          {
            path: '/produtos/:id/:aba?',
            element: (
              <Autenticado>
                <FormularioProduto />
              </Autenticado>
            ),
          },
        ],
      },
    ],
    url,
  );
}

function detalhe(extra: Partial<ProdutoDetalhe> = {}): ProdutoDetalhe {
  const v = produtoVazio([], UN);
  return {
    ...(Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]),
    ) as unknown as ProdutoDetalhe),
    id: ID,
    versao: 3,
    criadoEm: '2026-10-30T12:00:00Z',
    atualizadoEm: '2026-10-30T12:00:00Z',
    atualizadoPorNome: 'MARIA',
    codigo: 50,
    nome: 'CERV FICTICIA LN 355',
    tipo: 'simples',
    ativo: true,
    controlaEstoque: true,
    unidadeId: UN,
    unidadeSigla: 'UN',
    precoCusto: null,
    custoMedio: null,
    markupPct: null,
    precoVenda: '6.9000',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    relacionados: [],
    fornecedores: [],
    lotes: [],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    avisosCombo: [],
    temMovimento: false,
    fotoPrincipalArquivoId: FOTO,
    imagens: [
      { id: 'i1', arquivoId: arq(1), ordem: 1 },
      { id: 'i2', arquivoId: arq(2), ordem: 2 },
    ],
    ...extra,
  } as ProdutoDetalhe;
}

const info = (id: string): ArquivoInfo => ({
  id,
  categoria: 'foto_produto',
  entidade: 'produtos',
  lojaId: null,
  nomeOriginal: 'foto.png',
  tipoMime: 'image/png',
  tamanhoBytes: 12,
  sha256: 'a'.repeat(64),
  variantes: {},
  criadoEm: '2026-11-11T12:00:00.000Z',
});

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/marcas'
      ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/categorias/arvore' ? { corpo: [] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === '/api/grupos-preco-quantidade'
      ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/tipos-habilitados'
      ? { corpo: { tipos: ['simples', 'materia_prima', 'produzido', 'kit'], usaFornecedores: false } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: { linhas: [], combos: [] } } : undefined,
  // As miniaturas (`pdv_256`) de qualquer arquivo.
  ({ url }: { url: URL }) =>
    /^\/api\/arquivos\/[^/]+\/conteudo$/.test(url.pathname)
      ? { arquivo: { conteudo: 'webp', cabecalhos: { 'Content-Type': 'image/webp' } } }
      : undefined,
];

describe('foto e imagens do produto: valores (F2-B44)', () => {
  it('o detalhe vira a foto e a lista de ids; o corpo leva os dois; a cópia sai sem imagens', () => {
    const v = paraValores(detalhe(), []);
    expect(v.fotoPrincipalArquivoId).toBe(FOTO);
    expect(v.imagens).toEqual([arq(1), arq(2)]);
    const c = paraCorpo(v);
    expect(c.fotoPrincipalArquivoId).toBe(FOTO);
    expect(c.imagens).toEqual([arq(1), arq(2)]);
    const copia = paraValores(detalhe(), [], true);
    expect(copia.fotoPrincipalArquivoId).toBeNull();
    expect(copia.imagens).toEqual([]);
    // Sem foto e sem galeria, o corpo manda null e [] (tira o que estava gravado).
    expect(paraCorpo(copia)).toMatchObject({ fotoPrincipalArquivoId: null, imagens: [] });
  });

  it('o erro da API numa imagem da galeria cai no campo da galeria', () => {
    const v = paraValores(detalhe(), []);
    expect(
      errosParaFormulario(v, {
        'imagens.1': 'Foto do produto: arquivo inválido ou de outro cadastro',
        fotoPrincipalArquivoId: 'x',
      }),
    ).toEqual({
      imagens: 'Foto do produto: arquivo inválido ou de outro cadastro',
      fotoPrincipalArquivoId: 'x',
    });
  });
});

describe('bloco "Foto e imagens" do produto (F2-B44)', () => {
  it('envia a foto nova e uma imagem, reordena e remove na galeria e grava a foto e a lista inteira', async () => {
    const usuario = userEvent.setup();
    let envios = 0;
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/arquivos'
          ? { status: 201, corpo: info(arq(5 + envios++)) }
          : undefined,
      ({ url, metodo }) =>
        url.pathname === `/api/produtos/${ID}` && metodo === 'GET' ? { corpo: detalhe() } : undefined,
      ({ url, metodo }) =>
        url.pathname === `/api/produtos/${ID}` && metodo === 'PUT' ? { corpo: detalhe() } : undefined,
    );
    const { container } = renderizar(`/produtos/${ID}`);
    const cabecalho = await screen.findByRole('button', { name: /^Foto e imagens/ });
    expect(cabecalho).toHaveTextContent('Com foto · 2 imagem(ns)');
    await usuario.click(cabecalho);
    const galeria = await screen.findByTestId('galeria-imagens');
    expect(within(galeria).getByTestId('galeria-imagem-1')).toBeInTheDocument();
    expect(within(galeria).getByTestId('galeria-imagem-2')).toBeInTheDocument();
    // A foto: "Trocar imagem" envia outra (o primeiro seletor de arquivo do bloco é o da foto).
    const entradas = () => [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    const [entradaFoto, entradaGaleria] = entradas().slice(-2);
    await usuario.upload(entradaFoto!, png('foto-nova.png'));
    await waitFor(() => expect(envios).toBe(1));
    // A galeria: acrescenta uma (vai para o fim), passa a 2ª para a esquerda e remove a que era a 1ª.
    await usuario.upload(entradaGaleria!, png('lado.png'));
    await waitFor(() => expect(within(galeria).getByTestId('galeria-imagem-3')).toBeInTheDocument());
    await usuario.click(within(galeria).getByLabelText('Imagem 2 para a esquerda'));
    await usuario.click(within(galeria).getByLabelText('Remover a imagem 2'));
    const envioDestinos = chamadas
      .filter((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')
      .map((c) => c.url.searchParams.get('destino'));
    expect(envioDestinos).toEqual(['produto_foto', 'produto_foto']);

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)).toBe(true),
    );
    const corpo = chamadas.find((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)!
      .corpo as Record<string, unknown>;
    expect(corpo.fotoPrincipalArquivoId).toBe(arq(5));
    expect(corpo.imagens).toEqual([arq(2), arq(6)]);
  }, 30_000);

  it('sem produtos.editar o bloco só mostra as miniaturas', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: ['produtos.ver'] }), ...referencias, ({ url }) =>
      url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Foto e imagens/ }));
    const galeria = await screen.findByTestId('galeria-imagens');
    expect(within(galeria).queryByLabelText(/Remover a imagem/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Trocar imagem|Enviar imagem/ })).toBeNull();
  }, 30_000);
});
