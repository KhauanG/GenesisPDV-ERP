/**
 * Marcas (ERP 8.7; F2-B44; README do ERP › decisão 78): o logotipo enviado no formulário vai no Gravar; Imprimir abre a
 * ficha em aba nova (só com `produtos.ver`); a ficha mostra o logotipo e os produtos da marca, sem custo, e chama a
 * impressão do navegador.
 */
import type { ArquivoInfo, FichaMarca, MarcaDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { FichaMarcaImpressao } from './FichaMarca';
import { FormularioMarca } from './Marcas';

afterEach(() => vi.unstubAllGlobals());

const M = '0190a000-0000-7000-8000-0000000000b1';
const LOGO = '0190a000-0000-7000-8000-0000000000f1';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

const MARCA: MarcaDetalhe = {
  id: M,
  codigo: 7,
  descricao: 'CERVEJARIA FICTICIA',
  semMarca: false,
  exibeSite: false,
  ordem: 0,
  produtos: 2,
  versao: 3,
  criadoEm: '2026-11-01T12:00:00Z',
  atualizadoEm: '2026-11-01T12:00:00Z',
  atualizadoPorNome: 'MARIA',
  logotipoArquivoId: null,
};

const miniatura = ({ url }: { url: URL }) =>
  url.pathname === `/api/arquivos/${LOGO}/conteudo`
    ? { arquivo: { conteudo: 'webp', cabecalhos: { 'Content-Type': 'image/webp' } } }
    : undefined;

describe('formulário da marca (F2-B44)', () => {
  it('o logotipo enviado vai no Gravar; Imprimir abre a ficha em aba nova', async () => {
    const u = userEvent.setup();
    const abrir = vi.fn();
    vi.stubGlobal('open', abrir);
    const info: ArquivoInfo = {
      id: LOGO,
      categoria: 'logotipo',
      entidade: 'marcas',
      lojaId: null,
      nomeOriginal: 'logo.png',
      tipoMime: 'image/png',
      tamanhoBytes: 12,
      sha256: 'a'.repeat(64),
      variantes: {},
      criadoEm: '2026-11-11T12:00:00.000Z',
    };
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['marcas.ver', 'marcas.editar', 'produtos.ver'] }),
      ({ url, metodo }) =>
        url.pathname === `/api/marcas/${M}` && metodo === 'GET' ? { corpo: MARCA } : undefined,
      ({ url, metodo }) =>
        url.pathname === `/api/marcas/${M}` && metodo === 'PUT'
          ? { corpo: { ...MARCA, versao: 4, logotipoArquivoId: LOGO } }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/arquivos' ? { status: 201, corpo: info } : undefined,
      miniatura,
    );
    const { container } = renderizarComSessao(
      <FormularioMarca />,
      `/produtos/marcas/${M}`,
      '/produtos/marcas/:id',
    );
    expect(await screen.findByText('PNG, JPG ou WebP, até 1 MB')).toBeInTheDocument();
    await u.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File([Uint8Array.from(PNG)], 'logo.png', { type: 'image/png' }),
    );
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')?.url.search,
      ).toBe('?destino=marca_logotipo'),
    );
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.metodo === 'PUT')?.corpo).toMatchObject({
        descricao: 'CERVEJARIA FICTICIA',
        logotipoArquivoId: LOGO,
        versao: 3,
      }),
    );
    await u.click(screen.getByRole('button', { name: 'Imprimir' }));
    expect(abrir).toHaveBeenCalledWith(`/produtos/marcas/${M}/ficha?imprimir=1`, '_blank');
  }, 30_000);

  it('sem produtos.ver não há Imprimir; sem marcas.editar o logotipo é só leitura', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['marcas.ver'] }),
      ({ url }) =>
        url.pathname === `/api/marcas/${M}` ? { corpo: { ...MARCA, logotipoArquivoId: LOGO } } : undefined,
      miniatura,
    );
    renderizarComSessao(<FormularioMarca />, `/produtos/marcas/${M}`, '/produtos/marcas/:id');
    expect(await screen.findByAltText('Logotipo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Imprimir' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Trocar imagem/ })).toBeNull();
  }, 30_000);
});

describe('ficha impressa da marca (F2-B44)', () => {
  it('mostra o logotipo e os produtos, sem custo, e chama a impressão', async () => {
    const imprimir = vi.fn();
    vi.stubGlobal('print', imprimir);
    const ficha: FichaMarca = {
      marca: { ...MARCA, logotipoArquivoId: LOGO },
      produtos: [
        {
          id: 'p1',
          codigo: 11,
          nome: 'ALE FICTICIA LN 355',
          ean: null,
          unidadeSigla: 'UN',
          precoVenda: '9.9000',
          ativo: false,
        },
        {
          id: 'p2',
          codigo: 12,
          nome: 'PILSEN FICTICIA LT 350',
          ean: '7891234567895',
          unidadeSigla: 'UN',
          precoVenda: '5.5000',
          ativo: true,
        },
      ],
      totalProdutos: 2,
      geradoEm: '2026-11-11T15:00:00.000Z',
    };
    simularApi(
      ...rotasSessao({ permissoes: ['marcas.ver', 'produtos.ver'] }),
      ({ url }) => (url.pathname === `/api/marcas/${M}/ficha` ? { corpo: ficha } : undefined),
      miniatura,
    );
    renderizarComSessao(
      <FichaMarcaImpressao />,
      `/produtos/marcas/${M}/ficha?imprimir=1`,
      '/produtos/marcas/:id/ficha',
    );
    expect(await screen.findByText('Marca 7 – CERVEJARIA FICTICIA')).toBeInTheDocument();
    expect(await screen.findByAltText('Logotipo da marca')).toBeInTheDocument();
    const linhas = within(screen.getByRole('table', { name: 'Produtos da marca' })).getAllByRole('row');
    expect(linhas.slice(1).map((l) => l.textContent)).toEqual([
      '11ALE FICTICIA LN 355—UNR$ 9,90Inativo',
      '12PILSEN FICTICIA LT 3507891234567895UNR$ 5,50Ativo',
    ]);
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
  }, 30_000);
});
