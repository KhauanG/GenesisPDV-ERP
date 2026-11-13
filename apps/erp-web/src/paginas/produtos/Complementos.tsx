/**
 * Bloco e modal **Complementos** do produto "Com complementos" (Fase 2, F2-B51; ERP 8.2.16; MD 3.6.8; F2-Q1 = roadmap
 * D43; README do ERP › decisão 79): os grupos ("Molhos" de 0 a 2) e os complementos de cada um, vinculados a um
 * produto (com a baixa de estoque dele) ou livres, com o preço adicional. O modal edita o próprio formulário: a
 * gravação é a do produto (o "Salvar"), com as mesmas permissões. O complemento gravado não sai, só se inativa; o
 * grupo gravado removido é excluído no caixa com os complementos (a tela confirma). O caixa ainda vende sem
 * complementos: a escolha na venda é da Fase 3.
 */
import {
  MAXIMO_COMPLEMENTOS_GRUPO,
  MAXIMO_GRUPOS_COMPLEMENTOS,
  MAXIMO_LINHAS_COMPLEMENTOS_GRUPO,
  rotuloGrupoComplementos,
  TIPOS_COMPLEMENTO_VINCULADO,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { type UseFormReturnType } from '@mantine/form';
import { modals } from '@mantine/modals';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import {
  decimalParaTela,
  novaChave,
  numero,
  type ComplementoForm,
  type GrupoComplementosForm,
  type ValoresProduto,
} from './valores';

type Form = UseFormReturnType<ValoresProduto>;

const grupoNovo = (): GrupoComplementosForm => ({
  chave: novaChave(),
  id: null,
  nome: '',
  minimo: '0',
  maximo: '1',
  obrigatorio: false,
  gravado: false,
  complementos: [],
});

const complementoNovo = (): ComplementoForm => ({
  chave: novaChave(),
  id: null,
  produtoId: null,
  produto: null,
  descricao: '',
  precoAdicional: '0,00',
  baixaEstoque: false,
  quantidadeBaixa: '1',
  ativo: true,
  gravado: false,
});

/** O nome que o caixa mostra: a descrição, ou o nome do produto vinculado. */
export const nomeComplemento = (c: Pick<ComplementoForm, 'descricao' | 'produto'>) =>
  c.descricao.trim() || c.produto?.nome || '(sem nome)';

/** O grupo como a tela o resume: "Molhos (0 a 2)"; o mínimo e o máximo digitados que não são números ficam como vieram. */
export function rotuloGrupoForm(g: GrupoComplementosForm): string {
  const minimo = Number(g.minimo);
  const maximo = Number(g.maximo);
  if (!Number.isInteger(minimo) || !Number.isInteger(maximo))
    return `${g.nome || '(sem nome)'} (${g.minimo} a ${g.maximo})`;
  return rotuloGrupoComplementos({
    nome: g.nome || '(sem nome)',
    minimo,
    maximo,
    obrigatorio: g.obrigatorio,
  });
}

/** O resumo do bloco fechado: "2 grupo(s): Molhos (0 a 2), Gelo (0 a 1)". */
export function resumoComplementos(v: ValoresProduto): string | null {
  if (!v.gruposComplementos.length) return null;
  return `${v.gruposComplementos.length} grupo(s): ${v.gruposComplementos.map(rotuloGrupoForm).join(', ')}`;
}

/** Os erros que vieram do zod ou da API para os complementos (o bloco os lista e o modal os mostra no campo). */
const errosDosComplementos = (erros: Record<string, unknown>) =>
  Object.entries(erros).filter(([k]) => k === 'gruposComplementos' || k.startsWith('gruposComplementos.'));

export function BlocoComplementos({
  form,
  produtoId,
  somenteLeitura,
}: {
  form: Form;
  produtoId: string | null;
  somenteLeitura: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const v = form.getValues();
  const erros = errosDosComplementos(form.errors);
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Adicionais escolhidos na venda (molhos, gelo, fruta do drink), com o preço somado ao item e, no
        vinculado a um produto, a baixa do estoque dele. O caixa ainda vende este produto sem os complementos:
        a escolha na venda chega numa próxima versão do PDV.
      </Text>
      {v.tipo !== 'com_complementos' && v.gruposComplementos.length > 0 && (
        <Alert color="orange" variant="light">
          Só o tipo Com complementos tem complementos: exclua os grupos no modal para trocar o tipo.
        </Alert>
      )}
      {v.gruposComplementos.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhum grupo de complementos.
        </Text>
      ) : (
        <Stack gap={4} data-testid="resumo-complementos">
          {v.gruposComplementos.map((g) => (
            <Text size="sm" key={g.chave}>
              <b>{rotuloGrupoForm(g)}</b>:{' '}
              {g.complementos.filter((c) => c.ativo).length
                ? g.complementos
                    .filter((c) => c.ativo)
                    .map(
                      (c) =>
                        `${nomeComplemento(c)}${numero(c.precoAdicional) > 0 ? ` +R$ ${decimalParaTela(String(numero(c.precoAdicional)))}` : ''}`,
                    )
                    .join(', ')
                : 'nenhum complemento ativo'}
            </Text>
          ))}
        </Stack>
      )}
      {erros.length > 0 && (
        <Text size="xs" c="red" data-testid="erros-complementos">
          Verifique os complementos: {String(erros[0]![1])}
        </Text>
      )}
      <Group>
        <Button variant="default" onClick={() => setAberto(true)}>
          {somenteLeitura ? 'Ver complementos' : 'Complementos…'}
        </Button>
      </Group>
      <ModalComplementos
        form={form}
        produtoId={produtoId}
        somenteLeitura={somenteLeitura}
        aberto={aberto}
        aoFechar={() => setAberto(false)}
      />
    </Stack>
  );
}

