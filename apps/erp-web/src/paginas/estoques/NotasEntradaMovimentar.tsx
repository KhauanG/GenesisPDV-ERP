import type { NotaEntradaDetalhe, PrecoCustoAAtualizar, SaldoNegativoEstorno } from '@genesis/shared';
import { Button, Group, List, Modal, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconCircleCheck } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import {
  ConfirmacaoNegativoEstorno,
  PerguntaPrecoCusto,
  precosCustoDoErro,
  useConfirmacaoNegativo,
} from './ConfirmacoesEntrada';

const reais = (v: string | number) => `R$ ${formatarDecimal(Number(v), 2)}`;

/** O erro da ação na nota, com o que a API disse de cada item (`itens.N.campo`). */
export interface ErroAcaoNota {
  mensagem: string;
  /** As mensagens por item, com o número do item na nota (`nItem`), na ordem da nota. */
  itens: Array<{ numeroItem: number; mensagem: string }>;
  /** Os campos `itens.N.*` como vieram (N = a posição do item na nota): a aba de itens destaca as linhas. */
  campos: Record<string, string[]>;
}

/**
 * O erro da ação para a tela: a mensagem e, quando a API apontou itens (`itens.N.campo`: o lote já cadastrado com
 * outra validade, a embalagem que deixou de ser de compra, o produto que passou a pedir lote, o código do fornecedor
 * ligado a outro produto sem "Produtos: Editar"), a mensagem de cada um com o número do item na nota. Sem isso o
 * "Verifique os itens destacados" da API não diria qual.
 */
export function erroAcaoNota(e: unknown, nota: Pick<NotaEntradaDetalhe, 'itens'>): ErroAcaoNota {
  const campos: Record<string, string[]> = {};
  const itens: Array<{ indice: number; numeroItem: number; mensagem: string }> = [];
  if (e instanceof ErroRequisicao)
    for (const [chave, mensagens] of Object.entries(e.campos ?? {})) {
      const m = /^itens\.(\d+)\.\w+$/.exec(chave);
      if (!m) continue;
      campos[chave] = mensagens;
      const indice = Number(m[1]);
      const numeroItem = nota.itens[indice]?.numeroItem ?? indice + 1;
      for (const mensagem of mensagens) itens.push({ indice, numeroItem, mensagem });
    }
  itens.sort((a, b) => a.indice - b.indice);
  return {
    mensagem: (e as Error).message,
    itens: itens.map(({ numeroItem, mensagem }) => ({ numeroItem, mensagem })),
    campos,
  };
}

/**
 * Movimentar e estornar a NF-e (ERP 13.4; Fase 2, F2-B21; README do ERP › decisão 62), no cabeçalho da nota, com as
 * mesmas perguntas do recebimento manual: "Movimentar" (com `notas_entrada.movimentar`, na nota "pronta"; na pendente
 * fica desabilitado com o motivo) confirma e, se o custo da nota muda o preço de custo de algum produto (D49), abre a
 * pergunta com o atual e o novo; "Estornar" (com `notas_entrada.estornar`, na movimentada) pede o motivo e, quando o
 * estorno deixaria saldo negativo e quem estorna pode deixar (D56 com aviso), mostra a lista e pede a confirmação,
 * que devolve a lista mostrada (as duas perguntas são as do recebimento, `ConfirmacoesEntrada`). A movimentação usa o
 * que está **gravado** na aba de itens. O erro da ação (sem permissão de preço, lote, conflito de versão, rede) vai
 * para `aoErro` com a mensagem de cada item apontado pela API (`erroAcaoNota`): a tela mostra abaixo do cabeçalho, com
 * o número do item, e a aba de itens destaca as linhas.
 */
