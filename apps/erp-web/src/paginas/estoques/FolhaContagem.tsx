import {
  ORDENS_FOLHA_CONTAGEM,
  ROTULOS_ORDEM_FOLHA_CONTAGEM,
  type FolhaContagem,
  type OrdemFolhaContagem,
} from '@genesis/shared';
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useCategorias, useMarcas } from '../../api/produtos';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarDataHora } from '../../util/formato';

export const ROTA_FOLHA_CONTAGEM = '/estoque/folha-contagem';

/** Os filtros da folha que vão na URL (a tela do acerto abre a folha numa aba nova, já com eles). */
export interface ParametrosFolhaContagem {
  estoqueId: string;
  tipoEstoqueId?: string;
  cega: boolean;
  ordem: OrdemFolhaContagem;
  marcaId?: string;
  categoriaId?: string;
}

export function urlFolhaContagem(p: ParametrosFolhaContagem): string {
  return `${ROTA_FOLHA_CONTAGEM}${query({
    estoqueId: p.estoqueId,
    tipoEstoqueId: p.tipoEstoqueId || undefined,
    cega: String(p.cega),
    ordem: p.ordem,
    marcaId: p.marcaId || undefined,
    categoriaId: p.categoriaId || undefined,
    imprimir: '1',
  })}`;
}

/**
 * Folha de contagem (Fase 2, F2-B9; ERP 13.5 "Imprimir"): a lista dos produtos com estoque próprio do estoque × tipo,
 * impressa pelo navegador, com a coluna "Contado" em branco para o conferente. A folha cega (padrão) não traz o saldo;
 * a ordem por localização (a vazia por último) segue a prateleira. Aberta pela tela do acerto em aba nova com
 * `imprimir=1`, chama a impressão assim que os dados chegam; o cabeçalho e o menu não saem no papel (`estilos.css`).
 */
