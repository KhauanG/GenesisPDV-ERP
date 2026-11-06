import {
  alterarPerfilSchema,
  criarPerfilSchema,
  type Pagina,
  type PerfilDetalhe,
  type PerfilResumo,
} from '@genesis/shared';
import { Anchor, Badge, Button, Grid, Group, Text, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCopy } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { abaDoErro, useCadastro } from '../../componentes/cadastro';
import { EditorPermissoes } from '../../componentes/EditorPermissoes';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { NaoEncontrado } from '../Erros';

export const ROTA_PERFIS = '/cadastros/perfis';

/** Perfis de acesso – listagem (ERP 11.3): Nome, Descrição, Usuários. */
export function ListaPerfis() {
  const config = useMemo<ConfigListagem<PerfilResumo>>(
    () => ({
      recurso: 'perfis',
      titulo: 'Perfis de acesso',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_PERFIS}/novo`,
      rotuloNovo: 'Novo perfil',
      rotaEdicao: (p) => `${ROTA_PERFIS}/${p.id}`,
      chaveLinha: (p) => p.id,
      filtros: [{ campo: 'nome', rotulo: 'Nome', tipo: 'texto' }],
      colunas: [
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (p) => (
            <Group gap="xs">
              <Anchor component={Link} to={`${ROTA_PERFIS}/${p.id}`} c="inherit">
                {p.nome}
              </Anchor>
              {p.chaveSistema && (
                <Badge size="xs" variant="light" color="gray">
                  padrão
                </Badge>
              )}
            </Group>
          ),
        },
        { campo: 'descricao', rotulo: 'Descrição', formato: (p) => p.descricao ?? '—' },
        { campo: 'usuarios', rotulo: 'Usuários', ordenavel: true, alinhamento: 'right', largura: 110 },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<PerfilResumo>>(`/perfis${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

interface Valores extends Record<string, unknown> {
  nome: string;
  descricao: string;
  permissoes: string[];
}

const ABAS = ['dados', 'menus', 'permissoes'] as const;

/** Perfis de acesso – formulário (ERP 11.3): abas Menus do sistema e Permissões Gerais, Duplicar. */
export function FormularioPerfil() {
  const { id, aba } = useParams();
  const pode = usePode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [abaNovo, setAbaNovo] = useState('dados');
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: { nome: '', descricao: '', permissoes: [] },
  });
  const setAba = (a: string) =>
    id ? navigate(`${ROTA_PERFIS}/${id}${a === 'dados' ? '' : `/${a}`}`, { replace: true }) : setAbaNovo(a);
  const c = useCadastro<PerfilDetalhe, Valores>({
    api: '/perfis',
    rota: ROTA_PERFIS,
    recurso: 'perfis',
    id,
    form,
    paraValores: (p) => ({ nome: p.nome, descricao: p.descricao ?? '', permissoes: p.permissoes }),
    paraCorpo: (v) => v,
    schemaCriar: criarPerfilSchema,
    schemaAlterar: alterarPerfilSchema,
    aoErroCampos: (campos) =>
      setAba(abaDoErro(campos, { dados: ['nome', 'descricao'], permissoes: ['permissoes'] }) ?? 'dados'),
  });
  const [duplicando, setDuplicando] = useState(false);
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_PERFIS} />;
  const p = c.registro.data;
  const abaAtiva = id ? ((ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados') : abaNovo;
  const somenteLeitura = !pode(c.novo ? 'perfis.criar' : 'perfis.editar');
  const permissoes = new Set(form.getValues().permissoes);
  const mudar = (s: Set<string>) => form.setFieldValue('permissoes', [...s].sort());

  async function duplicar() {
    setDuplicando(true);
    try {
      const novo = await apiErp.post<PerfilDetalhe>(`/perfis/${id}/duplicar`);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'perfis'] });
      notifications.show({ color: 'green', message: `Perfil duplicado: ${novo.nome}` });
      navigate(`${ROTA_PERFIS}/${novo.id}`);
    } catch (e) {
      c.setErro(e);
    } finally {
      setDuplicando(false);
    }
  }

  return (
    <FormularioEntidade
      titulo={c.novo ? 'Novo perfil de acesso' : (p?.nome ?? 'Perfil')}
      alteradoEm={p?.atualizadoEm}
      alteradoPor={p?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={somenteLeitura}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_PERFIS}
      rotaNovo={!c.novo && pode('perfis.criar') ? `${ROTA_PERFIS}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('perfis.excluir') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={p ? { entidade: 'perfis', registroId: p.id } : undefined}
      abaAtiva={abaAtiva}
      aoMudarAba={setAba}
      acoesExtras={
        !c.novo && pode('perfis.criar') ? (
          <Button
            variant="default"
            leftSection={<IconCopy size={16} />}
            loading={duplicando}
            onClick={() => void duplicar()}
          >
            Duplicar
          </Button>
        ) : undefined
      }
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados',
          comErro: !!form.errors.nome || !!form.errors.descricao,
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 5 }}>
                <TextInput label="Nome" required maxLength={40} {...form.getInputProps('nome')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 7 }}>
                <Textarea
                  label="Descrição"
                  autosize
                  minRows={1}
                  maxLength={255}
                  {...form.getInputProps('descricao')}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Text size="sm" c="dimmed">
                  {permissoes.size} permissão(ões) marcada(s)
                  {p ? ` · ${p.usuarios} usuário(s) com este perfil` : ''}. Alterar as permissões vale na
                  próxima requisição de cada usuário do perfil.
                </Text>
              </Grid.Col>
            </Grid>
          ),
        },
        {
          valor: 'menus',
          rotulo: 'Menus do sistema',
          conteudo: (
            <EditorPermissoes
              modo="perfil"
              secao="menus"
              valor={permissoes}
              aoMudar={mudar}
              somenteLeitura={somenteLeitura}
            />
          ),
        },
        {
          valor: 'permissoes',
          rotulo: 'Permissões Gerais',
          comErro: !!form.errors.permissoes,
          conteudo: (
            <EditorPermissoes
              modo="perfil"
              secao="gerais"
              valor={permissoes}
              aoMudar={mudar}
              somenteLeitura={somenteLeitura}
            />
          ),
        },
      ]}
    />
  );
}
