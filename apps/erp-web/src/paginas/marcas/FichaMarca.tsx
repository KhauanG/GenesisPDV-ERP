import { type FichaMarca } from '@genesis/shared';
import { Alert, Badge, Button, Group, Image, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { useMiniaturaArquivo } from '../../componentes/campos/UploadArquivo';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarDataHora } from '../../util/formato';

/**
 * Ficha da marca (ERP 8.7 "Imprimir"; Fase 2, F2-B44; padrão "Impressão pelo navegador" do plano; README do ERP ›
 * decisão 78): o logotipo, o código e o nome da marca, e os produtos dela (código, nome, EAN, unidade, preço de venda e
 * a situação), pelo nome; nada de custo. Aberta pelo formulário da marca em aba nova com `imprimir=1`, chama a impressão
 * assim que os dados (e o logotipo) chegam; o cabeçalho e o menu do ERP não saem no papel (`estilos.css`).
 */
export function FichaMarcaImpressao() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const ficha = useQuery({
    queryKey: ['marcas', id, 'ficha'],
    queryFn: () => apiErp.get<FichaMarca>(`/marcas/${id}/ficha`),
    enabled: !!id,
  });
  const logo = useMiniaturaArquivo(ficha.data?.marca.logotipoArquivoId ?? null);
  const impresso = useRef(false);
  useEffect(() => {
    if (!ficha.data || logo.carregando || impresso.current || params.get('imprimir') !== '1') return;
    impresso.current = true;
    // jsdom não implementa a impressão; o navegador abre a caixa de diálogo depois de desenhar a tabela.
    if (typeof window.print === 'function') setTimeout(() => window.print(), 300);
  }, [ficha.data, logo.carregando, params]);

  if (ficha.isPending) return <Loader />;
  if (ficha.error) return <Alert color="red">{(ficha.error as Error).message}</Alert>;
  const { marca, produtos, totalProdutos, geradoEm } = ficha.data;
  return (
    <Stack gap="sm" className="ficha-marca">
      <Group justify="space-between" className="nao-imprimir">
        <Text size="sm" c="dimmed">
          Use a impressão do navegador (ou salve em PDF).
        </Text>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </Group>
      <Group gap="md" align="center">
        {logo.url && <Image src={logo.url} alt="Logotipo da marca" h={72} w="auto" fit="contain" />}
        <div>
          <Title order={3}>
            Marca {marca.codigo} – {marca.descricao}
          </Title>
          <Text size="sm">
            {totalProdutos} produto(s){marca.semMarca ? ' · marca genérica' : ''} · gerada em{' '}
            {formatarDataHora(geradoEm)}
          </Text>
        </div>
      </Group>
      {totalProdutos > produtos.length && (
        <Text size="sm" fw={500}>
          Mostrando os {produtos.length} primeiros pelo nome.
        </Text>
      )}
      <Table withTableBorder withColumnBorders verticalSpacing={4} fz="xs" aria-label="Produtos da marca">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Código</Table.Th>
            <Table.Th>Produto</Table.Th>
            <Table.Th>EAN</Table.Th>
            <Table.Th>Un.</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Preço de venda</Table.Th>
            <Table.Th>Situação</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {produtos.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>{p.codigo}</Table.Td>
              <Table.Td>{p.nome}</Table.Td>
              <Table.Td>{p.ean ?? '—'}</Table.Td>
              <Table.Td>{p.unidadeSigla}</Table.Td>
              <Table.Td style={{ textAlign: 'right' }}>
                R$ {formatarDecimal(Number(p.precoVenda), 2)}
              </Table.Td>
              <Table.Td>
                {p.ativo ? (
                  'Ativo'
                ) : (
                  <Badge size="xs" variant="light" color="gray">
                    Inativo
                  </Badge>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
          {!produtos.length && (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text size="sm" c="dimmed">
                  Nenhum produto desta marca.
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
