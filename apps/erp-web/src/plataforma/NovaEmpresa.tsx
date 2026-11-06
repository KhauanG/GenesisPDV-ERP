import { criarEmpresaSchema, REGIMES_FISCAIS, type ResultadoProvisionamento } from '@genesis/shared';
import {
  Alert,
  Button,
  Checkbox,
  CopyButton,
  Grid,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiPlataforma } from '../api/clientes';
import { ErroRequisicao } from '../api/http';
import { FormularioEntidade } from '../componentes/FormularioEntidade';
import { errosDaApi, errosDoZod } from '../util/erros';
import { useSessaoPlataforma } from './sessao';

interface Plano {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
}

const ROTULOS_REGIME: Record<(typeof REGIMES_FISCAIS)[number], string> = {
  simples_nacional: 'Simples Nacional',
  simples_excesso_sublimite: 'Simples Nacional – excesso de sublimite',
  regime_normal: 'Regime normal',
  mei: 'MEI',
};

const INICIAL = {
  codigo: '',
  razaoSocial: '',
  nomeFantasia: '',
  cnpj: '',
  planoCodigo: 'padrao',
  regime: 'simples_nacional',
  nomeResponsavel: '',
  emailResponsavel: '',
  telefoneResponsavel: '',
  observacoes: '',
  canario: false,
  adminNome: 'ADMINISTRADOR',
  adminLogin: 'admin',
  adminEmail: '',
};

