/**
 * Histórico de preços do produto (Fase 2, F2-B37; MD 3.6.10; ERP 8.2 "Alteração de preço"; README do ERP › decisão
 * 71): o modal aberto pelo botão "Histórico de preços" do formulário, com os filtros tipo, loja e período, a página
 * com o total e, por linha, a data, o tipo (com a loja, a variação e a faixa), o anterior, o novo, a variação em %, a
 * origem com o documento (o recebimento ou a NF-e, com o link para quem pode ver) e o usuário. O corte do custo e das
 * lojas é da API (`GET /produtos/:id/historico-precos`): a tela só esconde a opção "Custo" do filtro de quem não vê o
 * custo e lista nas lojas só as permitidas (as do `/eu`).
 */
import {
  LOJA_HISTORICO_GERAL,
  ROTULOS_ORIGEM_HISTORICO_PRECO,
  ROTULOS_TIPO_PRECO_HISTORICO,
  TIPOS_PRECO_HISTORICO,
  TIPOS_PRECO_HISTORICO_CUSTO,
  type HistoricoPrecoProduto,
  type Pagina,
} from '@genesis/shared';
import { Alert, Anchor, Group, Modal, Pagination, Select, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { CampoData } from '../../componentes/campos/CamposData';
import { formatarDataHora } from '../../util/formato';
import { ROTA_NOTAS_ENTRADA } from '../estoques/NotasEntradaEnvio';
import { ROTA_RECEBIMENTOS } from '../estoques/Recebimentos';
import { decimalParaTela } from './valores';

const TAMANHO = 20;

interface Filtro {
  tipo: string;
  loja: string;
  dataInicial: string;
  dataFinal: string;
  pagina: number;
}

const FILTRO_VAZIO: Filtro = { tipo: '', loja: '', dataInicial: '', dataFinal: '', pagina: 1 };

const PRECO = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CUSTO = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** O valor na tela: o custo com até 4 casas (o custo composto do recebimento), os preços com 2; vazio = "—". */
function valor(h: HistoricoPrecoProduto, v: string | null): string {
  if (v === null) return '—';
  return (TIPOS_PRECO_HISTORICO_CUSTO.includes(h.tipoPreco) ? CUSTO : PRECO).format(Number(v));
}

/** A variação em % do anterior para o novo; vazia quando um dos dois falta ou o anterior é zero. */
export function variacaoPct(anterior: string | null, novo: string | null): string {
  if (anterior === null || novo === null) return '';
  const a = Number(anterior);
  const n = Number(novo);
  if (!Number.isFinite(a) || !Number.isFinite(n) || a === 0) return '';
  const pct = ((n - a) / a) * 100;
  return `${pct > 0 ? '+' : ''}${decimalParaTela(String(pct), 2)}%`;
}

/** O tipo com o que ele afeta: a loja, a variação e o intervalo da faixa ("6 a 11", "12 ou mais"). */
function descricaoTipo(h: HistoricoPrecoProduto): string {
  const partes: string[] = [ROTULOS_TIPO_PRECO_HISTORICO[h.tipoPreco]];
  if (h.tipoPreco === 'quantidade' && h.quantidadeInicial !== null) {
    const ini = decimalParaTela(h.quantidadeInicial, 3);
    partes.push(
      h.quantidadeFinal === null ? `${ini} ou mais` : `${ini} a ${decimalParaTela(h.quantidadeFinal, 3)}`,
    );
  }
  if (h.variacaoNome) partes.push(h.variacaoNome);
  if (h.lojaNome) partes.push(h.lojaNome);
  else if (h.tipoPreco === 'quantidade') partes.push('todas as lojas');
  return partes.join(' · ');
}

function Origem({ h }: { h: HistoricoPrecoProduto }) {
  const pode = usePode();
  const rotulo = ROTULOS_ORIGEM_HISTORICO_PRECO[h.origem];
  if (!h.documento) return <>{rotulo}</>;
  const rota =
    h.origem === 'recebimento' && pode('recebimentos.ver')
      ? `${ROTA_RECEBIMENTOS}/${h.documento.id}`
      : h.origem === 'nota_entrada' && pode('notas_entrada.ver')
        ? `${ROTA_NOTAS_ENTRADA}/${h.documento.id}`
        : null;
  const texto = `${rotulo} nº ${h.documento.numero}`;
  return rota ? (
    <Anchor component={Link} to={rota} size="sm">
      {texto}
    </Anchor>
  ) : (
    <>{texto}</>
  );
}

/** Modal "Histórico de preços" do produto. */
export function ModalHistoricoPrecos({
  produtoId,
  aberto,
  aoFechar,
}: {
  produtoId: string;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const pode = usePode();
  const eu = useEu();
  const [filtro, setFiltro] = useState<Filtro>(FILTRO_VAZIO);
  const mudar = (parcial: Partial<Filtro>) => setFiltro((f) => ({ ...f, ...parcial, pagina: 1 }));
  const tipos = TIPOS_PRECO_HISTORICO.filter(
    (t) => pode('produtos.ver_custo') || !TIPOS_PRECO_HISTORICO_CUSTO.includes(t),
  );
  const r = useQuery({
    queryKey: ['produtos', produtoId, 'historico-precos', filtro],
    queryFn: () => {
      const q = new URLSearchParams({ pagina: String(filtro.pagina), tamanho: String(TAMANHO) });
      for (const c of ['tipo', 'loja', 'dataInicial', 'dataFinal'] as const)
        if (filtro[c]) q.set(c, filtro[c]);
      return apiErp.get<Pagina<HistoricoPrecoProduto>>(`/produtos/${produtoId}/historico-precos?${q}`);
    },
    enabled: aberto,
    placeholderData: keepPreviousData,
  });
  const paginas = r.data ? Math.max(1, Math.ceil(r.data.total / TAMANHO)) : 1;
  return (
    <Modal opened={aberto} onClose={aoFechar} title="Histórico de preços" size="xl">
      <Stack gap="sm">
        <Group grow align="flex-end">
          <Select
            label="Tipo"
            placeholder="Todos"
            clearable
            data={tipos.map((t) => ({ value: t, label: ROTULOS_TIPO_PRECO_HISTORICO[t] }))}
            value={filtro.tipo || null}
            onChange={(v) => mudar({ tipo: v ?? '' })}
          />
          <Select
            label="Loja"
            placeholder="Todas"
            clearable
            data={[
              { value: LOJA_HISTORICO_GERAL, label: 'Geral (sem loja)' },
              ...eu.lojas.map((l) => ({ value: l.id, label: l.nome })),
            ]}
            value={filtro.loja || null}
            onChange={(v) => mudar({ loja: v ?? '' })}
          />
          <CampoData label="De" value={filtro.dataInicial} onChange={(v) => mudar({ dataInicial: v })} />
          <CampoData label="Até" value={filtro.dataFinal} onChange={(v) => mudar({ dataFinal: v })} />
        </Group>
        {r.isError ? (
          <Alert color="red">{(r.error as Error).message}</Alert>
        ) : r.isPending ? (
          <Text size="sm">Carregando…</Text>
        ) : !r.data.itens.length ? (
          <Text size="sm" c="dimmed">
            Nenhuma alteração de preço
            {filtro.tipo || filtro.loja || filtro.dataInicial || filtro.dataFinal ? ' com estes filtros' : ''}
            .
          </Text>
        ) : (
          <Table striped data-testid="historico-precos">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Data</Table.Th>
                <Table.Th>Preço</Table.Th>
                <Table.Th ta="right">Anterior</Table.Th>
                <Table.Th ta="right">Novo</Table.Th>
                <Table.Th ta="right">Variação</Table.Th>
                <Table.Th>Origem</Table.Th>
                <Table.Th>Usuário</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.data.itens.map((h) => (
                <Table.Tr key={h.id}>
                  <Table.Td>{formatarDataHora(h.criadoEm)}</Table.Td>
                  <Table.Td>{descricaoTipo(h)}</Table.Td>
                  <Table.Td ta="right">{valor(h, h.valorAnterior)}</Table.Td>
                  <Table.Td ta="right">{valor(h, h.valorNovo)}</Table.Td>
                  <Table.Td ta="right">{variacaoPct(h.valorAnterior, h.valorNovo)}</Table.Td>
                  <Table.Td>
                    <Origem h={h} />
                  </Table.Td>
                  <Table.Td>{h.usuarioNome ?? '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {r.data && (
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {r.data.total} alteração(ões)
            </Text>
            {paginas > 1 && (
              <Pagination
                size="sm"
                total={paginas}
                value={filtro.pagina}
                onChange={(pagina) => setFiltro((f) => ({ ...f, pagina }))}
              />
            )}
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
