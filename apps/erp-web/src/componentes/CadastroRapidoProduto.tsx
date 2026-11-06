import {
  corpoProdutoRapido,
  criarProdutoSchema,
  validarGtin,
  type CriarProdutoEntrada,
  type ProdutoDetalhe,
  type ProdutoOpcao,
} from '@genesis/shared';
import { Alert, Button, Grid, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { apiErp } from '../api/clientes';
import { ErroRequisicao } from '../api/http';
import { useCategorias, useMarcas, useUnidades } from '../api/produtos';
import { usePode } from '../auth/permissoes';
import { errosDaApi, errosDoZod } from '../util/erros';
import { BuscaNcm } from './campos/BuscaNcm';

/** Valores que quem abre já conhece (o item da NF-e no F2-B20: nome, NCM, CEST, EAN, unidade e custo do XML). */
export interface InicialProdutoRapido {
  nome?: string;
  ean?: string;
  unidadeId?: string;
  ncm?: string;
  /** Só com o CEST conhecido o campo aparece (o item da NF-e). */
  cest?: string;
  precoCusto?: string;
  precoVenda?: string;
}

interface CamposProdutoRapido {
  nome: string;
  ean: string;
  unidadeId: string | null;
  ncm: string | null;
  cest: string;
  marcaId: string | null;
  categoriaId: string | null;
  precoVenda: string;
}

/** O resumo do produto (`ProdutoOpcao`) a partir do detalhe que o `POST /produtos` devolve. */
export function opcaoDoProduto(d: ProdutoDetalhe): ProdutoOpcao {
  return {
    id: d.id,
    codigo: d.codigo,
    nome: d.nome,
    tipo: d.tipo,
    ativo: d.ativo,
    unidadeId: d.unidadeId,
    unidadeSigla: d.unidadeSigla,
    permiteFracao: d.permiteFracao,
    controlaEstoque: d.controlaEstoque,
    ean: d.ean,
    precoVenda: d.precoVenda,
    precoAtacado: d.precoAtacado,
    qtdMinimaAtacado: d.qtdMinimaAtacado,
    precoCusto: d.precoCusto,
    custoMedio: d.custoMedio,
    grupoPrecoQuantidadeId: d.grupoPrecoQuantidadeId,
  };
}

/** Os erros do contrato/API nos campos do modal (o EAN é o 1º código de barras). */
const paraCampos = (campos: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(campos).map(([k, v]) => [
      k.startsWith('codigosBarras')
        ? 'ean'
        : k === 'categorias' || k.startsWith('categorias.')
          ? 'categoriaId'
          : k,
      v,
    ]),
  );

/**
 * Modal "Cadastrar novo produto" (ERP 13.3 "Produto: botão Cadastrar novo produto"; Fase 2, F2-B16), reaproveitado
 * pelo recebimento manual e, no F2-B20, pela vinculação dos itens da NF-e (com `inicial`): nome, EAN, unidade, NCM
 * pelo `<BuscaNcm>`, marca, categoria e preço de venda. Cria um produto **Simples**, ativo e com controle de estoque,
 * pelo `POST /produtos` (a mesma validação do formulário completo), com a tributação vazia — a padrão do cadastro na
 * Fase 2, sem nada fiscal (os campos fiscais só entram gravados no F2-B52). O EAN repetido segue `geral.ean_duplicado`
 * (com "avisar", confirma e grava). Quem abre monta o modal a cada abertura (começa limpo, com `inicial`).
 */
export function CadastroRapidoProduto({
  aberto,
  aoFechar,
  aoSalvar,
  inicial = {},
}: {
  aberto: boolean;
  aoFechar: () => void;
  aoSalvar: (produto: ProdutoOpcao) => void;
  inicial?: InicialProdutoRapido;
}) {
  const pode = usePode();
  const unidades = useUnidades();
  const marcas = useMarcas();
  const categorias = useCategorias();
  const form = useForm<CamposProdutoRapido>({
    mode: 'controlled',
    initialValues: {
      nome: inicial.nome ?? '',
      ean: inicial.ean ?? '',
      unidadeId: inicial.unidadeId ?? null,
      ncm: inicial.ncm ?? null,
      cest: inicial.cest ?? '',
      marcaId: null,
      categoriaId: null,
      precoVenda: inicial.precoVenda ?? '',
    },
  });
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const v = form.getValues();

  // Unidade padrão: UN (como o formulário do produto).
  const un = unidades.data?.find((u) => u.sigla === 'UN')?.id ?? null;
  useEffect(() => {
    if (!form.getValues().unidadeId && un) form.setFieldValue('unidadeId', un);
    // `form` muda a cada render; só a lista de unidades carregada importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [un]);

  // O corpo sai do shared (`corpoProdutoRapido`), o mesmo do teste de integração do critério de pronto.
  const corpo = (confirmarEanDuplicado: boolean): CriarProdutoEntrada =>
    corpoProdutoRapido(
      {
        ...v,
        cest: v.cest.replace(/\D/g, '') || null,
        unidadePermiteFracao: unidades.data?.find((u) => u.id === v.unidadeId)?.permiteFracao ?? false,
        precoCusto: pode('produtos.ver_custo') ? inicial.precoCusto : null,
      },
      confirmarEanDuplicado,
    );

  async function gravar(confirmarEanDuplicado = false) {
    setErro(null);
    const dados = corpo(confirmarEanDuplicado);
    const r = criarProdutoSchema.safeParse(dados);
    if (!r.success) {
      form.setErrors(paraCampos(errosDoZod(r.error)));
      return;
    }
    setSalvando(true);
    try {
      const d = await apiErp.post<ProdutoDetalhe>('/produtos', dados);
      notifications.show({ color: 'green', message: `Produto ${d.codigo} - ${d.nome} cadastrado` });
      aoSalvar(opcaoDoProduto(d));
      aoFechar();
    } catch (e) {
      const repetido =
        e instanceof ErroRequisicao &&
        (e.corpo.detalhes?.eanDuplicado as { confirmar?: boolean } | undefined)?.confirmar === true;
      if (repetido) {
        modals.openConfirmModal({
          title: 'EAN já cadastrado',
          children: <Text size="sm">{(e as Error).message}</Text>,
          labels: { confirm: 'Gravar mesmo assim', cancel: 'Cancelar' },
          onConfirm: () => void gravar(true),
        });
        return;
      }
      if (e instanceof ErroRequisicao && e.campos) form.setErrors(paraCampos(errosDaApi(e.campos)));
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  const ean = v.ean.replace(/\s/g, '');
  return (
    <Modal opened={aberto} onClose={aoFechar} title="Cadastrar novo produto" size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Cria um produto Simples, com controle de estoque e sem tributação (os dados fiscais e o restante do
          cadastro se completam depois, em Produtos).
        </Text>
        {erro && (
          <Alert color="red" variant="light">
            {erro}
          </Alert>
        )}
        <Grid>
          <Grid.Col span={12}>
            <TextInput label="Nome" required data-autofocus maxLength={120} {...form.getInputProps('nome')} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <TextInput
              label="Código de barras (EAN)"
              inputMode="numeric"
              maxLength={14}
              description={ean && !validarGtin(ean) ? 'Sem o dígito verificador de GTIN' : undefined}
              {...form.getInputProps('ean')}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, sm: 3 }}>
            <Select
              label="Unidade"
              required
              allowDeselect={false}
              searchable
              data={(unidades.data ?? []).map((u) => ({ value: u.id, label: `${u.sigla} - ${u.descricao}` }))}
              comboboxProps={{ withinPortal: true }}
              {...form.getInputProps('unidadeId')}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, sm: 3 }}>
            <TextInput
              label="Preço de venda"
              required
              inputMode="decimal"
              leftSection={<Text size="xs">R$</Text>}
              {...form.getInputProps('precoVenda')}
            />
          </Grid.Col>
          <Grid.Col span={inicial.cest !== undefined ? { base: 12, sm: 9 } : 12}>
            <BuscaNcm
              label="NCM"
              value={v.ncm}
              onChange={(c) => form.setFieldValue('ncm', c)}
              error={form.errors.ncm}
            />
          </Grid.Col>
          {inicial.cest !== undefined && (
            <Grid.Col span={{ base: 12, sm: 3 }}>
              <TextInput label="CEST" inputMode="numeric" maxLength={7} {...form.getInputProps('cest')} />
            </Grid.Col>
          )}
          {pode('marcas.ver') && (
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Select
                label="Marca"
                clearable
                searchable
                data={(marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao }))}
                comboboxProps={{ withinPortal: true }}
                {...form.getInputProps('marcaId')}
              />
            </Grid.Col>
          )}
          {pode('categorias.ver') && (
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Select
                label="Categoria"
                clearable
                searchable
                data={(categorias.data ?? [])
                  .filter((c) => c.ativa)
                  .map((c) => ({ value: c.id, label: c.caminhoNomes }))
                  .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))}
                comboboxProps={{ withinPortal: true }}
                {...form.getInputProps('categoriaId')}
              />
            </Grid.Col>
          )}
        </Grid>
        <Group justify="flex-end">
          <Button variant="default" onClick={aoFechar}>
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
