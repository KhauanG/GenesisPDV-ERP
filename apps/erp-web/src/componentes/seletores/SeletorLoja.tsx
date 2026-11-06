import { Select, type SelectProps } from '@mantine/core';
import { useMemo } from 'react';
import { useEu } from '../../auth/sessao';

const TODAS = '__todas__';

export interface PropsSeletorLoja extends Omit<SelectProps, 'data' | 'value' | 'onChange' | 'defaultValue'> {
  /** `null` = nenhuma (ou "Todas", quando `permitirTodas`). */
  value: string | null;
  onChange: (lojaId: string | null) => void;
  /** Mostra a opção "Todas as lojas" (valor `null`), onde a tela permitir (ERP 3.4). */
  permitirTodas?: boolean;
  rotuloTodas?: string;
}

/**
 * `<SeletorLoja>` (ERP 3.4): só as lojas permitidas ao usuário (`/auth/eu`) e ativas. Uma loja inativa já gravada no
 * registro continua aparecendo selecionada (marcada "inativa") para o campo não ficar em branco.
 */
export function SeletorLoja({
  value,
  onChange,
  permitirTodas = false,
  rotuloTodas = 'Todas as lojas',
  ...props
}: PropsSeletorLoja) {
  const eu = useEu();
  const opcoes = useMemo(() => {
    const lojas = eu.lojas
      .filter((l) => l.ativa || l.id === value)
      .map((l) => ({
        value: l.id,
        label: `${l.codigo} - ${l.nome}${l.treino ? ' (treino)' : ''}${l.ativa ? '' : ' (inativa)'}`,
        disabled: !l.ativa,
      }));
    return permitirTodas ? [{ value: TODAS, label: rotuloTodas }, ...lojas] : lojas;
  }, [eu.lojas, value, permitirTodas, rotuloTodas]);
  const atual = value ?? (permitirTodas ? TODAS : null);
  return (
    <Select
      data={opcoes}
      value={atual}
      onChange={(v) => onChange(!v || v === TODAS ? null : v)}
      allowDeselect={false}
      clearable={!permitirTodas && !props.required}
      searchable={opcoes.length > 8}
      nothingFoundMessage="Nenhuma loja encontrada"
      placeholder={eu.lojas.length === 0 ? 'Nenhuma loja cadastrada' : 'Selecione a loja'}
      comboboxProps={{ withinPortal: true }}
      {...props}
    />
  );
}
