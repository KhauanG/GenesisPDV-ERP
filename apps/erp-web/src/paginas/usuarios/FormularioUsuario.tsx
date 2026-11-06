import {
  alterarUsuarioSchema,
  criarUsuarioSchema,
  validarPin,
  type EstoqueResumo,
  type Pagina,
  type PermissoesUsuario,
  type RespostaSenhaRedefinida,
  type RespostaUsuarioGravado,
  type UsuarioDetalhe,
} from '@genesis/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Grid,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  PasswordInput,
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
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconCopy,
  IconDeviceFloppy,
  IconInfoCircle,
  IconKey,
  IconLockOpen,
  IconPassword,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
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
import { EditorPermissoes, type Ajuste } from '../../componentes/EditorPermissoes';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { errosDaApi, errosDoZod } from '../../util/erros';
import { formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import { ROTA_USUARIOS, usePerfis } from './ListaUsuarios';

interface Valores extends ValoresEndereco {
  codigo: number | '';
  nome: string;
  login: string;
  email: string;
  telefone: string;
  cpf: string;
  ativo: boolean;
  master: boolean;
  perfilId: string | null;
  limiteDescontoPct: number | string;
  comissaoPct: number | string;
  admissao: string | null;
  demissao: string | null;
  vendedor: boolean;
  entregador: boolean;
  tecnico: boolean;
  pdvUtilitario: boolean;
  comandaEletronica: boolean;
  observacoes: string;
  lojas: string[];
  estoques: string[];
  senha: string;
  rg: string;
  salario: number | string;
  totem: boolean;
}

const VAZIO: Valores = {
  ...ENDERECO_VAZIO,
  codigo: '',
  nome: '',
  login: '',
  email: '',
  telefone: '',
  cpf: '',
  ativo: true,
  master: false,
  perfilId: null,
  limiteDescontoPct: 0,
  comissaoPct: 0,
  admissao: null,
  demissao: null,
  vendedor: false,
  entregador: false,
  tecnico: false,
  pdvUtilitario: false,
  comandaEletronica: false,
  observacoes: '',
  lojas: [],
  estoques: [],
  senha: '',
  rg: '',
  salario: '',
  totem: false,
};

function paraValores(u: UsuarioDetalhe): Valores {
  return {
    ...VAZIO,
    ...enderecoParaForm(u),
    codigo: u.codigo,
    nome: u.nome,
    login: u.login,
    email: u.email ?? '',
    telefone: u.telefone ?? '',
    cpf: u.cpf ?? '',
    ativo: u.ativo,
    master: u.master,
    perfilId: u.perfilId,
    limiteDescontoPct: Number(u.limiteDescontoPct),
    comissaoPct: Number(u.comissaoPct),
    admissao: u.admissao,
    demissao: u.demissao,
    vendedor: u.vendedor,
    entregador: u.entregador,
    tecnico: u.tecnico,
    pdvUtilitario: u.pdvUtilitario,
    comandaEletronica: u.comandaEletronica,
    observacoes: u.observacoes ?? '',
    lojas: u.lojas,
    estoques: u.estoques,
    rg: u.rg ?? '',
    salario: u.salario === null ? '' : Number(u.salario),
    totem: u.totem,
  };
}

const ABAS = ['dados', 'menus', 'permissoes', 'acessos'] as const;

/**
 * Usuários – formulário (ERP 11.2): Dados Gerais (lojas e estoques permitidos, limite de desconto, flags, RH,
 * endereço), PIN do PDV, Redefinir senha, Desbloquear e as abas Menus do sistema / Permissões Gerais (ajustes
 * individuais com três estados).
 */
export function FormularioUsuario() {
  const { id, aba } = useParams();
  const novo = !id;
  const eu = useEu();
  const pode = usePode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perfis = usePerfis();
  const [abaNovo, setAbaNovo] = useState<string>('dados');
  const [erro, setErro] = useState<unknown>(null);
  const [senhaGerada, setSenhaGerada] = useState<{ senha: string; id: string; login: string } | null>(null);
  const [pinAberto, setPinAberto] = useState(false);
  // Ativos e inativos: o inativo que o usuário já tem precisa estar entre as opções, senão sairia da lista na primeira
  // mudança do campo (e a API o retiraria, porque o editor o vê).
  const estoquesQ = useQuery({
    queryKey: ['estoques', 'todos', 'com-inativos'],
    queryFn: () => apiErp.get<Pagina<EstoqueResumo>>('/estoques?situacao=todos&tamanho=todos'),
    enabled: pode('estoques.ver'),
  });

  const form = useForm<Valores>({ mode: 'controlled', initialValues: VAZIO });

  const registro = useQuery({
    queryKey: ['usuario', id],
    queryFn: () => apiErp.get<UsuarioDetalhe>(`/usuarios/${id}`),
    enabled: !novo,
  });

  useEffect(() => {
    if (registro.data) {
      const v = paraValores(registro.data);
      form.setValues(v);
      form.resetDirty(v);
    }
    // `form` muda a cada render; só a chegada de uma nova versão do registro deve recarregar os campos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registro.data]);

  const proprio = id === eu.usuario.id;
  const somenteLeitura = !pode(novo ? 'usuarios.criar' : 'usuarios.editar');

  const gravar = useMutation({
    mutationFn: (corpo: unknown) =>
      novo
        ? apiErp.post<RespostaUsuarioGravado>('/usuarios', corpo)
        : apiErp.put<RespostaUsuarioGravado>(`/usuarios/${id}`, corpo),
    onSuccess: (r) => {
      setErro(null);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'usuarios'] });
      queryClient.setQueryData(['usuario', r.usuario.id], r.usuario);
      notifications.show({ color: 'green', message: 'Registro gravado' });
      if (novo) {
        form.resetDirty();
        if (r.senhaProvisoria)
          setSenhaGerada({ senha: r.senhaProvisoria, id: r.usuario.id, login: r.usuario.login });
        else navigate(`${ROTA_USUARIOS}/${r.usuario.id}`, { replace: true });
      }
    },
    onError: (e) => {
      setErro(e);
      if (e instanceof ErroRequisicao && e.campos) {
        form.setErrors(errosDaApi(e.campos));
        setAba('dados');
      }
    },
  });

  const excluir = useMutation({
    mutationFn: () => apiErp.del(`/usuarios/${id}`),
    onSuccess: () => {
      form.resetDirty();
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'usuarios'] });
      notifications.show({ color: 'green', message: 'Usuário excluído' });
      navigate(ROTA_USUARIOS);
    },
    onError: (e) => setErro(e),
  });

  const abaAtiva = novo ? abaNovo : (ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados';
  function setAba(a: string) {
    if (novo) setAbaNovo(a);
    else navigate(`${ROTA_USUARIOS}/${id}${a === 'dados' ? '' : `/${a}`}`, { replace: true });
  }

  function salvar() {
    const v = form.getValues();
    const corpo = {
      ...v,
      ...enderecoParaApi(v),
      cep: v.cep.replace(/\D/g, '') || null,
      salario: v.salario === '' ? null : String(v.salario),
      codigo: v.codigo === '' ? undefined : Number(v.codigo),
      lojas: v.master ? [] : v.lojas,
      ...(novo ? {} : { versao: registro.data?.versao }),
    };
    if (!novo) delete (corpo as Partial<Valores>).senha;
    const r = (novo ? criarUsuarioSchema : alterarUsuarioSchema).safeParse(corpo);
    if (!r.success) {
      form.setErrors(errosDoZod(r.error));
      setAba('dados');
      return;
    }
    gravar.mutate(r.data);
  }

  if (!novo && registro.isError) {
    if (registro.error instanceof ErroRequisicao && registro.error.status === 404) {
      return <NaoEncontrado inicio={ROTA_USUARIOS} />;
    }
    return <Alert color="red">{(registro.error as Error).message}</Alert>;
  }

  const u = registro.data;
  const errosDados = Object.keys(form.errors).length > 0;
  const opcoesPerfis = (perfis.data?.itens ?? []).map((p) => ({ value: p.id, label: p.nome }));
  if (u?.perfilId && u.perfilNome && !opcoesPerfis.some((o) => o.value === u.perfilId)) {
    opcoesPerfis.push({ value: u.perfilId, label: u.perfilNome });
  }
  const lojasOcultas = (u?.lojas ?? []).filter((l) => !eu.lojas.some((x) => x.id === l)).length;
  const values = form.getValues();
  // Estoques permitidos (decisão 149 do README da API): o seletor lista só os que o editor vê (a API filtra). Os
  // ativos são as opções; o inativo entra só se o usuário já o tem, marcado "(inativo)", para poder ficar ou sair. Os
  // do usuário que a API não devolve ao editor ficam preservados na gravação e são só contados aqui.
  const estoquesVisiveis = estoquesQ.data?.itens ?? [];
  const estoquesAtivos = estoquesVisiveis.filter((e) => e.ativo);
  const opcoesEstoques = estoquesVisiveis
    .filter((e) => e.ativo || values.estoques.includes(e.id))
    .map((e) => ({ value: e.id, label: e.ativo ? e.nome : `${e.nome} (inativo)` }));
  const estoquesOcultos = estoquesQ.data
    ? (u?.estoques ?? []).filter((e) => !estoquesVisiveis.some((x) => x.id === e)).length
    : 0;
  /** O MultiSelect só conhece as opções: os ids fora delas (os que o editor não vê) continuam no formulário. */
  function trocarEstoques(escolhidos: string[]) {
    const foraDasOpcoes = form.getValues().estoques.filter((e) => !opcoesEstoques.some((o) => o.value === e));
    form.setFieldValue('estoques', [...foraDasOpcoes, ...escolhidos]);
  }

  /**
   * Liberar uma loja não libera o estoque dela (a lista de estoques permitidos é a única que vale): ao marcar a loja,
   * o estoque dela entra junto na lista, e o gerente pode tirá-lo. Desmarcar a loja não mexe nos estoques.
   */
  function trocarLojas(lojasNovas: string[]) {
    const atuais = form.getValues();
    const adicionadas = lojasNovas.filter((l) => !atuais.lojas.includes(l));
    const doEstoque = estoquesAtivos
      .filter((e) => e.lojaId !== null && adicionadas.includes(e.lojaId) && !atuais.estoques.includes(e.id))
      .map((e) => e.id);
    form.setFieldValue('lojas', lojasNovas);
    if (doEstoque.length) form.setFieldValue('estoques', [...atuais.estoques, ...doEstoque]);
  }

  const dados = (
    <Stack gap="md">
      <Grid>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <NumberInput
            label="Código"
            description={novo ? 'Vazio = próximo da sequência' : undefined}
            min={1}
            max={999999}
            allowDecimal={false}
            {...form.getInputProps('codigo')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 9 }}>
          <TextInput label="Nome" required maxLength={100} {...form.getInputProps('nome')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <TextInput
            label="Login"
            required
            maxLength={60}
            autoComplete="off"
            {...form.getInputProps('login')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 5 }}>
          <TextInput label="E-mail" type="email" maxLength={254} {...form.getInputProps('email')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <TextInput label="Telefone" maxLength={20} {...form.getInputProps('telefone')} />
        </Grid.Col>
        {novo && (
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <PasswordInput
              label="Senha provisória"
              description="Deixe em branco para gerar uma automaticamente. O usuário troca no primeiro acesso."
              autoComplete="new-password"
              {...form.getInputProps('senha')}
            />
          </Grid.Col>
        )}
        <Grid.Col span={{ base: 12, sm: novo ? 6 : 12 }}>
          <Group gap="xl" mt={novo ? 28 : 0}>
            <Switch label="Ativo" {...form.getInputProps('ativo', { type: 'checkbox' })} />
            <Switch
              label="Usuário Master"
              disabled={!eu.usuario.master || proprio}
              {...form.getInputProps('master', { type: 'checkbox' })}
            />
          </Group>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Select
            label="Perfil de acesso"
            placeholder={values.master ? 'Master tem todas as permissões' : 'Escolha o perfil'}
            data={opcoesPerfis}
            required={!values.master}
            disabled={proprio}
            clearable
            {...form.getInputProps('perfilId')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <NumberInput
            label="Limite de desconto %"
            min={0}
            max={100}
            decimalScale={2}
            decimalSeparator=","
            disabled={proprio}
            {...form.getInputProps('limiteDescontoPct')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <NumberInput
            label="Comissão %"
            min={0}
            max={100}
            decimalScale={2}
            decimalSeparator=","
            {...form.getInputProps('comissaoPct')}
          />
        </Grid.Col>
        {!values.master && (
          <Grid.Col span={12}>
            <MultiSelect
              label="Lojas permitidas"
              placeholder={eu.lojas.length ? 'Escolha as lojas' : 'Nenhuma loja cadastrada ainda'}
              data={eu.lojas.map((l) => ({ value: l.id, label: `${l.codigo} - ${l.nome}` }))}
              disabled={proprio || eu.lojas.length === 0}
              searchable
              {...form.getInputProps('lojas')}
              value={values.lojas.filter((l) => eu.lojas.some((x) => x.id === l))}
              onChange={trocarLojas}
              description={
                lojasOcultas
                  ? `${lojasOcultas} loja(s) a que você não tem acesso continuam liberadas para este usuário.`
                  : undefined
              }
            />
          </Grid.Col>
        )}
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <TextInput label="CPF" maxLength={14} {...form.getInputProps('cpf')} />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 4 }}>
          <DateInput
            label="Admissão"
            valueFormat="DD/MM/YYYY"
            clearable
            locale="pt-br"
            {...form.getInputProps('admissao')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 4 }}>
          <DateInput
            label="Demissão"
            valueFormat="DD/MM/YYYY"
            clearable
            locale="pt-br"
            description="A partir desta data o login é bloqueado"
            {...form.getInputProps('demissao')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <TextInput label="RG" maxLength={20} {...form.getInputProps('rg')} />
        </Grid.Col>
        {pode('usuarios.ver_dados_rh') && (
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <NumberInput
              label="Salário"
              min={0}
              decimalScale={2}
              fixedDecimalScale
              decimalSeparator=","
              thousandSeparator="."
              prefix="R$ "
              {...form.getInputProps('salario')}
            />
          </Grid.Col>
        )}
        {pode('estoques.ver') && !values.master && (
          <Grid.Col span={{ base: 12, sm: pode('usuarios.ver_dados_rh') ? 4 : 8 }}>
            <MultiSelect
              label="Estoques permitidos"
              placeholder="Ex.: Loja 1, CD"
              searchable
              data={opcoesEstoques}
              disabled={proprio}
              {...form.getInputProps('estoques')}
              value={values.estoques.filter((e) => opcoesEstoques.some((o) => o.value === e))}
              onChange={trocarEstoques}
              description={
                estoquesOcultos
                  ? `Só estes estoques são vistos e movimentados (inclusive o CD). ${estoquesOcultos} estoque(s) a que você não tem acesso continuam liberados.`
                  : 'Só estes estoques são vistos e movimentados (inclusive o CD).'
              }
            />
          </Grid.Col>
        )}
        <Grid.Col span={12}>
          <Group gap="lg">
            <Checkbox
              label="É totem (dispositivo de autoatendimento)"
              {...form.getInputProps('totem', { type: 'checkbox' })}
            />
            <Checkbox label="É vendedor" {...form.getInputProps('vendedor', { type: 'checkbox' })} />
            <Checkbox label="É entregador" {...form.getInputProps('entregador', { type: 'checkbox' })} />
            <Checkbox label="É técnico" {...form.getInputProps('tecnico', { type: 'checkbox' })} />
            <Checkbox
              label="Usa PDV como utilitário"
              {...form.getInputProps('pdvUtilitario', { type: 'checkbox' })}
            />
            <Checkbox
              label="Comanda eletrônica"
              {...form.getInputProps('comandaEletronica', { type: 'checkbox' })}
            />
          </Group>
        </Grid.Col>
        <Grid.Col span={12}>
          <Text size="sm" fw={500} mb={4}>
            Endereço
          </Text>
          <CamposEndereco form={form} obrigatorio={false} />
        </Grid.Col>
        {u && (
          <Grid.Col span={12}>
            <Group gap="sm">
              <Text size="sm">
                PIN do PDV:{' '}
                {u.pinDefinido ? (
                  <Badge color="blue" variant="light">
                    Definido
                  </Badge>
                ) : (
                  <Badge color="gray" variant="light">
                    Não definido
                  </Badge>
                )}
              </Text>
              {(proprio || pode('usuarios.editar')) && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconKey size={14} />}
                  onClick={() => setPinAberto(true)}
                >
                  {u.pinDefinido ? 'Trocar PIN' : 'Definir PIN'}
                </Button>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Login e liberação de supervisor no PDV (online e offline). Única credencial de operador que
              desce ao caixa.
            </Text>
          </Grid.Col>
        )}
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
      {proprio && (
        <Alert icon={<IconInfoCircle size={18} />} variant="light">
          Você está editando o próprio usuário: perfil, lojas, limite de desconto e a flag Master só podem ser
          alterados por outro usuário.
        </Alert>
      )}
    </Stack>
  );

  const emBreve = (texto: string) => (
    <Alert icon={<IconInfoCircle size={18} />} variant="light" title="Em construção · Fase 1">
      {texto}
    </Alert>
  );

  return (
    <>
      <FormularioEntidade
        titulo={novo ? 'Novo usuário' : (u?.nome ?? 'Usuário')}
        codigo={u?.codigo}
        situacao={
          u ? (u.ativo ? { rotulo: 'Ativo', cor: 'green' } : { rotulo: 'Inativo', cor: 'gray' }) : null
        }
        alteradoEm={u?.atualizadoEm}
        alteradoPor={u?.atualizadoPorNome}
        carregando={!novo && registro.isPending}
        salvando={gravar.isPending || excluir.isPending}
        somenteLeitura={somenteLeitura}
        sujo={form.isDirty()}
        rotaVoltar={ROTA_USUARIOS}
        rotaNovo={!novo && pode('usuarios.criar') ? `${ROTA_USUARIOS}/novo` : undefined}
        aoSalvar={salvar}
        aoExcluir={!novo && !proprio && pode('usuarios.excluir') ? () => excluir.mutateAsync() : undefined}
        erro={erro}
        aoRecarregar={() => {
          setErro(null);
          void registro.refetch();
        }}
        historico={u ? { entidade: 'usuarios', registroId: u.id } : undefined}
        acoesExtras={
          u ? (
            <AcoesUsuario
              usuario={u}
              proprio={proprio}
              aoSenha={(senha) => setSenhaGerada({ senha, id: u.id, login: u.login })}
              aoAtualizar={() => void registro.refetch()}
              aoErro={setErro}
            />
          ) : undefined
        }
        abaAtiva={abaAtiva}
        aoMudarAba={setAba}
        abas={[
          { valor: 'dados', rotulo: 'Dados Gerais', conteudo: dados, comErro: errosDados },
          {
            valor: 'menus',
            rotulo: 'Menus do sistema',
            conteudo: u ? (
              <AbaPermissoesUsuario usuario={u} secao="menus" proprio={proprio} />
            ) : (
              emBreve('Grave o usuário para ajustar as permissões individuais.')
            ),
          },
          {
            valor: 'permissoes',
            rotulo: 'Permissões Gerais',
            conteudo: u ? (
              <AbaPermissoesUsuario usuario={u} secao="gerais" proprio={proprio} />
            ) : (
              emBreve('Grave o usuário para ajustar as permissões individuais.')
            ),
          },
          {
            valor: 'acessos',
            rotulo: 'Acessos',
            conteudo: (
              <Stack gap="sm">
                <Text size="sm">
                  Último acesso ao ERP: <strong>{formatarDataHora(u?.ultimoLoginEm)}</strong>
                </Text>
                {u?.bloqueadoAte && (
                  <Text size="sm" c="red">
                    Bloqueado por tentativas até {formatarDataHora(u.bloqueadoAte)}.
                  </Text>
                )}
                {u?.senhaProvisoria && (
                  <Text size="sm" c="dimmed">
                    Ainda não trocou a senha provisória.
                  </Text>
                )}
                {emBreve('Sessões ativas com "Encerrar sessão", últimos 20 logins e terminais PDV usados.')}
              </Stack>
            ),
          },
        ]}
      />
      {u && pinAberto && (
        <ModalPin usuario={u} fechar={() => setPinAberto(false)} aoGravar={() => void registro.refetch()} />
      )}
      <Modal
        opened={senhaGerada !== null}
        onClose={() => {
          const s = senhaGerada;
          setSenhaGerada(null);
          if (s) navigate(`${ROTA_USUARIOS}/${s.id}`, { replace: true });
        }}
        title={
          <Title order={3} size="h4">
            Senha provisória
          </Title>
        }
        centered
        closeOnClickOutside={false}
      >
        <Stack gap="sm">
          <Text size="sm">
            Entregue esta senha ao usuário <strong>{senhaGerada?.login}</strong>. Ela é exibida{' '}
            <strong>uma única vez</strong> e deve ser trocada no primeiro acesso.
          </Text>
          <Group
            justify="space-between"
            p="sm"
            bg="var(--mantine-color-default-hover)"
            style={{ borderRadius: 6 }}
          >
            <Text ff="monospace" fw={700} size="lg" data-testid="senha-provisoria">
              {senhaGerada?.senha}
            </Text>
            <CopyButton value={senhaGerada?.senha ?? ''}>
              {({ copied, copy }) => (
                <Button size="xs" variant="light" leftSection={<IconCopy size={14} />} onClick={copy}>
                  {copied ? 'Copiada' : 'Copiar'}
                </Button>
              )}
            </CopyButton>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Redefinir senha (ERP 11.2, `usuarios.redefinir_senha`) e Desbloquear (Master, após tentativas falhas). */
function AcoesUsuario({
  usuario,
  proprio,
  aoSenha,
  aoAtualizar,
  aoErro,
}: {
  usuario: UsuarioDetalhe;
  proprio: boolean;
  aoSenha: (senha: string) => void;
  aoAtualizar: () => void;
  aoErro: (e: unknown) => void;
}) {
  const pode = usePode();
  const eu = useEu();
  const redefinir = useMutation({
    mutationFn: () => apiErp.post<RespostaSenhaRedefinida>(`/usuarios/${usuario.id}/redefinir-senha`),
    onSuccess: (r) => {
      aoSenha(r.senhaProvisoria);
      aoAtualizar();
    },
    onError: aoErro,
  });
  const desbloquear = useMutation({
    mutationFn: () => apiErp.post(`/usuarios/${usuario.id}/desbloquear`),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Usuário desbloqueado' });
      aoAtualizar();
    },
    onError: aoErro,
  });
  return (
    <>
      {!proprio && pode('usuarios.redefinir_senha') && (
        <Button
          variant="default"
          leftSection={<IconPassword size={16} />}
          loading={redefinir.isPending}
          onClick={() =>
            modals.openConfirmModal({
              title: 'Redefinir senha',
              children: (
                <Text size="sm">
                  Gerar uma senha provisória para {usuario.login}? As sessões abertas dele são encerradas.
                </Text>
              ),
              labels: { confirm: 'Redefinir', cancel: 'Cancelar' },
              onConfirm: () => redefinir.mutate(),
            })
          }
        >
          Redefinir senha
        </Button>
      )}
      {usuario.bloqueadoAte && eu.usuario.master && (
        <Button
          variant="default"
          leftSection={<IconLockOpen size={16} />}
          loading={desbloquear.isPending}
          onClick={() => desbloquear.mutate()}
        >
          Desbloquear
        </Button>
      )}
    </>
  );
}

/** PIN do PDV (SYNC 4.3): validado na tela com as mesmas regras da API. */
function ModalPin({
  usuario,
  fechar,
  aoGravar,
}: {
  usuario: UsuarioDetalhe;
  fechar: () => void;
  aoGravar: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const gravar = useMutation({
    mutationFn: (valor: string | null) => apiErp.put(`/usuarios/${usuario.id}/pin`, { pin: valor }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'PIN do PDV gravado' });
      aoGravar();
      fechar();
    },
    onError: (e) =>
      setErro(e instanceof ErroRequisicao && e.campos?.pin ? e.campos.pin[0]! : (e as Error).message),
  });
  function salvar() {
    // O PIN curto depende de `pdv.permite_pin_curto`: a tela aceita 4+ e a API confere a configuração.
    const msg = validarPin(pin, { permitirCurto: true, codigoUsuario: usuario.codigo });
    if (msg) return setErro(msg);
    if (pin !== confirmacao) return setErro('A confirmação não confere');
    gravar.mutate(pin);
  }
  return (
    <Modal opened onClose={fechar} title={`PIN do PDV – ${usuario.nome}`} centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Só números, 6 a 8 dígitos (4–5 se a empresa permitir PIN curto). Sem sequências, repetições ou o
          código do usuário.
        </Text>
        <PasswordInput
          label="Novo PIN"
          inputMode="numeric"
          autoComplete="new-password"
          value={pin}
          onChange={(e) => setPin(e.currentTarget.value)}
        />
        <PasswordInput
          label="Confirme o PIN"
          inputMode="numeric"
          autoComplete="new-password"
          value={confirmacao}
          onChange={(e) => setConfirmacao(e.currentTarget.value)}
        />
        {erro && (
          <Alert color="red" role="alert">
            {erro}
          </Alert>
        )}
        <Group justify="space-between">
          {usuario.pinDefinido ? (
            <Button
              variant="subtle"
              color="red"
              loading={gravar.isPending}
              onClick={() => gravar.mutate(null)}
            >
              Remover PIN
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={fechar}>
              Cancelar
            </Button>
            <Button loading={gravar.isPending} onClick={salvar}>
              Gravar PIN
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Abas Menus do sistema / Permissões Gerais do usuário: ajustes individuais sobre o perfil (ERP 11.2). */
function AbaPermissoesUsuario({
  usuario,
  secao,
  proprio,
}: {
  usuario: UsuarioDetalhe;
  secao: 'menus' | 'gerais';
  proprio: boolean;
}) {
  const pode = usePode();
  const queryClient = useQueryClient();
  const chave = ['usuario-permissoes', usuario.id];
  const dados = useQuery({
    queryKey: chave,
    queryFn: () => apiErp.get<PermissoesUsuario>(`/usuarios/${usuario.id}/permissoes`),
  });
  const [ajustes, setAjustes] = useState<Map<string, Ajuste> | null>(null);
  const atuais = ajustes ?? new Map((dados.data?.ajustes ?? []).map((a) => [a.permissao, a.efeito]));
  const gravar = useMutation({
    mutationFn: () =>
      apiErp.put<PermissoesUsuario>(`/usuarios/${usuario.id}/permissoes`, {
        versao: dados.data!.versao,
        ajustes: [...atuais.entries()].map(([permissao, efeito]) => ({ permissao, efeito })),
      }),
    onSuccess: (r) => {
      queryClient.setQueryData(chave, r);
      void queryClient.invalidateQueries({ queryKey: ['usuario', usuario.id] });
      setAjustes(null);
      notifications.show({ color: 'green', message: 'Permissões gravadas' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
  });
  if (dados.isPending) return <Text size="sm">Carregando…</Text>;
  if (dados.isError) return <Alert color="red">{(dados.error as Error).message}</Alert>;
  if (dados.data.master) {
    return (
      <Alert variant="light" icon={<IconInfoCircle size={18} />}>
        Usuário Master tem todas as permissões.
      </Alert>
    );
  }
  const somenteLeitura = proprio || !pode('usuarios.permissoes');
  return (
    <Stack gap="sm">
      {proprio && (
        <Alert variant="light" icon={<IconInfoCircle size={18} />}>
          Você não pode alterar as próprias permissões.
        </Alert>
      )}
      <EditorPermissoes
        modo="usuario"
        secao={secao}
        doPerfil={new Set(dados.data.doPerfil)}
        ajustes={atuais}
        aoMudar={setAjustes}
        somenteLeitura={somenteLeitura}
      />
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {dados.data.efetivas.length} permissão(ões) efetiva(s) · {atuais.size} ajuste(s) individual(is)
        </Text>
        {!somenteLeitura && (
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!ajustes}
            loading={gravar.isPending}
            onClick={() => gravar.mutate()}
          >
            Gravar permissões
          </Button>
        )}
      </Group>
    </Stack>
  );
}
