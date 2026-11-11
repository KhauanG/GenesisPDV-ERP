import {
  BYTES_DETECCAO_TIPO,
  DESTINOS_ARQUIVO,
  detectarTipoArquivo,
  formatarTamanhoArquivo,
  mensagemArquivoGrande,
  mensagemTipoRecusado,
  rotuloTiposAceitos,
  TIPOS_ARQUIVO,
  type ArquivoInfo,
  type DestinoArquivo,
  type TipoArquivo,
} from '@genesis/shared';
import { Button, Center, FileButton, Group, Image, Input, Paper, Stack, Text } from '@mantine/core';
import { IconPhoto, IconTrash, IconUpload } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';

export interface PropsUploadArquivo {
  rotulo: string;
  descricao?: string;
  /** Para que serve o arquivo (`POST /api/arquivos?destino=`): decide os tipos, o limite e a categoria. */
  destino: DestinoArquivo;
  /** Os destinos de loja (os Anexos) levam a loja. */
  lojaId?: string;
  /** O id do arquivo gravado no cadastro (`null` = sem imagem). */
  valor: string | null;
  aoMudar: (id: string | null) => void;
  somenteLeitura?: boolean;
  erro?: string;
}

/** Os tipos e o limite do destino ("PNG, JPG ou WebP, até 2 MB"), do shared: o mesmo que a validação usa. */
export const tiposELimiteArquivo = (destino: DestinoArquivo) =>
  `${rotuloTiposAceitos(destino)}, até ${formatarTamanhoArquivo(DESTINOS_ARQUIVO[destino].limiteBytes)}`;

/** O começo do arquivo (para conferir o tipo antes de enviar; a API confere de novo, pelo mesmo critério). */
async function lerComeco(f: File): Promise<Uint8Array> {
  const pedaco = f.slice(0, BYTES_DETECCAO_TIPO);
  if (typeof pedaco.arrayBuffer === 'function') return new Uint8Array(await pedaco.arrayBuffer());
  return new Promise((ok, falha) => {
    const leitor = new FileReader();
    leitor.onload = () => ok(new Uint8Array(leitor.result as ArrayBuffer));
    leitor.onerror = () => falha(leitor.error);
    leitor.readAsArrayBuffer(pedaco);
  });
}

/** O que a tela recusa antes de enviar: o tamanho e o tipo pelo conteúdo (o nome e a extensão não contam). */
export async function problemaDoArquivo(f: File, destino: DestinoArquivo): Promise<string | null> {
  if (f.size > DESTINOS_ARQUIVO[destino].limiteBytes) return mensagemArquivoGrande(destino);
  const tipo = detectarTipoArquivo(await lerComeco(f));
  if (!tipo || !(DESTINOS_ARQUIVO[destino].tipos as readonly TipoArquivo[]).includes(tipo))
    return mensagemTipoRecusado(destino);
  return null;
}

