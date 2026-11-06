import {
  alterarEstoqueSchema,
  criarEstoqueSchema,
  ROTULOS_TIPO_ESTOQUE,
  TIPOS_ESTOQUE_LOCAL,
  type EstoqueDetalhe,
  type EstoqueResumo,
  type Pagina,
} from '@genesis/shared';
import { Anchor, Badge, Grid, Select, Switch, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { NaoEncontrado } from '../Erros';

export const ROTA_ESTOQUES = '/estoque/locais';

const OPCOES_TIPO = TIPOS_ESTOQUE_LOCAL.map((t) => ({ value: t, label: ROTULOS_TIPO_ESTOQUE[t] }));

export const badgeAtivo = (ativo: boolean) => (
  <Badge color={ativo ? 'green' : 'gray'} variant="light">
    {ativo ? 'Sim' : 'Não'}
  </Badge>
);

export const OPCOES_SITUACAO = [
  { value: 'ativos', label: 'Ativos' },
  { value: 'inativos', label: 'Inativos' },
  { value: 'todos', label: 'Todos' },
];

/** Locais de estoque – listagem (ERP 13.2): Nome, Loja vinculada, Tipo, Ativo. */
export function ListaEstoques() {
  const config = useMemo<ConfigListagem<EstoqueResumo>>(
    () => ({
      recurso: 'estoques',
      titulo: 'Locais de estoque',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_ESTOQUES}/novo`,
      rotuloNovo: 'Novo local',
      rotaEdicao: (e) => `${ROTA_ESTOQUES}/${e.id}`,
      chaveLinha: (e) => e.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto' },
        { campo: 'tipo', rotulo: 'Tipo', tipo: 'selecao', opcoes: OPCOES_TIPO },
        { campo: 'situacao', rotulo: 'Situação', tipo: 'selecao', padrao: 'ativos', opcoes: OPCOES_SITUACAO },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Cód.', ordenavel: true, largura: 90 },
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (e) => (
            <Anchor component={Link} to={`${ROTA_ESTOQUES}/${e.id}`} c="inherit">
              {e.nome}
            </Anchor>
          ),
        },
        { campo: 'lojaNome', rotulo: 'Loja vinculada', formato: (e) => e.lojaNome ?? '—' },
        { campo: 'tipo', rotulo: 'Tipo', ordenavel: true, formato: (e) => ROTULOS_TIPO_ESTOQUE[e.tipo] },
        {
          campo: 'ativo',
          rotulo: 'Ativo',
          ordenavel: true,
          alinhamento: 'center',
          largura: 90,
          formato: (e) => badgeAtivo(e.ativo),
        },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<EstoqueResumo>>(`/estoques${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

interface Valores extends Record<string, unknown> {
  nome: string;
  tipo: string;
  endereco: string;
  ativo: boolean;
}

/** Locais de estoque – formulário (ERP 13.2): o CD é um local `deposito` ligado à loja depósito. */
export function FormularioEstoque() {
  const { id } = useParams();
  const pode = usePode();
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: { nome: '', tipo: 'loja', endereco: '', ativo: true },
  });
  const c = useCadastro<EstoqueDetalhe, Valores>({
    api: '/estoques',
    rota: ROTA_ESTOQUES,
    recurso: 'estoques',
    id,
    form,
    paraValores: (e) => ({ nome: e.nome, tipo: e.tipo, endereco: e.endereco ?? '', ativo: e.ativo }),
    paraCorpo: (v) => v,
    schemaCriar: criarEstoqueSchema,
    schemaAlterar: alterarEstoqueSchema,
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_ESTOQUES} />;
  const e = c.registro.data;
  return (
    <FormularioEntidade
      titulo={c.novo ? 'Novo local de estoque' : (e?.nome ?? 'Local de estoque')}
      codigo={e?.codigo}
      situacao={e ? (e.ativo ? { rotulo: 'Ativo', cor: 'green' } : { rotulo: 'Inativo', cor: 'gray' }) : null}
      alteradoEm={e?.atualizadoEm}
      alteradoPor={e?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={!pode(c.novo ? 'estoques.criar' : 'estoques.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_ESTOQUES}
      rotaNovo={!c.novo && pode('estoques.criar') ? `${ROTA_ESTOQUES}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('estoques.excluir') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={e ? { entidade: 'estoques', registroId: e.id } : undefined}
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
                  maxLength={60}
                  placeholder="Ex.: CD - Estoque Ice Beer"
                  {...form.getInputProps('nome')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <Select
                  label="Tipo"
                  required
                  data={OPCOES_TIPO}
                  allowDeselect={false}
                  {...form.getInputProps('tipo')}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <TextInput label="Endereço" maxLength={255} {...form.getInputProps('endereco')} />
              </Grid.Col>
              <Grid.Col span={12}>
                <Switch label="Ativo" {...form.getInputProps('ativo', { type: 'checkbox' })} />
                <Text size="xs" c="dimmed" mt={4}>
                  Inativar exige saldo zero em todos os produtos e nenhuma loja ativa vinculada.
                </Text>
              </Grid.Col>
              {e && (
                <Grid.Col span={12}>
                  <Text size="sm">
                    Loja vinculada:{' '}
                    {e.lojaId ? (
                      <Anchor component={Link} to={`/cadastros/lojas/${e.lojaId}`}>
                        {e.lojaNome}
                      </Anchor>
                    ) : (
                      '—'
                    )}
                  </Text>
                </Grid.Col>
              )}
            </Grid>
          ),
        },
      ]}
    />
  );
}
