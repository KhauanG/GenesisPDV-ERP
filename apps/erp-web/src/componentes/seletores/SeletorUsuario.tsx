import type { Pagina, UsuarioDetalhe, UsuarioResumo } from '@genesis/shared';
import { Loader, Select, type SelectProps } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';

/** Mínimo de caracteres para pesquisar, como no campo Produto da grade (ERP 3.3). */
export const MINIMO_BUSCA = 2;

export interface UsuarioSelecionado {
  id: string;
  codigo: number;
  nome: string;
}

export interface PropsSeletorUsuario extends Omit<
  SelectProps,
  'data' | 'value' | 'onChange' | 'defaultValue' | 'searchValue'
> {
  value: string | null;
  onChange: (usuarioId: string | null, usuario: UsuarioSelecionado | null) => void;
  /** Padrão `ativos`; relatórios e filtros de auditoria usam `todos`. */
  situacao?: 'ativos' | 'inativos' | 'todos';
  /** Só usuários com acesso a esta loja (Masters entram sempre). */
  lojaId?: string | null;
}

const rotulo = (u: UsuarioSelecionado) => `${u.codigo} - ${u.nome}`;
const resumir = (u: UsuarioSelecionado): UsuarioSelecionado => ({ id: u.id, codigo: u.codigo, nome: u.nome });

/**
 * `<SeletorUsuario>` (ERP 3.4): busca no servidor por nome, login ou código (`GET /api/usuarios`, até 20 sugestões)
 * a partir de 2 caracteres. Um valor vindo da URL ou do registro é resolvido por `GET /api/usuarios/:id` para mostrar
 * o nome.
 */
export function SeletorUsuario({
  value,
  onChange,
  situacao = 'ativos',
  lojaId,
  ...props
}: PropsSeletorUsuario) {
  const [busca, setBusca] = useState('');
  const [escolhido, setEscolhido] = useState<UsuarioSelecionado | null>(null);
  const [termo] = useDebouncedValue(busca.trim(), 250);
  const conhecido = escolhido && escolhido.id === value ? escolhido : null;
  const atual = useQuery({
    queryKey: ['usuario', value],
    queryFn: ({ signal }) => apiErp.get<UsuarioDetalhe>(`/usuarios/${value}`, { sinal: signal }),
    enabled: !!value && !conhecido,
    staleTime: 60_000,
  });

  const selecionado: UsuarioSelecionado | null =
    conhecido ?? (atual.data && atual.data.id === value ? resumir(atual.data) : null);

  const pesquisando = termo.length >= MINIMO_BUSCA && (!selecionado || termo !== rotulo(selecionado));

  const sugestoes = useQuery({
    queryKey: ['seletor-usuario', termo, situacao, lojaId ?? null],
    queryFn: ({ signal }) =>
      apiErp.get<Pagina<UsuarioResumo>>(
        `/usuarios${query({ nome: termo, situacao, lojaId, tamanho: 20, ordenar: 'nome:asc' })}`,
        { sinal: signal },
      ),
    enabled: pesquisando,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const opcoes = useMemo(() => {
    const itens: UsuarioSelecionado[] = pesquisando ? (sugestoes.data?.itens ?? []) : [];
    const lista =
      selecionado && !itens.some((u) => u.id === selecionado.id) ? [selecionado, ...itens] : itens;
    return lista.map((u) => ({ value: u.id, label: rotulo(u), usuario: resumir(u) }));
  }, [pesquisando, sugestoes.data, selecionado]);

  const mensagem =
    busca.trim().length < MINIMO_BUSCA
      ? `Digite ao menos ${MINIMO_BUSCA} caracteres`
      : sugestoes.isFetching
        ? 'Pesquisando…'
        : 'Nenhum usuário encontrado';

  return (
    <Select
      searchable
      clearable={!props.required}
      data={opcoes}
      value={value}
      searchValue={busca}
      onSearchChange={setBusca}
      // A busca é no servidor: o filtro local mostraria só o que já veio.
      filter={({ options }) => options}
      onChange={(id) => {
        const u = opcoes.find((o) => o.value === id)?.usuario ?? null;
        setEscolhido(u);
        onChange(id, u);
      }}
      nothingFoundMessage={mensagem}
      rightSection={sugestoes.isFetching || atual.isFetching ? <Loader size={14} /> : undefined}
      placeholder="Nome, login ou código"
      comboboxProps={{ withinPortal: true }}
      {...props}
    />
  );
}
