import {
  ROTULOS_PROBLEMA_CONTAGEM,
  type ModoItensExistentesContagem,
  type PreviaContagem,
} from '@genesis/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FileInput,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconFileImport, IconInfoCircle } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErp } from '../../api/clientes';
import { formatarDecimal } from '../../componentes/grade/decimal';

/** Itens e problemas mostrados na prévia (o arquivo inteiro é gravado; a tabela só não desenha milhares de linhas). */
const LINHAS_PREVIA = 200;

const qtd = (v: string | null) => (v === null ? '—' : formatarDecimal(Number(v), 3));
const linhasTexto = (l: number[]) =>
  l.length > 8 ? `${l.slice(0, 8).join(', ')}… (${l.length})` : l.join(', ');

/**
 * Importar contagem (Fase 2, F2-B9; ERP 13.5): o arquivo do coletor ou da planilha (`código;quantidade`, CSV ou TXT)
 * entra no rascunho do "Definir". "Ver prévia" manda o arquivo sem gravar e mostra o que fica no rascunho (o fardo já
 * em unidades, as leituras repetidas somadas) e os códigos que não entram; "Gravar no rascunho" manda de novo com a
 * versão do acerto. Acima de 5.000 itens a API divide a contagem em rascunhos novos com a mesma hora; o produto que já
 * está noutro rascunho da mesma contagem é somado (ou trocado) lá, e a coluna "Rascunho" mostra o Nº.
 */
