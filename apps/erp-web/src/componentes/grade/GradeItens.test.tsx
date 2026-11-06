import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderizarRotas } from '../../teste/utilidades';
import { lerDecimal } from './decimal';
import { errosDaGrade, GradeItens, type ColunaGrade } from './GradeItens';

interface Item {
  id: string;
  codigo: string;
  quantidade: string;
  preco: string;
  unidade: string;
}

let seq = 0;
const nova = (): Item => ({ id: `l${++seq}`, codigo: '', quantidade: '', preco: '', unidade: '' });
const vazia = (l: Item) => !l.codigo && !l.quantidade && !l.preco;
const totalLinha = (l: Item) => (lerDecimal(l.quantidade) ?? 0) * (lerDecimal(l.preco) ?? 0);
const validar = (l: Item) => {
  const e: Partial<Record<keyof Item | '_linha', string>> = {};
  if (!l.codigo) e.codigo = 'Informe o produto';
  const q = lerDecimal(l.quantidade);
  if (q === null || q <= 0) e.quantidade = 'Quantidade inválida';
  return e;
};

const COLUNAS: ColunaGrade<Item>[] = [
  { campo: 'codigo', rotulo: 'Produto', tipo: 'texto' },
  {
    campo: 'unidade',
    rotulo: 'Unidade',
    tipo: 'selecao',
    opcoes: [
      { value: 'UN', label: 'UN' },
      { value: 'CX', label: 'CX' },
    ],
  },
  { campo: 'quantidade', rotulo: 'Qtd.', tipo: 'numero' },
  { campo: 'preco', rotulo: 'Preço', tipo: 'dinheiro' },
  {
    campo: 'id',
    rotulo: 'Total',
    tipo: 'leitura',
    formato: (l) => totalLinha(l).toFixed(2).replace('.', ','),
  },
];

const estado: { linhas: Item[] } = { linhas: [] };

function Tela({
  inicial = [],
  mostrarErros = false,
  linhasFixas = false,
}: {
  inicial?: Item[];
  mostrarErros?: boolean;
  linhasFixas?: boolean;
}) {
  const [linhas, setLinhas] = useState<Item[]>(inicial);
  useEffect(() => {
    estado.linhas = linhas;
  }, [linhas]);
  return (
    <GradeItens
      rotulo="Itens do acerto"
      linhas={linhas}
      aoMudar={setLinhas}
      colunas={COLUNAS}
      novaLinha={nova}
      chave={(l) => l.id}
      validar={validar}
      vazia={vazia}
      rodape={{ quantidade: 'quantidade', total: totalLinha }}
      colarEm={['codigo', 'quantidade', 'preco']}
      mostrarErros={mostrarErros}
      linhasFixas={linhasFixas}
    />
  );
}

const montar = (props: Parameters<typeof Tela>[0] = {}) =>
  renderizarRotas([{ path: '/', element: <Tela {...props} /> }], '/');

const campo = (rotulo: string, linha: number) =>
  screen.getByRole('textbox', { name: `${rotulo} da linha ${linha}` });

