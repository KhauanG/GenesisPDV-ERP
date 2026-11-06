import {
  alterarMarcaSchema,
  criarMarcaSchema,
  type MarcaDetalhe,
  type MarcaResumo,
  type Pagina,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowsJoin } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { NaoEncontrado } from '../Erros';

export const ROTA_MARCAS = '/produtos/marcas';

/** Marcas – listagem (ERP 8.7): filtro Nome; colunas Nome e Produtos. */
export function ListaMarcas() {
  const config = useMemo<ConfigListagem<MarcaResumo>>(
    () => ({
      recurso: 'marcas',
      titulo: 'Marcas',
      ordenacaoPadrao: 'descricao:asc',
      rotaNovo: `${ROTA_MARCAS}/novo`,
      rotuloNovo: 'Nova marca',
      rotaEdicao: (m) => `${ROTA_MARCAS}/${m.id}`,
      chaveLinha: (m) => m.id,
      filtros: [{ campo: 'descricao', rotulo: 'Nome', tipo: 'texto' }],
      colunas: [
        { campo: 'codigo', rotulo: 'Cód.', ordenavel: true, largura: 90 },
        {
          campo: 'descricao',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (m) => (
            <Group gap="xs">
              <Anchor component={Link} to={`${ROTA_MARCAS}/${m.id}`} c="inherit">
                {m.descricao}
              </Anchor>
              {m.semMarca && (
                <Badge variant="light" color="gray">
                  Genérica
                </Badge>
              )}
            </Group>
          ),
        },
        { campo: 'ordem', rotulo: 'Ordem', ordenavel: true, largura: 90, alinhamento: 'right' },
        { campo: 'produtos', rotulo: 'Produtos', ordenavel: true, largura: 110, alinhamento: 'right' },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<MarcaResumo>>(`/marcas${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

interface Valores extends Record<string, unknown> {
  descricao: string;
  semMarca: boolean;
  exibeSite: boolean;
  ordem: number | string;
}
const VAZIO: Valores = { descricao: '', semMarca: false, exibeSite: false, ordem: 0 };

/** Marcas – formulário (ERP 8.7) com Mesclar marcas. */
export function FormularioMarca() {
  const { id } = useParams();
  const pode = usePode();
  const form = useForm<Valores>({ mode: 'controlled', initialValues: VAZIO });
  const c = useCadastro<MarcaDetalhe, Valores>({
    api: '/marcas',
    rota: ROTA_MARCAS,
    recurso: 'marcas',
    id,
    form,
    paraValores: (m) => ({
      descricao: m.descricao,
      semMarca: m.semMarca,
      exibeSite: m.exibeSite,
      ordem: m.ordem,
    }),
    paraCorpo: (v) => ({ ...v, ordem: v.ordem === '' ? 0 : Number(v.ordem) }),
    schemaCriar: criarMarcaSchema,
    schemaAlterar: alterarMarcaSchema,
  });
  const [mesclar, setMesclar] = useState(false);
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_MARCAS} />;
  const m = c.registro.data;

  return (
    <>
      <FormularioEntidade
        titulo={c.novo ? 'Nova marca' : (m?.descricao ?? 'Marca')}
        codigo={m?.codigo}
        alteradoEm={m?.atualizadoEm}
        alteradoPor={m?.atualizadoPorNome}
        carregando={!c.novo && c.registro.isPending}
        salvando={c.salvando}
        somenteLeitura={!pode(c.novo ? 'marcas.criar' : 'marcas.editar')}
        sujo={form.isDirty()}
        rotaVoltar={ROTA_MARCAS}
        rotaNovo={!c.novo && pode('marcas.criar') ? `${ROTA_MARCAS}/novo` : undefined}
        aoSalvar={c.salvar}
        aoExcluir={!c.novo && pode('marcas.excluir') ? c.excluir : undefined}
        erro={c.erro}
        aoRecarregar={c.recarregar}
        historico={m ? { entidade: 'marcas', registroId: m.id } : undefined}
        acoesExtras={
          !c.novo && pode('marcas.editar') && pode('marcas.excluir') ? (
            <Button
              variant="default"
              leftSection={<IconArrowsJoin size={16} />}
              onClick={() => setMesclar(true)}
            >
              Mesclar marcas
            </Button>
          ) : undefined
        }
        abas={[
          {
            valor: 'dados',
            rotulo: 'Dados',
            comErro: Object.keys(form.errors).length > 0,
            conteudo: (
              <Grid>
                <Grid.Col span={{ base: 12, sm: 8 }}>
                  <TextInput label="Descrição" required maxLength={60} {...form.getInputProps('descricao')} />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <NumberInput label="Ordem" min={0} allowDecimal={false} {...form.getInputProps('ordem')} />
                </Grid.Col>
                <Grid.Col span={12}>
                  <Group gap="xl">
                    <Switch
                      label="Sem marca (marca genérica, só uma)"
                      {...form.getInputProps('semMarca', { type: 'checkbox' })}
                    />
                    <Switch
                      label="Exibe no site"
                      {...form.getInputProps('exibeSite', { type: 'checkbox' })}
                    />
                  </Group>
                </Grid.Col>
                {m && (
                  <Grid.Col span={12}>
                    <Text size="sm" c="dimmed">
                      {m.produtos} produto(s) desta marca. O logotipo entra com o envio de arquivos.
                    </Text>
                  </Grid.Col>
                )}
              </Grid>
            ),
          },
        ]}
      />
      {m && <ModalMesclar aberto={mesclar} fechar={() => setMesclar(false)} destino={m} />}
    </>
  );
}

function ModalMesclar({
  aberto,
  fechar,
  destino,
}: {
  aberto: boolean;
  fechar: () => void;
  destino: MarcaDetalhe;
}) {
  const [origens, setOrigens] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [gravando, setGravando] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const marcas = useQuery({
    queryKey: ['marcas', 'todas'],
    queryFn: () => apiErp.get<Pagina<MarcaResumo>>('/marcas?tamanho=todos'),
    enabled: aberto,
  });
  async function confirmar() {
    setGravando(true);
    try {
      await apiErp.post('/marcas/mesclar', { destinoId: destino.id, origens });
      notifications.show({ color: 'green', message: 'Marcas mescladas' });
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'marcas'] });
      void queryClient.invalidateQueries({ queryKey: ['marcas'] });
      setOrigens([]);
      fechar();
      navigate(`${ROTA_MARCAS}/${destino.id}`, { replace: true });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setGravando(false);
    }
  }
  return (
    <Modal opened={aberto} onClose={fechar} title="Mesclar marcas" centered>
      <Stack gap="sm">
        <Text size="sm">
          Os produtos das marcas escolhidas passam para <strong>{destino.descricao}</strong> e elas são
          excluídas.
        </Text>
        <MultiSelect
          label="Marcas duplicadas"
          searchable
          data={(marcas.data?.itens ?? [])
            .filter((x) => x.id !== destino.id)
            .map((x) => ({ value: x.id, label: `${x.descricao} (${x.produtos})` }))}
          value={origens}
          onChange={setOrigens}
        />
        {erro && <Alert color="red">{erro}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          <Button color="red" disabled={!origens.length} loading={gravando} onClick={() => void confirmar()}>
            Mesclar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
