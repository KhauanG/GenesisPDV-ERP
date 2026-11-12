import {
  alterarLojaSchema,
  criarLojaSchema,
  formatarCpfCnpj,
  PIX_CIDADE_MAXIMO,
  PIX_NOME_MAXIMO,
  REGIMES_FISCAIS,
  ROTULOS_TIPO_EMISSAO,
  ROTULOS_TIPO_LOJA,
  TIPOS_EMISSAO,
  TIPOS_LOJA,
  type EstoqueResumo,
  type LojaDetalhe,
  type LojaResumo,
  type Pagina,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Grid,
  NumberInput,
  Radio,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useSessao } from '../../auth/sessao';
import { abaDoErro, useCadastro } from '../../componentes/cadastro';
import {
  CamposEndereco,
  ENDERECO_VAZIO,
  enderecoParaApi,
  enderecoParaForm,
  type ValoresEndereco,
} from '../../componentes/campos/CamposEndereco';
import { tiposELimiteArquivo, UploadArquivo } from '../../componentes/campos/UploadArquivo';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { CamposConfiguracoes } from '../configuracoes/CamposConfiguracoes';
import { ABA_GERAL, ABA_PARAMETROS, ABA_PDV } from '../configuracoes/rotulos';
import { NaoEncontrado } from '../Erros';
import { badgeAtivo, OPCOES_SITUACAO } from '../estoques/Estoques';
import { CaixasLoja } from './CaixasLoja';

export const ROTA_LOJAS = '/cadastros/lojas';

/** Lojas – listagem (ERP 10.3): Nome, CNPJ, Tipo, Estoque vinculado, Caixas ativos, Ativa. */
export function ListaLojas() {
  const config = useMemo<ConfigListagem<LojaResumo>>(
    () => ({
      recurso: 'lojas',
      titulo: 'Lojas',
      ordenacaoPadrao: 'ordem:asc',
      rotaNovo: `${ROTA_LOJAS}/novo`,
      rotuloNovo: 'Nova loja',
      rotaEdicao: (l) => `${ROTA_LOJAS}/${l.id}`,
      chaveLinha: (l) => l.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto', placeholder: 'Nome, fantasia ou CNPJ' },
        { campo: 'situacao', rotulo: 'Situação', tipo: 'selecao', padrao: 'todos', opcoes: OPCOES_SITUACAO },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Cód.', ordenavel: true, largura: 80 },
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (l) => (
            <Anchor component={Link} to={`${ROTA_LOJAS}/${l.id}`} c="inherit">
              {l.nome}
            </Anchor>
          ),
        },
        { campo: 'cnpj', rotulo: 'CNPJ', ordenavel: true, formato: (l) => formatarCpfCnpj(l.cnpj) },
        { campo: 'tipo', rotulo: 'Tipo', ordenavel: true, formato: (l) => ROTULOS_TIPO_LOJA[l.tipo] },
        { campo: 'estoqueNome', rotulo: 'Estoque vinculado', formato: (l) => l.estoqueNome ?? '—' },
        { campo: 'caixasAtivos', rotulo: 'Caixas ativos', alinhamento: 'right', largura: 120 },
        {
          campo: 'ativa',
          rotulo: 'Ativa',
          ordenavel: true,
          alinhamento: 'center',
          largura: 90,
          formato: (l) => badgeAtivo(l.ativa),
        },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<LojaResumo>>(`/lojas${query(params)}`, { sinal }),
    }),
    [],
  );
  return <Listagem config={config} />;
}

export interface ValoresLoja extends ValoresEndereco, Record<string, unknown> {
  nome: string;
  tipo: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string;
  ie: string;
  inscricaoMunicipal: string;
  telefone: string;
  celular: string;
  email: string;
  modoEstoque: 'criar' | 'existente';
  estoqueId: string | null;
  nomeEstoque: string;
  fusoHorario: string;
  fraseRodapeCupom: string;
  ordem: number | string;
  ativa: boolean;
  usaPdv: boolean;
  usaMenuDigital: boolean;
  treino: boolean;
  chavePublica: string;
  chavePix: string;
  pixNomeRecebedor: string;
  pixCidadeRecebedor: string;
  regime: string | null;
  tipoEmissao: string;
  nfceAmbiente: string;
  nfeSerie: number | string;
  nfcePrazoCancelamentoMin: number | string;
  nfceValorExigeIdentificacao: number | string;
  /** Anexos (ERP 10.3.4; F2-B43): o id do envio de `POST /api/arquivos`, gravado com a loja no Salvar. */
  logotipoArquivoId: string | null;
  fotoArquivoId: string | null;
}

