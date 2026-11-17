import type { ModoRevogacao, TerminalResumo } from '@genesis/shared';
import { Alert, Button, Group, List, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { ErroRequisicao } from '../../api/http';
import { useAcoesTerminais } from '../../api/terminais';
import { numeroCaixa, rotuloTerminal } from './rotulos';

/**
 * O que o modo perdido anula (README da API › decisão 211), o mesmo texto no terminal ativo e no já revogado: o PIN
 * de quem o computador pode ter recebido (quem acessa ou já acessou a loja e quem é ou já foi Master) e a senha de
 * cliente de quem já foi da loja.
 */
const AVISO_PIN_PERDIDO =
  'Anula o PIN do PDV de quem acessa ou já acessou esta loja e de quem é ou já foi Master, também nas outras lojas (cada um cadastra um novo): o computador pode guardar esses PINs.';
const AVISO_SENHA_CLIENTE_PERDIDO =
  'Anula a senha de cliente do crediário de todas as pessoas que já foram desta loja (redefinir no próximo atendimento).';

const TEXTOS: Record<ModoRevogacao, { titulo: string; botao: string; efeitos: string[] }> = {
  aceitar_pendencias: {
    titulo: 'Revogar – aceitar pendências',
    botao: 'Revogar aceitando pendências',
    efeitos: [
      'No próximo contato o PDV termina a venda atual e para de vender.',
      'Ele ainda envia os eventos pendentes e confirma a desativação; sem confirmação em 7 dias, é revogado.',
      'O próximo terminal do caixa continua a numeração só se a desativação for confirmada.',
    ],
  },
  imediato: {
    titulo: 'Revogar imediatamente',
    botao: 'Revogar agora',
    efeitos: [
      'O token deixa de valer na hora: toda chamada do PDV responde “terminal desativado”.',
      'O banco local fica intacto para o suporte; eventos não enviados só entram pela recuperação assistida.',
      'O próximo terminal do caixa recebe o salto de segurança na numeração.',
    ],
  },
  perdido: {
    titulo: 'Terminal perdido/roubado',
    botao: 'Revogar e anular PINs',
    efeitos: [
      'Revoga imediatamente.',
      AVISO_PIN_PERDIDO,
      AVISO_SENHA_CLIENTE_PERDIDO,
      'A senha do ERP não muda: ela nunca desce para o PDV.',
    ],
  },
};

/** "Terminal perdido/roubado" num terminal já revogado (o furto descoberto depois): só anula as credenciais. */
const PERDIDO_JA_REVOGADO = [
  'O terminal já está revogado: o token continua sem valer.',
  AVISO_PIN_PERDIDO,
  AVISO_SENHA_CLIENTE_PERDIDO,
  'A senha do ERP não muda: ela nunca desce para o PDV.',
];

/**
 * Confirmação da revogação (ERP 12.4): "imediato" e "perdido" pedem o número do caixa digitado (a API confere de
 * novo). "Não reconheço" (troca de hardware) chega aqui como `imediato` com a observação preenchida. "Perdido"
 * também vale para um terminal já revogado; a notificação diz quantos PINs e senhas foram anulados.
 */
export function DialogoRevogar({
  terminal,
  modo,
  observacaoInicial = '',
  aoFechar,
}: {
  terminal: TerminalResumo;
  modo: ModoRevogacao | null;
  observacaoInicial?: string;
  aoFechar: () => void;
}) {
  const { revogar } = useAcoesTerminais();
  const [confirmacao, setConfirmacao] = useState('');
  const [observacao, setObservacao] = useState(observacaoInicial);
  const [erro, setErro] = useState<string | null>(null);
  const exigeCaixa = modo === 'imediato' || modo === 'perdido';
  const confere = !exigeCaixa || Number(confirmacao) === terminal.numeroCaixa;
  const fechar = () => {
    setConfirmacao('');
    setErro(null);
    aoFechar();
  };
  if (!modo) return null;
  const t = TEXTOS[modo];
  const efeitos = modo === 'perdido' && terminal.status === 'revogado' ? PERDIDO_JA_REVOGADO : t.efeitos;
  return (
    <Modal opened onClose={fechar} title={t.titulo}>
      <Stack gap="sm">
        <Text size="sm" fw={500}>
          {rotuloTerminal(terminal)}
          {terminal.descricao ? ` – ${terminal.descricao}` : ''}
        </Text>
        <List size="sm" spacing={4}>
          {efeitos.map((e) => (
            <List.Item key={e}>{e}</List.Item>
          ))}
        </List>
        {terminal.eventosComErro > 0 && terminal.status !== 'revogado' && (
          <Alert color="orange" icon={<IconAlertTriangle size={18} />} variant="light">
            {terminal.eventosComErro} evento(s) com erro ou retido(s) neste terminal. A numeração passa ao
            próximo terminal mesmo assim e fica um alerta para alguém resolvê-los.
          </Alert>
        )}
        {exigeCaixa && (
          <TextInput
            label={`Digite ${terminal.numeroCaixa} (o número do caixa ${numeroCaixa(terminal.numeroCaixa)}) para confirmar`}
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.currentTarget.value)}
            inputMode="numeric"
            data-autofocus
          />
        )}
        <Textarea
          label="Observação (vai para a auditoria)"
          maxLength={200}
          value={observacao}
          onChange={(e) => setObservacao(e.currentTarget.value)}
          autosize
          minRows={2}
        />
        {erro && <Alert color="red">{erro}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          <Button
            color="red"
            disabled={!confere}
            loading={revogar.isPending}
            onClick={() =>
              revogar.mutate(
                {
                  id: terminal.id,
                  modo,
                  ...(exigeCaixa ? { confirmacaoCaixa: Number(confirmacao) } : {}),
                  observacao: observacao.trim() || null,
                },
                {
                  onSuccess: (r) => {
                    notifications.show({
                      color: 'green',
                      message:
                        modo === 'aceitar_pendencias'
                          ? 'Terminal em desativação: ele para de vender no próximo contato'
                          : modo === 'perdido'
                            ? `Terminal revogado como perdido/roubado: ${r.pinsAnulados} PIN(s) e ` +
                              `${r.senhasClienteAnuladas} senha(s) de cliente anulados`
                            : 'Terminal revogado',
                    });
                    fechar();
                  },
                  onError: (e) => setErro(e instanceof ErroRequisicao ? e.message : (e as Error).message),
                },
              )
            }
          >
            {t.botao}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
