import type { Prontidao as DadosProntidao } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { Prontidao, ROTA_PRONTIDAO } from './Prontidao';

/**
 * Implantação › Prontidão da loja (I5): a tela só desenha o que a API avaliou (as regras têm os testes de integração
 * em `apps/api/test/integracao/prontidao.test.ts`): o resumo, os grupos, o ícone e o link de cada item, a troca de loja
 * e o "Só o que falta resolver".
 */

afterEach(() => vi.unstubAllGlobals());

const PILOTO = '01928f3a-0000-7000-8000-0000000000a1';
const TREINO = '01928f3a-0000-7000-8000-0000000000a2';
const LOJAS = [
  { id: PILOTO, codigo: 1, nome: 'Loja 1 - Centro', ativa: true, treino: false },
  { id: TREINO, codigo: 9, nome: 'Treino', ativa: true, treino: true },
];

function prontidao(lojaId: string, faltando: boolean): DadosProntidao {
  const itens: DadosProntidao['itens'] = [
    {
      codigo: 'empresa.ativa',
      grupo: 'empresa',
      titulo: 'Empresa ativa',
      situacao: 'ok',
      mensagem: 'Empresa ativa e liberada para o caixa.',
      linkErp: null,
    },
    {
      codigo: 'formas.pix',
      grupo: 'formas',
      titulo: 'PIX',
      situacao: faltando ? 'falta' : 'ok',
      mensagem: faltando
        ? 'A forma PIX gera QR, mas a loja não tem chave PIX: informe a chave e o nome do recebedor no cadastro da loja.'
        : 'QR estático com a chave de cnpj da loja.',
      linkErp: `/cadastros/lojas/${lojaId}`,
    },
    {
      codigo: 'catalogo.ncm',
      grupo: 'catalogo',
      titulo: 'NCM (fiscal fica para depois)',
      situacao: 'aviso',
      mensagem: '569 produtos ativos sem NCM vigente.',
      linkErp: '/produtos',
    },
  ];
  const resumo = { ok: 0, aviso: 0, falta: 0 };
  for (const i of itens) resumo[i.situacao]++;
  return {
    lojaId,
    lojaCodigo: lojaId === PILOTO ? 1 : 9,
    lojaNome: lojaId === PILOTO ? 'Loja 1 - Centro' : 'Treino',
    geradoEm: '2026-11-04T12:00:00.000Z',
    pronta: resumo.falta === 0,
    resumo,
    itens,
  };
}

describe('<Prontidao> (implantação I5)', () => {
  it('resumo, grupos, situação e link de cada item; troca de loja e só pendências', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === '/api/implantacao/prontidao'
          ? { corpo: prontidao(url.searchParams.get('lojaId')!, url.searchParams.get('lojaId') === PILOTO) }
          : undefined,
    );
    renderizarComSessao(<Prontidao />, ROTA_PRONTIDAO);

    const resumo = await screen.findByTestId('prontidao-resumo');
    expect(resumo).toHaveTextContent('Loja 1 - Centro: falta 1 item para vender');
    expect(resumo).toHaveTextContent('1 ok');
    expect(resumo).toHaveTextContent('1 aviso');
    expect(resumo).toHaveTextContent('1 falta');
    expect(
      chamadas.find((c) => c.url.pathname === '/api/implantacao/prontidao')!.url.searchParams.get('lojaId'),
    ).toBe(PILOTO);

    const formas = screen.getByRole('region', { name: 'Formas de pagamento' });
    const pix = within(formas).getByTestId('prontidao-formas.pix');
    expect(pix).toHaveAttribute('data-situacao', 'falta');
    expect(within(pix).getByText('Falta')).toBeInTheDocument();
    expect(within(pix).getByRole('link', { name: 'Resolver' })).toHaveAttribute(
      'href',
      `/cadastros/lojas/${PILOTO}`,
    );
    // Item ok sem link (fora do ERP) não mostra nem "Resolver" nem "Abrir".
    const empresa = screen.getByTestId('prontidao-empresa.ativa');
    expect(within(empresa).queryByRole('link')).toBeNull();
    expect(screen.getByRole('region', { name: 'Catálogo' })).toHaveTextContent(
      '569 produtos ativos sem NCM vigente.',
    );

    // Só o que falta resolver: o ok some, o aviso e a falta ficam.
    await u.click(screen.getByRole('switch', { name: 'Só o que falta resolver' }));
    await waitFor(() => expect(screen.queryByTestId('prontidao-empresa.ativa')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Empresa' })).toBeNull();
    expect(screen.getByTestId('prontidao-formas.pix')).toBeInTheDocument();
    expect(screen.getByTestId('prontidao-catalogo.ncm')).toBeInTheDocument();

    // Outra loja: a pronta.
    await u.click(screen.getByRole('combobox', { name: 'Loja' }));
    await u.click(await screen.findByRole('option', { name: '9 - Treino (treino)', hidden: true }));
    await waitFor(() =>
      expect(screen.getByTestId('prontidao-resumo')).toHaveTextContent('Treino: pronta para vender'),
    );
    expect(
      chamadas.some(
        (c) => c.url.pathname === '/api/implantacao/prontidao' && c.url.searchParams.get('lojaId') === TREINO,
      ),
    ).toBe(true);
    expect(screen.queryByTestId('prontidao-formas.pix')).toBeNull();
  }, 30_000);

  it('erro da API aparece na tela', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['configuracoes.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === '/api/implantacao/prontidao'
          ? { status: 403, corpo: { codigo: 'SEM_PERMISSAO', mensagem: 'Você não tem acesso a esta loja.' } }
          : undefined,
    );
    renderizarComSessao(<Prontidao />, `${ROTA_PRONTIDAO}?lojaId=${TREINO}`);
    expect(await screen.findByText('Não deu para conferir a loja')).toBeInTheDocument();
    expect(screen.getByText('Você não tem acesso a esta loja.')).toBeInTheDocument();
  }, 30_000);
});