export const LOJA_VAZIA: ValoresLoja = {
  ...ENDERECO_VAZIO,
  nome: '',
  tipo: 'ponto_venda',
  razaoSocial: '',
  nomeFantasia: '',
  cnpj: '',
  ie: '',
  inscricaoMunicipal: '',
  telefone: '',
  celular: '',
  email: '',
  modoEstoque: 'criar',
  estoqueId: null,
  nomeEstoque: '',
  fusoHorario: 'America/Sao_Paulo',
  fraseRodapeCupom: '',
  ordem: 0,
  ativa: true,
  usaPdv: true,
  usaMenuDigital: false,
  treino: false,
  chavePublica: '',
  chavePix: '',
  pixNomeRecebedor: '',
  pixCidadeRecebedor: '',
  regime: null,
  tipoEmissao: 'nao_fiscal',
  nfceAmbiente: '2',
  nfeSerie: '',
  nfcePrazoCancelamentoMin: 30,
  nfceValorExigeIdentificacao: 10000,
  logotipoArquivoId: null,
  fotoArquivoId: null,
};

function paraValores(l: LojaDetalhe): ValoresLoja {
  return {
    ...LOJA_VAZIA,
    ...enderecoParaForm(l),
    nome: l.nome,
    tipo: l.tipo,
    razaoSocial: l.razaoSocial,
    nomeFantasia: l.nomeFantasia,
    cnpj: formatarCpfCnpj(l.cnpj),
    ie: l.ie ?? '',
    inscricaoMunicipal: l.inscricaoMunicipal ?? '',
    telefone: l.telefone ?? '',
    celular: l.celular ?? '',
    email: l.email ?? '',
    modoEstoque: 'existente',
    estoqueId: l.estoqueId,
    fusoHorario: l.fusoHorario,
    fraseRodapeCupom: l.fraseRodapeCupom ?? '',
    ordem: l.ordem,
    ativa: l.ativa,
    usaPdv: l.usaPdv,
    usaMenuDigital: l.usaMenuDigital,
    treino: l.treino,
    chavePublica: l.chavePublica ?? '',
    chavePix: l.chavePix ?? '',
    pixNomeRecebedor: l.pixNomeRecebedor ?? '',
    pixCidadeRecebedor: l.pixCidadeRecebedor ?? '',
    regime: l.regime,
    tipoEmissao: l.tipoEmissao,
    nfceAmbiente: String(l.nfceAmbiente),
    nfeSerie: l.nfeSerie ?? '',
    nfcePrazoCancelamentoMin: l.nfcePrazoCancelamentoMin,
    nfceValorExigeIdentificacao: Number(l.nfceValorExigeIdentificacao),
    logotipoArquivoId: l.logotipoArquivoId,
    fotoArquivoId: l.fotoArquivoId,
  };
}