export function ModalImportarContagem({
  aberto,
  aoFechar,
  acertoId,
  versao,
  aoGravar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  acertoId: string;
  versao: number;
  aoGravar: (p: PreviaContagem) => void;
}) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [zerar, setZerar] = useState(false);
  const [existentes, setExistentes] = useState<ModoItensExistentesContagem>('somar');
  const [previa, setPrevia] = useState<PreviaContagem | null>(null);

  const enviar = (modo: 'previa' | 'gravar') => {
    const f = new FormData();
    f.set('modo', modo);
    f.set('zerarNaoContados', String(zerar));
    f.set('itensExistentes', existentes);
    if (modo === 'gravar') f.set('versao', String(versao));
    f.set('arquivo', arquivo!);
    return apiErp.enviar<PreviaContagem>(`/acertos/${acertoId}/importar-contagem`, f);
  };
  const ver = useMutation({ mutationFn: () => enviar('previa'), onSuccess: setPrevia });
  const gravar = useMutation({
    mutationFn: () => enviar('gravar'),
    onSuccess: (p) => {
      fechar();
      aoGravar(p);
    },
  });
  // Mudar o arquivo ou uma opção invalida a prévia (a gravação manda o mesmo arquivo com as mesmas opções).
  const mudar =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPrevia(null);
      ver.reset();
      gravar.reset();
    };
  function fechar() {
    setArquivo(null);
    setPrevia(null);
    setZerar(false);
    setExistentes('somar');
    ver.reset();
    gravar.reset();
    aoFechar();
  }
  const erro = (ver.error ?? gravar.error) as Error | null;
  const t = previa?.totais;
  // A coluna "Rascunho": a divisão acima de 5.000 itens ou o produto que já está noutro rascunho da mesma contagem.
  const variosRascunhos = !!previa && (previa.rascunhos > 1 || previa.outrosAcertos.length > 0);

  return (
    <Modal opened={aberto} onClose={fechar} title="Importar contagem" size="xl">
      <Stack>
        <Text size="sm" c="dimmed">
          Arquivo do coletor ou planilha salva como CSV/TXT, uma leitura por linha: <b>código;quantidade</b>{' '}
          (EAN, código de barras da embalagem ou código interno; separador ponto-e-vírgula, tabulação ou
          vírgula). O código do fardo vira unidades pelo fator da embalagem, e as leituras repetidas são
          somadas. Linha só com o código conta 1.
        </Text>
        <FileInput
          label="Arquivo da contagem"
          placeholder="Escolha o arquivo .csv ou .txt"
          accept=".csv,.txt,text/csv,text/plain"
          clearable
          value={arquivo}
          onChange={mudar(setArquivo)}
        />
        <Group align="flex-end" gap="xl">
          <div>
            <Text size="sm" fw={500} mb={4}>
              Produto que já está no rascunho
            </Text>
            <SegmentedControl
              aria-label="Produto que já está no rascunho"
              data={[
                { value: 'somar', label: 'Somar' },
                { value: 'substituir', label: 'Substituir' },
              ]}
              value={existentes}
              onChange={mudar((v: string) => setExistentes(v as ModoItensExistentesContagem))}
            />
          </div>
          <Checkbox
            label="Zerar os não contados"
            description="Produtos com saldo neste estoque e tipo que não estão no arquivo entram com contado 0"
            checked={zerar}
            onChange={(e) => mudar(setZerar)(e.currentTarget.checked)}
          />
        </Group>
        {erro && (
          <Alert color="red" role="alert">
            {erro.message}
          </Alert>
        )}
        {previa && t && (
          <Stack gap="xs" data-testid="previa-contagem">
            <Text size="sm">
              {previa.linhas.toLocaleString('pt-BR')} linha(s), {previa.leituras.toLocaleString('pt-BR')}{' '}
              leitura(s): <b>{t.produtos} produto(s)</b> ({t.novos} novo(s), {t.alterados} já no rascunho)
              {t.zerados > 0 && <>, {t.zerados} zerado(s)</>}, {qtd(t.unidades)} unidade(s) lida(s)
              {t.leiturasRecusadas > 0 && <>; {t.leiturasRecusadas} leitura(s) recusada(s)</>}.
            </Text>
            {previa.avisos.map((a) => (
              <Alert key={a} color="yellow" icon={<IconInfoCircle size={18} />} p="xs">
                {a}
              </Alert>
            ))}
            {previa.problemas.length > 0 && (
              <>
                <Text size="sm" fw={500}>
                  Não entram no rascunho
                </Text>
                <ScrollArea.Autosize mah={220}>
                  <Table fz="xs" striped withTableBorder aria-label="Problemas da contagem">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Situação</Table.Th>
                        <Table.Th>Código</Table.Th>
                        <Table.Th>Linhas</Table.Th>
                        <Table.Th ta="right">Lido</Table.Th>
                        <Table.Th>Detalhe</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {previa.problemas.slice(0, LINHAS_PREVIA).map((p) => (
                        <Table.Tr key={`${p.tipo}:${p.codigo ?? ''}:${p.linhas[0]}`}>
                          <Table.Td>
                            <Badge
                              size="xs"
                              color={p.tipo === 'linha_invalida' ? 'gray' : 'red'}
                              variant="light"
                            >
                              {ROTULOS_PROBLEMA_CONTAGEM[p.tipo]}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{p.codigo ?? '—'}</Table.Td>
                          <Table.Td>{linhasTexto(p.linhas)}</Table.Td>
                          <Table.Td ta="right">{qtd(p.quantidadeLida)}</Table.Td>
                          <Table.Td>
                            {p.mensagem}
                            {p.produtos.length > 0 &&
                              `: ${p.produtos.map((x) => `${x.codigo} ${x.nome}`).join('; ')}`}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              </>
            )}
            {previa.itens.length > 0 && (
              <ScrollArea.Autosize mah={280}>
                <Table fz="xs" striped withTableBorder aria-label="Itens da contagem">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Produto</Table.Th>
                      <Table.Th>Códigos lidos</Table.Th>
                      <Table.Th ta="right">No arquivo</Table.Th>
                      <Table.Th ta="right">No rascunho</Table.Th>
                      <Table.Th ta="right">Contado</Table.Th>
                      {variosRascunhos && <Table.Th>Rascunho</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {previa.itens.slice(0, LINHAS_PREVIA).map((i) => (
                      <Table.Tr key={i.produto.id}>
                        <Table.Td>
                          {i.produto.codigo} {i.produto.nome}
                          {i.zerado && (
                            <Badge size="xs" color="gray" variant="light" ml={4}>
                              Não contado
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {i.codigos
                            .map(
                              (c) =>
                                `${c.codigo}${Number(c.fator) !== 1 ? ` (×${formatarDecimal(Number(c.fator), 3)})` : ''}: ${qtd(c.quantidadeLida)}`,
                            )
                            .join('; ') || '—'}
                        </Table.Td>
                        <Table.Td ta="right">
                          {qtd(i.quantidadeArquivo)} {i.produto.unidadeSigla}
                        </Table.Td>
                        <Table.Td ta="right">{qtd(i.quantidadeAnterior)}</Table.Td>
                        <Table.Td ta="right">
                          <b>{qtd(i.quantidadeFinal)}</b>
                        </Table.Td>
                        {variosRascunhos && (
                          <Table.Td>
                            {i.outroAcerto !== null
                              ? `Nº ${i.outroAcerto}`
                              : i.rascunho === 0
                                ? 'Este'
                                : `Novo ${i.rascunho}`}
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
            )}
            {(previa.itens.length > LINHAS_PREVIA || previa.problemas.length > LINHAS_PREVIA) && (
              <Text size="xs" c="dimmed">
                A prévia mostra as primeiras {LINHAS_PREVIA} linhas de cada tabela; a gravação leva o arquivo
                inteiro.
              </Text>
            )}
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          {!previa ? (
            <Button
              leftSection={<IconFileImport size={16} />}
              disabled={!arquivo}
              loading={ver.isPending}
              onClick={() => ver.mutate()}
            >
              Ver prévia
            </Button>
          ) : (
            <Button
              color="green"
              disabled={!previa.itens.length}
              loading={gravar.isPending}
              onClick={() => gravar.mutate()}
            >
              Gravar no rascunho
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
