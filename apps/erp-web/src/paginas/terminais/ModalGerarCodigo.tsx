import type { CodigoAtivacaoGerado } from '@genesis/shared';
import {
  Alert,
  Button,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { ErroRequisicao } from '../../api/http';
import { useAcoesTerminais, useCaixasLivres } from '../../api/terminais';
import { useEu } from '../../auth/sessao';
import { SeletorLoja } from '../../componentes/seletores';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarDataHora } from '../../util/formato';
import { numeroCaixa } from './rotulos';

/** "Substituir terminal" (ERP 12.4): o modal abre travado no caixa do terminal antigo. */
export interface Substituicao {
  terminalId: string;
  lojaId: string;
  caixaId: string;
  numeroCaixa: number;
  /** "Números 000501–001500 do Caixa 02 reservados ao terminal antigo" quando não houve confirmação (SYNC 13.3). */
  aviso: string | null;
}

/**
 * Gerar código de ativação (ERP 12.3): loja, caixa livre (padrão o primeiro), descrição e validade; o código aparece
 * uma única vez com o botão copiar e o código da empresa. Os caixas vêm de `/terminais/caixas-livres` (basta
 * `terminais.ativar`); o de um terminal em desativação aparece com aviso. Fora desta fase: "Novo caixa" (o caixa é
 * cadastrado em Lojas › Caixas), a escolha da série NFC-e (fiscal, 3F) e o QR code (README › decisão 38).
 */
export function ModalGerarCodigo({
  aberto,
  aoFechar,
  substituicao,
}: {
  aberto: boolean;
  aoFechar: () => void;
  substituicao?: Substituicao;
}) {
  const eu = useEu();
  const { lojaId: lojaContexto } = useLojaContexto();
  const { gerarCodigo } = useAcoesTerminais();
  const [lojaId, setLojaId] = useState<string | null>(substituicao?.lojaId ?? lojaContexto);
  const [caixaEscolhido, setCaixaId] = useState<string | null>(null);
  const [descricao, setDescricao] = useState('');
  const [validade, setValidade] = useState('24');
  const [gerado, setGerado] = useState<CodigoAtivacaoGerado | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const caixas = useCaixasLivres(lojaId, aberto && !substituicao);
  const livres = caixas.data ?? [];
  // Padrão "próximo livre" (ERP 12.3): o escolhido vale enquanto continuar livre na loja selecionada.
  const caixaId =
    substituicao?.caixaId ??
    (caixaEscolhido && livres.some((c) => c.id === caixaEscolhido)
      ? caixaEscolhido
      : (livres[0]?.id ?? null));
  const desativando = !substituicao && !!livres.find((c) => c.id === caixaId)?.terminalDesativandoId;

  const fechar = () => {
    setGerado(null);
    setErro(null);
    setDescricao('');
    gerarCodigo.reset();
    aoFechar();
  };

  const gerar = () => {
    if (!lojaId || !caixaId) return;
    setErro(null);
    gerarCodigo.mutate(
      {
        lojaId,
        caixaId,
        descricao: descricao.trim() || null,
        validadeHoras: Number(validade) as 1 | 24 | 72,
        substituiTerminalId: substituicao?.terminalId ?? null,
      },
      {
        onSuccess: setGerado,
        onError: (e) => setErro(e instanceof ErroRequisicao || e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <Modal
      opened={aberto}
      onClose={fechar}
      title={substituicao ? 'Substituir terminal' : 'Gerar código de ativação'}
      size="lg"
    >
      {gerado ? (
        <Stack gap="md" align="center">
          <Text size="sm" c="dimmed">
            Digite no PDV novo. O código é exibido só agora; depois aparece mascarado na lista de pendentes.
          </Text>
          <Title order={2} ff="monospace" data-testid="codigo-ativacao" style={{ letterSpacing: 4 }}>
            {gerado.codigo}
          </Title>
          <CopyButton value={gerado.codigo}>
            {({ copied, copy }) => (
              <Button
                variant="light"
                leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                onClick={copy}
              >
                {copied ? 'Copiado' : 'Copiar código'}
              </Button>
            )}
          </CopyButton>
          <Text size="sm">
            Código da empresa: <b>{eu.empresa.codigo}</b> · expira em {formatarDataHora(gerado.expiraEm)}
          </Text>
          <Button onClick={fechar}>Fechar</Button>
        </Stack>
      ) : (
        <Stack gap="sm">
          {substituicao ? (
            <Alert icon={<IconInfoCircle size={18} />} variant="light">
              Código para o caixa {numeroCaixa(substituicao.numeroCaixa)}. Quando o PDV novo ativar, o
              terminal atual passa a “Desativando”: envia o que tiver pendente e para de vender.
              {substituicao.aviso && (
                <Text size="sm" mt={4}>
                  {substituicao.aviso}
                </Text>
              )}
            </Alert>
          ) : (
            <>
              <SeletorLoja label="Loja" required value={lojaId} onChange={setLojaId} />
              <Select
                label="Caixa"
                required
                data={livres.map((c) => ({
                  value: c.id,
                  label:
                    `Caixa ${numeroCaixa(c.numero)}${c.descricao ? ` – ${c.descricao}` : ''}` +
                    (c.terminalDesativandoId ? ' (terminal em desativação)' : ''),
                }))}
                value={caixaId}
                onChange={setCaixaId}
                disabled={!lojaId}
                placeholder={lojaId && caixas.data && !livres.length ? 'Nenhum caixa livre' : 'Selecione'}
                description="Caixa ocupado por um terminal ativo só com “Substituir terminal” no detalhe dele. Caixa novo: Lojas › Caixas."
                comboboxProps={{ withinPortal: true }}
                error={caixas.isError ? (caixas.error as Error).message : undefined}
              />
              {desativando && (
                <Alert icon={<IconInfoCircle size={18} />} variant="light" color="orange">
                  O terminal deste caixa está em desativação. Quando o PDV novo ativar, ele sai do caixa sem
                  confirmação: a numeração recebe o salto de segurança e eventos dele com erro viram alerta.
                </Alert>
              )}
            </>
          )}
          <TextInput
            label="Descrição"
            placeholder="ex.: PC do balcão"
            maxLength={40}
            value={descricao}
            onChange={(e) => setDescricao(e.currentTarget.value)}
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Validade
            </Text>
            <SegmentedControl
              value={validade}
              onChange={setValidade}
              data={[
                { value: '1', label: '1 h' },
                { value: '24', label: '24 h' },
                { value: '72', label: '72 h' },
              ]}
            />
          </div>
          {erro && <Alert color="red">{erro}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={fechar}>
              Cancelar
            </Button>
            <Button onClick={gerar} loading={gerarCodigo.isPending} disabled={!lojaId || !caixaId}>
              Gerar código
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
