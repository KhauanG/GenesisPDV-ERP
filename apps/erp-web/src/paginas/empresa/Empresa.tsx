import { alterarEmpresaSchema, formatarCpfCnpj, type EmpresaDetalhe } from '@genesis/shared';
import { Alert, Grid, Stack, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import {
  CamposEndereco,
  ENDERECO_VAZIO,
  enderecoParaApi,
  enderecoParaForm,
  type ValoresEndereco,
} from '../../componentes/campos/CamposEndereco';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { errosDaApi, errosDoZod } from '../../util/erros';

interface Valores extends ValoresEndereco, Record<string, unknown> {
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string;
  ie: string;
  inscricaoMunicipal: string;
  telefone: string;
  email: string;
  emailContador: string;
  fusoHorario: string;
}

const VAZIO: Valores = {
  ...ENDERECO_VAZIO,
  razaoSocial: '',
  nomeFantasia: '',
  cnpj: '',
  ie: '',
  inscricaoMunicipal: '',
  telefone: '',
  email: '',
  emailContador: '',
  fusoHorario: 'America/Sao_Paulo',
};

/** Cadastros › Empresa (ERP 10.1): formulário único; CNPJ só o Master altera. */
export function Empresa() {
  const pode = usePode();
  const eu = useEu();
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<unknown>(null);
  const form = useForm<Valores>({ mode: 'controlled', initialValues: VAZIO });
  const registro = useQuery({ queryKey: ['empresa'], queryFn: () => apiErp.get<EmpresaDetalhe>('/empresa') });

  const carregar = (e: EmpresaDetalhe) => {
    const v: Valores = {
      ...enderecoParaForm(e),
      razaoSocial: e.razaoSocial,
      nomeFantasia: e.nomeFantasia ?? '',
      cnpj: formatarCpfCnpj(e.cnpj),
      ie: e.ie ?? '',
      inscricaoMunicipal: e.inscricaoMunicipal ?? '',
      telefone: e.telefone ?? '',
      email: e.email ?? '',
      emailContador: e.emailContador ?? '',
      fusoHorario: e.fusoHorario,
    };
    form.setValues(v);
    form.resetDirty(v);
  };
  useEffect(() => {
    if (registro.data) carregar(registro.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registro.data]);

  const gravar = useMutation({
    mutationFn: (corpo: unknown) => apiErp.put<EmpresaDetalhe>('/empresa', corpo),
    onSuccess: (d) => {
      setErro(null);
      queryClient.setQueryData(['empresa'], d);
      carregar(d);
      notifications.show({ color: 'green', message: 'Empresa gravada' });
    },
    onError: (e) => {
      setErro(e);
      if (e instanceof ErroRequisicao && e.campos) form.setErrors(errosDaApi(e.campos));
    },
  });

  function salvar() {
    const v = form.getValues();
    const corpo = { ...v, ...enderecoParaApi(v), versao: registro.data?.versao };
    const r = alterarEmpresaSchema.safeParse(corpo);
    if (!r.success) return form.setErrors(errosDoZod(r.error));
    gravar.mutate(corpo);
  }

  const e = registro.data;
  if (registro.isError) return <Alert color="red">{(registro.error as Error).message}</Alert>;
  return (
    <FormularioEntidade
      titulo={e?.nomeFantasia ?? e?.razaoSocial ?? 'Empresa'}
      codigo={e?.codigo}
      alteradoEm={e?.atualizadoEm}
      alteradoPor={e?.atualizadoPorNome}
      carregando={registro.isPending}
      salvando={gravar.isPending}
      somenteLeitura={!pode('empresa.editar')}
      sujo={form.isDirty()}
      rotaVoltar="/"
      aoSalvar={salvar}
      erro={erro}
      aoRecarregar={() => {
        setErro(null);
        void registro.refetch();
      }}
      historico={e ? { entidade: 'empresa', registroId: e.id } : undefined}
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados cadastrais',
          comErro: Object.keys(form.errors).length > 0,
          conteudo: (
            <Stack gap="md">
              <Grid>
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <TextInput
                    label="Razão social"
                    required
                    maxLength={150}
                    {...form.getInputProps('razaoSocial')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <TextInput
                    label="Nome fantasia"
                    description="Aparece no cabeçalho do ERP"
                    required
                    maxLength={150}
                    {...form.getInputProps('nomeFantasia')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <TextInput
                    label="CNPJ"
                    required
                    disabled={!eu.usuario.master}
                    description={eu.usuario.master ? undefined : 'Só um usuário Master altera o CNPJ'}
                    {...form.getInputProps('cnpj')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 6, sm: 4 }}>
                  <TextInput label="IE" maxLength={20} {...form.getInputProps('ie')} />
                </Grid.Col>
                <Grid.Col span={{ base: 6, sm: 4 }}>
                  <TextInput
                    label="Insc. municipal"
                    maxLength={20}
                    {...form.getInputProps('inscricaoMunicipal')}
                  />
                </Grid.Col>
              </Grid>
              <Title order={4} size="h5">
                Endereço
              </Title>
              <CamposEndereco form={form} />
              <Grid>
                <Grid.Col span={{ base: 12, sm: 3 }}>
                  <TextInput label="Telefone" maxLength={20} {...form.getInputProps('telefone')} />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <TextInput
                    label="E-mail"
                    description="Recebe os avisos da plataforma"
                    maxLength={254}
                    {...form.getInputProps('email')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 5 }}>
                  <TextInput
                    label="E-mail(s) do contador"
                    description="Separe por vírgula; destino padrão do Download de XML"
                    {...form.getInputProps('emailContador')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <TextInput
                    label="Fuso horário"
                    required
                    description="Formato IANA (ex.: America/Sao_Paulo)"
                    {...form.getInputProps('fusoHorario')}
                  />
                </Grid.Col>
              </Grid>
            </Stack>
          ),
        },
      ]}
    />
  );
}