describe('<GradeItens>', () => {
  it('linhas fixas: edita os campos, mas sem inserir (F9, botão, Enter no fim) nem remover linhas', async () => {
    const usuario = userEvent.setup();
    montar({
      linhasFixas: true,
      inicial: [
        { ...nova(), codigo: 'A', quantidade: '10' },
        { ...nova(), codigo: 'B', quantidade: '5' },
      ],
    });
    expect(screen.queryByRole('button', { name: /Inserir item/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remover linha/ })).not.toBeInTheDocument();
    await usuario.clear(campo('Qtd.', 2));
    await usuario.type(campo('Qtd.', 2), '4');
    await usuario.click(campo('Preço', 2));
    await usuario.keyboard('{Enter}{F9}');
    await usuario.keyboard('{Control>}{Delete}{/Control}');
    expect(estado.linhas).toHaveLength(2);
    expect(estado.linhas[1]).toMatchObject({ codigo: 'B', quantidade: '4' });
    await usuario.click(screen.getByRole('button', { name: 'Linha 1' }));
    await usuario.keyboard('{Delete}');
    expect(estado.linhas).toHaveLength(2);
  });

  it('F9 insere a linha com foco no 1º campo; Enter avança e, na última coluna, cria a próxima linha', async () => {
    const usuario = userEvent.setup();
    montar();
    expect(screen.getByText(/Nenhum item/)).toBeInTheDocument();
    await usuario.keyboard('{F9}');
    await waitFor(() => expect(campo('Produto', 1)).toHaveFocus());
    await usuario.keyboard('7891{Enter}');
    expect(screen.getByRole('combobox', { name: 'Unidade da linha 1' })).toHaveFocus();
    await usuario.keyboard('{Enter}');
    expect(campo('Qtd.', 1)).toHaveFocus();
    await usuario.keyboard('2{Enter}');
    expect(campo('Preço', 1)).toHaveFocus();
    await usuario.keyboard('3,50{Enter}');
    await waitFor(() => expect(campo('Produto', 2)).toHaveFocus());
    expect(estado.linhas).toHaveLength(2);
    expect(estado.linhas[0]).toMatchObject({ codigo: '7891', quantidade: '2', preco: '3,50' });
    // Rodapé: linhas preenchidas, soma das quantidades e total.
    expect(screen.getByText('Itens:').textContent).toBe('Itens: 1');
    expect(screen.getByText('Quantidade:').textContent).toBe('Quantidade: 2');
    expect(screen.getByText('Total:').textContent).toBe('Total: R$ 7,00');
  });

  it('↑/↓ mudam de linha na mesma coluna; botão "Inserir item" também cria linha', async () => {
    const usuario = userEvent.setup();
    montar({
      inicial: [
        { ...nova(), codigo: 'A' },
        { ...nova(), codigo: 'B' },
      ],
    });
    await usuario.click(campo('Qtd.', 1));
    await usuario.keyboard('{ArrowDown}');
    expect(campo('Qtd.', 2)).toHaveFocus();
    await usuario.keyboard('{ArrowUp}');
    expect(campo('Qtd.', 1)).toHaveFocus();
    await usuario.click(screen.getByRole('button', { name: /Inserir item/ }));
    await waitFor(() => expect(campo('Produto', 3)).toHaveFocus());
  });

  it('Delete na alça remove linha vazia direto; com dados, pede confirmação', async () => {
    const usuario = userEvent.setup();
    montar({ inicial: [{ ...nova(), codigo: 'A', quantidade: '1' }, nova()] });
    screen.getByRole('button', { name: 'Linha 2' }).focus();
    await usuario.keyboard('{Delete}');
    await waitFor(() => expect(estado.linhas).toHaveLength(1));

    screen.getByRole('button', { name: 'Linha 1' }).focus();
    await usuario.keyboard('{Delete}');
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByText('Remover o item da linha 1?')).toBeInTheDocument();
    await usuario.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(estado.linhas).toHaveLength(1);

    await usuario.click(campo('Produto', 1));
    await usuario.keyboard('{Control>}{Delete}{/Control}');
    await usuario.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(estado.linhas).toHaveLength(0));
  });

  it('linha com erro fica marcada com a dica; errosDaGrade bloqueia o gravar', async () => {
    const usuario = userEvent.setup();
    montar({ inicial: [nova()] });
    // Linha intocada e vazia: sem erro visível.
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('data-erro');
    await usuario.type(campo('Qtd.', 1), '0');
    const linha = screen.getAllByRole('row')[1]!;
    expect(linha).toHaveAttribute('data-erro', 'true');
    expect(campo('Produto', 1)).toHaveAttribute('title', 'Informe o produto');
    expect(campo('Qtd.', 1)).toHaveAttribute('aria-invalid', 'true');
    expect(errosDaGrade(estado.linhas, validar, vazia)).toEqual([
      { indice: 0, erros: { codigo: 'Informe o produto', quantidade: 'Quantidade inválida' } },
    ]);
    await usuario.type(campo('Produto', 1), 'X');
    await usuario.clear(campo('Qtd.', 1));
    await usuario.type(campo('Qtd.', 1), '1,5');
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('data-erro');
    expect(errosDaGrade(estado.linhas, validar, vazia)).toEqual([]);
  });

  it('mostrarErros (depois de tentar gravar) marca também as linhas não editadas', () => {
    montar({ inicial: [{ ...nova(), codigo: 'A' }], mostrarErros: true });
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-erro', 'true');
  });

  it('colar do Excel (código, quantidade, preço) preenche várias linhas a partir da linha vazia', async () => {
    const usuario = userEvent.setup();
    montar({ inicial: [{ ...nova(), codigo: 'A', quantidade: '1' }, nova()] });
    await usuario.click(campo('Produto', 2));
    await usuario.paste('7891\t2\t3,50\r\n7892\t1\t10\r\n');
    expect(estado.linhas.map((l) => [l.codigo, l.quantidade, l.preco])).toEqual([
      ['A', '1', ''],
      ['7891', '2', '3,50'],
      ['7892', '1', '10'],
    ]);
    expect(screen.getByText('Total:').textContent).toBe('Total: R$ 17,00');
    // Um valor só cola normalmente no campo.
    await usuario.click(campo('Produto', 1));
    await usuario.paste('B');
    expect(estado.linhas[0]!.codigo).toBe('AB');
  });
});

describe('lerDecimal', () => {
  it('aceita vírgula e milhar brasileiros', () => {
    expect(lerDecimal('1.234,56')).toBe(1234.56);
    expect(lerDecimal('1,5')).toBe(1.5);
    expect(lerDecimal('2')).toBe(2);
    expect(lerDecimal('2.5')).toBe(2.5);
    expect(lerDecimal('abc')).toBeNull();
    expect(lerDecimal('')).toBeNull();
  });
});
