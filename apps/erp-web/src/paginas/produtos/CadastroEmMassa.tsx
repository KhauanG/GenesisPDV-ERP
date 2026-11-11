import {
  LIMITE_LINHAS_CADASTRO_MASSA,
  type CadastroMassaEntrada,
  type EstoqueResumo,
  type Pagina,
  type ProdutoEanCadastroMassa,
  type RespostaPesquisaEanCadastroMassa,
  type ResultadoCadastroMassa,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Group,
  List,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconEraser, IconSearch } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { useCategorias, useMarcas, useUnidades } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { GradeItens, errosDaGrade, type ColunaGrade } from '../../componentes/grade/GradeItens';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarInteiro } from '../../util/formato';
import { ROTA_ACERTOS } from '../estoques/Acertos';
import {
  aplicarPesquisa,
  alterarPreco,
  eanDaLinha,
  errosLinhaMassa,
  linhaMassaVazia,
  linhaParaApi,
  marcaPeloNome,
  novaLinhaMassa,
  precisaPesquisar,
  type ContextoLinhaMassa,
  type LinhaMassa,
} from './cadastroMassa';

export const ROTA_CADASTRO_MASSA = '/produtos/cadastro-em-massa';

/** Estoques ativos visíveis (o mesmo cache do seletor do acerto). */
function useEstoques() {
  return useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    staleTime: 60_000,
  });
}

/** O campo da API (`linhas.N.campo`) na coluna da grade (o que não é coluna vai para a linha). */
const COLUNAS_API: Record<string, keyof LinhaMassa> = {
  ean: 'ean',
  nome: 'nome',
  unidadeId: 'unidadeId',
  ncm: 'ncm',
  marcaId: 'marca',
  marcaNova: 'marca',
  categoriaId: 'categoriaId',
  precoCusto: 'precoCusto',
  markupPct: 'markupPct',
  precoVenda: 'precoVenda',
  estoque: 'estoque',
  estoqueMinimo: 'estoqueMinimo',
};

/**
 * **Cadastro em massa por estoque** (ERP 8.3; Fase 2, F2-B39): cadastrar e dar entrada em muitos produtos de uma vez,
 * como no Nuvem3. O estoque escolhido (só os permitidos) recebe o estoque somado (um acerto de Entrada) e dá a loja
 * do estoque mínimo. O EAN já cadastrado vira "Atualização" (em azul) com os valores gravados, pela pesquisa na base
 * da empresa (ao sair do campo ou no "Pesquisar EAN"; sem base externa, F2-Q13 = D54 (a)). A marca digitada que não
 * existe é criada na gravação; a categoria vem da árvore. Gravar manda tudo numa transação (ou nada), até
 * `LIMITE_LINHAS_CADASTRO_MASSA` linhas, e mostra o resultado com os links.
 */
