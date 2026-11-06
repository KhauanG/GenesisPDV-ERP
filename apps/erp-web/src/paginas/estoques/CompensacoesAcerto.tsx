import {
  ROTULOS_MOTIVO_RELOGIO_COMPENSACAO,
  duracaoLegivel,
  type AcertoDetalhe,
  type CompensacaoAcerto,
} from '@genesis/shared';
import { Alert, Anchor, Badge, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { Link } from 'react-router';
import { ROTA_TERMINAIS } from '../../api/terminais';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { formatarDataHora } from '../../util/formato';
import { ROTA_VENDAS } from '../vendas/Vendas';
import { ROTA_ACERTOS } from './Acertos';

const qtd = (v: string) => formatarDecimal(Number(v), 3);

/**
 * Aba "Compensações" do acerto efetivado ou estornado (F2-B10; ERP 13.1.5 regra 4; SYNC 15.3; README da API ›
 * decisão 155): cada movimento anterior à hora da contagem que chegou depois e foi anulado por este "Definir" (a venda
 * offline, o acerto lançado antes), e cada movimento deste acerto anulado por outro "Definir". Destaca a linha (e a aba,
 * pelo `comAviso`) quando o relógio do caixa no evento é suspeito: é a hora do fato que decide se a venda entrou na
 * contagem.
 */
export function AbaCompensacoes({ acerto, verCusto }: { acerto: AcertoDetalhe; verCusto: boolean }) {
  const lancadas = acerto.compensacoes.filter((c) => c.sentido === 'lancada');
  const recebidas = acerto.compensacoes.filter((c) => c.sentido === 'recebida');
  const suspeitas = acerto.compensacoes.filter((c) => c.relogioSuspeito).length;
  if (!acerto.totalCompensacoes) {
    return (
      <Text size="sm" c="dimmed" data-testid="sem-compensacoes">
        Nenhuma compensação. Quando uma venda do PDV (ou outro movimento) anterior à hora da contagem chega
        depois da efetivação de um &quot;Definir&quot;, ela é anulada na data do fato para a contagem
        continuar valendo, e aparece aqui (ERP 13.1.5).
      </Text>
    );
  }
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        A compensação anula, na data do fato, o movimento anterior à hora da contagem que só foi lançado
        depois da efetivação: a contagem já o tinha visto. O estorno do acerto desfaz a compensação, e o
        movimento volta a valer, a menos que outro &quot;Definir&quot; efetivado também o tenha contado: aí
        ele é compensado de novo contra esse outro acerto (a situação da linha mostra qual).
      </Text>
      {suspeitas > 0 && (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} data-testid="alerta-relogio-suspeito">
          {suspeitas} compensação(ões) com o relógio do caixa suspeito: a hora do fato é a que o caixa
          registrou (corrigida pelo desvio que ele mede com a nuvem, quando tem uma medida confiável), e é ela
          que decide se a venda foi contada. Confira com a loja e acerte o relógio do computador (Cadastros ›
          PDVs).
        </Alert>
      )}
      {acerto.totalCompensacoes > acerto.compensacoes.length && (
        <Alert color="blue" icon={<IconInfoCircle size={18} />}>
          Mostrando as primeiras {acerto.compensacoes.length.toLocaleString('pt-BR')} de{' '}
          {acerto.totalCompensacoes.toLocaleString('pt-BR')} compensações, pela hora do fato.
        </Alert>
      )}
      {lancadas.length > 0 && (
        <TabelaCompensacoes
          titulo="Movimentos anulados por este acerto"
          compensacoes={lancadas}
          verCusto={verCusto}
        />
      )}
      {recebidas.length > 0 && (
        <TabelaCompensacoes
          titulo={'Movimentos deste acerto anulados por outro "Definir" de contagem posterior'}
          compensacoes={recebidas}
          verCusto={verCusto}
          comAcerto
        />
      )}
    </Stack>
  );
}

