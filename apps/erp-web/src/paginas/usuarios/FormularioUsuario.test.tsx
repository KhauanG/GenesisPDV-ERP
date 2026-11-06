import type { EstoqueResumo, UsuarioDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioUsuario } from './FormularioUsuario';

afterEach(() => vi.unstubAllGlobals());

const LOJAS = [
  { id: '01928f3a-0000-7000-8000-000000000001', codigo: 1, nome: 'Loja 1', ativa: true },
  { id: '01928f3a-0000-7000-8000-000000000002', codigo: 2, nome: 'Petiscaria 2', ativa: true },
];

const estoque = (id: string, nome: string, lojaId: string | null, ativo = true): EstoqueResumo => ({
  id,
  codigo: 1,
  nome,
  tipo: lojaId ? 'loja' : 'deposito',
  lojaId,
  lojaNome: lojaId ? 'Loja' : null,
  ativo,
  versao: 1,
});

// A API devolve só os estoques permitidos ao editor (decisão 149): o da Petiscaria 2 não vem.
const ESTOQUES = [
  estoque('01928f3a-0000-7000-8000-0000000000e1', 'Estoque Loja 1', LOJAS[0]!.id),
  estoque('01928f3a-0000-7000-8000-0000000000e3', 'CD - Estoque Ice Beer', null),
];

/** O campo de digitação de um MultiSelect (o rótulo também nomeia a lista de opções). */
const campoDe = (rotulo: string) => screen.getAllByLabelText(rotulo).find((e) => e.tagName === 'INPUT')!;

/** Pílulas (valores escolhidos) de um MultiSelect, pelo rótulo do campo. */
function pilulas(rotulo: string): string[] {
  const campo = campoDe(rotulo);
  const raiz = campo.closest('.mantine-MultiSelect-root') ?? campo.parentElement!.parentElement!;
  return [...raiz.querySelectorAll('.mantine-Pill-label')].map((p) => p.textContent ?? '');
}

describe('<FormularioUsuario> estoques permitidos', () => {
  it('lista só os estoques que a API permite e, ao marcar a loja, o estoque dela entra junto', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: ['usuarios.criar', 'estoques.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === '/api/estoques'
          ? { corpo: { itens: ESTOQUES, total: ESTOQUES.length, pagina: 1, tamanho: 'todos' } }
          : undefined,
    );
    renderizarComSessao(<FormularioUsuario />, '/cadastros/usuarios/novo', 'cadastros/usuarios/novo');
    await screen.findAllByLabelText('Estoques permitidos');
    const estoques = campoDe('Estoques permitidos');
    expect(
      screen.getByText('Só estes estoques são vistos e movimentados (inclusive o CD).'),
    ).toBeInTheDocument();
    await usuario.click(estoques);
    await screen.findByRole('option', { name: 'CD - Estoque Ice Beer', hidden: true });
    const lista = screen
      .getAllByLabelText('Estoques permitidos')
      .find((e) => e.getAttribute('role') === 'listbox')!;
    expect(
      within(lista)
        .getAllByRole('option', { hidden: true })
        .map((o) => o.textContent),
    ).toEqual(['Estoque Loja 1', 'CD - Estoque Ice Beer']);
    expect(pilulas('Estoques permitidos')).toEqual([]);

    await usuario.click(campoDe('Lojas permitidas'));
    await usuario.click(await screen.findByRole('option', { name: '1 - Loja 1', hidden: true }));
    await waitFor(() => expect(pilulas('Estoques permitidos')).toEqual(['Estoque Loja 1']));
    // A Petiscaria 2 não tem estoque visível ao editor: nada entra; o CD só entra se o gerente escolher.
    await usuario.click(campoDe('Lojas permitidas'));
    await usuario.click(await screen.findByRole('option', { name: '2 - Petiscaria 2', hidden: true }));
    await waitFor(() => expect(pilulas('Lojas permitidas')).toEqual(['1 - Loja 1', '2 - Petiscaria 2']));
    expect(pilulas('Estoques permitidos')).toEqual(['Estoque Loja 1']);
  });
});

const USUARIO_ID = '01928f3a-0000-7000-8000-0000000000a1';
const LOJA3_INATIVO = '01928f3a-0000-7000-8000-0000000000e4';
/** Estoque do usuário que a API não devolve ao editor (fora dos estoques permitidos dele). */
const OCULTO = '01928f3a-0000-7000-8000-0000000000e9';

