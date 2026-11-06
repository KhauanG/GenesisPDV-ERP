import {
  cadastroRapidoFornecedorSchema,
  type CadastroRapidoFornecedorEntrada,
  type PessoaOpcao,
  type ResultadoFornecedorRapido,
} from '@genesis/shared';
import { Alert, Button, Checkbox, Grid, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { apiErp } from '../api/clientes';
import { ErroRequisicao } from '../api/http';
import { errosDaApi, errosDoZod } from '../util/erros';
import {
  CamposEndereco,
  ENDERECO_VAZIO,
  enderecoParaApi,
  type ValoresEndereco,
} from './campos/CamposEndereco';

interface ValoresFornecedor {
  cpfCnpj: string;
  nome: string;
  apelido: string;
  rgIe: string;
  telefone: string;
  comEndereco: boolean;
  endereco: ValoresEndereco;
}

const VAZIO: ValoresFornecedor = {
  cpfCnpj: '',
  nome: '',
  apelido: '',
  rgIe: '',
  telefone: '',
  comEndereco: false,
  endereco: ENDERECO_VAZIO,
};

function corpo(v: ValoresFornecedor): CadastroRapidoFornecedorEntrada {
  return {
    cpfCnpj: v.cpfCnpj,
    nome: v.nome,
    apelido: v.apelido,
    rgIe: v.rgIe,
    telefone: v.telefone,
    endereco: v.comEndereco ? { ...enderecoParaApi(v.endereco), tipo: 'principal' } : null,
  };
}

/**
 * Modal "Cadastro rápido de fornecedor" (ERP 3.4 `<SeletorPessoa>` "+", 8.2.14, 13.3; F2-B13), reaproveitado pelo
 * produto e pelo recebimento: CNPJ ou CPF (com ou sem máscara), nome, fantasia, IE, telefone e o endereço opcional
 * (a UF entra com ele). O documento já cadastrado reaproveita a pessoa (`POST /pessoas/fornecedor-rapido`): o
 * modal avisa e devolve a pessoa existente, que só ganha a categoria Fornecedor quando não a tem. Quem abre monta o
 * modal a cada abertura (começa limpo, com `documentoInicial`).
 */
export function CadastroRapidoFornecedor({
  aberto,
  aoFechar,
  aoSalvar,
  documentoInicial = '',
}: {
  aberto: boolean;
  aoFechar: () => void;
  aoSalvar: (pessoa: PessoaOpcao) => void;
  documentoInicial?: string;
}) {
  const form = useForm<ValoresFornecedor>({
    mode: 'controlled',
    initialValues: { ...VAZIO, cpfCnpj: documentoInicial },
  });
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const v = form.getValues();

  const fechar = () => aoFechar();

  async function gravar() {
    setErro(null);
    const dados = corpo(form.getValues());
    const r = cadastroRapidoFornecedorSchema.safeParse(dados);
    if (!r.success) {
      // Os caminhos do endereço (`endereco.cep`) já são os do formulário.
      form.setErrors(errosDoZod(r.error));
      return;
    }
    setSalvando(true);
    try {
      const res = await apiErp.post<ResultadoFornecedorRapido>('/pessoas/fornecedor-rapido', dados);
      notifications.show({
        color: res.criada ? 'green' : 'blue',
        message: res.criada
          ? `Fornecedor ${res.pessoa.codigo} - ${res.pessoa.nome} cadastrado`
          : res.categoriaAdicionada
            ? `${res.pessoa.codigo} - ${res.pessoa.nome} já era cadastrado: passou a ser fornecedor`
            : `Fornecedor já cadastrado: ${res.pessoa.codigo} - ${res.pessoa.nome}`,
      });
      aoSalvar(res.pessoa);
      fechar();
    } catch (e) {
      if (e instanceof ErroRequisicao && e.campos) form.setErrors(errosDaApi(e.campos));
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal opened={aberto} onClose={fechar} title="Cadastro rápido de fornecedor" size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Se o CNPJ ou CPF já estiver cadastrado, a pessoa existente é usada (com a categoria Fornecedor) e os
          dados dela não mudam.
        </Text>
        {erro && (
          <Alert color="red" variant="light">
            {erro}
          </Alert>
        )}
        <Grid>
          <Grid.Col span={{ base: 12, sm: 5 }}>
            <TextInput
              label="CNPJ ou CPF"
              required
              data-autofocus
              maxLength={18}
              {...form.getInputProps('cpfCnpj')}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 7 }}>
            <TextInput label="Nome / razão social" required maxLength={150} {...form.getInputProps('nome')} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 5 }}>
            <TextInput label="Fantasia" maxLength={150} {...form.getInputProps('apelido')} />
          </Grid.Col>
          <Grid.Col span={{ base: 6, sm: 3 }}>
            <TextInput
              label="Inscrição estadual"
              description="CNPJ; ISENTO se for o caso"
              maxLength={20}
              {...form.getInputProps('rgIe')}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, sm: 4 }}>
            <TextInput
              label="Telefone"
              description="Com o DDD"
              inputMode="tel"
              maxLength={20}
              {...form.getInputProps('telefone')}
            />
          </Grid.Col>
        </Grid>
        <Checkbox
          label="Informar o endereço (com a UF)"
          {...form.getInputProps('comEndereco', { type: 'checkbox' })}
        />
        {v.comEndereco && <CamposEndereco form={form} prefixo="endereco." />}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          <Button loading={salvando} onClick={() => void gravar()}>
            Gravar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
