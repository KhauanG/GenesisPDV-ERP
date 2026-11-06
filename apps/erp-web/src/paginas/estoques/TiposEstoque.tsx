import {
  alterarTipoEstoqueSchema,
  CHAVES_TIPO_ESTOQUE_SEMPRE_ATIVAS,
  criarTipoEstoqueSchema,
  errosRegraTipoEstoque,
  VENDAVEL_TRAVADO_POR_CHAVE,
  type TipoEstoqueDetalhe,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { usePode } from '../../auth/permissoes';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { NaoEncontrado } from '../Erros';
import { badgeAtivo } from './Estoques';

export const ROTA_TIPOS_ESTOQUE = '/estoque/tipos';

/** Chave da lista (a mesma que a gravação invalida, `['listagem', recurso]`). */
const CHAVE_LISTA = ['listagem', 'tipos-estoque'];

/**
 * Uso de cada tipo do seed (ERP 13.6; MD 7.4), pela chave de sistema (o nome é editável). De onde o caixa vende não
 * vem da chave: as vendas baixam do padrão, qualquer que seja (`usoDoTipo`).
 */
const USOS: Record<string, string> = {
  disponivel: 'Mercadoria à venda (o padrão de fábrica)',
  avaria: 'Avariado: não vende; aguarda troca ou baixa',
  vencido: 'Vencido: não vende; aguarda troca ou descarte',
  uso_consumo: 'Consumo interno da loja (não vende)',
  vasilhame_vazio: 'Cascos vazios devolvidos pelo cliente (PDV 10.12)',
};

/** Por que o "Vendável" do tipo do sistema não muda, pelo valor travado (`VENDAVEL_TRAVADO_POR_CHAVE`). */
const MOTIVO_TRAVA_VENDAVEL = {
  vendavel:
    'O "Vendável" deste tipo do sistema não muda: é o padrão de fábrica e pode voltar a ser o padrão das vendas.',
  naoVendavel:
    'O "Vendável" deste tipo do sistema não muda e ele não pode ser o padrão: os cascos vazios não se vendem.',
};

/** Ajuda das chaves: no padrão, de onde o caixa vende; nos outros, as regras de inativar e de tirar o "Vendável". */
const AJUDA = {
  padrao:
    'Este é o padrão: as vendas do caixa baixam dele. Sempre há um tipo padrão: para trocar, marque "Padrão" em ' +
    'outro tipo.',
  outros:
    'Inativar exige saldo zero em todos os estoques e nenhum acerto nem recebimento em rascunho no tipo; tirar o ' +
    '"Vendável" também exige saldo zero.',
};

/** Uso da coluna da lista: o do seed e, no padrão, que as vendas do caixa baixam dele. */
function usoDoTipo(t: Pick<TipoEstoqueOpcao, 'chaveSistema' | 'padrao'>): string {
  const partes = [
    t.chaveSistema ? USOS[t.chaveSistema] : undefined,
    t.padrao ? 'as vendas do caixa baixam deste tipo' : undefined,
  ].filter((p): p is string => !!p);
  if (!partes.length) return '—';
  const texto = partes.join('; ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

const useTipos = () =>
  useQuery({ queryKey: CHAVE_LISTA, queryFn: () => apiErp.get<TipoEstoqueOpcao[]>('/tipos-estoque') });

/**
 * Tipo de Estoque – listagem (ERP 13.6): Nome, Uso, Vendável, Padrão, Ativo. Poucos registros: a lista vem inteira
 * (o mesmo `GET /tipos-estoque` dos seletores do acerto e dos saldos), sem paginação.
 */
export function TiposEstoque() {
  const pode = usePode();
  const r = useTipos();
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2} size="h3">
          Tipo de Estoque
        </Title>
        {pode('tipos_estoque.criar') && (
          <Button component={Link} to={`${ROTA_TIPOS_ESTOQUE}/novo`} leftSection={<IconPlus size={16} />}>
            Novo tipo
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed">
        Classificam o saldo dentro de cada local de estoque. Só o saldo dos tipos vendáveis desce para o PDV e
        entra nos combos montáveis; as vendas e os documentos sem tipo usam o padrão.
      </Text>
      <Paper withBorder p="sm">
        {r.isPending ? (
          <Loader size="sm" />
        ) : r.isError ? (
          <Alert color="red">{(r.error as Error).message}</Alert>
        ) : (
          <Table aria-label="Tipos de estoque" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Nome</Table.Th>
                <Table.Th>Uso</Table.Th>
                <Table.Th>Vendável</Table.Th>
                <Table.Th>Padrão</Table.Th>
                <Table.Th>Ativo</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`${ROTA_TIPOS_ESTOQUE}/${t.id}`} c="inherit">
                      {t.nome}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {usoDoTipo(t)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {t.vendavel ? <Badge color="green">Sim</Badge> : <Badge color="gray">Não</Badge>}
                  </Table.Td>
                  <Table.Td>{t.padrao ? <Badge>Padrão</Badge> : ''}</Table.Td>
                  <Table.Td>{badgeAtivo(t.ativo)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}

interface Valores extends Record<string, unknown> {
  nome: string;
  vendavel: boolean;
  padrao: boolean;
  ativo: boolean;
}

/**
 * Tipo de Estoque – formulário (ERP 13.6; decisão 152 da API): as travas da API (`errosRegraTipoEstoque`) aparecem
 * como chaves desabilitadas (o padrão é sempre vendável e ativo, e só deixa de sê-lo quando outro é marcado; o
 * Vasilhame vazio nunca é o padrão) e são conferidas antes do PUT, com o erro no campo. Desmarcar o "Padrão" recém
 * marcado devolve o "Vendável" e o "Ativo" de antes. Trocar o padrão ou o vendável avisa antes de salvar que os PDVs
 * vão ressincronizar o estoque, e o padrão novo muda para onde vão as vendas futuras.
 */
export function FormularioTipoEstoque() {
  const { id } = useParams();
  const pode = usePode();
  const queryClient = useQueryClient();
  const lista = useTipos();
  /** `vendavel` e `ativo` de antes de marcar o "Padrão" (que força os dois), para devolver ao desmarcar. */
  const [antesDoPadrao, setAntesDoPadrao] = useState<Pick<Valores, 'vendavel' | 'ativo'> | null>(null);
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: { nome: '', vendavel: false, padrao: false, ativo: true },
  });
  const c = useCadastro<TipoEstoqueDetalhe, Valores>({
    api: '/tipos-estoque',
    rota: ROTA_TIPOS_ESTOQUE,
    recurso: 'tipos-estoque',
    id,
    form,
    paraValores: (t) => ({ nome: t.nome, vendavel: t.vendavel, padrao: t.padrao, ativo: t.ativo }),
    paraCorpo: (v) => v,
    schemaCriar: criarTipoEstoqueSchema,
    schemaAlterar: alterarTipoEstoqueSchema,
    aoGravar: (t) => {
      setAntesDoPadrao(null);
      void queryClient.invalidateQueries({ queryKey: ['opcoes', 'tipos-estoque'] });
      // O padrão novo tirou a marca (e mudou a versão) do anterior: o detalhe dele em cache ficou velho.
      if (t.padrao)
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === 'tipos-estoque' && q.queryKey[1] !== t.id,
        });
      if (t.terminaisRessincronizados)
        notifications.show({
          color: 'blue',
          message: `${t.terminaisRessincronizados} PDV(s) vão ressincronizar o estoque.`,
        });
    },
    aoExcluir: () => void queryClient.invalidateQueries({ queryKey: ['opcoes', 'tipos-estoque'] }),
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_TIPOS_ESTOQUE} />;
  const t = c.registro.data;
  const v = form.getValues();
  const chave = t?.chaveSistema ?? null;
  const travaDaChave = chave !== null ? VENDAVEL_TRAVADO_POR_CHAVE[chave] : undefined;
  const vendavelTravado = travaDaChave !== undefined || v.padrao;
  // O padrão é sempre vendável: o tipo travado como não vendável nunca o é.
  const padraoTravado = t?.padrao === true || travaDaChave === false;
  const ativoTravado = (chave !== null && CHAVES_TIPO_ESTOQUE_SEMPRE_ATIVAS.includes(chave)) || v.padrao;
  const viraPadrao = v.padrao && !t?.padrao;
  const mudaVendavel = t ? v.vendavel !== t.vendavel : false;
  const padraoAtual = lista.data?.find((x) => x.padrao && x.id !== t?.id);
  const marcarPadrao = (marcado: boolean) => {
    if (marcado) {
      setAntesDoPadrao({ vendavel: v.vendavel, ativo: v.ativo });
      form.setValues({ padrao: true, vendavel: true, ativo: true });
    } else {
      form.setValues({ padrao: false, ...antesDoPadrao });
      setAntesDoPadrao(null);
    }
  };
  /** As regras que dependem do gravado, antes do PUT (as mesmas da API), com o erro no campo. */
  const salvar = () => {
    const erros = t ? errosRegraTipoEstoque(t, v) : {};
    if (Object.keys(erros).length) form.setErrors(erros);
    else c.salvar();
  };
  return (
    <FormularioEntidade
      titulo={c.novo ? 'Novo tipo de estoque' : (t?.nome ?? 'Tipo de estoque')}
      situacao={t ? (t.ativo ? { rotulo: 'Ativo', cor: 'green' } : { rotulo: 'Inativo', cor: 'gray' }) : null}
      alteradoEm={t?.atualizadoEm}
      alteradoPor={t?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={!pode(c.novo ? 'tipos_estoque.criar' : 'tipos_estoque.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_TIPOS_ESTOQUE}
      rotaNovo={!c.novo && pode('tipos_estoque.criar') ? `${ROTA_TIPOS_ESTOQUE}/novo` : undefined}
      aoSalvar={salvar}
      aoExcluir={!c.novo && !chave && !t?.padrao && pode('tipos_estoque.excluir') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={t ? { entidade: 'tipos_estoque', registroId: t.id } : undefined}
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados',
          comErro: Object.keys(form.errors).length > 0,
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 8 }}>
                <TextInput
                  label="Nome"
                  required
                  maxLength={40}
                  placeholder="Ex.: Quebra"
                  {...form.getInputProps('nome')}
                />
                {chave && USOS[chave] && (
                  <Text size="xs" c="dimmed" mt={4}>
                    Tipo do sistema: {USOS[chave]}.
                  </Text>
                )}
              </Grid.Col>
              <Grid.Col span={12}>
                <Stack gap="xs">
                  <Switch
                    label="Vendável (o saldo desce para o PDV e é baixado nas vendas)"
                    disabled={vendavelTravado}
                    {...form.getInputProps('vendavel', { type: 'checkbox' })}
                  />
                  <Switch
                    label="Padrão (usado pelas vendas e pelos documentos sem tipo)"
                    disabled={padraoTravado}
                    checked={v.padrao}
                    onChange={(e) => marcarPadrao(e.currentTarget.checked)}
                    error={form.errors.padrao}
                  />
                  <Switch
                    label="Ativo"
                    disabled={ativoTravado}
                    {...form.getInputProps('ativo', { type: 'checkbox' })}
                  />
                  <Text size="xs" c="dimmed">
                    {t?.padrao ? AJUDA.padrao : AJUDA.outros}
                    {travaDaChave !== undefined
                      ? ` ${travaDaChave ? MOTIVO_TRAVA_VENDAVEL.vendavel : MOTIVO_TRAVA_VENDAVEL.naoVendavel}`
                      : ''}
                  </Text>
                </Stack>
              </Grid.Col>
              {viraPadrao && (
                <Grid.Col span={12}>
                  <Alert color="yellow" title="Trocar o tipo padrão">
                    As vendas futuras do caixa e os documentos sem tipo passam a baixar deste tipo
                    {padraoAtual ? `, e "${padraoAtual.nome}" deixa de ser o padrão` : ''}. Os PDVs de todas
                    as lojas vão ressincronizar o estoque.
                  </Alert>
                </Grid.Col>
              )}
              {!viraPadrao && mudaVendavel && (
                <Grid.Col span={12}>
                  <Alert color="yellow" title="Os PDVs vão ressincronizar o estoque">
                    {v.vendavel
                      ? 'O saldo deste tipo passa a descer para o caixa e a contar no saldo das vendas.'
                      : 'O saldo deste tipo deixa de descer para o caixa (só com saldo zero em todos os ' +
                        'estoques: zere-o antes com um acerto).'}{' '}
                    Os PDVs de todas as lojas recebem a ressincronização do estoque ao salvar.
                  </Alert>
                </Grid.Col>
              )}
            </Grid>
          ),
        },
      ]}
    />
  );
}
