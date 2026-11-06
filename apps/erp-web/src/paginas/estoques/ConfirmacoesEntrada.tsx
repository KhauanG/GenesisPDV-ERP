import type { PrecoCustoAAtualizar, SaldoNegativoEstorno } from '@genesis/shared';
import { Alert, Button, Group, List, Modal, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { ErroRequisicao } from '../../api/http';
import { formatarDecimal } from '../../componentes/grade/decimal';

/**
 * As confirmações comuns ao movimentar e ao estornar uma entrada de mercadoria (Fase 2, F2-B16 e F2-B21; README do ERP
 * › decisões 60 e 62), escritas uma vez para o recebimento manual e a NF-e: a pergunta do preço de custo (D49,
 * `estoque.compra_atualiza_preco_custo`) e a confirmação do saldo negativo no estorno (D56 com aviso). A regra e o
 * texto de uma valem nas duas telas.
 */

/** Os produtos da pergunta do preço de custo (D49) quando o erro é ela (422 em `atualizarPrecoCusto`); senão `null`. */
export function precosCustoDoErro(e: unknown): PrecoCustoAAtualizar[] | null {
  if (!(e instanceof ErroRequisicao) || !e.campos?.atualizarPrecoCusto) return null;
  return (e.corpo.detalhes?.precosCusto ?? []) as PrecoCustoAAtualizar[];
}

/**
 * "Atualizar o preço de custo?" (D49): o atual e o novo de cada produto cujo preço de custo mudaria. `documento` é o
 * que a tela movimenta ("compra" no recebimento, "nota" na NF-e), no texto e na coluna do novo.
 */
export function PerguntaPrecoCusto({
  produtos,
  documento,
  processando,
  aoResponder,
  aoFechar,
}: {
  /** `null` fecha o modal. */
  produtos: readonly PrecoCustoAAtualizar[] | null;
  documento: 'compra' | 'nota';
  processando: boolean;
  aoResponder: (atualizar: boolean) => void;
  aoFechar: () => void;
}) {
  const desta = documento === 'compra' ? 'desta compra' : 'desta nota';
  const da = documento === 'compra' ? 'da compra' : 'da nota';
  return (
    <Modal opened={!!produtos} onClose={aoFechar} title="Atualizar o preço de custo?" size="lg">
      <Stack>
        <Text size="sm">
          O custo {desta} é diferente do preço de custo cadastrado. O preço de custo passa a ser o custo {da}?
          (O custo médio e o último custo mudam de qualquer forma.)
        </Text>
        <Table withTableBorder fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Produto</Table.Th>
              <Table.Th ta="right">Atual</Table.Th>
              <Table.Th ta="right">{documento === 'compra' ? 'Desta compra' : 'Desta nota'}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {produtos?.map((p) => (
              <Table.Tr key={p.produtoId}>
                <Table.Td>{p.nome}</Table.Td>
                <Table.Td ta="right">R$ {formatarDecimal(Number(p.atual), 4)}</Table.Td>
                <Table.Td ta="right">R$ {formatarDecimal(Number(p.novo), 4)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify="flex-end">
          <Button variant="default" loading={processando} onClick={() => aoResponder(false)}>
            Não, manter o preço de custo
          </Button>
          <Button color="green" loading={processando} onClick={() => aoResponder(true)}>
            Sim, atualizar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * O estado da confirmação do saldo negativo no estorno (D56 com aviso): quem pode deixar o saldo negativo (Master ou
 * "Permite saldo negativo no ERP") recebe 422 em `confirmarNegativo` com a lista dos saldos; a tela mostra a lista e a
 * confirmação devolve a lista mostrada (a API só aceita se ela cobrir os saldos de agora; senão pergunta de novo com a
 * lista nova, e `mudou` avisa). `tratar` devolve se o erro era a pergunta (senão a tela mostra o erro como sempre).
 */
export function useConfirmacaoNegativo() {
  const [negativos, setNegativos] = useState<SaldoNegativoEstorno[] | null>(null);
  // A lista mudou entre a pergunta e a confirmação (uma venda sincronizou): a API pergunta de novo.
  const [mudou, setMudou] = useState(false);
  return {
    negativos,
    mudou,
    tratar(e: unknown, confirmados: readonly SaldoNegativoEstorno[]): boolean {
      if (!(e instanceof ErroRequisicao) || !e.campos?.confirmarNegativo) return false;
      setMudou(confirmados.length > 0);
      setNegativos((e.corpo.detalhes?.saldosNegativos ?? []) as SaldoNegativoEstorno[]);
      return true;
    },
    limpar() {
      setNegativos(null);
      setMudou(false);
    },
  };
}

/** O conteúdo do modal de estorno quando o saldo ficará negativo: a lista, o aviso de que mudou e a confirmação. */
export function ConfirmacaoNegativoEstorno({
  negativos,
  mudou,
  processando,
  aoConfirmar,
  aoCancelar,
}: {
  negativos: readonly SaldoNegativoEstorno[];
  mudou: boolean;
  processando: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
}) {
  return (
    <Stack>
      {mudou && (
        <Text size="sm" c="red" data-testid="negativo-mudou">
          O saldo mudou desde a confirmação (uma venda sincronizou): confira a lista e confirme de novo.
        </Text>
      )}
      <Alert color="orange" title="O saldo ficará negativo">
        <Text size="sm">O saldo ficará negativo em:</Text>
        <List size="sm" mt="xs">
          {negativos.map((n) => (
            <List.Item key={`${n.produtoId}|${n.lote ?? ''}`}>
              {n.nome}
              {n.lote !== null ? ` (lote ${n.lote})` : ''}: de {formatarDecimal(Number(n.saldoAtual), 3)} para{' '}
              {formatarDecimal(Number(n.saldoFinal), 3)}
            </List.Item>
          ))}
        </List>
      </Alert>
      <Text size="sm">
        A mercadoria já saiu do estoque. Estornar mesmo assim? O estorno fica registrado na auditoria com o
        saldo negativo confirmado.
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={aoCancelar}>
          Cancelar
        </Button>
        <Button color="red" loading={processando} onClick={aoConfirmar}>
          Estornar mesmo assim
        </Button>
      </Group>
    </Stack>
  );
}
