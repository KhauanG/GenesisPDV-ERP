import {
  custoEntradaItemNfeTexto,
  partesLoteRastroNfe,
  quantidadeEstoqueNfeTexto,
  ROTULOS_ATUALIZAR_PRECO,
  ROTULOS_ORIGEM_VINCULO_NFE,
  type DadosCompraProdutos,
  type ItemNotaEntradaDetalhe,
  type NotaEntradaDetalhe,
  type OrigemVinculoNfe,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconBan, IconCheck, IconPlus } from '@tabler/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { useUnidades } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { CadastroRapidoProduto, type InicialProdutoRapido } from '../../componentes/CadastroRapidoProduto';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import {
  contasDaLinha,
  desfazerIgnorar,
  fatorDivergeDaNota,
  fatorDivergente,
  linhaConfirmavel,
  linhaDoItem,
  linhaParaApi,
  linhaResolvida,
  origemDaLinha,
  paraCampo,
  produtoDiverge,
  trocarProduto,
  type LinhaVinculo,
} from './notasEntradaItens';
import { dadosCompraEmBlocos, TIPOS_RECEBIMENTO } from './recebimentoItens';

const CORES_ORIGEM: Record<OrigemVinculoNfe, string> = {
  vinculo_anterior: 'teal',
  ean: 'blue',
  manual: 'gray',
};
const OPCOES_ATUALIZAR = (['nao', 'geral', 'loja'] as const).map((v) => ({
  value: v,
  label: ROTULOS_ATUALIZAR_PRECO[v],
}));

const reais = (v: string | null | undefined, casas = 2) =>
  v === null || v === undefined ? '—' : `R$ ${formatarDecimal(Number(v), casas)}`;
const qtd = (v: string, casas = 4) => formatarDecimal(Number(v), casas);

/** Os erros da API (`itens.N.campo`) por linha (a posição no corpo enviado = a da tela) e campo. */
type ErrosLinhas = Record<number, Record<string, string>>;
function errosPorLinha(campos: Record<string, string[]>): ErrosLinhas {
  const r: ErrosLinhas = {};
  for (const [k, v] of Object.entries(campos)) {
    const m = /^itens\.(\d+)\.(\w+)$/.exec(k);
    if (!m) continue;
    (r[Number(m[1])] ??= {})[m[2]!] = v[0] ?? '';
  }
  return r;
}

/** O item do XML: código e descrição do fornecedor, EANs, NCM, CFOP e as quantidades comercial e tributável. */
function ItemDoXml({ item }: { item: ItemNotaEntradaDetalhe }) {
  const trib =
    item.quantidadeTributavel !== null &&
    item.unidadeTributavel !== null &&
    (item.unidadeTributavel !== item.unidadeComercial ||
      Number(item.quantidadeTributavel) !== Number(item.quantidadeComercial));
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {item.descricao}
      </Text>
      <Text size="xs" c="dimmed">
        Cód. {item.codigoFornecedor} · EAN {item.ean ?? 'SEM GTIN'}
        {item.eanTributavel && item.eanTributavel !== item.ean ? ` / ${item.eanTributavel}` : ''} · NCM{' '}
        {item.ncm ?? '—'} · CFOP {item.cfop}
      </Text>
      <Text size="xs">
        {qtd(item.quantidadeComercial)} {item.unidadeComercial} × {reais(item.valorUnitarioComercial, 4)}
        {trib ? ` (= ${qtd(item.quantidadeTributavel!)} ${item.unidadeTributavel})` : ''}
      </Text>
    </Stack>
  );
}

/**
 * Aba "Itens e vinculação" da NF-e (ERP 13.4.1; Fase 2, F2-B20; README do ERP › decisão 61): cada item do XML com o
 * produto (a sugestão do vínculo anterior ou do EAN já preenchida, com a origem visível), a embalagem e o fator
 * **por confirmar** (com o destaque quando diverge do vínculo aprendido com o fornecedor), a quantidade no estoque, o
 * custo de entrada, o lote do rastro, o preço de venda proposto com o markup ⇄ preço do recebimento e "Ignorar item"
 * com motivo. "Cadastrar novo produto" abre o modal do recebimento pré-preenchido com o item. Gravar manda todos os
 * itens; a nota fica "pronta" quando todos estão vinculados com o fator confirmado ou ignorados. Montada com a versão
 * da nota na `key`: a nota regravada recomeça as linhas pelo que foi gravado.
 */
