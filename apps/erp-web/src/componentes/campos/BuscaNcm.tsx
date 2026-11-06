import type { NcmOpcao } from '@genesis/shared';
import { Loader, Select, type SelectProps } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { buscarNcms } from '../../api/produtos';

export interface PropsBuscaNcm extends Omit<SelectProps, 'data' | 'value' | 'onChange' | 'searchValue'> {
  value: string | null;
  onChange: (codigo: string | null) => void;
}

const mascara = (c: string) => (c.length === 8 ? `${c.slice(0, 4)}.${c.slice(4, 6)}.${c.slice(6)}` : c);

/**
 * `<BuscaNcm>` (ERP 8.2.16): pesquisa por código (prefixo, com ou sem pontos) ou descrição na tabela vigente de
 * `ncms`; Enter seleciona. O código gravado é o de 8 dígitos.
 */
export function BuscaNcm({ value, onChange, ...props }: PropsBuscaNcm) {
  const [busca, setBusca] = useState('');
  const [termo] = useDebouncedValue(busca.replace(/^(\d{4})\.(\d{2})\.(\d{2}).*$/, '$1$2$3').trim(), 250);
  const pesquisando = termo.length >= 2 && termo !== value && !termo.startsWith(mascara(value ?? '-'));
  const r = useQuery({
    queryKey: ['ncms', termo],
    queryFn: ({ signal }) => buscarNcms(termo, signal),
    enabled: pesquisando,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const opcoes = useMemo(() => {
    const lista: NcmOpcao[] = pesquisando ? (r.data ?? []) : [];
    const comAtual =
      value && !lista.some((n) => n.codigo === value)
        ? [{ codigo: value, descricao: '', vigenciaInicio: null, vigenciaFim: null }, ...lista]
        : lista;
    return comAtual.map((n) => ({
      value: n.codigo,
      label: n.descricao ? `${mascara(n.codigo)} – ${n.descricao.slice(0, 90)}` : mascara(n.codigo),
    }));
  }, [pesquisando, r.data, value]);
  return (
    <Select
      searchable
      clearable
      data={opcoes}
      value={value}
      searchValue={busca}
      onSearchChange={setBusca}
      filter={({ options }) => options}
      onChange={(c) => onChange(c)}
      nothingFoundMessage={
        termo.length < 2 ? 'Digite o código ou parte da descrição' : 'Nenhum NCM encontrado'
      }
      rightSection={r.isFetching ? <Loader size={14} /> : undefined}
      placeholder="Código ou descrição"
      comboboxProps={{ withinPortal: true }}
      {...props}
    />
  );
}
