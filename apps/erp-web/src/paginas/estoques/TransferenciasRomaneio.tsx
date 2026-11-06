import {
  dec,
  formatarCpfCnpj,
  ROTULOS_STATUS_TRANSFERENCIA,
  type PontaRomaneioTransferencia,
  type RomaneioTransferencia,
} from '@genesis/shared';
import { Alert, Button, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarData, formatarDataHora } from '../../util/formato';
import { quantidadeNaEmbalagem, rotuloEmbalagem } from './transferenciaItens';

const qtd = (v: string) => formatarDecimal(Number(v), 3);

function Ponta({ titulo, p }: { titulo: string; p: PontaRomaneioTransferencia }) {
  return (
    <div data-testid={`romaneio-${titulo.toLowerCase()}`}>
      <Text size="sm" fw={700}>
        {titulo}: {p.estoqueCodigo} - {p.estoqueNome}
      </Text>
      {p.lojaNome && (
        <Text size="sm">
          Loja: {p.lojaNome}
          {p.lojaRazaoSocial && p.lojaRazaoSocial !== p.lojaNome ? ` (${p.lojaRazaoSocial})` : ''}
          {p.lojaCnpj ? ` · CNPJ ${formatarCpfCnpj(p.lojaCnpj)}` : ''}
        </Text>
      )}
      <Text size="sm">Endereço: {p.endereco ?? '—'}</Text>
    </div>
  );
}

/**
 * Romaneio da transferência (ERP 13.7 "Imprime romaneio"; Fase 2, F2-B27; padrão "Impressão pelo navegador" do plano;
 * README do ERP › decisão 64): o papel que acompanha a carga — o cabeçalho da empresa, a origem e o destino com a loja
 * e o endereço, os itens com o lote e a quantidade na embalagem de compra ("5 FD + 3 UN"), uma coluna "Conferido" em
 * branco para quem recebe (ou a recebida, depois do recebimento) e os campos de assinatura de quem expediu, de quem
 * transportou e de quem recebeu. Aberto pela tela da transferência em aba nova com `imprimir=1`, chama a impressão
 * assim que os dados chegam; o cabeçalho e o menu do ERP não saem no papel (`estilos.css`).
 */