export function FolhaContagemImpressao() {
  const [params] = useSearchParams();
  const filtros = Object.fromEntries(
    ['estoqueId', 'tipoEstoqueId', 'cega', 'ordem', 'marcaId', 'categoriaId'].flatMap((k) => {
      const v = params.get(k);
      return v ? [[k, v]] : [];
    }),
  );
  const folha = useQuery({
    queryKey: ['folha-contagem', filtros],
    queryFn: () => apiErp.get<FolhaContagem>(`/acertos/folha-contagem${query(filtros)}`),
    enabled: !!filtros.estoqueId,
    staleTime: Infinity,
  });
  const impresso = useRef(false);
  useEffect(() => {
    if (!folha.data || impresso.current || params.get('imprimir') !== '1') return;
    impresso.current = true;
    // jsdom não implementa a impressão; o navegador abre a caixa de diálogo depois de desenhar a tabela.
    if (typeof window.print === 'function') setTimeout(() => window.print(), 300);
  }, [folha.data, params]);

  if (!filtros.estoqueId)
    return <Alert color="yellow">Escolha o estoque no acerto para gerar a folha.</Alert>;
  if (folha.isPending) return <Loader />;
  if (folha.error) return <Alert color="red">{(folha.error as Error).message}</Alert>;
  const f = folha.data;
  const filtrosTexto = [
    `Ordem: ${ROTULOS_ORDEM_FOLHA_CONTAGEM[f.ordem]}`,
    f.marca && `Marca: ${f.marca}`,
    f.categoria && `Categoria: ${f.categoria}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Stack gap="sm" className="folha-contagem">
      <Group justify="space-between" className="nao-imprimir">
        <Text size="sm" c="dimmed">
          {f.linhas.length.toLocaleString('pt-BR')} produto(s). Use a impressão do navegador (ou salve em
          PDF).
        </Text>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </Group>
      <div>
        <Title order={3}>
          Folha de contagem{f.cega ? ' (cega)' : ''} – {f.estoqueNome} · {f.tipoEstoqueNome}
        </Title>
        <Text size="sm">
          {filtrosTexto} · Gerada em {formatarDataHora(f.geradaEm)}
        </Text>
        <Text size="sm" mt={4}>
          Contado por: ______________________________ Data/hora da contagem: ____/____/______ ____:____
        </Text>
      </div>
      <Table withTableBorder withColumnBorders striped={false} verticalSpacing={6} fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 70 }}>Nº</Table.Th>
            <Table.Th style={{ width: 150 }}>Código</Table.Th>
            <Table.Th>Produto</Table.Th>
            <Table.Th style={{ width: 50 }}>Un.</Table.Th>
            <Table.Th style={{ width: 100 }}>Localização</Table.Th>
            {!f.cega && (
              <Table.Th style={{ width: 90, textAlign: 'right' }} data-testid="coluna-saldo">
                Saldo
              </Table.Th>
            )}
            <Table.Th style={{ width: 120 }}>Contado</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {f.linhas.map((l) => (
            <Table.Tr key={l.produtoId}>
              <Table.Td>{l.codigo}</Table.Td>
              <Table.Td>{l.codigoBarras ?? l.codigoInterno ?? ''}</Table.Td>
              <Table.Td>
                {l.nome}
                {l.marca && (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    · {l.marca}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{l.unidadeSigla}</Table.Td>
              <Table.Td>{l.localizacao ?? ''}</Table.Td>
              {!f.cega && (
                <Table.Td style={{ textAlign: 'right' }}>{formatarDecimal(Number(l.saldo ?? 0), 3)}</Table.Td>
              )}
              <Table.Td />
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * "Imprimir" do acerto (ERP 13.5): escolhe a folha (cega ou com saldo, a ordem e os filtros de marca e categoria) do
 * estoque × tipo do formulário e abre a folha numa aba nova, que chama a impressão do navegador.
 */
export function ModalFolhaContagem({
  aberto,
  aoFechar,
  estoqueId,
  tipoEstoqueId,
}: {
  aberto: boolean;
  aoFechar: () => void;
  estoqueId: string;
  tipoEstoqueId: string;
}) {
  const marcas = useMarcas();
  const categorias = useCategorias();
  const [cega, setCega] = useState(true);
  const [ordem, setOrdem] = useState<OrdemFolhaContagem>('localizacao');
  const [marcaId, setMarcaId] = useState<string | null>(null);
  const [categoriaId, setCategoriaId] = useState<string | null>(null);
  const abrir = () => {
    window.open(
      urlFolhaContagem({
        estoqueId,
        tipoEstoqueId,
        cega,
        ordem,
        marcaId: marcaId ?? undefined,
        categoriaId: categoriaId ?? undefined,
      }),
      '_blank',
    );
    aoFechar();
  };
  return (
    <Modal opened={aberto} onClose={aoFechar} title="Folha de contagem">
      <Stack>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Saldo
          </Text>
          <SegmentedControl
            aria-label="Saldo na folha"
            fullWidth
            data={[
              { value: 'cega', label: 'Cega (sem saldo)' },
              { value: 'saldo', label: 'Com o saldo' },
            ]}
            value={cega ? 'cega' : 'saldo'}
            onChange={(v) => setCega(v === 'cega')}
          />
        </div>
        <Select
          label="Ordem"
          allowDeselect={false}
          data={ORDENS_FOLHA_CONTAGEM.map((o) => ({ value: o, label: ROTULOS_ORDEM_FOLHA_CONTAGEM[o] }))}
          value={ordem}
          onChange={(v) => setOrdem((v as OrdemFolhaContagem | null) ?? 'localizacao')}
        />
        <Select
          label="Marca"
          placeholder="Todas"
          clearable
          searchable
          data={(marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao }))}
          value={marcaId}
          onChange={setMarcaId}
        />
        <Select
          label="Categoria"
          description="Inclui as subcategorias"
          placeholder="Todas"
          clearable
          searchable
          data={(categorias.data ?? [])
            .map((c) => ({ value: c.id, label: c.caminhoNomes }))
            .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))}
          value={categoriaId}
          onChange={setCategoriaId}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={aoFechar}>
            Cancelar
          </Button>
          <Button leftSection={<IconPrinter size={16} />} disabled={!estoqueId} onClick={abrir}>
            Abrir para imprimir
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