function usuarioDetalhe(parcial: Partial<UsuarioDetalhe> = {}): UsuarioDetalhe {
  return {
    id: USUARIO_ID,
    codigo: 7,
    nome: 'JOAO CAIXA',
    login: 'joao',
    email: null,
    ativo: true,
    master: false,
    perfilId: null,
    perfilNome: null,
    limiteDescontoPct: '0.0000',
    comissaoPct: '0.0000',
    telefone: null,
    cpf: null,
    rg: null,
    admissao: null,
    demissao: null,
    salario: null,
    cep: null,
    logradouro: null,
    numero: null,
    complemento: null,
    bairro: null,
    uf: null,
    municipioIbge: null,
    municipioNome: null,
    vendedor: false,
    entregador: false,
    tecnico: false,
    pdvUtilitario: false,
    comandaEletronica: false,
    totem: true,
    observacoes: null,
    lojas: [LOJAS[0]!.id],
    estoques: [ESTOQUES[0]!.id, LOJA3_INATIVO, OCULTO],
    pinDefinido: false,
    senhaProvisoria: false,
    bloqueadoAte: null,
    ultimoLoginEm: null,
    criadoEm: '2026-11-01T12:00:00.000Z',
    atualizadoEm: '2026-11-01T12:00:00.000Z',
    atualizadoPorNome: null,
    versao: 4,
    ...parcial,
  };
}

describe('<FormularioUsuario> edição: estoques inativos e fora do alcance do editor', () => {
  function simular(detalhe: UsuarioDetalhe) {
    const comInativo = [...ESTOQUES, estoque(LOJA3_INATIVO, 'Estoque Loja 3', null, false)];
    return simularApi(
      ...rotasSessao({ permissoes: ['usuarios.editar', 'estoques.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === '/api/estoques'
          ? { corpo: { itens: comInativo, total: comInativo.length, pagina: 1, tamanho: 'todos' } }
          : undefined,
      ({ url, metodo, corpo }) =>
        url.pathname === `/api/usuarios/${USUARIO_ID}`
          ? metodo === 'PUT'
            ? { corpo: { usuario: { ...detalhe, ...(corpo as object), versao: detalhe.versao + 1 } } }
            : { corpo: detalhe }
          : undefined,
    );
  }

  it('o inativo do usuário aparece "(inativo)" e fica; o oculto é contado e continua no PUT', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simular(usuarioDetalhe());
    renderizarComSessao(<FormularioUsuario />, `/cadastros/usuarios/${USUARIO_ID}`, 'cadastros/usuarios/:id');
    await waitFor(() =>
      expect(pilulas('Estoques permitidos')).toEqual(['Estoque Loja 1', 'Estoque Loja 3 (inativo)']),
    );
    // Só o que a API não devolve ao editor conta como "sem acesso"; o inativo não.
    expect(
      screen.getByText(
        'Só estes estoques são vistos e movimentados (inclusive o CD). 1 estoque(s) a que você não tem acesso continuam liberados.',
      ),
    ).toBeInTheDocument();
    // A busca traz ativos e inativos; o inativo que o usuário não tem não é oferecido.
    expect(chamadas.find((c) => c.url.pathname === '/api/estoques')!.url.searchParams.get('situacao')).toBe(
      'todos',
    );

    await usuario.click(campoDe('Estoques permitidos'));
    await usuario.click(await screen.findByRole('option', { name: 'CD - Estoque Ice Beer', hidden: true }));
    await waitFor(() =>
      expect(pilulas('Estoques permitidos')).toEqual([
        'Estoque Loja 1',
        'Estoque Loja 3 (inativo)',
        'CD - Estoque Ice Beer',
      ]),
    );
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(new Set((put.corpo as { estoques: string[] }).estoques)).toEqual(
      new Set([ESTOQUES[0]!.id, LOJA3_INATIVO, OCULTO, ESTOQUES[1]!.id]),
    );
  });

  it('com tudo ao alcance do editor não há aviso, e tirar o inativo o retira', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simular(usuarioDetalhe({ estoques: [ESTOQUES[0]!.id, LOJA3_INATIVO] }));
    renderizarComSessao(<FormularioUsuario />, `/cadastros/usuarios/${USUARIO_ID}`, 'cadastros/usuarios/:id');
    await waitFor(() =>
      expect(pilulas('Estoques permitidos')).toEqual(['Estoque Loja 1', 'Estoque Loja 3 (inativo)']),
    );
    expect(
      screen.getByText('Só estes estoques são vistos e movimentados (inclusive o CD).'),
    ).toBeInTheDocument();
    const raiz = campoDe('Estoques permitidos').closest('.mantine-MultiSelect-root')!;
    const pilula = [...raiz.querySelectorAll('.mantine-Pill-root')].find((p) =>
      p.textContent?.includes('(inativo)'),
    )!;
    await usuario.click(pilula.querySelector('button')!);
    await waitFor(() => expect(pilulas('Estoques permitidos')).toEqual(['Estoque Loja 1']));
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect((chamadas.find((c) => c.metodo === 'PUT')!.corpo as { estoques: string[] }).estoques).toEqual([
      ESTOQUES[0]!.id,
    ]);
  });

  it('o Master não tem o campo (vê todos os estoques)', async () => {
    simular(usuarioDetalhe({ master: true, totem: false }));
    renderizarComSessao(<FormularioUsuario />, `/cadastros/usuarios/${USUARIO_ID}`, 'cadastros/usuarios/:id');
    await screen.findByDisplayValue('JOAO CAIXA');
    expect(screen.queryByLabelText('Estoques permitidos')).not.toBeInTheDocument();
  });
});