export function RomaneioTransferenciaImpressao() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const doc = useQuery({
    queryKey: ['transferencias', id, 'romaneio'],
    queryFn: () => apiErp.get<RomaneioTransferencia>(`/transferencias/${id}/romaneio`),
    enabled: !!id,
  });
  const impresso = useRef(false);
  useEffect(() => {
    if (!doc.data || impresso.current || params.get('imprimir') !== '1') return;
    impresso.current = true;
    // jsdom não implementa a impressão; o navegador abre a caixa de diálogo depois de desenhar a tabela.
    if (typeof window.print === 'function') setTimeout(() => window.print(), 300);
  }, [doc.data, params]);

  if (doc.isPending) return <Loader />;
  if (doc.error) return <Alert color="red">{(doc.error as Error).message}</Alert>;
  const { empresa, origem, destino, transferencia: t, geradoEm } = doc.data;
  const recebida = t.recebidaEm !== null;
  const total = t.itens.reduce((s, i) => s.plus(i.quantidadeEnviada), dec(0));
  return (
    <Stack gap="sm" className="romaneio-transferencia">
      <Group justify="space-between" className="nao-imprimir">
        <Text size="sm" c="dimmed">
          Use a impressão do navegador (ou salve em PDF).
        </Text>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </Group>
      <div data-testid="romaneio-empresa">
        <Text fw={700}>{empresa.nomeFantasia || empresa.razaoSocial}</Text>
        <Text size="sm">
          {empresa.razaoSocial} · CNPJ {formatarCpfCnpj(empresa.cnpj)}
          {empresa.ie ? ` · IE ${empresa.ie}` : ''}
        </Text>
        {(empresa.endereco || empresa.telefone) && (
          <Text size="sm">
            {[empresa.endereco, empresa.telefone && `Tel. ${empresa.telefone}`].filter(Boolean).join(' · ')}
          </Text>
        )}
      </div>
      <div>
        <Title order={3}>
          Romaneio de transferência Nº {t.codigo} – {ROTULOS_STATUS_TRANSFERENCIA[t.status]}
        </Title>
        <Text size="sm">
          Data: {formatarData(t.data)} · Tipo de estoque: {t.tipoEstoqueNome} · Motivo: {t.motivo}
        </Text>
        {t.enviadaEm && (
          <Text size="sm">
            Enviada em {formatarDataHora(t.enviadaEm)} por {t.enviadaPorNome ?? '—'}
            {t.recebidaEm &&
              ` · recebida em ${formatarDataHora(t.recebidaEm)} por ${t.recebidaPorNome ?? '—'}`}
          </Text>
        )}
        {(t.nfeExternaChave || t.nfeExternaNumero) && (
          <Text size="sm">NF-e de transferência: {t.nfeExternaChave ?? t.nfeExternaNumero}</Text>
        )}
        {t.status === 'rascunho' && (
          <Text size="sm" fw={500}>
            Rascunho: a mercadoria ainda não saiu do estoque de origem.
          </Text>
        )}
        {t.status === 'cancelada' && (
          <Text size="sm" fw={500}>
            Cancelada em {formatarDataHora(t.canceladaEm)}: {t.motivoCancelamento}
          </Text>
        )}
      </div>
      <SimpleGrid cols={2}>
        <Ponta titulo="Origem" p={origem} />
        <Ponta titulo="Destino" p={destino} />
      </SimpleGrid>
      <Table withTableBorder withColumnBorders verticalSpacing={4} fz="xs" aria-label="Itens do romaneio">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Código</Table.Th>
            <Table.Th>Produto</Table.Th>
            <Table.Th>Lote / validade</Table.Th>
            <Table.Th>Embalagem</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Na embalagem</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Quantidade</Table.Th>
            <Table.Th style={{ textAlign: 'right', minWidth: 90 }}>
              {recebida ? 'Recebida' : 'Conferido'}
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {t.itens.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>{i.sequencia}</Table.Td>
              <Table.Td>{i.produto.codigo}</Table.Td>
              <Table.Td>{i.produto.nome}</Table.Td>
              <Table.Td>
                {[i.lote, i.validade && `val. ${formatarData(i.validade)}`].filter(Boolean).join(' · ') ||
                  (t.status === 'rascunho' ? 'FEFO' : '—')}
              </Table.Td>
              <Table.Td>{rotuloEmbalagem(i.embalagem, i.produto.unidadeSigla)}</Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {quantidadeNaEmbalagem(i.quantidadeEnviada, i.embalagem, i.produto.unidadeSigla)}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {qtd(i.quantidadeEnviada)} {i.produto.unidadeSigla}
              </Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                {recebida && i.quantidadeRecebida !== null ? qtd(i.quantidadeRecebida) : ''}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="flex-end" gap="xl" data-testid="totais-romaneio">
        <Text size="sm">Itens: {t.qtdItens}</Text>
        <Text size="sm">Quantidade total: {qtd(total.toFixed(3))}</Text>
      </Group>
      {t.observacoes && <Text size="sm">Observações: {t.observacoes}</Text>}
      <SimpleGrid cols={3} mt="xl" data-testid="romaneio-assinaturas">
        {['Expedido por', 'Transportado por', 'Recebido e conferido por'].map((rotulo) => (
          <Stack key={rotulo} gap={2}>
            <Text size="sm" mt="xl">
              ____________________________________
            </Text>
            <Text size="sm">{rotulo}</Text>
            <Text size="xs">Nome legível, assinatura e data ____/____/______</Text>
          </Stack>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="md">
        Gerado em {formatarDataHora(geradoEm)}. Documento interno de conferência: não substitui a NF-e de
        transferência quando ela for exigida.
      </Text>
    </Stack>
  );
}
