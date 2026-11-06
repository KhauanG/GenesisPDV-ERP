import {
  alterarFormaPagamentoSchema,
  criarFormaPagamentoSchema,
  INTEGRACOES_FORMA,
  ROTULOS_INTEGRACAO_FORMA,
  ROTULOS_TIPO_FORMA,
  TIPOS_FORMA_PAGAMENTO,
  TIPOS_SEM_TROCO,
  type FormaPagamentoDetalhe,
  type FormaPagamentoResumo,
  type OpcoesFormaPagamento,
  type Pagina,
} from '@genesis/shared';
import {
  Anchor,
  Badge,
  Checkbox,
  Grid,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { abaDoErro, useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { NaoEncontrado } from '../Erros';
import { badgeAtivo, OPCOES_SITUACAO } from '../estoques/Estoques';

export const ROTA_FORMAS = '/cadastros/formas-pagamento';

/** Lojas em que a forma vale (C8b): sem vínculo de loja = todas. */
export const rotuloLojas = (lojas: FormaPagamentoResumo['lojas']) =>
  lojas.length ? lojas.map((l) => l.nome).join(', ') : 'Todas';

/** O23 (dono, 1C): troco só em forma sem integração e fora de cartão/PIX (`ck_formas_pagamento_troco`). */
export const podeDarTroco = (v: { tipoForma: string; integracao: string }) =>
  v.integracao === 'nenhuma' && !(TIPOS_SEM_TROCO as readonly string[]).includes(v.tipoForma);

const usos = (f: { usaPdv: boolean; usaTotem: boolean; usaMenuDigital: boolean }) =>
  [f.usaPdv && 'PDV', f.usaTotem && 'Totem', f.usaMenuDigital && 'Menu digital'].filter(Boolean).join(', ') ||
  '—';

/** Formas de pagamento – listagem (ERP 10.2). */
export function ListaFormasPagamento() {
  const eu = useEu();
  const config = useMemo<ConfigListagem<FormaPagamentoResumo>>(
    () => ({
      recurso: 'formas_pagamento',
      titulo: 'Formas de pagamento',
      ordenacaoPadrao: 'ordem:asc',
      rotaNovo: `${ROTA_FORMAS}/novo`,
      rotuloNovo: 'Nova forma',
      rotaEdicao: (f) => `${ROTA_FORMAS}/${f.id}`,
      chaveLinha: (f) => f.id,
      filtros: [
        { campo: 'descricao', rotulo: 'Nome', tipo: 'texto' },
        {
          campo: 'uso',
          rotulo: 'Tipo',
          tipo: 'selecao',
          opcoes: [
            { value: 'pdv', label: 'PDV' },
            { value: 'totem', label: 'Totem autoatendimento' },
            { value: 'menu_digital', label: 'Menu digital' },
          ],
        },
        { campo: 'situacao', rotulo: 'Status', tipo: 'selecao', padrao: 'ativos', opcoes: OPCOES_SITUACAO },
        {
          campo: 'lojaId',
          rotulo: 'Loja',
          tipo: 'loja',
          placeholder: 'Todas as lojas',
          opcoes: eu.lojas.map((l) => ({ value: l.id, label: `${l.codigo} - ${l.nome}` })),
        },
      ],
      colunas: [
        {
          campo: 'descricao',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (f) => (
            <Anchor component={Link} to={`${ROTA_FORMAS}/${f.id}`} c="inherit">
              {f.descricao}
            </Anchor>
          ),
        },
        {
          campo: 'tipoForma',
          campoOrdenacao: 'tipo_forma',
          rotulo: 'Tipo da forma',
          ordenavel: true,
          formato: (f) => ROTULOS_TIPO_FORMA[f.tipoForma],
        },
        { campo: 'uso', rotulo: 'Tipo de uso', formato: usos },
        { campo: 'ordem', rotulo: 'Ordem', ordenavel: true, alinhamento: 'right', largura: 90 },
        { campo: 'lojas', rotulo: 'Lojas', formato: (f) => rotuloLojas(f.lojas) },
        {
          campo: 'ativa',
          rotulo: 'Ativa',
          ordenavel: true,
          alinhamento: 'center',
          largura: 90,
          formato: (f) => badgeAtivo(f.ativa),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<FormaPagamentoResumo>>(`/formas-pagamento${query(params)}`, { sinal }),
    }),
    [eu.lojas],
  );
  return <Listagem config={config} />;
}

const FLAGS_PDV = [
  ['usaPdv', 'Usa no PDV'],
  ['usaTotem', 'Usa no totem'],
  ['usaMenuDigital', 'Usa no menu digital'],
  ['sempreZeradoPdv', 'Sempre zerado no PDV (operador digita o valor)'],
  ['permiteTroco', 'Dá troco (só sem maquininha, fora de cartão e PIX)'],
  ['exigeSupervisor', 'Exige liberação do supervisor no PDV'],
  ['abrirGaveta', 'Abrir gaveta'],
  ['exigePessoa', 'Exige pessoa (cliente identificado)'],
  ['aPrazo', 'Venda a prazo (crediário/caderneta)'],
  ['creditoFuncionario', 'Crédito funcionário'],
  ['valeCompra', 'Aceita vale compra / crédito de troca'],
  ['eBoleto', 'É boleto'],
  ['restringeIdadeMinima', 'Não paga itens com idade mínima (VA/VR)'],
  ['geraQrcodePix', 'Gera QR Code PIX'],
  ['exigeDadosPos', 'Pede dados do POS (bandeira, NSU, autorização)'],
] as const;

interface Valores extends Record<string, unknown> {
  descricao: string;
  ordem: number | string;
  tipoForma: string;
  meioPagamentoFiscal: string | null;
  descricaoFiscal: string;
  integracao: string;
  tipoPinpad: string | null;
  lojaIds: string[];
  taxaPct: number | string;
  diasRecebimento: number | string;
  contaCorrenteId: string | null;
  planoContasId: string | null;
  senhaLiberacao: string;
  removerSenhaLiberacao: boolean;
  lancaQuitada: boolean;
  ativa: boolean;
  permiteParcelar: boolean;
  parcelasMaximo: number | string;
  parcelaValorMinimo: number | string;
  usaPdv: boolean;
  usaTotem: boolean;
  usaMenuDigital: boolean;
  sempreZeradoPdv: boolean;
  permiteTroco: boolean;
  abrirGaveta: boolean;
  exigePessoa: boolean;
  aPrazo: boolean;
  creditoFuncionario: boolean;
  valeCompra: boolean;
  eBoleto: boolean;
  restringeIdadeMinima: boolean;
  geraQrcodePix: boolean;
  exigeDadosPos: boolean;
  exigeSupervisor: boolean;
}

const VAZIO: Valores = {
  descricao: '',
  ordem: 0,
  tipoForma: 'outros',
  meioPagamentoFiscal: null,
  descricaoFiscal: '',
  integracao: 'nenhuma',
  tipoPinpad: null,
  lojaIds: [],
  taxaPct: 0,
  diasRecebimento: 0,
  contaCorrenteId: null,
  planoContasId: null,
  senhaLiberacao: '',
  removerSenhaLiberacao: false,
  lancaQuitada: true,
  ativa: true,
  permiteParcelar: false,
  parcelasMaximo: 1,
  parcelaValorMinimo: '',
  usaPdv: true,
  usaTotem: false,
  usaMenuDigital: false,
  sempreZeradoPdv: false,
  permiteTroco: false,
  abrirGaveta: false,
  exigePessoa: false,
  aPrazo: false,
  creditoFuncionario: false,
  valeCompra: false,
  eBoleto: false,
  restringeIdadeMinima: false,
  geraQrcodePix: false,
  exigeDadosPos: false,
  exigeSupervisor: false,
};

function paraValores(f: FormaPagamentoDetalhe): Valores {
  const v = { ...VAZIO };
  for (const k of Object.keys(VAZIO))
    if (k in f) (v as Record<string, unknown>)[k] = (f as unknown as Record<string, unknown>)[k];
  return {
    ...v,
    descricaoFiscal: f.descricaoFiscal ?? '',
    lojaIds: [...f.lojaIds],
    taxaPct: Number(f.taxaPct),
    parcelaValorMinimo: f.parcelaValorMinimo === null ? '' : Number(f.parcelaValorMinimo),
    senhaLiberacao: '',
    removerSenhaLiberacao: false,
  };
}

const paraCorpo = (v: Valores) => ({
  ...v,
  ordem: Number(v.ordem || 0),
  diasRecebimento: Number(v.diasRecebimento || 0),
  parcelasMaximo: Number(v.parcelasMaximo || 1),
  taxaPct: String(v.taxaPct === '' ? 0 : v.taxaPct),
  parcelaValorMinimo: v.parcelaValorMinimo === '' ? null : String(v.parcelaValorMinimo),
});

const ABAS_CAMPOS = {
  dados: ['descricao', 'ordem', 'tipoForma', 'meioPagamentoFiscal', 'descricaoFiscal', 'lojaIds', 'ativa'],
  pdv: ['integracao', 'tipoPinpad', 'senhaLiberacao', 'parcelasMaximo', ...FLAGS_PDV.map(([k]) => k)],
  financeiro: [
    'taxaPct',
    'diasRecebimento',
    'contaCorrenteId',
    'planoContasId',
    'lancaQuitada',
    'parcelaValorMinimo',
  ],
};

/** Formas de pagamento – formulário (ERP 10.2) com todas as flags do MVP. */
export function FormularioFormaPagamento() {
  const { id } = useParams();
  const pode = usePode();
  const eu = useEu();
  const [aba, setAba] = useState('dados');
  const form = useForm<Valores>({ mode: 'controlled', initialValues: VAZIO });
  const opcoes = useQuery({
    queryKey: ['formas-pagamento', 'opcoes'],
    queryFn: () => apiErp.get<OpcoesFormaPagamento>('/formas-pagamento/opcoes'),
    staleTime: 60_000,
  });
  const c = useCadastro<FormaPagamentoDetalhe, Valores>({
    api: '/formas-pagamento',
    rota: ROTA_FORMAS,
    recurso: 'formas_pagamento',
    id,
    form,
    paraValores,
    paraCorpo,
    schemaCriar: criarFormaPagamentoSchema,
    schemaAlterar: alterarFormaPagamentoSchema,
    aoErroCampos: (campos) => setAba(abaDoErro(campos, ABAS_CAMPOS) ?? 'dados'),
  });
  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_FORMAS} />;
  const f = c.registro.data;
  const v = form.getValues();
  const erros = (aba: keyof typeof ABAS_CAMPOS) =>
    Object.keys(form.errors).some((k) => ABAS_CAMPOS[aba].includes(k));
  const meios = (opcoes.data?.meiosFiscais ?? [])
    .filter((m) => m.ativo || m.codigo === f?.meioPagamentoFiscal)
    .map((m) => ({
      value: m.codigo,
      label: `${m.codigo} - ${m.descricao}${m.ativo ? '' : ' (não vale mais na NFC-e)'}`,
    }));
  const comTroco = podeDarTroco(v);
  /** Tipo ou integração que não dá troco desliga a flag (O23). */
  const semTrocoSe = (campo: 'tipoForma' | 'integracao', valor: string) => {
    if (!podeDarTroco({ ...v, [campo]: valor })) form.setFieldValue('permiteTroco', false);
  };
  /**
   * ERP 10.2 (README, decisão 40): a forma que também vale numa loja que o usuário não tem é só leitura para ele (a API
   * recusaria a gravação com 403), e essa loja aparece com rótulo próprio em vez do id cru na pílula.
   */
  const minhasLojas = new Set(eu.lojas.map((l) => l.id));
  const lojasAlheias = eu.todasLojas ? [] : (f?.lojaIds ?? []).filter((l) => !minhasLojas.has(l));
  const opcoesLojas = [
    ...eu.lojas.map((l) => ({ value: l.id, label: `${l.codigo} - ${l.nome}` })),
    ...lojasAlheias.map((l) => ({ value: l, label: 'Loja sem acesso' })),
  ];
  const semPermissao = !pode(c.novo ? 'formas_pagamento.criar' : 'formas_pagamento.editar');
  const planos = (opcoes.data?.planosContas ?? [])
    .filter((p) => (v.tipoForma === 'consumo_interno' ? p.tipo === 'despesa' : p.tipo === 'receita'))
    .map((p) => ({ value: p.id, label: `${p.codigo} ${p.nome}` }));

  return (
    <FormularioEntidade
      titulo={c.novo ? 'Nova forma de pagamento' : (f?.descricao ?? 'Forma de pagamento')}
      situacao={f ? (f.ativa ? { rotulo: 'Ativa', cor: 'green' } : { rotulo: 'Inativa', cor: 'gray' }) : null}
      alteradoEm={f?.atualizadoEm}
      alteradoPor={f?.atualizadoPorNome}
      carregando={!c.novo && c.registro.isPending}
      salvando={c.salvando}
      somenteLeitura={semPermissao || lojasAlheias.length > 0}
      avisoSomenteLeitura={
        !semPermissao && lojasAlheias.length
          ? 'Somente leitura: esta forma também vale em loja a que você não tem acesso.'
          : undefined
      }
      sujo={form.isDirty()}
      rotaVoltar={ROTA_FORMAS}
      rotaNovo={!c.novo && pode('formas_pagamento.criar') ? `${ROTA_FORMAS}/novo` : undefined}
      aoSalvar={c.salvar}
      aoExcluir={!c.novo && pode('formas_pagamento.excluir') ? c.excluir : undefined}
      erro={c.erro}
      aoRecarregar={c.recarregar}
      historico={f ? { entidade: 'formas_pagamento', registroId: f.id } : undefined}
      abaAtiva={aba}
      aoMudarAba={setAba}
      abas={[
        {
          valor: 'dados',
          rotulo: 'Dados',
          comErro: erros('dados'),
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput label="Descrição" required maxLength={40} {...form.getInputProps('descricao')} />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 2 }}>
                <NumberInput
                  label="Ordem"
                  description="Botões do PDV"
                  min={0}
                  allowDecimal={false}
                  {...form.getInputProps('ordem')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 4 }}>
                <Select
                  label="Tipo da forma"
                  required
                  allowDeselect={false}
                  data={TIPOS_FORMA_PAGAMENTO.map((t) => ({ value: t, label: ROTULOS_TIPO_FORMA[t] }))}
                  {...form.getInputProps('tipoForma')}
                  onChange={(val) => {
                    form.setFieldValue('tipoForma', val ?? 'outros');
                    semTrocoSe('tipoForma', val ?? 'outros');
                  }}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Meio de pagamento CFe/NFC-e (tPag)"
                  required
                  searchable
                  data={meios}
                  {...form.getInputProps('meioPagamentoFiscal')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Descrição fiscal (xPag)"
                  description="Obrigatória com o meio 99 (Outros)"
                  maxLength={60}
                  {...form.getInputProps('descricaoFiscal')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <MultiSelect
                  label="Lojas"
                  placeholder={v.lojaIds.length ? undefined : 'Todas as lojas'}
                  description="Vazio = todas, inclusive as lojas novas. A forma só aparece no caixa das lojas escolhidas."
                  searchable
                  clearable
                  data={opcoesLojas}
                  {...form.getInputProps('lojaIds')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Switch mt={30} label="Ativa" {...form.getInputProps('ativa', { type: 'checkbox' })} />
              </Grid.Col>
            </Grid>
          ),
        },
        {
          valor: 'pdv',
          rotulo: 'Uso no PDV',
          comErro: erros('pdv'),
          conteudo: (
            <Stack gap="md">
              <Grid>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <Select
                    label="Integração"
                    allowDeselect={false}
                    data={INTEGRACOES_FORMA.map((i) => ({ value: i, label: ROTULOS_INTEGRACAO_FORMA[i] }))}
                    {...form.getInputProps('integracao')}
                    onChange={(val) => {
                      form.setFieldValue('integracao', val ?? 'nenhuma');
                      semTrocoSe('integracao', val ?? 'nenhuma');
                      if (val !== 'tef') form.setFieldValue('tipoPinpad', null);
                      if (val !== 'pos_externo') form.setFieldValue('exigeDadosPos', false);
                    }}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <Select
                    label="Tipo de pinpad"
                    disabled={v.integracao !== 'tef'}
                    data={[
                      { value: 'fisico', label: 'Físico' },
                      { value: 'virtual', label: 'Virtual' },
                    ]}
                    {...form.getInputProps('tipoPinpad')}
                  />
                </Grid.Col>
              </Grid>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {FLAGS_PDV.map(([campo, rotulo]) => (
                  <Checkbox
                    key={campo}
                    label={rotulo}
                    disabled={campo === 'permiteTroco' && !comTroco && !v.permiteTroco}
                    {...form.getInputProps(campo, { type: 'checkbox' })}
                  />
                ))}
              </SimpleGrid>
              <Grid>
                <Grid.Col span={{ base: 12, sm: 4 }}>
                  <Switch
                    mt={30}
                    label="Permite parcelar"
                    {...form.getInputProps('permiteParcelar', { type: 'checkbox' })}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 6, sm: 4 }}>
                  <NumberInput
                    label="Máximo de parcelas"
                    min={1}
                    max={48}
                    disabled={!v.permiteParcelar}
                    allowDecimal={false}
                    {...form.getInputProps('parcelasMaximo')}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 6, sm: 4 }}>
                  <NumberInput
                    label="Valor mínimo da parcela"
                    min={0}
                    decimalScale={2}
                    fixedDecimalScale
                    decimalSeparator=","
                    thousandSeparator="."
                    prefix="R$ "
                    disabled={!v.permiteParcelar}
                    {...form.getInputProps('parcelaValorMinimo')}
                  />
                </Grid.Col>
              </Grid>
              <Title order={5}>Senha de liberação</Title>
              <Group align="flex-end" gap="md">
                <Text size="sm">
                  {f?.senhaLiberacaoDefinida ? (
                    <Badge color="blue" variant="light">
                      Definida
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      Não definida
                    </Badge>
                  )}
                </Text>
                <PasswordInput
                  label={f?.senhaLiberacaoDefinida ? 'Nova senha' : 'Senha'}
                  description="O PDV pede a senha (ou um supervisor) para usar a forma"
                  autoComplete="new-password"
                  disabled={v.removerSenhaLiberacao}
                  {...form.getInputProps('senhaLiberacao')}
                />
                {f?.senhaLiberacaoDefinida && (
                  <Checkbox
                    label="Remover a senha"
                    {...form.getInputProps('removerSenhaLiberacao', { type: 'checkbox' })}
                  />
                )}
              </Group>
            </Stack>
          ),
        },
        {
          valor: 'financeiro',
          rotulo: 'Financeiro',
          comErro: erros('financeiro'),
          conteudo: (
            <Grid>
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Taxa %"
                  min={0}
                  max={100}
                  decimalScale={4}
                  decimalSeparator=","
                  {...form.getInputProps('taxaPct')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Prazo de recebimento (dias)"
                  min={0}
                  allowDecimal={false}
                  {...form.getInputProps('diasRecebimento')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Switch
                  mt={30}
                  label="Lança quitada (Não = conta a receber em aberto)"
                  {...form.getInputProps('lancaQuitada', { type: 'checkbox' })}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Conta corrente de destino"
                  placeholder="Caixa interno"
                  clearable
                  searchable
                  data={(opcoes.data?.contasCorrentes ?? []).map((cc) => ({
                    value: cc.id,
                    label: cc.descricao,
                  }))}
                  {...form.getInputProps('contaCorrenteId')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label={v.tipoForma === 'consumo_interno' ? 'Conta de despesa' : 'Plano de contas (receita)'}
                  required={v.tipoForma === 'consumo_interno'}
                  clearable
                  searchable
                  data={planos}
                  {...form.getInputProps('planoContasId')}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <Text size="xs" c="dimmed">
                  Alterar a taxa ou o prazo não muda as contas já geradas.
                </Text>
              </Grid.Col>
            </Grid>
          ),
        },
      ]}
    />
  );
}
