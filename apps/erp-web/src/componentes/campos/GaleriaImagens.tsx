import type { DestinoArquivo } from '@genesis/shared';
import { ActionIcon, Center, Group, Image, Input, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconArrowRight, IconPhoto, IconTrash } from '@tabler/icons-react';
import { UploadArquivo, useMiniaturaArquivo } from './UploadArquivo';

export interface PropsGaleriaImagens {
  rotulo: string;
  descricao?: string;
  destino: DestinoArquivo;
  /** Os ids dos arquivos, na ordem. */
  valor: readonly string[];
  aoMudar: (ids: string[]) => void;
  maximo: number;
  somenteLeitura?: boolean;
  erro?: string;
}

function Miniatura({ id, posicao }: { id: string; posicao: number }) {
  const m = useMiniaturaArquivo(id);
  return (
    <Paper withBorder w={96} h={96} radius="sm" style={{ overflow: 'hidden' }}>
      {m.url ? (
        <Image src={m.url} alt={`Imagem ${posicao}`} w={96} h={96} fit="contain" />
      ) : (
        <Center h="100%">
          <Stack gap={2} align="center">
            <IconPhoto size={22} stroke={1.5} color="var(--mantine-color-dimmed)" />
            <Text size="xs" c="dimmed">
              {m.carregando ? 'Carregando…' : m.falhou ? 'Indisponível' : `Imagem ${posicao}`}
            </Text>
          </Stack>
        </Center>
      )}
    </Paper>
  );
}

/**
 * Galeria de imagens de um cadastro (as outras imagens do produto, `produtos_imagens`; F2-B44; README do ERP › decisão
 * 78): as miniaturas na ordem, com "para a esquerda"/"para a direita" e Remover em cada uma, e o `<UploadArquivo>` para
 * acrescentar (o envio já devolve o id, que entra no fim da lista). A lista vai inteira no Salvar do formulário.
 */
export function GaleriaImagens(p: PropsGaleriaImagens) {
  const trocar = (de: number, para: number) => {
    const l = [...p.valor];
    [l[de], l[para]] = [l[para]!, l[de]!];
    p.aoMudar(l);
  };
  return (
    <Input.Wrapper label={p.rotulo} description={p.descricao} error={p.erro}>
      <Group align="flex-start" gap="md" mt={6} data-testid="galeria-imagens">
        {p.valor.map((id, i) => (
          <Stack key={id} gap={4} align="center" data-testid={`galeria-imagem-${i + 1}`}>
            <Miniatura id={id} posicao={i + 1} />
            {!p.somenteLeitura && (
              <Group gap={2}>
                <Tooltip label="Para a esquerda">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Imagem ${i + 1} para a esquerda`}
                    disabled={i === 0}
                    onClick={() => trocar(i, i - 1)}
                  >
                    <IconArrowLeft size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Para a direita">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Imagem ${i + 1} para a direita`}
                    disabled={i === p.valor.length - 1}
                    onClick={() => trocar(i, i + 1)}
                  >
                    <IconArrowRight size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Remover">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    color="red"
                    aria-label={`Remover a imagem ${i + 1}`}
                    onClick={() => p.aoMudar(p.valor.filter((_, j) => j !== i))}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            )}
          </Stack>
        ))}
        {!p.somenteLeitura && p.valor.length < p.maximo && (
          <UploadArquivo
            rotulo="Acrescentar imagem"
            destino={p.destino}
            valor={null}
            aoMudar={(id) => {
              if (id && !p.valor.includes(id)) p.aoMudar([...p.valor, id]);
            }}
          />
        )}
        {p.somenteLeitura && p.valor.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhuma imagem.
          </Text>
        )}
      </Group>
    </Input.Wrapper>
  );
}