/** Corpo da API a partir do formulário (o assistente manda `estoqueId` nulo para criar o estoque homônimo). */
export function corpoLoja(v: ValoresLoja, novo: boolean): Record<string, unknown> {
  const { modoEstoque, nomeEstoque, logotipoArquivoId, fotoArquivoId, ...resto } = v;
  return {
    ...resto,
    ...enderecoParaApi(v),
    ordem: Number(v.ordem || 0),
    nfceAmbiente: Number(v.nfceAmbiente),
    nfeSerie: v.nfeSerie === '' ? null : Number(v.nfeSerie),
    nfcePrazoCancelamentoMin: Number(v.nfcePrazoCancelamentoMin || 30),
    nfceValorExigeIdentificacao: String(
      v.nfceValorExigeIdentificacao === '' ? 0 : v.nfceValorExigeIdentificacao,
    ),
    usaPdv: v.tipo === 'deposito' ? false : v.usaPdv,
    // CD (depósito) não tem cupom nem menu digital.
    ...(v.tipo === 'deposito'
      ? {
          usaMenuDigital: false,
          fraseRodapeCupom: null,
          chavePublica: null,
          chavePix: null,
          pixNomeRecebedor: null,
          pixCidadeRecebedor: null,
        }
      : {}),
    // Os Anexos só existem na loja já criada (o envio leva o id dela).
    ...(novo
      ? {
          estoqueId: modoEstoque === 'criar' ? null : v.estoqueId,
          nomeEstoque: modoEstoque === 'criar' ? nomeEstoque : null,
        }
      : { logotipoArquivoId, fotoArquivoId }),
  };
}

const ABAS = ['dados', 'fiscal', 'anexos', 'caixas', 'parametros'] as const;
const CAMPOS_FISCAL = [
  'regime',
  'tipoEmissao',
  'nfceAmbiente',
  'nfeSerie',
  'nfcePrazoCancelamentoMin',
  'nfceValorExigeIdentificacao',
];
const CAMPOS_ANEXOS = ['logotipoArquivoId', 'fotoArquivoId'];
const PARAMETROS_LOJA = [...ABA_GERAL, ...ABA_PARAMETROS, ...ABA_PDV];

/**
 * Lojas – formulário (ERP 10.3). "Nova loja" é o assistente de primeira configuração (MD 7.13): estoque homônimo
 * (ou um existente, como o CD), caixa 0, conta "Caixa – loja" e numerações nascem juntos na API.
 */
