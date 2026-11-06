import {
  alterarGrupoPrecoSchema,
  criarGrupoPrecoSchema,
  MODOS_PRECO_GRUPO,
  ROTULOS_MODO_PRECO_GRUPO,
  ROTULOS_ORIGEM_PRECO,
  promocaoVigente,
  simularGrupoPreco,
  type GrupoPrecoDetalhe,
  type GrupoPrecoResumo,
  type Pagina,
  type ProdutoOpcao,
} from '@genesis/shared';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { NaoEncontrado } from '../Erros';
import { AvisoPrecoVolume } from './FormularioProduto';
import { decimalParaTela, novaChave, numero, type FaixaForm } from './valores';

export const ROTA_GRUPOS_PRECO = '/produtos/grupos-preco';

/** Grupos de preço por quantidade – mix (ERP 8.10): filtros Nome, Modo, Ativo. */
export function ListaGruposPreco() {
  const config = useMemo<ConfigListagem<GrupoPrecoResumo>>(
    () => ({
      recurso: 'grupos_preco',
      titulo: 'Grupos de preço por quantidade (mix)',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_GRUPOS_PRECO}/novo`,
      rotuloNovo: 'Novo grupo',
      permissaoNovo: 'grupos_preco.editar',
      rotaEdicao: (g) => `${ROTA_GRUPOS_PRECO}/${g.id}`,
      chaveLinha: (g) => g.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto' },
        {
          campo: 'modoPreco',
          rotulo: 'Modo',
          tipo: 'selecao',
          opcoes: MODOS_PRECO_GRUPO.map((m) => ({ value: m, label: ROTULOS_MODO_PRECO_GRUPO[m] })),
        },
        {
          campo: 'situacao',
          rotulo: 'Ativo',
          tipo: 'selecao',
          padrao: 'ativos',
          opcoes: [
            { value: 'ativos', label: 'Ativos' },
            { value: 'inativos', label: 'Inativos' },
            { value: 'todos', label: 'Todos' },
          ],
        },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Código', ordenavel: true, largura: 90 },
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (g) => (
            <Anchor component={Link} to={`${ROTA_GRUPOS_PRECO}/${g.id}`} c="inherit">
              {g.nome}
            </Anchor>
          ),
        },
        { campo: 'modoPreco', rotulo: 'Modo', formato: (g) => ROTULOS_MODO_PRECO_GRUPO[g.modoPreco] },
        { campo: 'produtos', rotulo: 'Nº de produtos', ordenavel: true, alinhamento: 'right' },
        { campo: 'faixasResumo', rotulo: 'Faixas', formato: (g) => g.faixasResumo || '—' },
        {
          campo: 'ativo',
          rotulo: 'Ativo',
          formato: (g) => (
            <Badge variant="light" color={g.ativo ? 'green' : 'gray'}>
              {g.ativo ? 'Sim' : 'Não'}
            </Badge>
          ),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<GrupoPrecoResumo>>(`/grupos-preco-quantidade${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

interface ValoresGrupo extends Record<string, unknown> {
  nome: string;
  modoPreco: 'produto' | 'grupo';
  ativo: boolean;
  faixas: FaixaForm[];
  produtos: ProdutoOpcao[];
}

const VAZIO: ValoresGrupo = { nome: '', modoPreco: 'produto', ativo: true, faixas: [], produtos: [] };

function paraValores(g: GrupoPrecoDetalhe): ValoresGrupo {
  return {
    nome: g.nome,
    modoPreco: g.modoPreco,
    ativo: g.ativo,
    faixas: g.faixas.map((f) => ({
      chave: f.id,
      id: f.id,
      lojaId: f.lojaId ?? '',
      quantidadeInicial: decimalParaTela(f.quantidadeInicial, 3),
      quantidadeFinal: decimalParaTela(f.quantidadeFinal, 3),
      preco: decimalParaTela(f.preco),
    })),
    produtos: g.produtos,
  };
}

/** Grupo de preço por quantidade (ERP 8.10): faixas (modo grupo), produtos do grupo e o botão Simular. */
export function FormularioGrupoPreco() {
  const { id } = useParams();
  const pode = usePode();
  const eu = useEu();
  const form = useForm<ValoresGrupo>({ mode: 'controlled', initialValues: VAZIO });
  const confirmarMover = useRef(false);
  const c = useCadastro<GrupoPrecoDetalhe, ValoresGrupo>({
    api: '/grupos-preco-quantidade',
    rota: ROTA_GRUPOS_PRECO,
    recurso: 'grupos_preco',
    id,
    form,
    paraValores,
    paraCorpo: (v) => ({
      nome: v.nome,
      modoPreco: v.modoPreco,
      ativo: v.ativo,
      faixas:
        v.modoPreco === 'grupo'
          ? v.faixas.map((f) => ({
              id: f.id,
              lojaId: f.lojaId || null,
              quantidadeInicial: f.quantidadeInicial,
              quantidadeFinal: f.quantidadeFinal.trim() || null,
              preco: f.preco,
            }))
          : [],
      produtos: v.produtos.map((p) => p.id),
      confirmarMover: confirmarMover.current,
    }),
    schemaCriar: criarGrupoPrecoSchema,
    schemaAlterar: alterarGrupoPrecoSchema,
  });

  // Produto que já está em outro grupo: confirma e move (ERP 8.10).
  useEffect(() => {
    const e = c.erro;
    if (!(e instanceof ErroRequisicao) || e.codigo !== 'CONFLITO' || !e.corpo.detalhes?.moverDeOutroGrupo)
      return;
    modals.openConfirmModal({
      title: 'Produto em outro grupo',
      children: <Text size="sm">{e.message}</Text>,
      labels: { confirm: 'Mover para este grupo', cancel: 'Cancelar' },
      onConfirm: () => {
        confirmarMover.current = true;
        c.salvar();
        confirmarMover.current = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.erro]);

  const [novoMembro, setNovoMembro] = useState<string | null>(null);
  const [qtdSimulacao, setQtdSimulacao] = useState<Record<string, string>>({});
  const [lojaSimulacao, setLojaSimulacao] = useState('');
  const precoVolume = useQuery({
    queryKey: ['produtos', 'preco-volume'],
    queryFn: () =>
      apiErp.get<{ lojasDesligadas: Array<{ id: string; nome: string }> }>('/produtos/preco-volume'),
    staleTime: 60_000,
    enabled: pode('produtos.ver'),
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_GRUPOS_PRECO} />;
  const g = c.registro.data;
  const v = form.getValues();
  const lojas = eu.lojas.filter((l) => l.ativa);
  const simulacao = simularGrupoPreco(
    {
      ativo: v.ativo,
      modo: v.modoPreco,
      faixas: v.faixas.map((f) => ({
        lojaId: f.lojaId || null,
        quantidadeInicial: numero(f.quantidadeInicial),
        quantidadeFinal: f.quantidadeFinal.trim() ? numero(f.quantidadeFinal) : null,
        preco: numero(f.preco),
      })),
    },
    v.produtos
      .filter((p) => numero(qtdSimulacao[p.id]) > 0)
      .map((p) => {
        // Mesma regra do PDV (11.3): preço da loja simulada, promoção vigente e faixas próprias do membro.
        const proprios = g?.precosMembros?.find((m) => m.produtoId === p.id);
        const daLoja = lojaSimulacao ? proprios?.lojas.find((l) => l.lojaId === lojaSimulacao) : undefined;
        return {
          produtoId: p.id,
          nome: p.nome,
          quantidade: numero(qtdSimulacao[p.id]),
          produto: {
            precoVenda: Number(p.precoVenda),
            precoLoja: daLoja?.precoVenda ? Number(daLoja.precoVenda) : null,
            precoPromocional: proprios?.precoPromocional ? Number(proprios.precoPromocional) : null,
            promocaoVigente: proprios ? promocaoVigente(proprios) : false,
            precoAtacado: p.precoAtacado === null ? null : Number(p.precoAtacado),
            qtdMinimaAtacado: p.qtdMinimaAtacado === null ? null : Number(p.qtdMinimaAtacado),
            faixas: (proprios?.faixas ?? []).map((f) => ({
              lojaId: f.lojaId,
              quantidadeInicial: Number(f.quantidadeInicial),
              quantidadeFinal: f.quantidadeFinal === null ? null : Number(f.quantidadeFinal),
              preco: Number(f.preco),
            })),
          },
        };
      }),
    // O Simular supõe "Usa Produto Preço Volume" ligado (decisão 28); o aviso diz onde não está.
    { usaPrecoVolume: true, lojaId: lojaSimulacao || null },
  );
  const lojasDesligadas = (precoVolume.data?.lojasDesligadas ?? []).filter(
    (l) => !lojaSimulacao || l.id === lojaSimulacao,
  );

  const conteudo = (
    <Stack gap="md">
      <Grid>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput
            label="Nome"
            required
            maxLength={60}
            description="Aparece no PDV e no comprovante"
            {...form.getInputProps('nome')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 8, sm: 4 }}>
          <Select
            label="Modo de preço"
            allowDeselect={false}
            data={MODOS_PRECO_GRUPO.map((m) => ({ value: m, label: ROTULOS_MODO_PRECO_GRUPO[m] }))}
            {...form.getInputProps('modoPreco')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 4, sm: 2 }}>
          <Switch mt={30} label="Ativo" {...form.getInputProps('ativo', { type: 'checkbox' })} />
        </Grid.Col>
      </Grid>
      <Text size="xs" c="dimmed">
        {v.modoPreco === 'produto'
          ? 'A soma das quantidades do grupo ativa o atacado e as faixas de cada produto (cada um com o seu preço).'
          : 'O preço vem das faixas do grupo, igual para todos os produtos. Só vale com “Usa Produto Preço Volume”.'}
      </Text>
      <AvisoPrecoVolume lojas={precoVolume.data?.lojasDesligadas ?? []} />
      {v.modoPreco === 'grupo' && (
        <Stack gap="xs">
          <Title order={5} size="h6">
            Faixas
          </Title>
          {form.errors.faixas && (
            <Text size="sm" c="red">
              {form.errors.faixas}
            </Text>
          )}
          {v.faixas.map((f, i) => (
            <Group key={f.chave} gap="xs" align="flex-start">
              <Select
                aria-label="Loja da faixa"
                w={200}
                allowDeselect={false}
                disabled={!!f.id}
                data={[
                  { value: '', label: 'Todas as lojas' },
                  ...lojas.map((l) => ({ value: l.id, label: l.nome })),
                ]}
                {...form.getInputProps(`faixas.${i}.lojaId`)}
              />
              <TextInput
                aria-label="Qtd inicial"
                placeholder="Qtd inicial"
                w={110}
                {...form.getInputProps(`faixas.${i}.quantidadeInicial`)}
              />
              <TextInput
                aria-label="Qtd final"
                placeholder="Sem limite"
                w={110}
                {...form.getInputProps(`faixas.${i}.quantidadeFinal`)}
              />
              <TextInput
                aria-label="Preço"
                leftSection="R$"
                w={120}
                {...form.getInputProps(`faixas.${i}.preco`)}
              />
              <ActionIcon
                mt={4}
                color="red"
                variant="subtle"
                aria-label={`Remover faixa ${i + 1}`}
                onClick={() => form.removeListItem('faixas', i)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() =>
                form.insertListItem('faixas', {
                  chave: novaChave(),
                  id: null,
                  lojaId: '',
                  quantidadeInicial: '',
                  quantidadeFinal: '',
                  preco: '',
                })
              }
            >
              Inserir faixa
            </Button>
          </Group>
        </Stack>
      )}

      <Title order={5} size="h6">
        Produtos do grupo
      </Title>
      {form.errors.produtos && (
        <Text size="sm" c="red">
          {form.errors.produtos}
        </Text>
      )}
      <Group align="flex-end">
        <SeletorProduto
          label="Inserir produto"
          w={360}
          tipos={['simples', 'com_variacoes', 'produzido']}
          excluir={v.produtos.map((p) => p.id)}
          value={novoMembro}
          onChange={(id, p) => {
            setNovoMembro(null);
            if (id && p) form.insertListItem('produtos', p);
          }}
        />
      </Group>
      <Table data-testid="membros">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Código</Table.Th>
            <Table.Th>Nome</Table.Th>
            <Table.Th>Unidade</Table.Th>
            <Table.Th ta="right">Preço de venda</Table.Th>
            <Table.Th ta="right">Atacado</Table.Th>
            <Table.Th>Simular (qtd)</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {v.produtos.map((p, i) => {
            const s = simulacao.find((x) => x.produtoId === p.id);
            return (
              <Table.Tr key={p.id}>
                <Table.Td>{p.codigo}</Table.Td>
                <Table.Td>
                  {p.nome}
                  {form.errors[`produtos.${i}`] && (
                    <Text size="xs" c="red">
                      {form.errors[`produtos.${i}`]}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{p.unidadeSigla}</Table.Td>
                <Table.Td ta="right">R$ {decimalParaTela(p.precoVenda)}</Table.Td>
                <Table.Td ta="right">
                  {p.precoAtacado
                    ? `R$ ${decimalParaTela(p.precoAtacado)}${p.qtdMinimaAtacado ? ` (${decimalParaTela(p.qtdMinimaAtacado, 3)}+)` : ''}`
                    : '—'}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <TextInput
                      aria-label={`Quantidade simulada ${p.nome}`}
                      size="xs"
                      w={70}
                      value={qtdSimulacao[p.id] ?? ''}
                      onChange={(e) => {
                        const valor = e.currentTarget.value;
                        setQtdSimulacao((q) => ({ ...q, [p.id]: valor }));
                      }}
                    />
                    {s && (
                      <Text size="xs" data-testid={`simulacao-${p.id}`}>
                        R$ {decimalParaTela(String(s.preco))} · {ROTULOS_ORIGEM_PRECO[s.origem]}
                      </Text>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    aria-label={`Remover ${p.nome}`}
                    onClick={() => form.removeListItem('produtos', i)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {simulacao.length > 0 && lojasDesligadas.length > 0 && (
        <Text size="xs" c="orange" data-testid="simulacao-desligada">
          Simulação com a chave ligada: desligado nas lojas {lojasDesligadas.map((l) => l.nome).join(', ')}{' '}
          (lá as faixas não valem).
        </Text>
      )}
      {simulacao.length > 0 && (
        <Group gap="md">
          <Text size="sm" data-testid="simulacao-total">
            Simulação: {decimalParaTela(String(simulacao.reduce((t, s) => t + s.quantidade, 0)), 3)} un do
            grupo · total R$ {decimalParaTela(String(simulacao.reduce((t, s) => t + s.total, 0)))}
          </Text>
          {lojas.length > 0 && (
            <Select
              aria-label="Loja da simulação"
              size="xs"
              w={200}
              allowDeselect={false}
              value={lojaSimulacao}
              onChange={(l) => setLojaSimulacao(l ?? '')}
              data={[
                { value: '', label: 'Faixas de todas as lojas' },
                ...lojas.map((l) => ({ value: l.id, label: l.nome })),
              ]}
            />
          )}
        </Group>
      )}
    </Stack>
  );

  return (
    <FormularioEntidade
      titulo={c.novo ? 'Novo grupo de preço' : (g?.nome ?? 'Grupo de preço')}
      codigo={g?.codigo}
      situacao={g ? (g.ativo ? { rotulo: 'Ativo', cor: 'green' } : { rotulo: 'Inativo', cor: 'gray' }) : null}
      alteradoEm={g?.atualizadoEm}
      alteradoPor={g?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={!pode('grupos_preco.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_GRUPOS_PRECO}
      rotaNovo={!c.novo && pode('grupos_preco.editar') ? `${ROTA_GRUPOS_PRECO}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('grupos_preco.editar') ? c.excluir : undefined}
      erro={c.erro instanceof ErroRequisicao && c.erro.corpo.detalhes?.moverDeOutroGrupo ? null : c.erro}
      aoRecarregar={c.recarregar}
      historico={g ? { entidade: 'grupos_preco_quantidade', registroId: g.id } : undefined}
      abas={[{ valor: 'dados', rotulo: 'Grupo', conteudo, comErro: Object.keys(form.errors).length > 0 }]}
    />
  );
}
