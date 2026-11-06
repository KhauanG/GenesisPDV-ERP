import type { ProdutoOpcao, TipoProduto } from '@genesis/shared';
import { Loader, Select, type SelectProps } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { buscarProdutos } from '../../api/produtos';
import { MINIMO_BUSCA } from './SeletorUsuario';

export interface PropsSeletorProduto extends Omit<
  SelectProps,
  'data' | 'value' | 'onChange' | 'defaultValue' | 'searchValue'
> {
  value: string | null;
  /** O produto já conhecido (vindo do registro): mostra o nome sem consultar a API. */
  produto?: ProdutoOpcao | null;
  /**
   * `termo`: o que foi digitado (ou lido pelo leitor) antes de escolher — o recebimento (F2-B16) acha por ele a
   * embalagem de compra cujo código foi lido.
   */
  onChange: (produtoId: string | null, produto: ProdutoOpcao | null, termo: string) => void;
  /** Só estes tipos (ex.: componentes do combo, casco). */
  tipos?: readonly TipoProduto[];
  /** Ids que não podem ser escolhidos (o próprio produto, o padrão da posição). */
  excluir?: readonly string[];
}

const rotulo = (p: ProdutoOpcao) => `${p.codigo} - ${p.nome}`;

/**
 * `<SeletorProduto>` (ERP 3.3, 3.4): busca no servidor por nome, código, código interno ou código de barras
 * (`GET /api/produtos/busca`) a partir de 2 caracteres — ou já com o código de barras lido pelo leitor.
 */
export function SeletorProduto({ value, produto, onChange, tipos, excluir, ...props }: PropsSeletorProduto) {
  const [busca, setBusca] = useState('');
  const [escolhido, setEscolhido] = useState<ProdutoOpcao | null>(null);
  const [termo] = useDebouncedValue(busca.trim(), 250);
  // O texto digitado, não o rótulo da opção que o Select põe na busca ao escolher.
  const digitado = useRef('');
  const selecionado =
    (escolhido && escolhido.id === value ? escolhido : null) ??
    (produto && produto.id === value ? produto : null);
  const pesquisando = termo.length >= MINIMO_BUSCA && (!selecionado || termo !== rotulo(selecionado));
  const sugestoes = useQuery({
    queryKey: ['seletor-produto', termo, tipos?.join(',') ?? ''],
    queryFn: ({ signal }) => buscarProdutos(termo, { tipos, sinal: signal }),
    enabled: pesquisando,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const opcoes = useMemo(() => {
    const itens = (pesquisando ? (sugestoes.data ?? []) : []).filter((p) => !excluir?.includes(p.id));
    const lista =
      selecionado && !itens.some((p) => p.id === selecionado.id) ? [selecionado, ...itens] : itens;
    return lista.map((p) => ({ value: p.id, label: rotulo(p), produto: p }));
  }, [pesquisando, sugestoes.data, selecionado, excluir]);
  return (
    <Select
      searchable
      clearable={!props.required}
      data={opcoes}
      value={value}
      searchValue={busca}
      onSearchChange={(t) => {
        setBusca(t);
        if (!opcoes.some((o) => o.label === t)) digitado.current = t.trim();
      }}
      filter={({ options }) => options}
      onChange={(id) => {
        const p = opcoes.find((o) => o.value === id)?.produto ?? null;
        setEscolhido(p);
        onChange(id, p, digitado.current);
      }}
      nothingFoundMessage={
        busca.trim().length < MINIMO_BUSCA
          ? `Digite ao menos ${MINIMO_BUSCA} caracteres`
          : sugestoes.isFetching
            ? 'Pesquisando…'
            : 'Nenhum produto encontrado'
      }
      rightSection={sugestoes.isFetching ? <Loader size={14} /> : undefined}
      placeholder="Nome, código ou código de barras"
      comboboxProps={{ withinPortal: true }}
      {...props}
    />
  );
}