/** O blob como `data:` (a miniatura tem ~10–20 KB): sem `URL.createObjectURL`, nada para revogar ao sair da tela. */
async function comoDataUrl(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let binario = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${b.type || 'image/webp'};base64,${btoa(binario)}`;
}

/** A miniatura (`pdv_256`) pela API autenticada: o `<img src="/api/…">` não mandaria o token, então vem como blob. */
function useMiniatura(id: string | null) {
  const arquivo = useQuery({
    queryKey: ['arquivos', id, 'pdv_256'],
    queryFn: async () =>
      comoDataUrl((await apiErp.baixar(`/arquivos/${id}/conteudo${query({ variante: 'pdv_256' })}`)).blob),
    enabled: !!id,
    staleTime: Infinity,
  });
  return {
    url: id ? (arquivo.data ?? null) : null,
    carregando: !!id && arquivo.isPending,
    falhou: arquivo.isError,
  };
}

/**
 * Envio de imagem de um cadastro (F2-B43; README do ERP › decisão 77): a foto do produto, a imagem da categoria, o
 * logotipo da marca e os Anexos da loja. Arrastar o arquivo para o quadro da miniatura ou escolhê-lo no botão já o
 * envia (`POST /api/arquivos`) e devolve o id ao formulário, que o grava com o cadastro no Salvar; "Remover" só tira
 * o id (o arquivo antigo fica no histórico). A tela confere o tamanho e o tipo pelo conteúdo antes de enviar; a API
 * confere tudo de novo e gera a miniatura.
 */
export function UploadArquivo(p: PropsUploadArquivo) {
  const destino = DESTINOS_ARQUIVO[p.destino];
  const miniatura = useMiniatura(p.valor);
  const [problema, setProblema] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const envio = useMutation({
    mutationFn: (f: File) => {
      const corpo = new FormData();
      corpo.append('arquivo', f);
      return apiErp.enviar<ArquivoInfo>(`/arquivos${query({ destino: p.destino, lojaId: p.lojaId })}`, corpo);
    },
    onSuccess: (a) => {
      setProblema(null);
      p.aoMudar(a.id);
    },
    onError: (e) =>
      setProblema(
        e instanceof ErroRequisicao ? e.message : 'Não foi possível enviar o arquivo. Tente de novo.',
      ),
  });
  const escolher = async (f: File | null) => {
    if (!f) return;
    const erro = await problemaDoArquivo(f, p.destino);
    setProblema(erro);
    if (!erro) envio.mutate(f);
  };
  /**
   * Soltar no quadro: o `preventDefault` vale também no somente leitura, para o navegador não abrir a imagem na aba
   * (o formulário não salvo sumiria). Um arquivo só (o primeiro), pelo mesmo `escolher` do botão.
   */
  const soltar = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setArrastando(false);
    if (p.somenteLeitura || envio.isPending) return;
    void escolher(e.dataTransfer.files[0] ?? null);
  };
  const aceitos = destino.tipos.map((t) => TIPOS_ARQUIVO[t].tipoMime).join(',');
  const erro = problema ?? p.erro;
  return (
    <Input.Wrapper label={p.rotulo} description={p.descricao ?? tiposELimiteArquivo(p.destino)} error={erro}>
      <Group align="flex-start" gap="md" mt={6}>
        <Paper
          withBorder
          w={128}
          h={128}
          radius="sm"
          data-testid="quadro-upload"
          style={{
            overflow: 'hidden',
            borderStyle: p.somenteLeitura ? undefined : 'dashed',
            background: arrastando ? 'var(--mantine-color-blue-light)' : undefined,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!p.somenteLeitura) setArrastando(true);
          }}
          onDragLeave={() => setArrastando(false)}
          onDrop={soltar}
        >
          {miniatura.url ? (
            <Image src={miniatura.url} alt={p.rotulo} w={128} h={128} fit="contain" />
          ) : (
            <Center h="100%">
              <Stack gap={2} align="center">
                <IconPhoto size={28} stroke={1.5} color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed">
                  {arrastando
                    ? 'Solte aqui'
                    : miniatura.carregando
                      ? 'Carregando…'
                      : miniatura.falhou
                        ? 'Imagem indisponível'
                        : p.valor
                          ? 'Imagem enviada'
                          : 'Sem imagem'}
                </Text>
              </Stack>
            </Center>
          )}
        </Paper>
        {!p.somenteLeitura && (
          <Stack gap="xs">
            <FileButton onChange={(f) => void escolher(f)} accept={aceitos}>
              {(props) => (
                <Button
                  variant="default"
                  leftSection={<IconUpload size={16} />}
                  loading={envio.isPending}
                  {...props}
                >
                  {p.valor ? 'Trocar imagem' : 'Enviar imagem'}
                </Button>
              )}
            </FileButton>
            {p.valor && (
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  setProblema(null);
                  p.aoMudar(null);
                }}
                disabled={envio.isPending}
              >
                Remover
              </Button>
            )}
          </Stack>
        )}
      </Group>
    </Input.Wrapper>
  );
}
