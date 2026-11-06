import {
  alterarPessoaSchema,
  CATEGORIAS_PESSOA,
  criarPessoaSchema,
  formatarCpfCnpj,
  ROTULOS_CATEGORIA_PESSOA,
  ROTULOS_TIPO_ENDERECO,
  ROTULOS_TIPO_TELEFONE,
  TIPOS_ENDERECO,
  TIPOS_TELEFONE,
  type Pagina,
  type PessoaDetalhe,
  type PessoaResumo,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePaises, useUfs } from '../../api/referencias';
import { usePode } from '../../auth/permissoes';
import { abaDoErro, useCadastro } from '../../componentes/cadastro';
import {
  CamposEndereco,
  ENDERECO_VAZIO,
  enderecoParaApi,
  enderecoParaForm,
  type ValoresEndereco,
} from '../../componentes/campos/CamposEndereco';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { NaoEncontrado } from '../Erros';

export const ROTA_PESSOAS = '/pessoas';

/** Pessoas – listagem (ERP 7.1). */
export function ListaPessoas() {
  const ufs = useUfs();
  const config = useMemo<ConfigListagem<PessoaResumo>>(
    () => ({
      recurso: 'pessoas',
      titulo: 'Pessoas',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_PESSOAS}/novo`,
      rotuloNovo: 'Novo registro',
      rotaEdicao: (p) => `${ROTA_PESSOAS}/${p.id}`,
      chaveLinha: (p) => p.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto', placeholder: 'Nome ou apelido' },
        { campo: 'cpfCnpj', rotulo: 'CPF/CNPJ', tipo: 'texto' },
        { campo: 'cep', rotulo: 'CEP', tipo: 'texto' },
        { campo: 'cidade', rotulo: 'Cidade', tipo: 'texto' },
        {
          campo: 'categorias',
          rotulo: 'Categoria',
          tipo: 'selecao',
          opcoes: CATEGORIAS_PESSOA.map((c) => ({ value: c, label: ROTULOS_CATEGORIA_PESSOA[c] })),
        },
        {
          campo: 'uf',
          rotulo: 'Estado',
          tipo: 'selecao',
          opcoes: (ufs.data ?? []).map((u) => ({ value: u.sigla, label: u.sigla })),
        },
        {
          campo: 'situacao',
          rotulo: 'Situação',
          tipo: 'selecao',
          padrao: 'ativas',
          opcoes: [
            { value: 'ativas', label: 'Ativas' },
            { value: 'inativas', label: 'Inativas' },
            { value: 'todas', label: 'Todas' },
          ],
        },
        { campo: 'codigo', rotulo: 'Código', tipo: 'numero' },
      ],
      colunas: [
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (p) => (
            <Anchor component={Link} to={`${ROTA_PESSOAS}/${p.id}`} c="inherit">
              {p.nome}
            </Anchor>
          ),
        },
        {
          campo: 'cpfCnpj',
          campoOrdenacao: 'cpf_cnpj',
          rotulo: 'CPF/CNPJ',
          ordenavel: true,
          formato: (p) => formatarCpfCnpj(p.cpfCnpj) || '—',
        },
        { campo: 'telefone', rotulo: 'Telefone', formato: (p) => p.telefone ?? '—' },
        { campo: 'email', rotulo: 'E-mail', formato: (p) => p.email ?? '—' },
        {
          campo: 'categorias',
          rotulo: 'Categoria',
          formato: (p) => p.categorias.map((c) => ROTULOS_CATEGORIA_PESSOA[c]).join(', '),
        },
        {
          campo: 'cidade',
          rotulo: 'Cidade/UF',
          ordenavel: true,
          formato: (p) => (p.cidade ? `${p.cidade}${p.uf ? `/${p.uf}` : ''}` : '—'),
        },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<PessoaResumo>>(`/pessoas${query(params)}`, { sinal }),
      exportar: (params, formato) => apiErp.baixar(`/pessoas/exportar${query({ ...params, formato })}`),
    }),
    [ufs.data],
  );
  return <Listagem config={config} />;
}

interface EnderecoForm extends ValoresEndereco {
  id: string | null;
  tipo: string;
  exterior: boolean;
  paisCodigo: string | null;
  cidadeExterior: string;
  referencia: string;
}
interface TelefoneForm {
  id: string | null;
  tipo: string;
  numero: string;
  contato: string;
  principal: boolean;
}
interface EmailForm {
  id: string | null;
  email: string;
  principal: boolean;
  recebeDocumentos: boolean;
}

export interface ValoresPessoa extends Record<string, unknown> {
  tipo: 'PF' | 'PJ';
  nome: string;
  apelido: string;
  ativa: boolean;
  cpfCnpj: string;
  rgIe: string;
  indicadorIe: string;
  inscricaoMunicipal: string;
  nascimento: string | null;
  sexo: string;
  limiteCompras: number | string;
  descontoPct: number | string;
  bloqueadaCredito: boolean;
  observacoes: string;
  observacaoPdv: string;
  manterNoPdv: boolean;
  categorias: string[];
  enderecos: EnderecoForm[];
  telefones: TelefoneForm[];
  emails: EmailForm[];
  senha: string;
  removerSenha: boolean;
}

export const PESSOA_VAZIA: ValoresPessoa = {
  tipo: 'PF',
  nome: '',
  apelido: '',
  ativa: true,
  cpfCnpj: '',
  rgIe: '',
  indicadorIe: 'nao_contribuinte',
  inscricaoMunicipal: '',
  nascimento: null,
  sexo: 'N',
  limiteCompras: '',
  descontoPct: 0,
  bloqueadaCredito: false,
  observacoes: '',
  observacaoPdv: '',
  manterNoPdv: false,
  categorias: ['cliente'],
  enderecos: [],
  telefones: [],
  emails: [],
  senha: '',
  removerSenha: false,
};

const novoEndereco = (principal: boolean): EnderecoForm => ({
  ...ENDERECO_VAZIO,
  id: null,
  tipo: principal ? 'principal' : 'entrega',
  exterior: false,
  paisCodigo: null,
  cidadeExterior: '',
  referencia: '',
});

function paraValores(p: PessoaDetalhe): ValoresPessoa {
  return {
    tipo: p.tipo,
    nome: p.nome,
    apelido: p.apelido ?? '',
    ativa: p.ativa,
    cpfCnpj: formatarCpfCnpj(p.cpfCnpj),
    rgIe: p.rgIe ?? '',
    indicadorIe: p.indicadorIe,
    inscricaoMunicipal: p.inscricaoMunicipal ?? '',
    nascimento: p.nascimento,
    sexo: p.sexo,
    limiteCompras: p.limiteCompras === null ? '' : Number(p.limiteCompras),
    descontoPct: Number(p.descontoPct),
    bloqueadaCredito: p.bloqueadaCredito,
    observacoes: p.observacoes ?? '',
    observacaoPdv: p.observacaoPdv ?? '',
    manterNoPdv: p.manterNoPdv,
    categorias: p.categorias,
    enderecos: p.enderecos.map((e) => ({
      ...enderecoParaForm(e),
      id: e.id,
      tipo: e.tipo,
      exterior: e.exterior,
      paisCodigo: e.paisCodigo,
      cidadeExterior: e.cidadeExterior ?? '',
      referencia: e.referencia ?? '',
    })),
    telefones: p.telefones.map((t) => ({
      id: t.id,
      tipo: t.tipo,
      numero: `(${t.ddd}) ${t.numero}`,
      contato: t.contato ?? '',
      principal: t.principal,
    })),
    emails: p.emails.map((e) => ({
      id: e.id,
      email: e.email,
      principal: e.principal,
      recebeDocumentos: e.recebeDocumentos,
    })),
    senha: '',
    removerSenha: false,
  };
}

export function corpoPessoa(v: ValoresPessoa): Record<string, unknown> {
  return {
    ...v,
    limiteCompras: v.limiteCompras === '' ? null : String(v.limiteCompras),
    descontoPct: String(v.descontoPct === '' ? 0 : v.descontoPct),
    sexo: v.tipo === 'PJ' ? 'N' : v.sexo,
    enderecos: v.enderecos.map((e) => ({ ...e, ...enderecoParaApi(e) })),
    telefones: v.telefones.map((t) => ({ ...t, ddd: '' })),
  };
}

const ABAS = ['dados', 'financeiro', 'total'] as const;

/** Pessoas – formulário (ERP 7.2): dados gerais com endereços, telefones, e-mails e categorias. */
export function FormularioPessoa() {
  const { id, aba } = useParams();
  const pode = usePode();
  const navigate = useNavigate();
  const paises = usePaises();
  const [abaNovo, setAbaNovo] = useState('dados');
  const form = useForm<ValoresPessoa>({ mode: 'controlled', initialValues: PESSOA_VAZIA });
  const setAba = (a: string) =>
    id ? navigate(`${ROTA_PESSOAS}/${id}${a === 'dados' ? '' : `/${a}`}`, { replace: true }) : setAbaNovo(a);
  const c = useCadastro<PessoaDetalhe, ValoresPessoa>({
    api: '/pessoas',
    rota: ROTA_PESSOAS,
    recurso: 'pessoas',
    id,
    form,
    paraValores,
    paraCorpo: corpoPessoa,
    schemaCriar: criarPessoaSchema,
    schemaAlterar: alterarPessoaSchema,
    aoErroCampos: (campos) => setAba(abaDoErro(campos, { dados: Object.keys(PESSOA_VAZIA) }) ?? 'dados'),
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_PESSOAS} />;
  const p = c.registro.data;
  const v = form.getValues();
  const pj = v.tipo === 'PJ';
  const abaAtiva = id ? ((ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados') : abaNovo;
  const podeCredito = pode('pessoas.editar_credito');
  const duplicada =
    c.erro instanceof ErroRequisicao && c.erro.codigo === 'CONFLITO' && c.erro.corpo.detalhes?.pessoaId
      ? (c.erro.corpo.detalhes as { pessoaId: string; codigo: number; nome: string })
      : null;
  const erroLista = (campo: string) =>
    form.errors[campo] ? (
      <Text size="xs" c="red">
        {form.errors[campo]}
      </Text>
    ) : null;

  const dados = (
    <Stack gap="md">
      {duplicada && (
        <Alert color="yellow" title="CPF/CNPJ já cadastrado">
          Já existe{' '}
          <Anchor component={Link} to={`${ROTA_PESSOAS}/${duplicada.pessoaId}`}>
            {duplicada.codigo} - {duplicada.nome}
          </Anchor>{' '}
          com este documento.
        </Alert>
      )}
      <Grid>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <SegmentedControl
            fullWidth
            mt={24}
            data={[
              { value: 'PF', label: 'Pessoa física' },
              { value: 'PJ', label: 'Jurídica' },
            ]}
            {...form.getInputProps('tipo')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput
            label={pj ? 'Razão social' : 'Nome'}
            required
            maxLength={150}
            {...form.getInputProps('nome')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <Switch mt={30} label="Ativa" {...form.getInputProps('ativa', { type: 'checkbox' })} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput
            label={pj ? 'Nome fantasia' : 'Apelido'}
            maxLength={150}
            {...form.getInputProps('apelido')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <TextInput label={pj ? 'CNPJ' : 'CPF'} maxLength={18} {...form.getInputProps('cpfCnpj')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <TextInput
            label={pj ? 'IE' : 'RG'}
            description={pj ? 'Aceita ISENTO' : undefined}
            maxLength={20}
            {...form.getInputProps('rgIe')}
          />
        </Grid.Col>
        {pj && (
          <>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <Select
                label="Contribuinte ICMS"
                allowDeselect={false}
                data={[
                  { value: 'contribuinte', label: 'Contribuinte' },
                  { value: 'isento', label: 'Isento' },
                  { value: 'nao_contribuinte', label: 'Não contribuinte' },
                ]}
                {...form.getInputProps('indicadorIe')}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <TextInput
                label="Insc. municipal"
                maxLength={20}
                {...form.getInputProps('inscricaoMunicipal')}
              />
            </Grid.Col>
          </>
        )}
        <Grid.Col span={{ base: 6, sm: pj ? 4 : 3 }}>
          <DateInput
            label={pj ? 'Fundação' : 'Nascimento'}
            valueFormat="DD/MM/YYYY"
            clearable
            maxDate={new Date()}
            {...form.getInputProps('nascimento')}
          />
        </Grid.Col>
        {!pj && (
          <Grid.Col span={{ base: 6, sm: 3 }}>
            <Select
              label="Sexo"
              allowDeselect={false}
              data={[
                { value: 'N', label: 'Não informado' },
                { value: 'F', label: 'Feminino' },
                { value: 'M', label: 'Masculino' },
                { value: 'O', label: 'Outro' },
              ]}
              {...form.getInputProps('sexo')}
            />
          </Grid.Col>
        )}
      </Grid>

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Categorias{' '}
          <Text span c="red">
            *
          </Text>
        </Text>
        <Checkbox.Group {...form.getInputProps('categorias')}>
          <Group gap="lg">
            {CATEGORIAS_PESSOA.map((cat) => (
              <Checkbox key={cat} value={cat} label={ROTULOS_CATEGORIA_PESSOA[cat]} />
            ))}
          </Group>
        </Checkbox.Group>
      </Stack>

      <Grid>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <NumberInput
            label="Limite de compras"
            description={podeCredito ? 'Vazio = limite padrão' : 'Exige "Alterar limite de compras"'}
            min={0}
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            prefix="R$ "
            disabled={!podeCredito}
            {...form.getInputProps('limiteCompras')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <NumberInput
            label="Desconto %"
            min={0}
            max={100}
            decimalScale={2}
            decimalSeparator=","
            {...form.getInputProps('descontoPct')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Switch
            mt={30}
            label="Bloquear vendas a prazo"
            disabled={!podeCredito}
            {...form.getInputProps('bloqueadaCredito', { type: 'checkbox' })}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Group align="flex-end" gap="sm">
            <PasswordInput
              label="Senha do cliente (crediário)"
              description={
                p?.senhaDefinida ? 'Definida · deixe em branco para manter' : 'Numérica, 6 a 8 dígitos'
              }
              autoComplete="new-password"
              inputMode="numeric"
              disabled={v.removerSenha}
              {...form.getInputProps('senha')}
            />
            {p?.senhaDefinida && (
              <Checkbox label="Remover" {...form.getInputProps('removerSenha', { type: 'checkbox' })} />
            )}
          </Group>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput
            label="Aviso no PDV"
            description="Mostrado ao operador quando o cliente é identificado"
            maxLength={200}
            {...form.getInputProps('observacaoPdv')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Switch
            mt={30}
            label="Manter no PDV (consulta offline)"
            description="Funcionários e clientes com crediário já ficam no caixa"
            {...form.getInputProps('manterNoPdv', { type: 'checkbox' })}
          />
        </Grid.Col>
        <Grid.Col span={12}>
          <Textarea
            label="Observações"
            autosize
            minRows={2}
            maxRows={6}
            {...form.getInputProps('observacoes')}
          />
        </Grid.Col>
      </Grid>

      <Group justify="space-between">
        <Title order={4} size="h5">
          Endereços
        </Title>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => form.insertListItem('enderecos', novoEndereco(v.enderecos.length === 0))}
        >
          Inserir endereço
        </Button>
      </Group>
      {erroLista('enderecos')}
      {v.enderecos.map((e, i) => (
        <Paper key={e.id ?? `novo-${i}`} withBorder p="sm" data-testid={`endereco-${i}`}>
          <Group justify="space-between" mb="xs">
            <Group gap="sm">
              <Select
                aria-label="Tipo do endereço"
                size="xs"
                w={150}
                allowDeselect={false}
                data={TIPOS_ENDERECO.map((t) => ({ value: t, label: ROTULOS_TIPO_ENDERECO[t] }))}
                {...form.getInputProps(`enderecos.${i}.tipo`)}
              />
              <Checkbox
                label="Fora do país"
                {...form.getInputProps(`enderecos.${i}.exterior`, { type: 'checkbox' })}
              />
            </Group>
            <ActionIcon
              color="red"
              variant="subtle"
              aria-label={`Remover endereço ${i + 1}`}
              onClick={() => form.removeListItem('enderecos', i)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
          {e.exterior ? (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <Select
                  label="País"
                  required
                  searchable
                  data={(paises.data ?? []).map((x) => ({ value: x.codigoBacen, label: x.nome }))}
                  {...form.getInputProps(`enderecos.${i}.paisCodigo`)}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput
                  label="Cidade"
                  maxLength={80}
                  {...form.getInputProps(`enderecos.${i}.cidadeExterior`)}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4 }}>
                <TextInput
                  label="Endereço"
                  maxLength={150}
                  {...form.getInputProps(`enderecos.${i}.logradouro`)}
                />
              </Grid.Col>
            </Grid>
          ) : (
            <CamposEndereco form={form} prefixo={`enderecos.${i}.`} />
          )}
          <TextInput
            mt="xs"
            label="Referência"
            maxLength={150}
            {...form.getInputProps(`enderecos.${i}.referencia`)}
          />
        </Paper>
      ))}

      <Group justify="space-between">
        <Title order={4} size="h5">
          Telefones
        </Title>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            form.insertListItem('telefones', {
              id: null,
              tipo: 'celular',
              numero: '',
              contato: '',
              principal: v.telefones.length === 0,
            })
          }
        >
          Inserir telefone
        </Button>
      </Group>
      {erroLista('telefones')}
      {v.telefones.map((t, i) => (
        <Group key={t.id ?? `tel-${i}`} align="flex-start" gap="sm" wrap="wrap">
          <Select
            aria-label="Tipo do telefone"
            w={150}
            allowDeselect={false}
            data={TIPOS_TELEFONE.map((x) => ({ value: x, label: ROTULOS_TIPO_TELEFONE[x] }))}
            {...form.getInputProps(`telefones.${i}.tipo`)}
          />
          <TextInput
            aria-label="Número do telefone"
            placeholder="(41) 99999-0000"
            w={180}
            {...form.getInputProps(`telefones.${i}.numero`)}
            error={form.errors[`telefones.${i}.numero`] ?? form.errors[`telefones.${i}.ddd`]}
          />
          <TextInput
            aria-label="Contato"
            placeholder="Contato"
            maxLength={80}
            {...form.getInputProps(`telefones.${i}.contato`)}
          />
          <Checkbox
            mt={8}
            label="Principal"
            {...form.getInputProps(`telefones.${i}.principal`, { type: 'checkbox' })}
          />
          <ActionIcon
            mt={4}
            color="red"
            variant="subtle"
            aria-label={`Remover telefone ${i + 1}`}
            onClick={() => form.removeListItem('telefones', i)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}

      <Group justify="space-between">
        <Title order={4} size="h5">
          E-mails
        </Title>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            form.insertListItem('emails', {
              id: null,
              email: '',
              principal: v.emails.length === 0,
              recebeDocumentos: true,
            })
          }
        >
          Inserir e-mail
        </Button>
      </Group>
      {erroLista('emails')}
      {v.emails.map((e, i) => (
        <Group key={e.id ?? `email-${i}`} align="flex-start" gap="sm">
          <TextInput
            aria-label="E-mail"
            placeholder="nome@exemplo.com"
            w={320}
            {...form.getInputProps(`emails.${i}.email`)}
          />
          <Checkbox
            mt={8}
            label="Principal"
            {...form.getInputProps(`emails.${i}.principal`, { type: 'checkbox' })}
          />
          <Checkbox
            mt={8}
            label="Recebe XML/DANFE/boletos"
            {...form.getInputProps(`emails.${i}.recebeDocumentos`, { type: 'checkbox' })}
          />
          <ActionIcon
            mt={4}
            color="red"
            variant="subtle"
            aria-label={`Remover e-mail ${i + 1}`}
            onClick={() => form.removeListItem('emails', i)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
    </Stack>
  );

  const emBreve = (texto: string) => (
    <Alert icon={<IconInfoCircle size={18} />} variant="light" title="Em construção">
      {texto}
    </Alert>
  );

  return (
    <FormularioEntidade
      titulo={c.novo ? 'Nova pessoa' : (p?.nome ?? 'Pessoa')}
      codigo={p?.codigo}
      situacao={p ? (p.ativa ? { rotulo: 'Ativa', cor: 'green' } : { rotulo: 'Inativa', cor: 'gray' }) : null}
      alteradoEm={p?.atualizadoEm}
      alteradoPor={p?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={!pode(c.novo ? 'pessoas.criar' : 'pessoas.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_PESSOAS}
      rotaNovo={!c.novo && pode('pessoas.criar') ? `${ROTA_PESSOAS}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('pessoas.excluir') ? c.excluir : undefined}
      erro={duplicada ? null : c.erro}
      aoRecarregar={c.recarregar}
      historico={p ? { entidade: 'pessoas', registroId: p.id } : undefined}
      abaAtiva={abaAtiva}
      aoMudarAba={setAba}
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados gerais',
          conteudo: dados,
          comErro: Object.keys(form.errors).length > 0,
        },
        {
          valor: 'financeiro',
          rotulo: 'Vendas e Financeiro',
          conteudo: (
            <Stack>
              {p?.origem === 'pdv' && <Badge>Cadastrada no caixa</Badge>}
              {emBreve(
                'Crédito em aberto, últimas vendas, contas a receber/pagar e vasilhames chegam com as vendas e o financeiro.',
              )}
            </Stack>
          ),
        },
        {
          valor: 'total',
          rotulo: 'Total',
          conteudo: emBreve('Totais de compras, ticket médio e maior atraso chegam com as vendas.'),
        },
      ]}
    />
  );
}