export function AcoesMovimentacaoNota({
  nota,
  aoErro,
}: {
  nota: NotaEntradaDetalhe;
  aoErro: (erro: ErroAcaoNota | null) => void;
}) {
  const pode = usePode();
  const queryClient = useQueryClient();
  const [confirmando, setConfirmando] = useState(false);
  const [perguntaCusto, setPerguntaCusto] = useState<PrecoCustoAAtualizar[] | null>(null);
  const [estornando, setEstornando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const negativo = useConfirmacaoNegativo();
  const [processando, setProcessando] = useState(false);
  const setErro = (e: unknown) => aoErro(e === null ? null : erroAcaoNota(e, nota));

  const depois = (d: NotaEntradaDetalhe, mensagem: string) => {
    queryClient.setQueryData(['nota-entrada', nota.id], d);
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
    notifications.show({ color: 'green', message: mensagem });
  };

  /** Movimenta; a pergunta do preço de custo (D49) volta como 422 e abre o modal com os produtos. */
  async function movimentar(atualizarPrecoCusto: boolean | null) {
    setErro(null);
    setProcessando(true);
    try {
      const d = await apiErp.post<NotaEntradaDetalhe>(`/notas-entrada/${nota.id}/movimentar`, {
        versao: nota.versao,
        atualizarPrecoCusto,
      });
      setConfirmando(false);
      setPerguntaCusto(null);
      depois(d, 'NF-e movimentada: estoque atualizado');
    } catch (e) {
      setConfirmando(false);
      const produtos = precosCustoDoErro(e);
      setPerguntaCusto(produtos);
      if (!produtos) setErro(e);
    } finally {
      setProcessando(false);
    }
  }

  async function estornar(confirmarNegativo: SaldoNegativoEstorno[] = []) {
    setErro(null);
    setProcessando(true);
    try {
      const d = await apiErp.post<NotaEntradaDetalhe>(`/notas-entrada/${nota.id}/estornar`, {
        versao: nota.versao,
        motivo,
        confirmarNegativo,
      });
      fecharEstorno();
      setMotivo('');
      depois(d, 'NF-e estornada');
    } catch (e) {
      if (!negativo.tratar(e, confirmarNegativo)) {
        fecharEstorno();
        setErro(e);
      }
    } finally {
      setProcessando(false);
    }
  }

  function fecharEstorno() {
    setEstornando(false);
    negativo.limpar();
  }

  const aberta = nota.status === 'pendente' || nota.status === 'pronta';
  const podeMovimentar = aberta && pode('notas_entrada.movimentar');
  const podeEstornar = nota.status === 'movimentada' && pode('notas_entrada.estornar');
  const ignorados = nota.itens.filter((i) => i.ignorado).length;

  return (
    <>
      <Group gap="xs">
        {podeMovimentar && (
          <Tooltip
            label="Vincule (com o fator confirmado) ou ignore todos os itens na aba Itens e vinculação"
            disabled={nota.status === 'pronta'}
          >
            <Button
              color="green"
              leftSection={<IconCircleCheck size={16} />}
              disabled={nota.status !== 'pronta'}
              loading={processando}
              onClick={() => setConfirmando(true)}
            >
              Movimentar
            </Button>
          </Tooltip>
        )}
        {podeEstornar && (
          <Button
            variant="default"
            color="red"
            leftSection={<IconArrowBackUp size={16} />}
            onClick={() => setEstornando(true)}
          >
            Estornar
          </Button>
        )}
      </Group>
      <Modal opened={confirmando} onClose={() => setConfirmando(false)} title="Movimentar a NF-e">
        <Stack>
          <Text size="sm">
            O estoque "{nota.estoqueNome}" recebe os itens vinculados agora, com o fator confirmado e o custo
            da nota (produtos, frete, impostos e despesas pelas configurações da loja). Entra o que está
            gravado na aba Itens e vinculação. Depois de movimentada, a nota não muda mais (só se estorna).
          </Text>
          <List size="sm">
            <List.Item>
              NF-e Nº {nota.numero}/{nota.serie}, {nota.itens.length - ignorados} item(ns) a lançar
              {ignorados ? ` (${ignorados} ignorado(s))` : ''}, {reais(nota.totais.total)}
            </List.Item>
          </List>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmando(false)}>
              Cancelar
            </Button>
            <Button color="green" loading={processando} onClick={() => void movimentar(null)}>
              Movimentar
            </Button>
          </Group>
        </Stack>
      </Modal>
      <PerguntaPrecoCusto
        produtos={perguntaCusto}
        documento="nota"
        processando={processando}
        aoFechar={() => setPerguntaCusto(null)}
        aoResponder={(atualizar) => void movimentar(atualizar)}
      />
      <Modal opened={estornando} onClose={fecharEstorno} title="Estornar NF-e">
        {negativo.negativos ? (
          <ConfirmacaoNegativoEstorno
            negativos={negativo.negativos}
            mudou={negativo.mudou}
            processando={processando}
            aoConfirmar={() => void estornar(negativo.negativos!)}
            aoCancelar={fecharEstorno}
          />
        ) : (
          <Stack>
            <Text size="sm">
              O estorno tira do estoque o que a nota lançou (os mesmos lotes). Se a mercadoria já tiver sido
              vendida e o saldo ficar negativo, é recusado (salvo Master ou "Permite saldo negativo no ERP",
              que confirmam vendo a lista). O preço de venda, o preço de custo e o vínculo com o fornecedor
              não voltam, e a nota estornada não se movimenta de novo.
            </Text>
            <TextInput
              label="Motivo do estorno"
              required
              data-autofocus
              maxLength={255}
              value={motivo}
              onChange={(e) => setMotivo(e.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={fecharEstorno}>
                Cancelar
              </Button>
              <Button
                color="red"
                disabled={!motivo.trim()}
                loading={processando}
                onClick={() => void estornar()}
              >
                Estornar
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
