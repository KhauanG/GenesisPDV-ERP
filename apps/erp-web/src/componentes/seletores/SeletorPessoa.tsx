import {
  formatarCpfCnpj,
  normalizarCnpj,
  type CategoriaPessoa,
  type Pagina,
  type PessoaOpcao,
  type PessoaResumo,
} from '@genesis/shared';
import { ActionIcon, Group, Loader, Select, Tooltip, type SelectProps } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { CadastroRapidoFornecedor } from '../CadastroRapidoFornecedor';
import { MINIMO_BUSCA } from './SeletorUsuario';

export interface PropsSeletorPessoa extends Omit<
  SelectProps,
  'data' | 'value' | 'onChange' | 'defaultValue' | 'searchValue'
> {
  value: string | null;
  /** A pessoa já conhecida (vinda do registro): mostra o nome sem consultar a API. */
  pessoa?: PessoaOpcao | null;
  onChange: (pessoaId: string | null, pessoa: PessoaOpcao | null) => void;
  /** Só pessoas desta categoria (ex.: fornecedor). */
  categoria?: CategoriaPessoa;
  /** Ids que não podem ser escolhidos. */
  excluir?: readonly string[];
}

const rotulo = (p: PessoaOpcao) =>
  `${p.codigo} - ${p.apelido && p.apelido !== p.nome ? `${p.nome} (${p.apelido})` : p.nome}${p.cpfCnpj ? ` · ${formatarCpfCnpj(p.cpfCnpj)}` : ''}`;
const opcao = (p: PessoaResumo): PessoaOpcao => ({
  id: p.id,
  codigo: p.codigo,
  tipo: p.tipo,
  nome: p.nome,
  apelido: p.apelido,
  cpfCnpj: p.cpfCnpj,
  ativa: p.ativa,
  // A busca (`GET /pessoas`) só lista as não excluídas.
  excluida: false,
});

/** Termo com cara de documento (só dígitos e a pontuação da máscara, 11+ caracteres): busca pelo CPF/CNPJ. */
const ehDocumento = (t: string) => /^[\d./-]+$/.test(t) && normalizarCnpj(t).length >= 11;

/**
 * `<SeletorPessoa categoria>` (ERP 3.4): busca no servidor por nome, apelido, código ou CPF/CNPJ com ou sem máscara
 * (`GET /api/pessoas`, até 20 ativas), a partir de 2 caracteres, filtrada pela categoria. Com a categoria Fornecedor,
 * o "+" abre o cadastro rápido (F2-B13), visível com `pessoas.criar` ou `pessoas.editar` (a API confere o caso).
 */
export function SeletorPessoa({ value, pessoa, onChange, categoria, excluir, ...props }: PropsSeletorPessoa) {
  const pode = usePode();
  const [busca, setBusca] = useState('');
  const [escolhido, setEscolhido] = useState<PessoaOpcao | null>(null);
  const [cadastro, setCadastro] = useState(false);
  const [termo] = useDebouncedValue(busca.trim(), 250);
  const selecionado =
    (escolhido && escolhido.id === value ? escolhido : null) ??
    (pessoa && pessoa.id === value ? pessoa : null);
  const pesquisando = termo.length >= MINIMO_BUSCA && (!selecionado || termo !== rotulo(selecionado));
  const sugestoes = useQuery({
    queryKey: ['seletor-pessoa', termo, categoria ?? ''],
    queryFn: ({ signal }) =>
      apiErp.get<Pagina<PessoaResumo>>(
        `/pessoas${query({
          ...(ehDocumento(termo) ? { cpfCnpj: normalizarCnpj(termo) } : { nome: termo }),
          categorias: categoria,
          tamanho: 20,
          ordenar: 'nome:asc',
        })}`,
        { sinal: signal },
      ),
    enabled: pesquisando && pode('pessoas.ver'),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const opcoes = useMemo(() => {
    const itens = (pesquisando ? (sugestoes.data?.itens ?? []) : [])
      .map(opcao)
      .filter((p) => !excluir?.includes(p.id));
    const lista =
      selecionado && !itens.some((p) => p.id === selecionado.id) ? [selecionado, ...itens] : itens;
    return lista.map((p) => ({ value: p.id, label: rotulo(p), pessoa: p }));
  }, [pesquisando, sugestoes.data, selecionado, excluir]);
  const escolher = (p: PessoaOpcao | null) => {
    setEscolhido(p);
    setBusca('');
    onChange(p?.id ?? null, p);
  };
  // O "+" do fornecedor: o cadastro rápido aceita `pessoas.criar_fornecedor` (o Estoquista), `pessoas.criar` ou, para
  // quem já existe, `pessoas.editar` (README da API › decisão 165).
  const rapido =
    categoria === 'fornecedor' &&
    (pode('pessoas.criar_fornecedor') || pode('pessoas.criar') || pode('pessoas.editar'));
  return (
    <>
      <Group align="flex-end" gap={4} wrap="nowrap" style={props.style}>
        <Select
          searchable
          clearable={!props.required}
          data={opcoes}
          value={value}
          searchValue={busca}
          onSearchChange={setBusca}
          filter={({ options }) => options}
          onChange={(id) => escolher(opcoes.find((o) => o.value === id)?.pessoa ?? null)}
          nothingFoundMessage={
            !pode('pessoas.ver')
              ? 'Sem permissão para consultar pessoas'
              : busca.trim().length < MINIMO_BUSCA
                ? `Digite ao menos ${MINIMO_BUSCA} caracteres`
                : sugestoes.isFetching
                  ? 'Pesquisando…'
                  : 'Nenhuma pessoa encontrada'
          }
          rightSection={sugestoes.isFetching ? <Loader size={14} /> : undefined}
          placeholder="Nome, código ou CPF/CNPJ"
          comboboxProps={{ withinPortal: true }}
          {...props}
          style={{ flex: 1 }}
        />
        {rapido && (
          <Tooltip label="Cadastro rápido de fornecedor">
            <ActionIcon
              variant="default"
              size="lg"
              mb={props.error ? 22 : 0}
              aria-label="Cadastro rápido de fornecedor"
              onClick={() => setCadastro(true)}
            >
              <IconPlus size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {/* Montado só aberto: cada abertura começa limpa, com o documento digitado na busca. */}
      {rapido && cadastro && (
        <CadastroRapidoFornecedor
          aberto
          aoFechar={() => setCadastro(false)}
          aoSalvar={escolher}
          documentoInicial={ehDocumento(busca.trim()) ? busca.trim() : ''}
        />
      )}
    </>
  );
}
