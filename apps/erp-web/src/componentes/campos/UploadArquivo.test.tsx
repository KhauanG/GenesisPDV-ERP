import type { ArquivoInfo } from '@genesis/shared';
import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { problemaDoArquivo, UploadArquivo } from './UploadArquivo';

const LOJA = '01928f3a-0000-7000-8000-0000000000a1';
const ARQUIVO = '01928f3a-0000-7000-8000-0000000000f1';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

const arquivo = (bytes: number[] | string, nome: string, tipo: string, tamanho?: number) => {
  const conteudo = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes);
  const f = new File([conteudo], nome, { type: tipo });
  if (tamanho !== undefined) Object.defineProperty(f, 'size', { value: tamanho });
  return f;
};

const INFO: ArquivoInfo = {
  id: ARQUIVO,
  categoria: 'logotipo',
  entidade: 'lojas',
  lojaId: LOJA,
  nomeOriginal: 'logo.png',
  tipoMime: 'image/png',
  tamanhoBytes: 12,
  sha256: 'a'.repeat(64),
  variantes: {
    pdv_256: { tipoMime: 'image/webp', tamanhoBytes: 10, sha256: 'b'.repeat(64), largura: 256, altura: 85 },
  },
  criadoEm: '2026-11-11T12:00:00.000Z',
};

let mudancas: Array<string | null> = [];

function Campo({ inicial = null, somenteLeitura }: { inicial?: string | null; somenteLeitura?: boolean }) {
  const [valor, setValor] = useState<string | null>(inicial);
  return (
    <UploadArquivo
      rotulo="Logotipo"
      destino="loja_logotipo"
      lojaId={LOJA}
      valor={valor}
      aoMudar={(id) => {
        mudancas.push(id);
        setValor(id);
      }}
      somenteLeitura={somenteLeitura}
    />
  );
}

beforeEach(() => {
  mudancas = [];
});
afterEach(() => vi.unstubAllGlobals());

const miniatura = ({ url }: { url: URL }) =>
  url.pathname === `/api/arquivos/${ARQUIVO}/conteudo`
    ? { arquivo: { conteudo: 'webp', cabecalhos: { 'Content-Type': 'image/webp' } } }
    : undefined;