export function FormularioLoja() {
  const { id, aba } = useParams();
  const pode = usePode();
  const { recarregarEu } = useSessao();
  const navigate = useNavigate();
  const [abaNovo, setAbaNovo] = useState('dados');
  const form = useForm<ValoresLoja>({ mode: 'controlled', initialValues: LOJA_VAZIA });
  const setAba = (a: string) =>
    id ? navigate(`${ROTA_LOJAS}/${id}${a === 'dados' ? '' : `/${a}`}`, { replace: true }) : setAbaNovo(a);
  const c = useCadastro<LojaDetalhe, ValoresLoja>({
    api: '/lojas',
    rota: ROTA_LOJAS,
    recurso: 'lojas',
    id,
    form,
    paraValores,
    paraCorpo: (v) => corpoLoja(v, !id),
    schemaCriar: criarLojaSchema,
    schemaAlterar: alterarLojaSchema,
    aoErroCampos: (campos) =>
      setAba(abaDoErro(campos, { fiscal: CAMPOS_FISCAL, anexos: CAMPOS_ANEXOS }) ?? 'dados'),
    aoGravar: () => void recarregarEu(),
  });
  const estoques = useQuery({
    queryKey: ['estoques', 'livres'],
    queryFn: () => apiErp.get<Pagina<EstoqueResumo>>('/estoques?situacao=ativos&tamanho=todos'),
    enabled: pode('estoques.ver'),
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_LOJAS} />;
  const l = c.registro.data;
  const v = form.getValues();
  const somenteLeitura = !pode(c.novo ? 'lojas.criar' : 'lojas.editar');
  // O recebedor do PIX decide para qual conta vai o dinheiro do QR do caixa: só com `lojas.editar_pix` (API README ›
  // decisão 144); o Gerente edita o resto da loja e vê a chave sem poder trocá-la.
  const semPermissaoPix = !pode('lojas.editar_pix');
  const abaAtiva = id ? ((ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados') : abaNovo;
  const opcoesEstoque = (estoques.data?.itens ?? [])
    .filter((e) => !e.lojaId || e.lojaId === id)
    .map((e) => ({ value: e.id, label: `${e.nome}${e.tipo === 'deposito' ? ' (CD)' : ''}` }));
  if (l && !opcoesEstoque.some((o) => o.value === l.estoqueId))
    opcoesEstoque.push({ value: l.estoqueId, label: l.estoqueNome ?? 'Estoque atual' });
  const errosDados = Object.keys(form.errors).some(
    (k) => !CAMPOS_FISCAL.includes(k) && !CAMPOS_ANEXOS.includes(k),
  );

  const dados = (
    <Stack gap="md">
      {c.novo && (
        <Alert icon={<IconInfoCircle size={18} />} variant="light" title="Primeira configuração da loja">
          Ao gravar, o sistema cria junto o caixa 0 (vendas do ERP), a conta corrente “Caixa –{' '}
          {v.nome || 'nome da loja'}” e as numerações. Para o CD, escolha o tipo Depósito/CD e o estoque “CD -
          Estoque …”.
        </Alert>
      )}
      <Grid>
        <Grid.Col span={{ base: 12, sm: 5 }}>
          <TextInput label="Nome" required maxLength={60} {...form.getInputProps('nome')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 3 }}>
          <Select
            label="Tipo"
            required
            allowDeselect={false}
            data={TIPOS_LOJA.map((t) => ({ value: t, label: ROTULOS_TIPO_LOJA[t] }))}
            {...form.getInputProps('tipo')}
            onChange={(t) => {
              form.setFieldValue('tipo', t ?? 'ponto_venda');
              if (t === 'deposito') form.setFieldValue('usaPdv', false);
            }}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <TextInput label="CNPJ" required {...form.getInputProps('cnpj')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput label="Razão social" required maxLength={150} {...form.getInputProps('razaoSocial')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput
            label="Fantasia"
            description={v.tipo === 'deposito' ? undefined : 'Impresso no cupom'}
            required
            maxLength={150}
            {...form.getInputProps('nomeFantasia')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput
            label="IE"
            description="Obrigatória para NFC-e/NF-e"
            maxLength={20}
            {...form.getInputProps('ie')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput label="Insc. municipal" maxLength={20} {...form.getInputProps('inscricaoMunicipal')} />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput label="Telefone" maxLength={20} {...form.getInputProps('telefone')} />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput label="Celular" maxLength={20} {...form.getInputProps('celular')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput label="E-mail" maxLength={254} {...form.getInputProps('email')} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <TextInput label="Fuso horário" required {...form.getInputProps('fusoHorario')} />
        </Grid.Col>
      </Grid>
      <Title order={4} size="h5">
        Estoque vinculado
      </Title>
      {c.novo ? (
        <Stack gap="xs">
          <Radio.Group {...form.getInputProps('modoEstoque')}>
            <Stack gap={6}>
              <Radio value="criar" label="Criar estoque com o nome da loja" />
              <Radio
                value="existente"
                label="Usar um local de estoque já cadastrado"
                disabled={!opcoesEstoque.length}
              />
            </Stack>
          </Radio.Group>
          {v.modoEstoque === 'criar' ? (
            <TextInput
              label="Nome do estoque"
              placeholder={v.nome || 'Igual ao nome da loja'}
              maxLength={60}
              {...form.getInputProps('nomeEstoque')}
            />
          ) : (
            <Select
              label="Estoque"
              required
              searchable
              data={opcoesEstoque}
              {...form.getInputProps('estoqueId')}
            />
          )}
        </Stack>
      ) : (
        <Select
          label="Estoque"
          description="Um estoque só pode ser vinculado a uma loja"
          required
          searchable
          data={opcoesEstoque}
          {...form.getInputProps('estoqueId')}
        />
      )}
      <Title order={4} size="h5">
        Endereço
      </Title>
      <CamposEndereco form={form} />
      <Grid>
        {v.tipo !== 'deposito' && (
          <Grid.Col span={12}>
            <Textarea
              label="Frase do rodapé do cupom"
              maxLength={300}
              autosize
              minRows={1}
              {...form.getInputProps('fraseRodapeCupom')}
            />
          </Grid.Col>
        )}
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <NumberInput label="Ordem" min={0} allowDecimal={false} {...form.getInputProps('ordem')} />
        </Grid.Col>
        {v.tipo !== 'deposito' && (
          <Grid.Col span={{ base: 6, sm: 4 }}>
            <TextInput
              label="Chave (menu digital)"
              description="Letras minúsculas, números e hífen"
              maxLength={40}
              {...form.getInputProps('chavePublica')}
            />
          </Grid.Col>
        )}
        <Grid.Col span={{ base: 12, sm: 6 }}>
          <Stack gap={6} mt={6}>
            <Switch label="Ativa" {...form.getInputProps('ativa', { type: 'checkbox' })} />
            <Switch
              label="Usa PDV nesta loja"
              disabled={v.tipo === 'deposito'}
              {...form.getInputProps('usaPdv', { type: 'checkbox' })}
            />
            {v.tipo !== 'deposito' && (
              <Switch
                label="Usa menu digital"
                {...form.getInputProps('usaMenuDigital', { type: 'checkbox' })}
              />
            )}
            {/* Loja de treino (O10): fora das consultas e do dashboard por padrão; só não fiscal (`regrasLoja`). */}
            <Switch
              label="Loja de treino"
              description="Só não fiscal. Vendas de treino ficam fora das consultas e do dashboard, salvo no filtro"
              {...form.getInputProps('treino', { type: 'checkbox' })}
            />
          </Stack>
        </Grid.Col>
      </Grid>
      {v.tipo !== 'deposito' && (
        <>
          {/* PIX estático com valor (PDV 16.7; implantação I5): sem a chave, o caixa confirma o PIX à mão, sem QR. */}
          <Title order={4} size="h5">
            PIX do recebedor (QR no caixa)
          </Title>
          {semPermissaoPix && !somenteLeitura && (
            <Text size="sm" c="dimmed">
              Só quem tem a permissão “Lojas: Alterar o recebedor do PIX” (o Administrador) troca a chave, o
              nome ou a cidade.
            </Text>
          )}
          <Grid>
            <Grid.Col span={{ base: 12, sm: 5 }}>
              <TextInput
                label="Chave PIX"
                description="CPF, CNPJ, e-mail, celular com +55 e DDD ou chave aleatória"
                maxLength={77}
                disabled={semPermissaoPix}
                {...form.getInputProps('chavePix')}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <TextInput
                label="Nome do recebedor"
                description="Até 25 letras, como aparece no app do banco"
                maxLength={PIX_NOME_MAXIMO}
                disabled={semPermissaoPix}
                {...form.getInputProps('pixNomeRecebedor')}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 3 }}>
              <TextInput
                label="Cidade do recebedor"
                description="Até 15 letras"
                maxLength={PIX_CIDADE_MAXIMO}
                disabled={semPermissaoPix}
                {...form.getInputProps('pixCidadeRecebedor')}
              />
            </Grid.Col>
          </Grid>
        </>
      )}
    </Stack>
  );

  const fiscal = (
    <Stack gap="md">
      <Grid>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Select
            label="Tipo de emissão"
            allowDeselect={false}
            data={TIPOS_EMISSAO.map((t) => ({ value: t, label: ROTULOS_TIPO_EMISSAO[t] }))}
            {...form.getInputProps('tipoEmissao')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Select
            label="Ambiente NFC-e"
            allowDeselect={false}
            data={[
              { value: '2', label: 'Homologação' },
              { value: '1', label: 'Produção' },
            ]}
            {...form.getInputProps('nfceAmbiente')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Select
            label="Regime"
            placeholder="O da empresa (Configurações › Fiscal)"
            clearable
            data={REGIMES_FISCAIS.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))}
            {...form.getInputProps('regime')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 4 }}>
          <NumberInput
            label="Série NF-e"
            min={1}
            max={889}
            allowDecimal={false}
            {...form.getInputProps('nfeSerie')}
          />
          {l?.nfeProximoNumero && (
            <Text size="xs" c="dimmed">
              Próxima NF-e: {l.nfeProximoNumero}
            </Text>
          )}
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 4 }}>
          <NumberInput
            label="Prazo de cancelamento (min)"
            min={1}
            allowDecimal={false}
            {...form.getInputProps('nfcePrazoCancelamentoMin')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <NumberInput
            label="Valor que exige CPF do consumidor"
            min={0}
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            prefix="R$ "
            {...form.getInputProps('nfceValorExigeIdentificacao')}
          />
        </Grid.Col>
      </Grid>
      <Alert variant="light" icon={<IconInfoCircle size={18} />} title="Em construção · Fase 3F">
        Certificado digital A1, CSC da NFC-e, inutilização e TEF entram com a nota fiscal do caixa.
      </Alert>
    </Stack>
  );

  // Anexos (ERP 10.3.4; F2-B43): o logotipo (cupom e DANFE) e a foto da fachada (menu digital). Escolher a imagem a
  // envia; o id vai com a loja no Salvar. Os tipos e o limite da dica vêm do shared (`tiposELimiteArquivo`), os mesmos
  // da validação. O caixa ainda não imprime o logotipo (a variante `cupom_mono` e a descida ao PDV ficam pendentes;
  // docs/andamento.md), e a dica diz isso em vez de prometer a impressão.
  const anexos = l && (
    <Grid>
      <Grid.Col span={{ base: 12, sm: 6 }}>
        <UploadArquivo
          rotulo="Logotipo"
          descricao={
            'Para o cupom e o DANFE (a impressão no caixa entra numa próxima versão). PNG monocromático ' +
            `recomendado; ${tiposELimiteArquivo('loja_logotipo')}`
          }
          destino="loja_logotipo"
          lojaId={l.id}
          valor={v.logotipoArquivoId}
          aoMudar={(id) => form.setFieldValue('logotipoArquivoId', id)}
          somenteLeitura={somenteLeitura}
          erro={form.errors.logotipoArquivoId as string | undefined}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 6 }}>
        <UploadArquivo
          rotulo="Foto da loja"
          descricao={`A fachada, para o menu digital; ${tiposELimiteArquivo('loja_foto')}`}
          destino="loja_foto"
          lojaId={l.id}
          valor={v.fotoArquivoId}
          aoMudar={(id) => form.setFieldValue('fotoArquivoId', id)}
          somenteLeitura={somenteLeitura}
          erro={form.errors.fotoArquivoId as string | undefined}
        />
      </Grid.Col>
    </Grid>
  );

  return (
    <FormularioEntidade
      titulo={c.novo ? 'Nova loja' : (l?.nome ?? 'Loja')}
      codigo={l?.codigo}
      situacao={l ? (l.ativa ? { rotulo: 'Ativa', cor: 'green' } : { rotulo: 'Inativa', cor: 'gray' }) : null}
      alteradoEm={l?.atualizadoEm}
      alteradoPor={l?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={somenteLeitura}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_LOJAS}
      rotaNovo={!c.novo && pode('lojas.criar') ? `${ROTA_LOJAS}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('lojas.excluir') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={l ? { entidade: 'lojas', registroId: l.id } : undefined}
      abaAtiva={abaAtiva}
      aoMudarAba={setAba}
      abas={[
        { valor: 'dados', rotulo: 'Dados Gerais', conteudo: dados, comErro: errosDados },
        {
          valor: 'fiscal',
          rotulo: 'Fiscal',
          conteudo: fiscal,
          comErro: Object.keys(form.errors).some((k) => CAMPOS_FISCAL.includes(k)),
        },
        ...(l
          ? [
              {
                valor: 'anexos',
                rotulo: 'Anexos',
                conteudo: anexos,
                comErro: Object.keys(form.errors).some((k) => CAMPOS_ANEXOS.includes(k)),
              },
              {
                valor: 'caixas',
                rotulo: 'Caixas',
                conteudo: <CaixasLoja loja={l} somenteLeitura={!pode('lojas.editar')} />,
              },
              {
                valor: 'parametros',
                rotulo: 'Parâmetros',
                conteudo: pode('configuracoes.ver') ? (
                  <CamposConfiguracoes
                    itens={PARAMETROS_LOJA}
                    lojaId={l.id}
                    somenteLeitura={!pode('configuracoes.editar')}
                  />
                ) : (
                  <Text c="dimmed">Você não tem permissão para ver as configurações.</Text>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