export function CadastroEmMassa() {
  useDocumentTitle('Cadastro em massa · Genesis ERP');
  const pode = usePode();
  const queryClient = useQueryClient();
  const { lojaId } = useLojaContexto();
  const estoques = useEstoques();
  const unidades = useUnidades();
  const marcas = useMarcas();
  const categorias = useCategorias();
  const verCusto = pode('produtos.ver_custo');
  const lancaEstoque = pode('estoque_acertos.criar');
  const un = unidades.data?.find((u) => u.sigla === 'UN')?.id ?? '';

  const [estoqueEscolhido, setEstoqueEscolhido] = useState('');
  const [linhas, setLinhas] = useState<LinhaMassa[]>(() => [novaLinhaMassa()]);
  const [mostrarErros, setMostrarErros] = useState(false);
  const [errosApi, setErrosApi] = useState<Record<string, Partial<Record<string, string>>>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [gravando, setGravando] = useState(false);
  const [pesquisando, setPesquisando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCadastroMassa | null>(null);
  // O último estoque escolhido: a pesquisa que volta depois de trocar o estoque é descartada (a loja mudou).
  const estoqueAtual = useRef('');
  // A unidade padrão (UN) já posta nas linhas vazias (as unidades chegam depois da primeira linha).
  const [unAplicada, setUnAplicada] = useState('');
  if (un && unAplicada !== un) {
    setUnAplicada(un);
    setLinhas((ls) => ls.map((l) => (l.unidadeId || !linhaMassaVazia(l) ? l : { ...l, unidadeId: un })));
  }

  // Estoque padrão: o da loja de contexto (como o acerto, ERP 13.5) ou o primeiro.
  // ("Todas as lojas" não escolhe o CD só por ele também não ter loja.)
  const estoquePadrao =
    (lojaId ? estoques.data?.itens.find((e) => e.lojaId === lojaId)?.id : undefined) ??
    estoques.data?.itens[0]?.id ??
    '';
  const estoqueId = estoqueEscolhido || estoquePadrao;
  const estoque = estoques.data?.itens.find((e) => e.id === estoqueId);

  const ctx: ContextoLinhaMassa = {
    marcas: marcas.data?.itens ?? [],
    podeCriarMarca: pode('marcas.criar'),
    estoqueTemLoja: !!estoque?.lojaId,
    fracaoDaUnidade: (id) => unidades.data?.find((u) => u.id === id)?.permiteFracao ?? false,
  };
  const preenchidas = linhas.filter((l) => !linhaMassaVazia(l));
  /**
   * A API numera as linhas enviadas (só as preenchidas): "Linha N" na mensagem dela vira a posição na grade (a que a
   * coluna "#" mostra, com as linhas vazias do meio).
   */
  const naGrade = (enviadas: readonly LinhaMassa[]) => (n: number) => {
    const l = enviadas[n - 1];
    const i = l ? linhas.indexOf(l) : -1;
    return i >= 0 ? i + 1 : n;
  };
  const traduzirLinhas = (texto: string, posicao: (n: number) => number) =>
    texto.replace(
      /\b([Ll]inhas?) (\d+)\b/g,
      (_, palavra: string, n: string) => `${palavra} ${posicao(Number(n))}`,
    );
  const validar = (l: LinhaMassa) => ({ ...errosLinhaMassa(l, ctx), ...errosApi[l.chave] });

  function mudarLinhas(lista: LinhaMassa[]) {
    // A linha mexida perde os erros da última gravação.
    const antes = new Map(linhas.map((l) => [l.chave, l]));
    setErrosApi((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([k]) => lista.some((l) => l.chave === k && l === antes.get(k))),
      ),
    );
    setLinhas(lista);
    // Colou do Excel: as linhas que entraram já com o EAN (a colagem; o "Inserir linha" entra vazio) são pesquisadas,
    // quantas forem e de onde se colou (a colagem sobre a linha vazia a substitui).
    const coladas = lista.filter((l) => !antes.has(l.chave) && precisaPesquisar(l));
    if (coladas.length) void pesquisar(coladas);
  }

  function alterarLinha(chave: string, fn: (l: LinhaMassa) => LinhaMassa) {
    mudarLinhas(linhas.map((l) => (l.chave === chave ? fn(l) : l)));
  }

  /** "Pesquisar EAN" na base da empresa: as linhas dadas (padrão: as que mudaram o EAN desde a última pesquisa). */
  async function pesquisar(alvo: LinhaMassa[], estoqueDaPesquisa = estoqueId) {
    const codigos = [...new Set(alvo.map(eanDaLinha).filter(Boolean))];
    if (!codigos.length || !estoqueDaPesquisa) return;
    setPesquisando(true);
    try {
      const r = await apiErp.post<RespostaPesquisaEanCadastroMassa>(
        '/produtos/cadastro-em-massa/pesquisar-ean',
        {
          estoqueId: estoqueDaPesquisa,
          codigos,
        },
      );
      if (estoqueAtual.current && estoqueAtual.current !== estoqueDaPesquisa) return;
      const achados = new Map<string, ProdutoEanCadastroMassa[]>(r.itens.map((i) => [i.codigo, i.produtos]));
      setLinhas((atuais) =>
        atuais.map((l) => {
          const ean = eanDaLinha(l);
          return codigos.includes(ean) && alvo.some((a) => a.chave === l.chave)
            ? aplicarPesquisa(l, achados.get(ean) ?? [], un)
            : l;
        }),
      );
    } catch (e) {
      notifications.show({ color: 'red', message: (e as Error).message });
    } finally {
      setPesquisando(false);
    }
  }

  function trocarEstoque(id: string) {
    setEstoqueEscolhido(id);
    estoqueAtual.current = id;
    // O estoque mínimo da Atualização é da loja do estoque: as linhas pesquisadas são pesquisadas de novo.
    const pesquisadas = linhas.filter((l) => eanDaLinha(l));
    void pesquisar(pesquisadas, id);
  }

  function limpar() {
    const executar = () => {
      setLinhas([novaLinhaMassa(un)]);
      setErrosApi({});
      setMostrarErros(false);
      setErro(null);
      setResultado(null);
    };
    if (!preenchidas.length) return executar();
    modals.openConfirmModal({
      title: 'Limpar a grade',
      children: <Text size="sm">Remover as {preenchidas.length} linha(s) digitadas? Nada foi gravado.</Text>,
      labels: { confirm: 'Limpar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: executar,
    });
  }

  async function gravar(confirmarEanDuplicado = false) {
    setErro(null);
    setResultado(null);
    if (!preenchidas.length) {
      setErro('Digite ao menos uma linha.');
      return;
    }
    if (preenchidas.length > LIMITE_LINHAS_CADASTRO_MASSA) {
      setErro(`No máximo ${LIMITE_LINHAS_CADASTRO_MASSA} linhas por gravação: grave em partes.`);
      return;
    }
    if (errosDaGrade(linhas, validar, linhaMassaVazia).length) {
      setMostrarErros(true);
      setErro('Corrija as linhas destacadas antes de gravar.');
      return;
    }
    const corpo: CadastroMassaEntrada = {
      estoqueId,
      linhas: preenchidas.map((l) => linhaParaApi(l, ctx)),
      confirmarEanDuplicado,
    };
    const posicao = naGrade(preenchidas);
    setGravando(true);
    try {
      const r = await apiErp.post<ResultadoCadastroMassa>('/produtos/cadastro-em-massa', corpo);
      setResultado({ ...r, produtos: r.produtos.map((p) => ({ ...p, linha: posicao(p.linha) })) });
      setLinhas([novaLinhaMassa(un)]);
      setErrosApi({});
      setMostrarErros(false);
      notifications.show({
        color: 'green',
        message: `${r.criados} produto(s) criado(s) e ${r.atualizados} atualizado(s)`,
      });
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'produtos'] });
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_acertos'] });
      if (r.marcasCriadas) void queryClient.invalidateQueries({ queryKey: ['opcoes', 'marcas'] });
    } catch (e) {
      const confirmar =
        e instanceof ErroRequisicao &&
        (e.corpo.detalhes?.eanDuplicado as { confirmar?: boolean } | undefined)?.confirmar === true;
      if (confirmar) {
        modals.openConfirmModal({
          title: 'EAN já cadastrado',
          children: <Text size="sm">{traduzirLinhas((e as Error).message, posicao)}</Text>,
          labels: { confirm: 'Gravar mesmo assim', cancel: 'Cancelar' },
          onConfirm: () => void gravar(true),
        });
        return;
      }
      if (e instanceof ErroRequisicao && e.campos) {
        // `linhas.N.campo`: N é a posição entre as linhas preenchidas (as enviadas).
        const porLinha: Record<string, Partial<Record<string, string>>> = {};
        for (const [k, msgs] of Object.entries(e.campos)) {
          const m = /^linhas\.(\d+)\.(\w+)/.exec(k);
          const l = m ? preenchidas[Number(m[1])] : undefined;
          if (!l || !msgs[0]) continue;
          const coluna = COLUNAS_API[m![2]!] ?? '_linha';
          // ("EAN repetido na grade (linha N)" do contrato também conta entre as enviadas.)
          (porLinha[l.chave] ??= {})[coluna] ??= traduzirLinhas(msgs[0], posicao);
        }
        setErrosApi(porLinha);
        setMostrarErros(true);
      }
      setErro(traduzirLinhas((e as Error).message, posicao));
    } finally {
      setGravando(false);
    }
  }

  const opcoesCategoria = (categorias.data ?? [])
    .filter((c) => c.ativa)
    .map((c) => ({ value: c.id, label: c.caminhoNomes }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  const nomesMarcas = [...new Set((marcas.data?.itens ?? []).map((m) => m.descricao))];

  const colunas: ColunaGrade<LinhaMassa>[] = [
    {
      campo: 'ean',
      rotulo: 'EAN',
      tipo: 'texto',
      largura: 150,
      editor: ({ linha, valor, aoMudar, campo }) => (
        <TextInput
          ref={campo.ref as (el: HTMLInputElement | null) => void}
          onKeyDown={campo.onKeyDown}
          onPaste={campo.onPaste}
          aria-label={campo['aria-label']}
          error={campo['aria-invalid'] ? true : undefined}
          disabled={campo.disabled}
          size="xs"
          inputMode="numeric"
          maxLength={30}
          value={String(valor ?? '')}
          onChange={(ev) => aoMudar(ev.currentTarget.value)}
          onBlur={() => {
            if (precisaPesquisar(linha)) void pesquisar([linha]);
          }}
        />
      ),
    },
    { campo: 'nome', rotulo: 'Nome', tipo: 'texto', largura: 240 },
    {
      campo: 'unidadeId',
      rotulo: 'Unidade',
      tipo: 'selecao',
      largura: 90,
      opcoes: (unidades.data ?? []).map((u) => ({ value: u.id, label: u.sigla })),
    },
    { campo: 'ncm', rotulo: 'NCM', tipo: 'texto', largura: 100 },
    {
      campo: 'marca',
      rotulo: 'Marca',
      tipo: 'texto',
      largura: 160,
      editor: ({ valor, aoMudar, campo }) => {
        const texto = String(valor ?? '');
        const nova = !!texto.trim() && !marcaPeloNome(ctx.marcas, texto);
        return (
          <Autocomplete
            ref={campo.ref as (el: HTMLInputElement | null) => void}
            onKeyDown={campo.onKeyDown}
            onPaste={campo.onPaste}
            aria-label={campo['aria-label']}
            error={campo['aria-invalid'] ? true : undefined}
            disabled={campo.disabled}
            size="xs"
            data={nomesMarcas}
            limit={20}
            value={texto}
            onChange={aoMudar}
            comboboxProps={{ withinPortal: true }}
            rightSection={nova ? <Badge size="xs">nova</Badge> : undefined}
            rightSectionWidth={nova ? 44 : undefined}
            title={nova ? 'Marca nova: criada ao gravar' : undefined}
          />
        );
      },
    },
    { campo: 'categoriaId', rotulo: 'Categoria', tipo: 'selecao', largura: 200, opcoes: opcoesCategoria },
    ...(verCusto
      ? ([
          {
            campo: 'precoCusto',
            rotulo: 'Preço custo',
            tipo: 'dinheiro',
            largura: 110,
            editor: ({ linha, valor, campo }) => (
              <CampoDecimal
                campo={campo}
                valor={valor}
                dinheiro
                aoMudar={(v) => alterarLinha(linha.chave, (l) => alterarPreco(l, 'precoCusto', v))}
              />
            ),
          },
          {
            campo: 'markupPct',
            rotulo: 'Markup %',
            tipo: 'numero',
            largura: 90,
            editor: ({ linha, valor, campo }) => (
              <CampoDecimal
                campo={campo}
                valor={valor}
                aoMudar={(v) => alterarLinha(linha.chave, (l) => alterarPreco(l, 'markupPct', v))}
              />
            ),
          },
        ] satisfies ColunaGrade<LinhaMassa>[])
      : []),
    {
      campo: 'precoVenda',
      rotulo: 'Preço venda',
      tipo: 'dinheiro',
      largura: 110,
      editor: ({ linha, valor, campo }) => (
        <CampoDecimal
          campo={campo}
          valor={valor}
          dinheiro
          aoMudar={(v) => alterarLinha(linha.chave, (l) => alterarPreco(l, 'precoVenda', v))}
        />
      ),
    },
    ...(lancaEstoque
      ? ([
          { campo: 'estoque', rotulo: 'Estoque (+)', tipo: 'numero', largura: 90 },
        ] satisfies ColunaGrade<LinhaMassa>[])
      : []),
    { campo: 'estoqueMinimo', rotulo: 'Estoque mín.', tipo: 'numero', largura: 90 },
    {
      campo: 'situacao',
      rotulo: 'Situação',
      tipo: 'leitura',
      largura: 150,
      formato: (l) => <SituacaoLinha linha={l} />,
    },
  ];

  // A colagem só preenche as colunas que a tela mostra (sem "Estoque (+)" sem o acerto, sem o custo sem vê-lo).
  const colarEm: Array<keyof LinhaMassa & string> = [
    'ean',
    'nome',
    ...(verCusto ? (['precoCusto'] as const) : []),
    'precoVenda',
    ...(lancaEstoque ? (['estoque'] as const) : []),
  ];

  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        Cadastro em massa
      </Title>
      <Paper p="md">
        <Group align="flex-end" justify="space-between" wrap="wrap">
          <Select
            label="Estoque"
            description={
              estoque && !estoque.lojaId
                ? 'Estoque sem loja (CD): o estoque mínimo fica de fora'
                : 'Recebe o estoque somado; o estoque mínimo é da loja dele'
            }
            required
            w={320}
            allowDeselect={false}
            data={(estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome }))}
            value={estoqueId || null}
            onChange={(v) => v && trocarEstoque(v)}
          />
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconSearch size={16} />}
              loading={pesquisando}
              onClick={() => void pesquisar(linhas.filter((l) => eanDaLinha(l)))}
            >
              Pesquisar EAN
            </Button>
            <Button variant="default" color="red" leftSection={<IconEraser size={16} />} onClick={limpar}>
              Limpar
            </Button>
            <Button
              leftSection={<IconDeviceFloppy size={16} />}
              loading={gravando}
              disabled={!estoqueId}
              onClick={() => void gravar()}
            >
              Gravar
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          O produto novo é Simples, com controle de estoque e sem tributação (o restante do cadastro se
          completa em Produtos). O EAN já cadastrado vira “Atualização” (em azul): os campos vazios recebem o
          que está gravado, e o que foi digitado ou colado fica. O estoque é somado na unidade do produto. Até{' '}
          {LIMITE_LINHAS_CADASTRO_MASSA} linhas por gravação; tudo é gravado junto, ou nada.
        </Text>
      </Paper>
      {erro && (
        <Alert color="red" variant="light" title="Nada foi gravado">
          {erro}
        </Alert>
      )}
      {resultado && <ResultadoGravacao r={resultado} />}
      <GradeItens
        rotulo="Produtos do cadastro em massa"
        linhas={linhas}
        aoMudar={mudarLinhas}
        colunas={colunas}
        novaLinha={() => novaLinhaMassa(un)}
        chave={(l) => l.chave}
        validar={validar}
        vazia={linhaMassaVazia}
        mostrarErros={mostrarErros}
        colarEm={colarEm}
        rotuloInserir="Inserir linha"
        destaque={(l) =>
          l.situacao === 'atualizacao' && l.pesquisado === eanDaLinha(l)
            ? { cor: 'blue', rotulo: 'Atualização' }
            : undefined
        }
      />
    </Stack>
  );
}