/** Painel › Nova empresa (ERP 19.3, 19.4): provisiona o banco e mostra a senha provisória do admin uma vez. */
export function NovaEmpresa() {
  const { temPapel } = useSessaoPlataforma();
  const queryClient = useQueryClient();
  const [resultado, setResultado] = useState<ResultadoProvisionamento | null>(null);
  const [erro, setErro] = useState<unknown>(null);
  const form = useForm({ mode: 'controlled', initialValues: INICIAL });
  const planos = useQuery({
    queryKey: ['plataforma', 'planos'],
    queryFn: () => apiPlataforma.get<{ itens: Plano[] }>('/planos'),
  });

  const criar = useMutation({
    mutationFn: (corpo: unknown) => apiPlataforma.post<ResultadoProvisionamento>('/empresas', corpo),
    onSuccess: (r) => {
      form.resetDirty();
      setErro(null);
      setResultado(r);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'plataforma_empresas'] });
    },
    onError: (e) => {
      setErro(e);
      if (e instanceof ErroRequisicao && e.campos) form.setErrors(errosDaApi(e.campos));
    },
  });

  function salvar() {
    const v = form.getValues();
    const vazio = (s: string) => (s.trim() ? s : undefined);
    const corpo = {
      codigo: v.codigo ? Number(v.codigo) : undefined,
      razaoSocial: v.razaoSocial,
      nomeFantasia: vazio(v.nomeFantasia),
      cnpj: v.cnpj,
      planoCodigo: v.planoCodigo,
      regime: v.regime,
      nomeResponsavel: vazio(v.nomeResponsavel),
      emailResponsavel: vazio(v.emailResponsavel),
      telefoneResponsavel: vazio(v.telefoneResponsavel),
      observacoes: vazio(v.observacoes),
      canario: v.canario,
      admin: {
        nome: v.adminNome || 'ADMINISTRADOR',
        login: v.adminLogin || 'admin',
        email: vazio(v.adminEmail),
      },
    };
    const r = criarEmpresaSchema.safeParse(corpo);
    if (!r.success) {
      const erros = errosDoZod(r.error);
      form.setErrors({
        ...erros,
        adminNome: erros['admin.nome'],
        adminLogin: erros['admin.login'],
        adminEmail: erros['admin.email'],
      });
      return;
    }
    criar.mutate(r.data);
  }

  if (resultado) {
    return (
      <Stack gap="md" maw={640}>
        <Title order={2} size="h3">
          Empresa {resultado.codigo} criada
        </Title>
        <Paper p="lg">
          <Stack gap="sm">
            <Group gap="xs">
              <IconCheck color="var(--mantine-color-green-6)" />
              <Text>
                Banco <code>{resultado.nomeBanco}</code> provisionado; status{' '}
                <strong>{resultado.status}</strong>.
              </Text>
            </Group>
            <Text size="sm">
              Acesso do administrador: código da empresa <strong>{resultado.codigo}</strong>, usuário{' '}
              <strong>{resultado.adminLogin}</strong>.
            </Text>
            {resultado.senhaProvisoria ? (
              <Alert
                color="yellow"
                icon={<IconInfoCircle size={18} />}
                title="Senha provisória (exibida uma única vez)"
              >
                <Group justify="space-between">
                  <Text ff="monospace" fw={700} size="lg" data-testid="senha-provisoria-admin">
                    {resultado.senhaProvisoria}
                  </Text>
                  <CopyButton value={resultado.senhaProvisoria}>
                    {({ copied, copy }) => (
                      <Button size="xs" variant="light" leftSection={<IconCopy size={14} />} onClick={copy}>
                        {copied ? 'Copiada' : 'Copiar'}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
                <Text size="xs" mt="xs">
                  Ela não fica gravada em claro e não poderá ser vista de novo. O administrador troca no
                  primeiro acesso.
                </Text>
              </Alert>
            ) : (
              <Text size="sm" c="dimmed">
                O administrador já tinha senha definitiva; nenhuma senha provisória foi gerada.
              </Text>
            )}
            <Group mt="sm">
              <Button component={Link} to={`/plataforma/empresas/${resultado.codigo}`}>
                Ver empresa
              </Button>
              <Button component={Link} to="/plataforma/empresas" variant="default">
                Voltar à lista
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Stack>
    );
  }

  const opcoesPlanos = (planos.data?.itens ?? [])
    .filter((p) => p.ativo)
    .map((p) => ({ value: p.codigo, label: p.nome }));

  return (
    <FormularioEntidade
      titulo="Nova empresa"
      rotaVoltar="/plataforma/empresas"
      somenteLeitura={!temPapel('financeiro')}
      salvando={criar.isPending}
      sujo={form.isDirty()}
      aoSalvar={salvar}
      erro={erro}
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados',
          comErro: Object.keys(form.errors).some((k) => !k.startsWith('admin')),
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 3 }}>
                <TextInput
                  label="Código"
                  description="Vazio = próximo livre"
                  inputMode="numeric"
                  maxLength={6}
                  {...form.getInputProps('codigo')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 9 }}>
                <TextInput label="Razão social" required {...form.getInputProps('razaoSocial')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput label="Nome fantasia" {...form.getInputProps('nomeFantasia')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="CNPJ"
                  required
                  description="Numérico ou alfanumérico"
                  {...form.getInputProps('cnpj')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Plano"
                  required
                  data={opcoesPlanos}
                  allowDeselect={false}
                  {...form.getInputProps('planoCodigo')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Regime tributário"
                  required
                  allowDeselect={false}
                  data={REGIMES_FISCAIS.map((r) => ({ value: r, label: ROTULOS_REGIME[r] }))}
                  {...form.getInputProps('regime')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput label="Responsável" {...form.getInputProps('nomeResponsavel')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput
                  label="E-mail do responsável"
                  type="email"
                  {...form.getInputProps('emailResponsavel')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput label="Telefone do responsável" {...form.getInputProps('telefoneResponsavel')} />
              </Grid.Col>
              <Grid.Col span={12}>
                <Textarea
                  label="Observações (interno)"
                  autosize
                  minRows={2}
                  {...form.getInputProps('observacoes')}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Checkbox
                  label="Empresa canário (recebe as migrações primeiro)"
                  {...form.getInputProps('canario', { type: 'checkbox' })}
                />
              </Grid.Col>
            </Grid>
          ),
        },
        {
          valor: 'admin',
          rotulo: 'Administrador inicial',
          comErro: Object.keys(form.errors).some((k) => k.startsWith('admin')),
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 5 }}>
                <TextInput label="Nome" {...form.getInputProps('adminNome')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 3 }}>
                <TextInput label="Login" {...form.getInputProps('adminLogin')} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput label="E-mail" type="email" {...form.getInputProps('adminEmail')} />
              </Grid.Col>
              <Grid.Col span={12}>
                <Text size="sm" c="dimmed">
                  A primeira loja não é criada aqui: ela nasce no assistente de primeira configuração do ERP
                  (Fase 1).
                </Text>
              </Grid.Col>
            </Grid>
          ),
        },
      ]}
    />
  );
}