export function AbaItensNota({
  nota,
  podeEditar,
  errosAcao,
}: {
  nota: NotaEntradaDetalhe;
  podeEditar: boolean;
  /**
   * Os erros por item da ação do cabeçalho (`itens.N.campo` do Movimentar, F2-B21: o lote já cadastrado com outra
   * validade, a embalagem que deixou de ser de compra, o código ligado a outro produto): destacados nas linhas como os
   * do `PUT`, até a linha ser alterada.
   */
  errosAcao?: Record<string, string[]>;
}) {
  const queryClient = useQueryClient();
  const pode = usePode();
  const unidades = useUnidades();
  const [linhas, setLinhas] = useState<LinhaVinculo[]>(() => nota.itens.map(linhaDoItem));
  const [erros, setErros] = useState<ErrosLinhas>(() => errosPorLinha(errosAcao ?? {}));
  // Os erros da ação mudaram (outro Movimentar recusado): passam a ser os destacados (o ajuste no render, sem efeito).
  const [errosAcaoVistos, setErrosAcaoVistos] = useState(errosAcao);
  if (errosAcao !== errosAcaoVistos) {
    setErrosAcaoVistos(errosAcao);
    if (errosAcao) setErros(errosPorLinha(errosAcao));
  }
  const [ignorando, setIgnorando] = useState<number | null>(null);
  const [motivo, setMotivo] = useState('');
  const [cadastrando, setCadastrando] = useState<number | null>(null);
  const config = nota.vinculacao;
  const podeAlterarPreco = config.podeAlterarPreco;

  const ids = [...new Set(linhas.map((l) => l.produto?.id).filter((x): x is string => !!x))].sort();
  const dados = useQuery({
    queryKey: ['nota-entrada-dados', nota.estoqueId, nota.tipoEstoqueId, nota.lojaId, ids.join(',')],
    queryFn: () =>
      dadosCompraEmBlocos(ids, (bloco) =>
        apiErp.get<DadosCompraProdutos>(
          `/notas-entrada/dados-produtos${query({
            produtoIds: bloco.join(','),
            estoqueId: nota.estoqueId,
            tipoEstoqueId: nota.tipoEstoqueId,
            lojaId: nota.lojaId,
          })}`,
        ),
      ),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const dadosDo = (produtoId: string | undefined) =>
    produtoId ? dados.data?.produtos.find((p) => p.produtoId === produtoId) : undefined;

  const alterar = (i: number, mudanca: (l: LinhaVinculo) => LinhaVinculo) => {
    setLinhas((ls) => ls.map((l, j) => (j === i ? mudanca(l) : l)));
    setErros((e) => {
      if (!(i in e)) return e;
      const resto = { ...e };
      delete resto[i];
      return resto;
    });
  };

  const contas = linhas.map((l, i) => contasDaLinha(l, nota.itens[i]!, config, dadosDo(l.produto?.id)));
  const resolvidos = linhas.filter(linhaResolvida).length;
  const porConfirmar = linhas.filter((l) => !l.ignorado && l.produto && !l.fatorConfirmado).length;
  // O fator vazio ou inválido não se confirma (o PUT o recusaria: "Informe o fator").
  const confirmaveis = linhas.filter((l) => linhaConfirmavel(l) && !l.fatorConfirmado).length;

  const salvar = useMutation({
    mutationFn: () =>
      apiErp.put<NotaEntradaDetalhe>(`/notas-entrada/${nota.id}/itens`, {
        versao: nota.versao,
        itens: linhas.map((l, i) => linhaParaApi(l, contas[i] ?? null, podeAlterarPreco)),
      }),
    onSuccess: (d) => {
      setErros({});
      queryClient.setQueryData(['nota-entrada', nota.id], d);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
      notifications.show({
        color: 'green',
        message:
          d.status === 'pronta'
            ? 'Vinculação gravada: a nota está pronta para movimentar.'
            : 'Vinculação gravada.',
      });
    },
    onError: (e) => {
      if (e instanceof ErroRequisicao && e.campos) setErros(errosPorLinha(e.campos));
    },
  });

  /** O modal "Cadastrar novo produto" com o item: o EAN e a unidade tributáveis (a do produto) e o custo por unidade. */
  function inicialDoItem(item: ItemNotaEntradaDetalhe): InicialProdutoRapido {
    const sigla = item.unidadeTributavel ?? item.unidadeComercial;
    const unidadeId = unidades.data?.find((u) => u.sigla.toUpperCase() === sigla.toUpperCase())?.id;
    const quantidade = quantidadeEstoqueNfeTexto(item.quantidadeComercial, item.fatorTributavel ?? '1');
    return {
      nome: item.descricao,
      ean: item.eanTributavel ?? item.ean ?? '',
      ...(unidadeId ? { unidadeId } : {}),
      ...(item.ncm ? { ncm: item.ncm } : {}),
      cest: item.cest ?? '',
      precoCusto: custoEntradaItemNfeTexto(item, quantidade, config.parcelasCusto),
    };
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm">
          {resolvidos} de {linhas.length} item(ns) resolvido(s)
          {porConfirmar ? ` · ${porConfirmar} com o fator por confirmar` : ''}
        </Text>
        {podeEditar && (
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconCheck size={16} />}
              disabled={!confirmaveis}
              onClick={() =>
                setLinhas((ls) => ls.map((l) => (linhaConfirmavel(l) ? { ...l, fatorConfirmado: true } : l)))
              }
            >
              Confirmar todos os fatores
            </Button>
            <Button loading={salvar.isPending} onClick={() => salvar.mutate()}>
              Salvar vinculação
            </Button>
          </Group>
        )}
      </Group>
      {salvar.error && <Alert color="red">{(salvar.error as Error).message}</Alert>}
      <ScrollArea type="auto">
        <Table striped verticalSpacing="xs" miw={1100} aria-label="Itens da nota">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Item da nota</Table.Th>
              <Table.Th miw={260}>Produto</Table.Th>
              <Table.Th>Fator</Table.Th>
              <Table.Th ta="right">Custo un.</Table.Th>
              <Table.Th>Lote / validade</Table.Th>
              <Table.Th>Preço de venda</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {linhas.map((l, i) => {
              const item = nota.itens[i]!;
              const e = erros[i] ?? {};
              const c = contas[i];
              const d = dadosDo(l.produto?.id);
              const origem = origemDaLinha(l, item);
              const divergente = fatorDivergente(l, item);
              const daNota = divergente ? null : fatorDivergeDaNota(l, item);
              const lote =
                item.rastro.length > 0 || !!d?.temLotes || !!d?.solicitaLotePdv || !!l.lote || !!l.validade;
              // O item em mais de um lote do rastro, com o lote sugerido mantido, entra em cada lote com a sua parte
              // ao movimentar (F2-B21; a mesma divisão da API).
              const partesRastro =
                c && l.lote.trim()
                  ? partesLoteRastroNfe(
                      { lote: l.lote.trim(), validade: null, fabricacao: null, rastro: item.rastro },
                      c.quantidadeEstoque,
                    )
                  : null;
              return (
                <Table.Tr key={l.id} data-testid={`item-${item.numeroItem}`}>
                  <Table.Td>{item.numeroItem}</Table.Td>
                  <Table.Td maw={320}>
                    <ItemDoXml item={item} />
                  </Table.Td>
                  {l.ignorado ? (
                    <Table.Td colSpan={5}>
                      <Text size="sm" c="dimmed">
                        Ignorado: {l.motivoIgnorado}
                      </Text>
                      {e.motivoIgnorado && (
                        <Text size="xs" c="red">
                          {e.motivoIgnorado}
                        </Text>
                      )}
                    </Table.Td>
                  ) : (
                    <>
                      <Table.Td>
                        <Stack gap={4}>
                          {podeEditar ? (
                            <Group gap={4} wrap="nowrap" align="flex-start">
                              <SeletorProduto
                                aria-label={`Produto do item ${item.numeroItem}`}
                                style={{ flex: 1 }}
                                value={l.produto?.id ?? null}
                                produto={l.produto}
                                tipos={TIPOS_RECEBIMENTO}
                                error={e.produtoId}
                                onChange={(_id, p) => alterar(i, (x) => trocarProduto(x, item, p))}
                              />
                              {pode('produtos.criar') && (
                                <Tooltip label="Cadastrar novo produto">
                                  <ActionIcon
                                    variant="default"
                                    size="lg"
                                    aria-label={`Cadastrar novo produto do item ${item.numeroItem}`}
                                    onClick={() => setCadastrando(i)}
                                  >
                                    <IconPlus size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              )}
                            </Group>
                          ) : (
                            <Text size="sm">
                              {l.produto ? `${l.produto.codigo} - ${l.produto.nome}` : '—'}
                            </Text>
                          )}
                          {origem && (
                            <Badge size="xs" variant="light" color={CORES_ORIGEM[origem]}>
                              {ROTULOS_ORIGEM_VINCULO_NFE[origem]}
                            </Badge>
                          )}
                          {produtoDiverge(l, item) && (
                            <Text size="xs" c="orange">
                              O fornecedor costuma vir vinculado a outro produto.
                            </Text>
                          )}
                          {podeEditar && d && d.embalagens.length > 0 && (
                            <Select
                              size="xs"
                              aria-label={`Embalagem do item ${item.numeroItem}`}
                              placeholder="Unidade do produto"
                              clearable
                              data={d.embalagens.map((emb) => ({
                                value: emb.id,
                                label: `${emb.descricao ?? emb.unidadeSigla ?? 'Embalagem'} (${emb.codigo}) × ${paraCampo(emb.fator, 3)}`,
                              }))}
                              value={l.codigoBarrasId}
                              error={e.codigoBarrasId}
                              onChange={(v) =>
                                alterar(i, (x) => {
                                  const emb = d.embalagens.find((m) => m.id === v);
                                  return {
                                    ...x,
                                    codigoBarrasId: v,
                                    fator: emb ? paraCampo(emb.fator, 3) : x.fator,
                                    fatorConfirmado: false,
                                  };
                                })
                              }
                            />
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td miw={130}>
                        <Stack gap={4}>
                          <TextInput
                            size="xs"
                            aria-label={`Fator do item ${item.numeroItem}`}
                            value={l.fator}
                            disabled={!podeEditar}
                            error={e.fator}
                            styles={
                              divergente || daNota
                                ? { input: { borderColor: 'var(--mantine-color-orange-6)' } }
                                : undefined
                            }
                            onChange={(ev) => {
                              const v = ev.currentTarget.value;
                              alterar(i, (x) => ({
                                ...x,
                                fator: v,
                                codigoBarrasId: null,
                                fatorConfirmado: false,
                              }));
                            }}
                          />
                          {divergente && (
                            <Text size="xs" c="orange">
                              Vínculo anterior: fator {paraCampo(divergente, 3)}
                            </Text>
                          )}
                          {daNota && (
                            <Text size="xs" c="orange">
                              Pelas quantidades da nota: fator {paraCampo(daNota, 3)}
                            </Text>
                          )}
                          {c && (
                            <Text size="xs" c="dimmed">
                              = {qtd(c.quantidadeEstoque, 3)} {l.produto?.unidadeSigla}
                            </Text>
                          )}
                          <Checkbox
                            size="xs"
                            label="Fator confirmado"
                            checked={l.fatorConfirmado}
                            disabled={!podeEditar || !linhaConfirmavel(l)}
                            onChange={(ev) => {
                              const v = ev.currentTarget.checked;
                              alterar(i, (x) => ({ ...x, fatorConfirmado: v }));
                            }}
                          />
                        </Stack>
                      </Table.Td>
                      <Table.Td ta="right">{c ? reais(c.custo, 4) : '—'}</Table.Td>
                      <Table.Td miw={140}>
                        {lote ? (
                          <Stack gap={4}>
                            <TextInput
                              size="xs"
                              aria-label={`Lote do item ${item.numeroItem}`}
                              placeholder="Lote"
                              value={l.lote}
                              disabled={!podeEditar}
                              error={e.lote}
                              onChange={(ev) => {
                                const v = ev.currentTarget.value;
                                alterar(i, (x) => ({ ...x, lote: v }));
                              }}
                            />
                            <TextInput
                              size="xs"
                              aria-label={`Validade do item ${item.numeroItem}`}
                              placeholder="Validade dd/mm/aaaa"
                              value={l.validade}
                              disabled={!podeEditar}
                              error={e.validade ?? e.fabricacao}
                              onChange={(ev) => {
                                const v = ev.currentTarget.value;
                                alterar(i, (x) => ({ ...x, validade: v }));
                              }}
                            />
                            {partesRastro && (
                              <Text size="xs" c="dimmed" data-testid={`partes-rastro-${item.numeroItem}`}>
                                Entra em {partesRastro.length} lotes do rastro:{' '}
                                {partesRastro.map((p) => `${p.lote} (${qtd(p.quantidade, 3)})`).join(', ')}
                              </Text>
                            )}
                          </Stack>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td miw={170}>
                        {l.produto && (
                          <Stack gap={4}>
                            <Group gap={4} wrap="nowrap">
                              <TextInput
                                size="xs"
                                aria-label={`Preço de venda do item ${item.numeroItem}`}
                                placeholder="Preço"
                                value={
                                  l.markup !== null && l.markup !== ''
                                    ? paraCampo(c?.precoVenda, 2)
                                    : l.precoVenda
                                }
                                disabled={!podeEditar || !podeAlterarPreco}
                                error={e.precoVenda}
                                onChange={(ev) => {
                                  const v = ev.currentTarget.value;
                                  alterar(i, (x) => ({ ...x, precoVenda: v, markup: null }));
                                }}
                              />
                              <TextInput
                                size="xs"
                                w={80}
                                aria-label={`Markup do item ${item.numeroItem}`}
                                placeholder="%"
                                value={l.markup ?? paraCampo(c?.markupPct, 2)}
                                disabled={!podeEditar || !podeAlterarPreco}
                                onChange={(ev) => {
                                  const v = ev.currentTarget.value;
                                  alterar(i, (x) => ({ ...x, markup: v }));
                                }}
                              />
                            </Group>
                            <Text size="xs" c="dimmed">
                              Atual: {reais(d?.precoVendaLoja ?? l.produto.precoVenda)}
                            </Text>
                            {podeAlterarPreco && podeEditar && (
                              <Select
                                size="xs"
                                aria-label={`Atualizar preço do item ${item.numeroItem}`}
                                allowDeselect={false}
                                data={OPCOES_ATUALIZAR}
                                value={l.atualizarPreco}
                                onChange={(v) =>
                                  alterar(i, (x) => ({
                                    ...x,
                                    atualizarPreco: (v ?? 'nao') as typeof x.atualizarPreco,
                                  }))
                                }
                              />
                            )}
                          </Stack>
                        )}
                      </Table.Td>
                    </>
                  )}
                  <Table.Td>
                    {podeEditar &&
                      (l.ignorado ? (
                        <Tooltip label="Desfazer o ignorar">
                          <ActionIcon
                            variant="default"
                            aria-label={`Desfazer ignorar do item ${item.numeroItem}`}
                            onClick={() => alterar(i, (x) => desfazerIgnorar(x, item))}
                          >
                            <IconArrowBackUp size={16} />
                          </ActionIcon>
                        </Tooltip>
                      ) : (
                        <Tooltip label="Ignorar item">
                          <ActionIcon
                            variant="default"
                            color="red"
                            aria-label={`Ignorar o item ${item.numeroItem}`}
                            onClick={() => {
                              setMotivo('');
                              setIgnorando(i);
                            }}
                          >
                            <IconBan size={16} />
                          </ActionIcon>
                        </Tooltip>
                      ))}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Text size="xs" c="dimmed">
        A nota fica pronta quando todos os itens estão vinculados com o fator confirmado ou ignorados. O CFOP
        é só o do XML (sem conversão nesta fase).
      </Text>
      <Modal opened={ignorando !== null} onClose={() => setIgnorando(null)} title="Ignorar item">
        <Stack>
          <Text size="sm">O item não entra no estoque quando a nota for movimentada.</Text>
          <Textarea
            label="Motivo"
            required
            autosize
            minRows={2}
            maxLength={255}
            value={motivo}
            onChange={(ev) => setMotivo(ev.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setIgnorando(null)}>
              Voltar
            </Button>
            <Button
              color="red"
              disabled={!motivo.trim()}
              onClick={() => {
                const i = ignorando!;
                alterar(i, (x) => ({ ...x, ignorado: true, motivoIgnorado: motivo.trim() }));
                setIgnorando(null);
              }}
            >
              Ignorar item
            </Button>
          </Group>
        </Stack>
      </Modal>
      {cadastrando !== null && (
        <CadastroRapidoProduto
          aberto
          aoFechar={() => setCadastrando(null)}
          inicial={inicialDoItem(nota.itens[cadastrando]!)}
          aoSalvar={(p) => {
            const i = cadastrando;
            alterar(i, (x) => trocarProduto(x, nota.itens[i]!, p));
          }}
        />
      )}
    </Stack>
  );
}