/** Campo decimal da grade que muda a linha inteira (o markup ⇄ preço). */
function CampoDecimal({
  campo,
  valor,
  aoMudar,
  dinheiro = false,
}: {
  campo: Parameters<NonNullable<ColunaGrade<LinhaMassa>['editor']>>[0]['campo'];
  valor: unknown;
  aoMudar: (v: string) => void;
  dinheiro?: boolean;
}) {
  const { ref, ...resto } = campo;
  return (
    <TextInput
      ref={ref as (el: HTMLInputElement | null) => void}
      {...resto}
      error={resto['aria-invalid'] ? true : undefined}
      size="xs"
      inputMode="decimal"
      value={String(valor ?? '')}
      onChange={(ev) => aoMudar(ev.currentTarget.value)}
      styles={{ input: { textAlign: 'right' } }}
      leftSection={dinheiro ? <Text size="xs">R$</Text> : undefined}
    />
  );
}

function SituacaoLinha({ linha: l }: { linha: LinhaMassa }) {
  const ean = eanDaLinha(l);
  if (l.pesquisado !== ean || !l.situacao)
    return (
      <Text size="xs" c="dimmed">
        {ean ? 'A pesquisar' : 'Novo'}
      </Text>
    );
  if (l.situacao === 'novo')
    return (
      <Badge color="green" variant="light">
        Novo
      </Badge>
    );
  if (l.situacao === 'duplicado')
    return (
      <Badge color="red" variant="light">
        EAN duplicado
      </Badge>
    );
  if (l.situacao === 'variacao')
    return (
      <Badge color="red" variant="light">
        Variação
      </Badge>
    );
  const p = l.produtos[0]!;
  return (
    <Stack gap={0}>
      <Badge color="blue" variant="filled">
        Atualização
      </Badge>
      <Anchor component={Link} to={`/produtos/${p.id}`} size="xs" target="_blank">
        Cód. {p.codigo}
      </Anchor>
      {Number(p.fator) !== 1 && (
        <Text size="xs" c="dimmed">
          Embalagem × {Number(p.fator).toLocaleString('pt-BR')}: estoque em {p.unidadeSigla}
        </Text>
      )}
    </Stack>
  );
}