function TabelaCompensacoes({
  titulo,
  compensacoes,
  verCusto,
  comAcerto,
}: {
  titulo: string;
  compensacoes: CompensacaoAcerto[];
  verCusto: boolean;
  /** Mostra o "Definir" que anulou (nas recebidas). */
  comAcerto?: boolean;
}) {
  const pode = usePode();
  return (
    <Stack gap="xs">
      <Title order={5}>{titulo}</Title>
      <Table.ScrollContainer minWidth={1000}>
        <Table striped highlightOnHover verticalSpacing={4} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Hora do fato</Table.Th>
              <Table.Th>Produto</Table.Th>
              <Table.Th ta="right">Compensado</Table.Th>
              {verCusto && <Table.Th ta="right">Custo</Table.Th>}
              <Table.Th>Movimento compensado</Table.Th>
              <Table.Th>Terminal</Table.Th>
              <Table.Th>Recebido em</Table.Th>
              <Table.Th>Relógio</Table.Th>
              {comAcerto && <Table.Th>Anulado por</Table.Th>}
              <Table.Th>Situação</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {compensacoes.map((c) => (
              <Table.Tr
                key={c.id}
                data-testid={`compensacao-${c.id}`}
                data-suspeito={c.relogioSuspeito || undefined}
                bg={c.relogioSuspeito ? 'var(--mantine-color-orange-light)' : undefined}
              >
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatarDataHora(c.dataFato)}</Table.Td>
                <Table.Td>
                  {c.produtoCodigo} · {c.produtoNome}
                  {c.lote && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      (lote {c.lote})
                    </Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">{qtd(c.quantidade)}</Table.Td>
                {verCusto && (
                  <Table.Td ta="right">
                    {c.custoUnitario === null ? '—' : `R$ ${formatarDecimal(Number(c.custoUnitario), 4)}`}
                  </Table.Td>
                )}
                <Table.Td>
                  <Documento c={c} podeVenda={pode('vendas.ver')} />
                  <Text size="xs" c="dimmed">
                    {c.compensado.tipoMovimentoNome}: {qtd(c.compensado.quantidade)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {c.compensado.terminalId && c.compensado.terminal ? (
                    pode('terminais.ver') ? (
                      <Anchor component={Link} to={`${ROTA_TERMINAIS}/${c.compensado.terminalId}`} size="sm">
                        {c.compensado.terminal}
                      </Anchor>
                    ) : (
                      c.compensado.terminal
                    )
                  ) : (
                    <Text span size="sm" c="dimmed">
                      ERP
                    </Text>
                  )}
                  {c.compensado.sequencia !== null && (
                    <Text size="xs" c="dimmed">
                      evento nº {c.compensado.sequencia}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  {formatarDataHora(c.compensado.recebidoEm ?? c.lancadaEm)}
                </Table.Td>
                <Table.Td>
                  <Relogio c={c} />
                </Table.Td>
                {comAcerto && (
                  <Table.Td>
                    <Anchor component={Link} to={`${ROTA_ACERTOS}/${c.acertoId}`} size="sm">
                      Acerto Nº {c.acertoCodigo}
                    </Anchor>
                  </Table.Td>
                )}
                <Table.Td>
                  <Situacao c={c} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

/** O documento de origem, com o link para a venda ou o acerto. */
function Documento({ c, podeVenda }: { c: CompensacaoAcerto; podeVenda: boolean }) {
  const { documentoTipo, documentoId, documento } = c.compensado;
  if (documentoId && documentoTipo === 'venda' && podeVenda)
    return (
      <Anchor component={Link} to={`${ROTA_VENDAS}/${documentoId}`} size="sm">
        {documento}
      </Anchor>
    );
  if (documentoId && documentoTipo === 'acerto')
    return (
      <Anchor component={Link} to={`${ROTA_ACERTOS}/${documentoId}`} size="sm">
        {documento}
      </Anchor>
    );
  return <Text size="sm">{documento}</Text>;
}

/**
 * O relógio do caixa no evento do fato: "Suspeito" (laranja) com os motivos, "Corrigido" (a regressão marcada) ou
 * "Confiável", com o desvio medido na dica (com a hora confiável, a do fato já saiu corrigida por ele).
 */
function Relogio({ c }: { c: CompensacaoAcerto }) {
  if (!c.relogio)
    return (
      <Text span size="sm" c="dimmed">
        —
      </Text>
    );
  const { motivos, desvioMs } = c.relogio;
  const desvio =
    desvioMs !== null && desvioMs !== 0
      ? `Desvio medido pelo caixa: ${duracaoLegivel(desvioMs)} ${desvioMs > 0 ? 'atrasado' : 'adiantado'}` +
        (c.relogio.confiavel === true ? '; a hora do fato já foi corrigida por ele.' : '.')
      : null;
  const dica = [...motivos.map((m) => ROTULOS_MOTIVO_RELOGIO_COMPENSACAO[m]), desvio]
    .filter(Boolean)
    .join('; ');
  if (c.relogioSuspeito)
    return (
      <Tooltip label={dica} multiline w={280}>
        <Badge color="orange" variant="light" miw="max-content" data-testid={`relogio-${c.id}`}>
          Suspeito
        </Badge>
      </Tooltip>
    );
  if (motivos.length)
    return (
      <Tooltip label={dica} multiline w={280}>
        <Badge color="gray" variant="light" miw="max-content" data-testid={`relogio-${c.id}`}>
          Corrigido
        </Badge>
      </Tooltip>
    );
  return (
    <Text span size="sm" c="dimmed" data-testid={`relogio-${c.id}`}>
      {desvio ? (
        <Tooltip label={desvio}>
          <span>Confiável</span>
        </Tooltip>
      ) : (
        'Confiável'
      )}
    </Text>
  );
}

/**
 * "Valendo" ou "Estornada" (com a data, o acerto estornado e o motivo); quando outro "Definir" compensou o fato de
 * novo no estorno, o link para ele: o movimento continua anulado.
 */
function Situacao({ c }: { c: CompensacaoAcerto }) {
  if (!c.estorno)
    return (
      <Badge color="green" variant="light" miw="max-content">
        Valendo
      </Badge>
    );
  const dica = [
    `Estornada em ${formatarDataHora(c.estorno.em)}`,
    c.estorno.acertoCodigo !== null ? `no estorno do acerto Nº ${c.estorno.acertoCodigo}` : null,
    c.estorno.motivo ? `motivo: ${c.estorno.motivo}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const substituta = c.estorno.substituidaPor;
  return (
    <Stack gap={2} align="flex-start">
      <Tooltip label={dica} multiline w={280}>
        <Badge color="gray" variant="light" miw="max-content">
          Estornada
        </Badge>
      </Tooltip>
      {substituta && (
        <Text size="xs" c="dimmed" data-testid={`substituida-${c.id}`}>
          Compensado de novo pelo{' '}
          <Anchor component={Link} to={`${ROTA_ACERTOS}/${substituta.acertoId}`} size="xs">
            Acerto Nº {substituta.acertoCodigo}
          </Anchor>
        </Text>
      )}
    </Stack>
  );
}
