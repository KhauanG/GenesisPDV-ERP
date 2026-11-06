import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { corpoLoja, FormularioLoja, LOJA_VAZIA } from './Lojas';

afterEach(() => vi.unstubAllGlobals());

const ESTOQUE_CD = '01928f3a-0000-7000-8000-0000000000e1';

const rotasBase = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/ufs' ? { corpo: [{ sigla: 'PR', nome: 'Paraná' }] } : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/municipios'
      ? { corpo: [{ codigoIbge: 4106902, nome: 'Curitiba', uf: 'PR' }] }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/utilitarios/cep/80010000'
      ? {
          corpo: {
            cep: '80010000',
            logradouro: 'Rua XV',
            complemento: null,
            bairro: 'Centro',
            uf: 'PR',
            municipioIbge: 4106902,
            municipioNome: 'Curitiba',
          },
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/estoques'
      ? {
          corpo: {
            itens: [
              {
                id: ESTOQUE_CD,
                codigo: 1,
                nome: 'CD - Estoque Ice Beer',
                tipo: 'deposito',
                lojaId: null,
                lojaNome: null,
                ativo: true,
                versao: 1,
              },
            ],
            total: 1,
            pagina: 1,
            tamanho: 'todos',
          },
        }
      : undefined,
];

async function preencher(u: ReturnType<typeof userEvent.setup>, nome: string) {
  await u.type(await screen.findByRole('textbox', { name: /^Nome( \*)?$/ }), nome);
  await u.type(screen.getByLabelText(/^CNPJ/), '11.222.333/0001-81');
  await u.type(screen.getByLabelText(/^Razão social/), `${nome} Ltda`);
  await u.type(screen.getByLabelText(/^Fantasia/), nome);
  await u.type(screen.getByLabelText(/^CEP/), '80010000');
  await u.click(screen.getByRole('button', { name: 'Buscar CEP' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: /^Cidade/ })).toHaveValue('Curitiba'));
  await u.type(screen.getByLabelText(/^Número/), '100');
}

describe('<FormularioLoja> – assistente de primeira configuração (MD 7.13)', () => {
  it('nova loja cria o estoque homônimo: manda estoqueId nulo e o nome do estoque', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['lojas.ver', 'lojas.criar', 'lojas.editar_pix', 'estoques.ver'] }),
      ...rotasBase,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/lojas'
          ? { status: 422, corpo: { codigo: 'VALIDACAO', mensagem: 'x', campos: {} } }
          : undefined,
    );
    renderizarComSessao(<FormularioLoja />);
    expect(await screen.findByText(/Primeira configuração da loja/)).toBeInTheDocument();
    await preencher(u, 'Loja 1 - Hermes');
    await u.type(screen.getByLabelText('Nome do estoque'), 'Estoque Hermes');
    // PIX do recebedor (implantação I5): a chave e o nome vão para o BR Code do caixa.
    await u.type(screen.getByLabelText(/^Chave PIX/), 'pix@icebeer.com.br');
    await u.type(screen.getByLabelText(/^Nome do recebedor/), 'ICE BEER HERMES');
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/lojas')).toBe(true),
    );
    const corpo = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/lojas')!.corpo;
    expect(corpo).toMatchObject({
      nome: 'Loja 1 - Hermes',
      estoqueId: null,
      nomeEstoque: 'Estoque Hermes',
      municipioIbge: 4106902,
      cep: '80010000',
      tipo: 'ponto_venda',
      usaPdv: true,
      nfceAmbiente: 2,
      chavePix: 'pix@icebeer.com.br',
      pixNomeRecebedor: 'ICE BEER HERMES',
    });
  }, 30_000);

  it('CD: tipo Depósito/CD desliga o PDV e usa o estoque "deposito" escolhido', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['lojas.ver', 'lojas.criar', 'estoques.ver'] }),
      ...rotasBase,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/lojas'
          ? { status: 422, corpo: { codigo: 'VALIDACAO', mensagem: 'x', campos: {} } }
          : undefined,
    );
    renderizarComSessao(<FormularioLoja />);
    await preencher(u, 'CD Ice Beer');
    await u.click(screen.getByRole('combobox', { name: /^Tipo/ }));
    await u.click(await screen.findByRole('option', { name: 'Depósito / CD', hidden: true }));
    expect(screen.getByRole('switch', { name: 'Usa PDV nesta loja' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Usa PDV nesta loja' })).toBeDisabled();
    await u.click(screen.getByRole('radio', { name: 'Usar um local de estoque já cadastrado' }));
    await u.click(screen.getByRole('combobox', { name: /^Estoque/ }));
    await u.click(await screen.findByRole('option', { name: 'CD - Estoque Ice Beer (CD)', hidden: true }));
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/lojas')).toBe(true),
    );
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/lojas')!.corpo).toMatchObject(
      {
        tipo: 'deposito',
        usaPdv: false,
        estoqueId: ESTOQUE_CD,
        nomeEstoque: null,
        chavePix: null,
      },
    );
  }, 30_000);

  it('sem lojas.editar_pix o recebedor do PIX fica travado (o resto da loja, não)', async () => {
    simularApi(...rotasSessao({ permissoes: ['lojas.ver', 'lojas.criar', 'estoques.ver'] }), ...rotasBase);
    renderizarComSessao(<FormularioLoja />);
    expect(await screen.findByRole('textbox', { name: /^Nome( \*)?$/ })).toBeEnabled();
    expect(screen.getByLabelText(/^Chave PIX/)).toBeDisabled();
    expect(screen.getByLabelText(/^Nome do recebedor/)).toBeDisabled();
    expect(screen.getByLabelText(/^Cidade do recebedor/)).toBeDisabled();
    expect(screen.getByText(/Lojas: Alterar o recebedor do PIX/)).toBeInTheDocument();
  });

  it('sem lojas.criar o formulário fica somente leitura', async () => {
    simularApi(...rotasSessao({ permissoes: ['lojas.ver'] }), ...rotasBase);
    renderizarComSessao(<FormularioLoja />);
    expect(await screen.findByText(/Somente leitura/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Salvar/ })).not.toBeInTheDocument();
  });
});

describe('corpoLoja', () => {
  it('na alteração não manda o modo do estoque; série vazia vira nula', () => {
    const c = corpoLoja(
      { ...LOJA_VAZIA, estoqueId: ESTOQUE_CD, nfeSerie: '', municipioIbge: '4106902', cep: '80010-000' },
      false,
    );
    expect(c).toMatchObject({
      estoqueId: ESTOQUE_CD,
      nfeSerie: null,
      municipioIbge: 4106902,
      cep: '80010000',
    });
    expect(c).not.toHaveProperty('nomeEstoque');
    expect(c).not.toHaveProperty('modoEstoque');
  });
});
