import {
  FORMAS_DEVOLUCAO_CANCELAMENTO,
  MOTIVO_CANCELAMENTO_VENDA_MAX,
  MOTIVO_CANCELAMENTO_VENDA_MIN,
  ROTULOS_FORMA_DEVOLUCAO_CANCELAMENTO,
  type CancelarVendaEntrada,
  type FormaDevolucaoCancelamento,
  type PreviaCancelamentoVenda,
  type VendaDetalhe,
} from '@genesis/shared';
import { Alert, Button, Checkbox, Group, Modal, Radio, Skeleton, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBan, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { segmento } from '../../api/caminho';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { reais } from './comum';

/**
 * Modal "Cancelar venda" (ERP 15.4.3; Fase 3, F3-B11; D112, D113): lê a prévia da API (`GET /vendas/:id/cancelamento`)
 * e mostra o bloqueio (sessão ainda aberta: "cancele no caixa"; o caixa já cancelou e não sincronizou; venda com troca
 * ou com documento fiscal) ou o formulário: o motivo (15 a 255, como no caixa), a forma de devolução ao cliente na
 * venda de caixa fechado (o vale desabilitado até os vales entrarem; só registrada até a Fase 4) e os avisos do caixa de
 * origem — offline ou com eventos pendentes pede o "estou ciente"; abaixo da versão que lê a projeção, só informa.
 */
export function ModalCancelarVenda({
  venda,
  aberto,
  aoFechar,
}: {
  venda: VendaDetalhe;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const queryClient = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const [forma, setForma] = useState<FormaDevolucaoCancelamento | null>(null);
  const [ciente, setCiente] = useState(false);
  const previa = useQuery({
    queryKey: ['venda-cancelamento', venda.id],
    queryFn: ({ signal }) =>
      apiErp.get<PreviaCancelamentoVenda>(`/vendas/${segmento(venda.id)}/cancelamento`, { sinal: signal }),
    enabled: aberto,
    staleTime: 0,
  });
  const fechar = () => {
    setMotivo('');
    setForma(null);
    setCiente(false);
    cancelar.reset();
    aoFechar();
  };
  const cancelar = useMutation({
    mutationFn: () =>
      apiErp.post<VendaDetalhe>(`/vendas/${segmento(venda.id)}/cancelar`, {
        motivo,
        formaDevolucao: p?.exigeFormaDevolucao ? forma : null,
        confirmarAvisos: ciente,
      } satisfies CancelarVendaEntrada),
    onSuccess: (d) => {
      queryClient.setQueryData(['venda', venda.id], d);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'vendas'] });
      void queryClient.invalidateQueries({ queryKey: ['auditoria', 'vendas', venda.id] });
      notifications.show({ color: 'green', message: `Venda ${venda.numeroExibicao} cancelada.` });
      fechar();
    },
    onError: (e) => {
      // A situação mudou entre a prévia e a gravação (novo aviso, o cancelamento do caixa chegou, outro usuário já
      // cancelou): relê a prévia e também o detalhe e a listagem atrás do modal, senão a página continua com a venda
      // "Finalizada" e o botão "Cancelar venda" até recarregar (o QueryClient não relê ao fechar o modal).
      if (e instanceof ErroRequisicao && (e.status === 409 || (e.status === 422 && !e.campos))) {
        setCiente(false);
        void previa.refetch();
        void queryClient.invalidateQueries({ queryKey: ['venda', venda.id] });
        void queryClient.invalidateQueries({ queryKey: ['listagem', 'vendas'] });
      }
    },
  });
  const p = previa.data;
  const tamanho = motivo.trim().length;
  const motivoValido = tamanho >= MOTIVO_CANCELAMENTO_VENDA_MIN && tamanho <= MOTIVO_CANCELAMENTO_VENDA_MAX;
  const exigeCiencia = p?.avisos.some((a) => a.exigeConfirmacao) ?? false;
  const pronto =
    !!p?.podeCancelar &&
    motivoValido &&
    (!p.exigeFormaDevolucao || forma !== null) &&
    (!exigeCiencia || ciente);
  const erro = cancelar.error as Error | null;
  const erroCampos = cancelar.error instanceof ErroRequisicao ? cancelar.error.campos : undefined;
  return (
    <Modal opened={aberto} onClose={fechar} title={`Cancelar a venda ${venda.numeroExibicao}`} size="lg">
      {previa.isError ? (
        <Alert color="red">{(previa.error as Error).message}</Alert>
      ) : !p ? (
        <Skeleton h={160} />
      ) : p.bloqueio ? (
        <Stack>
          <Alert color="red" icon={<IconBan size={18} />} title="Esta venda não pode ser cancelada aqui">
            {p.bloqueio.mensagem}
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={fechar}>
              Fechar
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm">
            O cancelamento devolve ao estoque o que a venda baixou, ao custo da venda
            {p.devolveVazios ? ', e os cascos vazios que o cliente trouxe voltam para ele' : ''}. O caixa de
            origem fica sabendo pela sincronização.
          </Text>
          {p.avisos.map((a) => (
            <Alert
              key={a.codigo}
              color={a.exigeConfirmacao ? 'orange' : 'yellow'}
              icon={a.exigeConfirmacao ? <IconAlertTriangle size={16} /> : <IconInfoCircle size={16} />}
              p="xs"
            >
              {a.mensagem}
            </Alert>
          ))}
          <Textarea
            label="Motivo do cancelamento"
            description={`De ${MOTIVO_CANCELAMENTO_VENDA_MIN} a ${MOTIVO_CANCELAMENTO_VENDA_MAX} caracteres (${tamanho}).`}
            required
            autosize
            minRows={2}
            maxLength={MOTIVO_CANCELAMENTO_VENDA_MAX}
            data-autofocus
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
            error={erroCampos?.motivo?.[0]}
          />
          {p.exigeFormaDevolucao && (
            <Radio.Group
              label="Como a devolução ao cliente foi feita"
              description={`O caixa já foi fechado: devolva ${reais(venda.total)} ao cliente fora dele. Até o financeiro (Fase 4) a forma só fica registrada no histórico da venda.`}
              required
              value={forma}
              onChange={(v) => setForma(v as FormaDevolucaoCancelamento)}
              error={erroCampos?.formaDevolucao?.[0]}
            >
              <Stack gap={6} mt="xs">
                {FORMAS_DEVOLUCAO_CANCELAMENTO.map((f) => {
                  const disponivel = p.formasDevolucao.includes(f);
                  return (
                    <Radio
                      key={f}
                      value={f}
                      disabled={!disponivel}
                      label={
                        disponivel
                          ? ROTULOS_FORMA_DEVOLUCAO_CANCELAMENTO[f]
                          : `${ROTULOS_FORMA_DEVOLUCAO_CANCELAMENTO[f]} (disponível quando os vales entrarem)`
                      }
                    />
                  );
                })}
              </Stack>
            </Radio.Group>
          )}
          {exigeCiencia && (
            <Checkbox
              label="Estou ciente: se o caixa também cancelou esta venda, confiro a devolução em dobro pelo alerta."
              checked={ciente}
              onChange={(e) => setCiente(e.currentTarget.checked)}
            />
          )}
          {erro && !erroCampos && (
            <Alert color="red" p="xs">
              {erro.message}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={fechar}>
              Voltar
            </Button>
            <Button
              color="red"
              leftSection={<IconBan size={16} />}
              disabled={!pronto}
              loading={cancelar.isPending}
              onClick={() => cancelar.mutate()}
            >
              Cancelar venda
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
