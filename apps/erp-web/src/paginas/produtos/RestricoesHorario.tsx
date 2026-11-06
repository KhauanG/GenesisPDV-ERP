import {
  alterarRestricaoHorarioSchema,
  criarRestricaoHorarioSchema,
  DIAS_SEMANA,
  type Pagina,
  type RestricaoHorarioDetalhe,
  type RestricaoHorarioResumo,
} from '@genesis/shared';
import { Anchor, Badge, Chip, Grid, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useCategorias } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { formatarData } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import { DateInput } from '@mantine/dates';

export const ROTA_RESTRICOES = '/produtos/restricoes-horario';

const dias = (d: number[] | null) => (d ? d.map((x) => DIAS_SEMANA[x]).join(', ') : 'Todos os dias');

/** Restrições de horário de venda – listagem (ERP 8.9). */
export function ListaRestricoesHorario() {
  const config = useMemo<ConfigListagem<RestricaoHorarioResumo>>(
    () => ({
      recurso: 'restricoes_horario',
      titulo: 'Restrições de horário de venda',
      ordenacaoPadrao: 'descricao:asc',
      rotaNovo: `${ROTA_RESTRICOES}/novo`,
      rotuloNovo: 'Nova restrição',
      permissaoNovo: 'restricoes_horario.editar',
      rotaEdicao: (r) => `${ROTA_RESTRICOES}/${r.id}`,
      chaveLinha: (r) => r.id,
      filtros: [
        { campo: 'descricao', rotulo: 'Descrição', tipo: 'texto' },
        { campo: 'lojaId', rotulo: 'Loja', tipo: 'loja' },
        {
          campo: 'situacao',
          rotulo: 'Situação',
          tipo: 'selecao',
          padrao: 'ativos',
          opcoes: [
            { value: 'ativos', label: 'Ativas' },
            { value: 'inativos', label: 'Inativas' },
            { value: 'todos', label: 'Todas' },
          ],
        },
      ],
      colunas: [
        {
          campo: 'descricao',
          rotulo: 'Descrição',
          ordenavel: true,
          formato: (r) => (
            <Anchor component={Link} to={`${ROTA_RESTRICOES}/${r.id}`} c="inherit">
              {r.descricao}
            </Anchor>
          ),
        },
        {
          campo: 'lojaNome',
          campoOrdenacao: 'loja',
          rotulo: 'Loja',
          ordenavel: true,
          formato: (r) => r.lojaNome ?? 'Todas',
        },
        {
          campo: 'categoriaNome',
          rotulo: 'Alvo',
          formato: (r) =>
            [r.categoriaNome, r.idadeMinimaProduto ? `Idade ≥ ${r.idadeMinimaProduto}` : null]
              .filter(Boolean)
              .join(' · '),
        },
        {
          campo: 'horaInicio',
          campoOrdenacao: 'hora_inicio',
          rotulo: 'Faixa proibida',
          ordenavel: true,
          formato: (r) => `${r.horaInicio}–${r.horaFim}`,
        },
        {
          campo: 'diasSemana',
          rotulo: 'Quando',
          formato: (r) => (r.dataEspecifica ? formatarData(r.dataEspecifica) : dias(r.diasSemana)),
        },
        {
          campo: 'ativo',
          rotulo: 'Ativa',
          formato: (r) => (
            <Badge variant="light" color={r.ativo ? 'green' : 'gray'}>
              {r.ativo ? 'Sim' : 'Não'}
            </Badge>
          ),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<RestricaoHorarioResumo>>(`/restricoes-horario-venda${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

interface Valores extends Record<string, unknown> {
  descricao: string;
  lojaId: string;
  categoriaId: string | null;
  idadeMinimaProduto: string;
  diasSemana: string[];
  horaInicio: string;
  horaFim: string;
  dataEspecifica: string;
  ativo: boolean;
}

const VAZIO: Valores = {
  descricao: '',
  lojaId: '',
  categoriaId: null,
  idadeMinimaProduto: '',
  diasSemana: [],
  horaInicio: '',
  horaFim: '',
  dataEspecifica: '',
  ativo: true,
};

/** Restrição de horário de venda (ERP 8.9; aplicada pelo PDV 10.11): loja imutável depois de gravada. */
export function FormularioRestricaoHorario() {
  const { id } = useParams();
  const pode = usePode();
  const eu = useEu();
  const categorias = useCategorias();
  const form = useForm<Valores>({ mode: 'controlled', initialValues: VAZIO });
  const c = useCadastro<RestricaoHorarioDetalhe, Valores>({
    api: '/restricoes-horario-venda',
    rota: ROTA_RESTRICOES,
    recurso: 'restricoes_horario',
    id,
    form,
    paraValores: (r) => ({
      descricao: r.descricao,
      lojaId: r.lojaId ?? '',
      categoriaId: r.categoriaId,
      idadeMinimaProduto: r.idadeMinimaProduto === null ? '' : String(r.idadeMinimaProduto),
      diasSemana: (r.diasSemana ?? []).map(String),
      horaInicio: r.horaInicio,
      horaFim: r.horaFim,
      dataEspecifica: r.dataEspecifica ?? '',
      ativo: r.ativo,
    }),
    paraCorpo: (v) => ({
      descricao: v.descricao,
      ...(id ? {} : { lojaId: v.lojaId || null }),
      categoriaId: v.categoriaId,
      idadeMinimaProduto: v.idadeMinimaProduto || null,
      diasSemana: v.diasSemana.map(Number),
      horaInicio: v.horaInicio,
      horaFim: v.horaFim,
      dataEspecifica: v.dataEspecifica || null,
      ativo: v.ativo,
    }),
    schemaCriar: criarRestricaoHorarioSchema,
    schemaAlterar: alterarRestricaoHorarioSchema,
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_RESTRICOES} />;
  const r = c.registro.data;
  const v = form.getValues();
  const conteudo = (
    <Stack gap="md">
      <Grid>
        <Grid.Col span={{ base: 12, sm: 8 }}>
          <TextInput
            label="Descrição"
            required
            maxLength={100}
            description="Mostrada ao operador (ex.: Lei municipal 1.234/2020)"
            {...form.getInputProps('descricao')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Switch mt={30} label="Ativa" {...form.getInputProps('ativo', { type: 'checkbox' })} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Select
            label="Loja"
            description={c.novo ? 'Vazio = todas as lojas' : 'Não muda depois de gravada'}
            disabled={!c.novo}
            allowDeselect={false}
            data={[
              { value: '', label: 'Todas as lojas' },
              ...eu.lojas
                .filter((l) => l.ativa || l.id === v.lojaId)
                .map((l) => ({ value: l.id, label: l.nome })),
            ]}
            {...form.getInputProps('lojaId')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 5 }}>
          <Select
            label="Categoria"
            description="Com as subcategorias"
            searchable
            clearable
            data={(categorias.data ?? []).map((x) => ({ value: x.id, label: x.caminhoNomes }))}
            {...form.getInputProps('categoriaId')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <TextInput
            label="Idade mínima do produto"
            description="Ex.: 18 = bebidas alcoólicas"
            {...form.getInputProps('idadeMinimaProduto')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput
            label="Início (proibido a partir de)"
            type="time"
            required
            {...form.getInputProps('horaInicio')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput
            label="Fim"
            type="time"
            required
            description="Pode atravessar a meia-noite"
            {...form.getInputProps('horaFim')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <DateInput
            label="Data específica"
            valueFormat="DD/MM/YYYY"
            clearable
            description="Ex.: eleição (ignora os dias)"
            {...form.getInputProps('dataEspecifica')}
            value={form.getValues().dataEspecifica || null}
            onChange={(d) => form.setFieldValue('dataEspecifica', d ?? '')}
          />
        </Grid.Col>
      </Grid>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Dias da semana{' '}
          <Text span size="xs" c="dimmed">
            (nenhum = todos)
          </Text>
        </Text>
        <Chip.Group multiple {...form.getInputProps('diasSemana')}>
          <Group gap="xs">
            {DIAS_SEMANA.map((d, i) => (
              <Chip key={d} value={String(i)} disabled={!!v.dataEspecifica}>
                {d}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
    </Stack>
  );
  return (
    <FormularioEntidade
      titulo={c.novo ? 'Nova restrição de horário' : (r?.descricao ?? 'Restrição')}
      situacao={r ? (r.ativo ? { rotulo: 'Ativa', cor: 'green' } : { rotulo: 'Inativa', cor: 'gray' }) : null}
      alteradoEm={r?.atualizadoEm}
      alteradoPor={r?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={!pode('restricoes_horario.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_RESTRICOES}
      rotaNovo={!c.novo && pode('restricoes_horario.editar') ? `${ROTA_RESTRICOES}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('restricoes_horario.editar') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={r ? { entidade: 'restricoes_horario_venda', registroId: r.id } : undefined}
      abas={[{ valor: 'dados', rotulo: 'Restrição', conteudo, comErro: Object.keys(form.errors).length > 0 }]}
    />
  );
}
