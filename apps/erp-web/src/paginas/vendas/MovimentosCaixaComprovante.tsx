import {
  formatarCpfCnpj,
  ROTULOS_TIPO_MOVIMENTO_CAIXA,
  VIAS_COMPROVANTE_MOVIMENTO,
  type ComprovanteMovimentoCaixa,
} from '@genesis/shared';
import { Alert, Button, Divider, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { segmento } from '../../api/caminho';
import { apiErp } from '../../api/clientes';
import { formatarData, formatarDataHora } from '../../util/formato';
import { reais } from './comum';

/** O comprovante impresso pelo navegador (aba nova), aberto pelo detalhe do reforço ou da sangria. */
export const urlComprovanteMovimento = (rotaGrupo: string, id: string) =>
  `${rotaGrupo}/${id}/comprovante?imprimir=1`;

function Via({ c, via }: { c: ComprovanteMovimentoCaixa; via: string }) {
  const m = c.movimento;
  const tipo = ROTULOS_TIPO_MOVIMENTO_CAIXA[m.tipo] ?? m.tipo;
  const ehSangria = m.tipo === 'sangria' || m.tipo === 'sangria_fechamento';
  const quemRetira = m.quemRetiraUsuarioNome ?? m.quemRetiraNome;
  const loja = c.loja;
  return (
    <Stack gap={4} className="comprovante-via" data-testid="comprovante-via">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{c.empresa.nomeFantasia || c.empresa.razaoSocial}</Text>
          <Text size="sm">
            Loja {loja.codigo} - {loja.nome}
            {loja.cnpj
              ? ` · CNPJ ${formatarCpfCnpj(loja.cnpj)}`
              : ` · CNPJ ${formatarCpfCnpj(c.empresa.cnpj)}`}
          </Text>
        </div>
        <Text size="xs" c="dimmed">
          {via}
        </Text>
      </Group>
      <Title order={3}>
        Comprovante de {tipo.toLowerCase()} – {reais(m.valor)}
      </Title>
      {/* A loja de treino (O10, D39) fica na empresa real, com o mesmo cabeçalho e CNPJ: o papel tem de dizer que não
          vale, como o CANCELADO, para não servir de prova de dinheiro que nunca saiu do caixa. */}
      {m.lojaTreino && (
        <Text fw={700} c="grape" data-testid="comprovante-treino">
          TREINO – SEM VALOR: movimento da loja de treino, não mexe em dinheiro real.
        </Text>
      )}
      {m.cancelado && (
        <Text fw={700} c="red">
          CANCELADO no caixa em {formatarDataHora(m.canceladoEm)}: {m.motivoCancelamento ?? '—'}
        </Text>
      )}
      <SimpleGrid cols={2} spacing={4} verticalSpacing={2}>
        <Text size="sm">Data/hora: {formatarDataHora(m.ocorridoEm)}</Text>
        <Text size="sm">Dia operacional: {formatarData(m.diaOperacional)}</Text>
        <Text size="sm">
          Caixa: {m.numeroCaixa}
          {m.terminalDescricao ? ` · ${m.terminalDescricao}` : ''}
        </Text>
        <Text size="sm">Operador: {m.operadorNome ?? '—'}</Text>
        {ehSangria && <Text size="sm">Quem retira: {quemRetira ?? '—'}</Text>}
        {m.autorizadoPorNome && <Text size="sm">Autorizado por: {m.autorizadoPorNome}</Text>}
        {m.formaPagamentoDescricao && <Text size="sm">Forma: {m.formaPagamentoDescricao}</Text>}
      </SimpleGrid>
      <Text size="sm">Observação: {m.observacao ?? '—'}</Text>
      <Text size="sm">Inf. adicionais: {m.infAdicionais ?? '—'}</Text>
      <SimpleGrid cols={2} mt="lg" data-testid="comprovante-assinaturas">
        {[
          `Operador: ${m.operadorNome ?? ''}`,
          ehSangria ? `Quem retira: ${quemRetira ?? ''}` : 'Quem entregou o dinheiro',
        ].map((rotulo) => (
          <Stack key={rotulo} gap={2}>
            <Text size="sm" mt="lg">
              ____________________________________
            </Text>
            <Text size="sm">{rotulo}</Text>
          </Stack>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/**
 * "Imprimir comprovante" do reforço, da abertura e da sangria (ERP 15.2 e 15.3; Fase 3, F3-B9; README do ERP ›
 * decisão 89): layout fixo impresso pelo navegador (não há tipo de template para ele), em 2 vias na mesma folha (a do
 * caixa e a de quem retira), cada uma com a empresa e a loja, o movimento e os campos de assinatura do operador e de
 * quem retira (na sangria) ou de quem entregou o dinheiro (no reforço). O cancelado e o da loja de treino ("TREINO –
 * SEM VALOR") saem marcados. Aberto em aba nova com `imprimir=1`, chama a impressão assim que os dados chegam; o
 * cabeçalho e o menu do ERP não saem no papel.
 */
export function ComprovanteMovimentoImpressao() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const doc = useQuery({
    queryKey: ['movimento-caixa', id, 'comprovante'],
    queryFn: () => apiErp.get<ComprovanteMovimentoCaixa>(`/movimentos-caixa/${segmento(id)}/comprovante`),
    enabled: !!id,
  });
  const impresso = useRef(false);
  useEffect(() => {
    if (!doc.data || impresso.current || params.get('imprimir') !== '1') return;
    impresso.current = true;
    // jsdom não implementa a impressão; o navegador abre a caixa de diálogo depois de desenhar o comprovante.
    if (typeof window.print === 'function') setTimeout(() => window.print(), 300);
  }, [doc.data, params]);

  if (doc.isPending) return <Loader />;
  if (doc.error) return <Alert color="red">{(doc.error as Error).message}</Alert>;
  const c = doc.data;
  return (
    <Stack gap="sm" className="comprovante-movimento">
      <Group justify="space-between" className="nao-imprimir">
        <Text size="sm" c="dimmed">
          Use a impressão do navegador (ou salve em PDF). Saem as 2 vias na mesma folha.
        </Text>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </Group>
      {VIAS_COMPROVANTE_MOVIMENTO.map((via, i) => (
        <Fragment key={via}>
          {i > 0 && <Divider variant="dashed" my="md" label="corte aqui" labelPosition="center" />}
          <Via c={c} via={via} />
        </Fragment>
      ))}
      <Text size="xs" c="dimmed">
        Gerado em {formatarDataHora(c.geradoEm)}. Documento interno do caixa, sem valor fiscal.
      </Text>
    </Stack>
  );
}