function ResultadoGravacao({ r }: { r: ResultadoCadastroMassa }) {
  return (
    <Alert color="green" variant="light" title="Cadastro em massa gravado">
      <Stack gap="xs">
        <Text size="sm">
          {formatarInteiro(r.criados)} produto(s) criado(s), {formatarInteiro(r.atualizados)} atualizado(s)
          {r.marcasCriadas ? `, ${formatarInteiro(r.marcasCriadas)} marca(s) nova(s)` : ''}.
          {r.acerto && (
            <>
              {' '}
              Estoque lançado no{' '}
              <Anchor component={Link} to={`${ROTA_ACERTOS}/${r.acerto.id}`}>
                acerto de Entrada Nº {r.acerto.codigo}
              </Anchor>{' '}
              ({formatarInteiro(r.acerto.itens)} item(ns)).
            </>
          )}
        </Text>
        <List size="sm" spacing={2} mah={240} style={{ overflow: 'auto' }}>
          {r.produtos.map((p) => (
            <List.Item key={p.id}>
              Linha {p.linha}: {p.acao === 'criado' ? 'criado' : 'atualizado'}{' '}
              <Anchor component={Link} to={`/produtos/${p.id}`}>
                {p.codigo} - {p.nome}
              </Anchor>
            </List.Item>
          ))}
        </List>
      </Stack>
    </Alert>
  );
}