function ModalComplementos({
  form,
  produtoId,
  somenteLeitura,
  aberto,
  aoFechar,
}: {
  form: Form;
  produtoId: string | null;
  somenteLeitura: boolean;
  aberto: boolean;
  aoFechar: () => void;
}) {
  const v = form.getValues();
  const erro = (caminho: string) => {
    const e = form.errors[caminho];
    return e ? String(e) : undefined;
  };
  const removerGrupo = (i: number) => {
    const g = v.gruposComplementos[i]!;
    if (!g.gravado) return form.removeListItem('gruposComplementos', i);
    modals.openConfirmModal({
      title: 'Excluir o grupo',
      children: (
        <Text size="sm">
          O grupo “{g.nome}” sai do cadastro e dos caixas com os {g.complementos.length} complemento(s) dele,
          ao gravar o produto.
        </Text>
      ),
      labels: { confirm: 'Excluir', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: () => form.removeListItem('gruposComplementos', i),
    });
  };
  return (
    <Modal opened={aberto} onClose={aoFechar} title="Complementos" size="90%">
      <Stack gap="md">
        {form.errors.gruposComplementos && (
          <Alert color="red" variant="light">
            {String(form.errors.gruposComplementos)}
          </Alert>
        )}
        {v.gruposComplementos.map((g, i) => (
          <Paper withBorder p="sm" key={g.chave} data-testid={`grupo-complementos-${i}`}>
            <Stack gap="xs">
              <Group align="flex-end" wrap="wrap">
                <TextInput
                  label="Grupo"
                  placeholder="Molhos"
                  required
                  maxLength={40}
                  readOnly={somenteLeitura}
                  style={{ flex: 1, minWidth: 200 }}
                  {...form.getInputProps(`gruposComplementos.${i}.nome`)}
                />
                <TextInput
                  label="Mínimo"
                  inputMode="numeric"
                  w={90}
                  readOnly={somenteLeitura}
                  {...form.getInputProps(`gruposComplementos.${i}.minimo`)}
                />
                <TextInput
                  label="Máximo"
                  inputMode="numeric"
                  w={90}
                  readOnly={somenteLeitura}
                  {...form.getInputProps(`gruposComplementos.${i}.maximo`)}
                />
                <Switch
                  label="Obrigatório"
                  mb={8}
                  disabled={somenteLeitura}
                  {...form.getInputProps(`gruposComplementos.${i}.obrigatorio`, { type: 'checkbox' })}
                />
                {!somenteLeitura && (
                  <Group gap={4} mb={4}>
                    <Tooltip label="Subir o grupo">
                      <ActionIcon
                        variant="subtle"
                        aria-label={`Subir o grupo ${g.nome}`}
                        disabled={i === 0}
                        onClick={() => form.reorderListItem('gruposComplementos', { from: i, to: i - 1 })}
                      >
                        <IconArrowUp size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Descer o grupo">
                      <ActionIcon
                        variant="subtle"
                        aria-label={`Descer o grupo ${g.nome}`}
                        disabled={i === v.gruposComplementos.length - 1}
                        onClick={() => form.reorderListItem('gruposComplementos', { from: i, to: i + 1 })}
                      >
                        <IconArrowDown size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Excluir o grupo">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Excluir o grupo ${g.nome}`}
                        onClick={() => removerGrupo(i)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                Mínimo e máximo de escolhas no caixa (ex.: 0 a 2). Obrigatório pede ao menos uma escolha.
              </Text>
              {erro(`gruposComplementos.${i}.complementos`) && (
                <Text size="xs" c="red">
                  {erro(`gruposComplementos.${i}.complementos`)}
                </Text>
              )}
              {g.complementos.length > 0 && (
                <Table data-testid={`complementos-${i}`}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Produto vinculado</Table.Th>
                      <Table.Th>Descrição</Table.Th>
                      <Table.Th>Preço adicional</Table.Th>
                      <Table.Th>Baixa estoque</Table.Th>
                      <Table.Th>Ativo</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {g.complementos.map((c, j) => {
                      const caminho = `gruposComplementos.${i}.complementos.${j}`;
                      const nome = nomeComplemento(c);
                      return (
                        <Table.Tr key={c.chave} opacity={c.ativo ? 1 : 0.6}>
                          <Table.Td>
                            <SeletorProduto
                              aria-label={`Produto do complemento ${j + 1}`}
                              placeholder="Livre (sem produto)"
                              value={c.produtoId}
                              produto={c.produto}
                              tipos={TIPOS_COMPLEMENTO_VINCULADO}
                              excluir={produtoId ? [produtoId] : []}
                              readOnly={somenteLeitura}
                              onChange={(id, p) => {
                                form.setFieldValue(`${caminho}.produtoId`, id);
                                form.setFieldValue(`${caminho}.produto`, p);
                                if (!id) form.setFieldValue(`${caminho}.baixaEstoque`, false);
                              }}
                              error={erro(`${caminho}.produtoId`)}
                              miw={220}
                            />
                            {c.produto && !c.produto.ativo && (
                              <Badge size="xs" color="gray" variant="light">
                                produto inativo
                              </Badge>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <TextInput
                              aria-label={`Descrição do complemento ${j + 1}`}
                              placeholder={c.produto ? c.produto.nome : 'Barbecue'}
                              maxLength={60}
                              readOnly={somenteLeitura}
                              miw={160}
                              {...form.getInputProps(`${caminho}.descricao`)}
                            />
                          </Table.Td>
                          <Table.Td>
                            <TextInput
                              aria-label={`Preço adicional ${nome}`}
                              leftSection="+R$"
                              w={120}
                              readOnly={somenteLeitura}
                              {...form.getInputProps(`${caminho}.precoAdicional`)}
                            />
                          </Table.Td>
                          <Table.Td>
                            <Group gap="xs" wrap="nowrap">
                              <Checkbox
                                aria-label={`Baixa estoque ${nome}`}
                                disabled={somenteLeitura || !c.produtoId}
                                {...form.getInputProps(`${caminho}.baixaEstoque`, { type: 'checkbox' })}
                                error={erro(`${caminho}.baixaEstoque`)}
                              />
                              <TextInput
                                aria-label={`Quantidade da baixa ${nome}`}
                                rightSection={
                                  <Text size="xs" c="dimmed">
                                    {c.produto?.unidadeSigla ?? ''}
                                  </Text>
                                }
                                w={110}
                                disabled={!c.baixaEstoque}
                                readOnly={somenteLeitura}
                                {...form.getInputProps(`${caminho}.quantidadeBaixa`)}
                              />
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Switch
                              aria-label={`Ativo ${nome}`}
                              disabled={somenteLeitura}
                              {...form.getInputProps(`${caminho}.ativo`, { type: 'checkbox' })}
                            />
                          </Table.Td>
                          <Table.Td>
                            {!somenteLeitura && (
                              <Tooltip
                                label={
                                  c.gravado
                                    ? 'Inativar (o complemento gravado não é excluído: o caixa pode tê-lo numa venda)'
                                    : 'Remover'
                                }
                              >
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  aria-label={`${c.gravado ? 'Inativar' : 'Remover'} ${nome}`}
                                  disabled={c.gravado && !c.ativo}
                                  onClick={() =>
                                    c.gravado
                                      ? form.setFieldValue(`${caminho}.ativo`, false)
                                      : form.removeListItem(`gruposComplementos.${i}.complementos`, j)
                                  }
                                >
                                  <IconTrash size={16} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
              {!somenteLeitura && (
                <Group>
                  <Button
                    variant="subtle"
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    disabled={
                      // O teto conta só os ativos (o inativo gravado não sai e não trava a opção nova); a
                      // lista inteira tem só o limite técnico.
                      g.complementos.filter((c) => c.ativo).length >= MAXIMO_COMPLEMENTOS_GRUPO ||
                      g.complementos.length >= MAXIMO_LINHAS_COMPLEMENTOS_GRUPO
                    }
                    onClick={() =>
                      form.insertListItem(`gruposComplementos.${i}.complementos`, complementoNovo())
                    }
                  >
                    Inserir complemento
                  </Button>
                </Group>
              )}
            </Stack>
          </Paper>
        ))}
        <Group justify="space-between">
          {!somenteLeitura ? (
            <Button
              variant="default"
              leftSection={<IconPlus size={16} />}
              disabled={v.gruposComplementos.length >= MAXIMO_GRUPOS_COMPLEMENTOS}
              onClick={() => form.insertListItem('gruposComplementos', grupoNovo())}
            >
              Novo grupo
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            {!somenteLeitura && (
              <Text size="xs" c="dimmed">
                As mudanças são gravadas com o produto (Salvar).
              </Text>
            )}
            <Button onClick={aoFechar}>Concluir</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
