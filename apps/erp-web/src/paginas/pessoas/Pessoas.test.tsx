import { criarPessoaSchema } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { corpoPessoa, FormularioPessoa, PESSOA_VAZIA } from './Pessoas';

afterEach(() => vi.unstubAllGlobals());

const PERMISSOES = ['pessoas.ver', 'pessoas.criar', 'pessoas.editar', 'pessoas.editar_credito'];

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/ufs'
      ? {
          corpo: [
            { sigla: 'PR', nome: 'Paraná' },
            { sigla: 'SP', nome: 'São Paulo' },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/municipios'
      ? {
          corpo:
            url.searchParams.get('uf') === 'PR' ? [{ codigoIbge: 4106902, nome: 'Curitiba', uf: 'PR' }] : [],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/paises'
      ? { corpo: [{ codigoBacen: '1058', nome: 'Brasil' }] }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/utilitarios/cep/80010000'
      ? {
          corpo: {
            cep: '80010000',
            logradouro: 'Rua XV de Novembro',
            complemento: null,
            bairro: 'Centro',
            uf: 'PR',
            municipioIbge: 4106902,
            municipioNome: 'Curitiba',
          },
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname.startsWith('/api/utilitarios/cep/')
      ? { status: 404, corpo: { codigo: 'NAO_ENCONTRADO', mensagem: 'CEP não encontrado' } }
      : undefined,
];

describe('<FormularioPessoa> (ERP 7.2)', () => {
  it('valida na tela (nome, CPF) sem chamar a API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao({ permissoes: PERMISSOES }), ...referencias);
    renderizarComSessao(<FormularioPessoa />);
    await usuario.type(await screen.findByLabelText(/^Nome/), 'J');
    await usuario.type(screen.getByLabelText('CPF'), '111.111.111-11');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('CPF inválido')).toBeInTheDocument();
    expect(screen.getByText('Informe ao menos 2 caracteres')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/pessoas')).toBe(false);
  });

  it('busca o CEP, preenche o endereço e grava endereço, telefone e e-mail no formato da API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES }),
      ...referencias,
      ({ url, metodo, corpo }) =>
        metodo === 'POST' && url.pathname === '/api/pessoas'
          ? {
              status: 201,
              corpo: {
                ...(corpo as object),
                id: '01928f3a-0000-7000-8000-0000000000b1',
                codigo: 1,
                versao: 1,
                enderecos: [],
                telefones: [],
                emails: [],
                categorias: ['cliente'],
                origem: 'erp',
                senhaDefinida: false,
                criadoEm: '2026-10-30T12:00:00Z',
                atualizadoEm: '2026-10-30T12:00:00Z',
                atualizadoPorNome: 'MARIA',
                descontoPct: '0',
                limiteCompras: null,
              },
            }
          : undefined,
    );
    renderizarComSessao(<FormularioPessoa />);
    await usuario.type(await screen.findByLabelText(/^Nome/), 'José da Silva');
    await usuario.type(screen.getByLabelText('CPF'), '529.982.247-25');

    await usuario.click(screen.getByRole('button', { name: 'Inserir endereço' }));
    const endereco = screen.getByTestId('endereco-0');
    await usuario.type(within(endereco).getByLabelText(/^CEP/), '80010000');
    await usuario.click(within(endereco).getByRole('button', { name: 'Buscar CEP' }));
    await waitFor(() =>
      expect(within(endereco).getByLabelText(/^Endereço/)).toHaveValue('Rua XV de Novembro'),
    );
    await waitFor(() =>
      expect(within(endereco).getByRole('combobox', { name: /^Cidade/ })).toHaveValue('Curitiba'),
    );
    await usuario.type(within(endereco).getByLabelText(/^Número/), '100');

    await usuario.click(screen.getByRole('button', { name: 'Inserir telefone' }));
    await usuario.type(screen.getByLabelText('Número do telefone'), '(41) 99999-1234');
    await usuario.click(screen.getByRole('button', { name: 'Inserir e-mail' }));
    await usuario.type(screen.getByLabelText('E-mail'), 'jose@exemplo.com');

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/pessoas')).toBe(true),
    );
    const corpo = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/pessoas')!
      .corpo as Record<string, unknown>;
    expect(corpo).toMatchObject({
      nome: 'José da Silva',
      cpfCnpj: '529.982.247-25',
      categorias: ['cliente'],
      enderecos: [
        {
          tipo: 'principal',
          cep: '80010000',
          uf: 'PR',
          municipioIbge: 4106902,
          numero: '100',
          bairro: 'Centro',
        },
      ],
      telefones: [{ numero: '(41) 99999-1234', principal: true }],
      emails: [{ email: 'jose@exemplo.com', principal: true }],
    });
  }, 30_000);

  it('CPF já cadastrado (409) mostra o link para o cadastro existente', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: PERMISSOES }), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/pessoas'
        ? {
            status: 409,
            corpo: {
              codigo: 'CONFLITO',
              mensagem: 'Já existe a pessoa 7 - JOSÉ com este documento.',
              campos: { cpfCnpj: ['Já cadastrado: 7 - JOSÉ'] },
              detalhes: { pessoaId: '01928f3a-0000-7000-8000-0000000000c7', codigo: 7, nome: 'JOSÉ' },
            },
          }
        : undefined,
    );
    renderizarComSessao(<FormularioPessoa />);
    await usuario.type(await screen.findByLabelText(/^Nome/), 'José');
    await usuario.type(screen.getByLabelText('CPF'), '52998224725');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    const link = await screen.findByRole('link', { name: '7 - JOSÉ' });
    expect(link).toHaveAttribute('href', '/pessoas/01928f3a-0000-7000-8000-0000000000c7');
    expect(screen.getByText('Já cadastrado: 7 - JOSÉ')).toBeInTheDocument();
  });

  it('sem pessoas.editar_credito o limite de compras fica bloqueado', async () => {
    simularApi(...rotasSessao({ permissoes: ['pessoas.ver', 'pessoas.criar'] }), ...referencias);
    renderizarComSessao(<FormularioPessoa />);
    expect(await screen.findByLabelText(/Limite de compras/)).toBeDisabled();
  });
});

describe('corpoPessoa', () => {
  it('"Manter no PDV" vai para a API e passa pelo schema (relevância manual, D19)', () => {
    const c = corpoPessoa({ ...PESSOA_VAZIA, nome: 'Ana', manterNoPdv: true });
    expect(c.manterNoPdv).toBe(true);
    expect(criarPessoaSchema.parse(c).manterNoPdv).toBe(true);
    expect(criarPessoaSchema.parse({ nome: 'Sem a marca' }).manterNoPdv).toBe(false);
  });

  it('PJ zera o sexo, limite vazio vira nulo e o telefone segue num campo só', () => {
    const c = corpoPessoa({
      ...PESSOA_VAZIA,
      tipo: 'PJ',
      sexo: 'M',
      limiteCompras: '',
      telefones: [{ id: null, tipo: 'celular', numero: '(41) 3333-4444', contato: '', principal: true }],
    });
    expect(c).toMatchObject({
      sexo: 'N',
      limiteCompras: null,
      descontoPct: '0',
      telefones: [{ ddd: '', numero: '(41) 3333-4444' }],
    });
  });
});