describe('<UploadArquivo>', () => {
  it('escolher a imagem a envia com o destino e a loja, mostra a miniatura e devolve o id', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao(),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/arquivos' ? { status: 201, corpo: INFO } : undefined,
      miniatura,
    );
    const { container } = renderizarComSessao(<Campo />);
    expect(await screen.findByText('Sem imagem')).toBeInTheDocument();
    expect(screen.getByText('PNG, JPG ou WebP, até 1 MB')).toBeInTheDocument();
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(entrada.accept).toBe('image/png,image/jpeg,image/webp');
    await u.upload(entrada, arquivo(PNG, 'logo.png', 'image/png'));
    await waitFor(() => expect(mudancas).toEqual([ARQUIVO]));
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')!;
    expect(post.url.searchParams.get('destino')).toBe('loja_logotipo');
    expect(post.url.searchParams.get('lojaId')).toBe(LOJA);
    expect(((post.corpo as FormData).get('arquivo') as File).name).toBe('logo.png');
    expect(await screen.findByRole('img', { name: 'Logotipo' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/webp;base64,/),
    );
    const get = chamadas.find((c) => c.url.pathname === `/api/arquivos/${ARQUIVO}/conteudo`)!;
    expect(get.url.searchParams.get('variante')).toBe('pdv_256');
    expect(get.cabecalhos.get('Authorization')).toBe('Bearer tok');
    await u.click(screen.getByRole('button', { name: /Remover/ }));
    expect(mudancas).toEqual([ARQUIVO, null]);
    expect(screen.getByText('Sem imagem')).toBeInTheDocument();
  });

  it('o HTML com nome .png e o arquivo grande são recusados na tela, sem enviar', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao());
    const { container } = renderizarComSessao(<Campo />);
    await screen.findByText('Sem imagem');
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await u.upload(entrada, arquivo('<html><script>x</script></html>', 'foto.png', 'image/png'));
    expect(await screen.findByText(/conferido pelo conteúdo/)).toBeInTheDocument();
    await u.upload(entrada, arquivo(PNG, 'grande.png', 'image/png', 1024 * 1024 + 1));
    expect(await screen.findByText(/acima de 1 MB/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')).toBe(false);
    expect(mudancas).toEqual([]);
  });

  it('a recusa da API (415) aparece no campo e o valor não muda', async () => {
    const u = userEvent.setup();
    simularApi(...rotasSessao(), ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/arquivos'
        ? {
            status: 415,
            corpo: { codigo: 'TIPO_NAO_SUPORTADO', mensagem: 'Não foi possível ler a imagem: corrompida.' },
          }
        : undefined,
    );
    const { container } = renderizarComSessao(<Campo />);
    await screen.findByText('Sem imagem');
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await u.upload(entrada, arquivo(PNG, 'logo.png', 'image/png'));
    expect(await screen.findByText('Não foi possível ler a imagem: corrompida.')).toBeInTheDocument();
    expect(mudancas).toEqual([]);
  });

  it('arrastar e soltar no quadro envia o primeiro arquivo, com a mesma conferência do botão', async () => {
    const { chamadas } = simularApi(
      ...rotasSessao(),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/arquivos' ? { status: 201, corpo: INFO } : undefined,
      miniatura,
    );
    renderizarComSessao(<Campo />);
    await screen.findByText('Sem imagem');
    const quadro = screen.getByTestId('quadro-upload');
    fireEvent.dragOver(quadro);
    expect(screen.getByText('Solte aqui')).toBeInTheDocument();
    // O HTML renomeado é recusado na tela, igual ao do botão.
    fireEvent.drop(quadro, {
      dataTransfer: { files: [arquivo('<html><script>x</script></html>', 'foto.png', 'image/png')] },
    });
    expect(await screen.findByText(/conferido pelo conteúdo/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')).toBe(false);
    // Vários arquivos soltos de uma vez: só o primeiro vai.
    fireEvent.drop(quadro, {
      dataTransfer: {
        files: [arquivo(PNG, 'logo.png', 'image/png'), arquivo(PNG, 'outro.png', 'image/png')],
      },
    });
    await waitFor(() => expect(mudancas).toEqual([ARQUIVO]));
    const posts = chamadas.filter((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos');
    expect(posts).toHaveLength(1);
    expect(((posts[0]!.corpo as FormData).get('arquivo') as File).name).toBe('logo.png');
    expect(await screen.findByRole('img', { name: 'Logotipo' })).toBeInTheDocument();
  });

  it('somente leitura: soltar não envia, mas impede o navegador de abrir o arquivo', async () => {
    const { chamadas } = simularApi(...rotasSessao(), miniatura);
    renderizarComSessao(<Campo inicial={ARQUIVO} somenteLeitura />);
    await screen.findByRole('img', { name: 'Logotipo' });
    const quadro = screen.getByTestId('quadro-upload');
    const evento = createEvent.drop(quadro, {
      dataTransfer: { files: [arquivo(PNG, 'logo.png', 'image/png')] },
    });
    fireEvent(quadro, evento);
    expect(evento.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/arquivos')).toBe(false);
    expect(mudancas).toEqual([]);
  });

  it('somente leitura: só a miniatura, sem enviar nem remover', async () => {
    simularApi(...rotasSessao(), miniatura);
    const { container } = renderizarComSessao(<Campo inicial={ARQUIVO} somenteLeitura />);
    expect(await screen.findByRole('img', { name: 'Logotipo' })).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });

  it('problemaDoArquivo: o tipo pelo conteúdo, nunca pela extensão', async () => {
    expect(await problemaDoArquivo(arquivo(PNG, 'x.gif', 'image/gif'), 'produto_foto')).toBeNull();
    expect(await problemaDoArquivo(arquivo('GIF89a', 'x.png', 'image/png'), 'produto_foto')).toMatch(
      /PNG, JPG ou WebP/,
    );
    expect(await problemaDoArquivo(arquivo('%PDF-1.7', 'x.png', 'image/png'), 'produto_foto')).not.toBeNull();
    expect(
      await problemaDoArquivo(arquivo(PNG, 'x.png', 'image/png', 2 * 1024 * 1024 + 1), 'produto_foto'),
    ).toMatch(/2 MB/);
  });
});
