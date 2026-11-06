import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { dividirCatalogo, EditorPermissoes, type Ajuste } from './EditorPermissoes';

function Perfil({ inicial }: { inicial: string[] }) {
  const [v, setV] = useState(new Set(inicial));
  return (
    <MantineProvider>
      <EditorPermissoes modo="perfil" secao="menus" valor={v} aoMudar={setV} />
      <output>{[...v].sort().join(',')}</output>
    </MantineProvider>
  );
}

function Usuario({ doPerfil }: { doPerfil: string[] }) {
  const [a, setA] = useState(new Map<string, Ajuste>());
  return (
    <MantineProvider>
      <EditorPermissoes
        modo="usuario"
        secao="gerais"
        doPerfil={new Set(doPerfil)}
        ajustes={a}
        aoMudar={setA}
      />
      <output>{[...a.entries()].map(([k, e]) => `${k}=${e}`).join(',')}</output>
    </MantineProvider>
  );
}

describe('dividirCatalogo', () => {
  it('menus = ações padrão de recurso do ERP; gerais = demais ações e o PDV', () => {
    const { menus, gerais } = dividirCatalogo();
    const pessoas = menus.find((m) => m.recurso === 'pessoas')!;
    expect(Object.keys(pessoas.acoes).sort()).toEqual(['criar', 'editar', 'excluir', 'exportar', 'ver']);
    expect(menus.some((m) => m.recurso.startsWith('pdv'))).toBe(false);
    expect(gerais.get('Pessoas')!.map((p) => p.chave)).toContain('pessoas.editar_credito');
    expect([...gerais.keys()].some((g) => g.startsWith('PDV'))).toBe(true);
  });
});

describe('<EditorPermissoes>', () => {
  it('perfil: marcar e desmarcar; desmarcar "Ver" desmarca as demais ações do item', async () => {
    const u = userEvent.setup();
    render(<Perfil inicial={['marcas.ver', 'marcas.criar', 'marcas.editar', 'pessoas.ver']} />);
    await u.click(screen.getByRole('checkbox', { name: 'Marcas Excluir – marcas.excluir' }));
    expect(
      screen.getByText('marcas.criar,marcas.editar,marcas.excluir,marcas.ver,pessoas.ver'),
    ).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: 'Marcas Ver – marcas.ver' }));
    expect(screen.getByText('pessoas.ver')).toBeInTheDocument();
  });

  it('usuário: herdado → negado → herdado; sem permissão → concedido', async () => {
    const u = userEvent.setup();
    render(<Usuario doPerfil={['pessoas.importar']} />);
    const herdado = screen.getByRole('button', { name: /pessoas\.importar: herdado/ });
    await u.click(herdado);
    expect(screen.getByText('pessoas.importar=negar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pessoas\.importar: negar/ })).toHaveAttribute(
      'data-estado',
      'negar',
    );
    await u.click(screen.getByRole('button', { name: /pessoas\.importar: negar/ }));
    expect(screen.getByRole('button', { name: /pessoas\.importar: herdado/ })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /pessoas\.anonimizar: sem/ }));
    expect(screen.getByText('pessoas.anonimizar=conceder')).toBeInTheDocument();
  });

  it('a busca filtra os itens', async () => {
    const u = userEvent.setup();
    render(<Usuario doPerfil={[]} />);
    await u.type(screen.getByPlaceholderText('Buscar permissão'), 'sangria');
    expect(screen.getByRole('button', { name: /pdv\.caixa\.sangria: sem/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pessoas\.importar/ })).not.toBeInTheDocument();
  });
});
