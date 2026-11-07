import {
  DOCUMENTOS_MOVIMENTACAO,
  RELATORIO_MOVIMENTACAO_ESTOQUE,
  ROTULOS_DOCUMENTO_MOVIMENTACAO,
  type DocumentoMovimentacao,
  type EstoqueResumo,
  type LinhaMovimentacaoEstoque,
  type Pagina,
  type ProdutoOpcao,
  type RespostaMovimentacaoEstoque,
  type TipoMovimentoEstoqueOpcao,
} from '@genesis/shared';
import { Anchor, Group, Text, Tooltip } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import type { FiltroListagem } from '../../componentes/listagem/Listagem';
import { Relatorio, type ColunaRelatorio, type ConfigRelatorio } from '../../componentes/relatorio/Relatorio';
import { SeletorPessoa, SeletorProduto } from '../../componentes/seletores';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarDataHora } from '../../util/formato';
import { ROTA_ACERTOS } from '../estoques/Acertos';
import { ROTA_NOTAS_ENTRADA } from '../estoques/NotasEntradaEnvio';
import { ROTA_RECEBIMENTOS } from '../estoques/Recebimentos';
import { ROTA_TRANSFERENCIAS } from '../estoques/Transferencias';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';
import { useOpcoesOperadores } from '../vendas/comum';
import { ROTA_VENDAS } from '../vendas/Vendas';

export const ROTA_MOVIMENTACAO_ESTOQUE = '/relatorios/movimentacao-estoque';

const reais = (v: string | null) => (v === null ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`);
/** Custo unitário: de 2 a 4 casas (o `numeric(15,4)` gravado, sem os zeros à direita além dos centavos). */
const custoUnitario = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const reais4 = (v: string | null) => (v === null ? '—' : `R$ ${custoUnitario.format(Number(v))}`);
const qtd = (v: string) => formatarDecimal(Number(v), 3);

/** Hoje e o primeiro dia do mês no fuso da empresa (`AAAA-MM-DD`; o de Brasília, como `formatarDataHora`). */
function diasPadrao(agora = new Date()): { inicio: string; hoje: string } {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
  return { inicio: `${hoje.slice(0, 8)}01`, hoje };
}

/** O documento de origem: a tela dele (com a permissão de ver) e o rótulo com o número. */
const DOCUMENTOS: Record<DocumentoMovimentacao, { rota?: string; permissao?: string; prefixo: string }> = {
  venda: { rota: ROTA_VENDAS, permissao: 'vendas.ver', prefixo: 'Venda' },
  troca: { prefixo: 'Troca' },
  acerto: { rota: ROTA_ACERTOS, permissao: 'estoque_acertos.ver', prefixo: 'Acerto Nº' },
  recebimento: { rota: ROTA_RECEBIMENTOS, permissao: 'recebimentos.ver', prefixo: 'Recebimento Nº' },
  nota_entrada: { rota: ROTA_NOTAS_ENTRADA, permissao: 'notas_entrada.ver', prefixo: 'NF-e' },
  transferencia: { rota: ROTA_TRANSFERENCIAS, permissao: 'transferencias.ver', prefixo: 'Transferência Nº' },
  vasilhame: { prefixo: 'Vasilhame' },
};

/** A unidade do documento com o fator quando não é a base (ex.: "CX ×12"). */
export function unidadeDocumento(l: Pick<LinhaMovimentacaoEstoque, 'sigla' | 'fator'>): string {
  return Number(l.fator) === 1 ? l.sigla : `${l.sigla} ×${formatarDecimal(Number(l.fator), 3)}`;
}

export function rotuloDocumento(d: LinhaMovimentacaoEstoque['documento']): string {
  const p = DOCUMENTOS[d.tipo]?.prefixo ?? d.tipo;
  return d.numero ? `${p} ${d.numero}` : p.replace(/ Nº$/, '');
}

/**
 * Relatório **Movimentação de Estoque**, visão analítica (ERP 16.5; Fase 2, F2-B32; README do ERP › decisão 67): um
 * movimento do razão por linha, de um local de estoque num período (até 366 dias; padrão: do primeiro dia do mês até
 * hoje, no estoque da loja de contexto), no `<Relatorio>` paginado por cursor (Próxima/Anterior, sem total: um ano de
 * uma loja passa de um milhão de movimentos). Filtros: produto, tipos de movimento (multisseleção), usuário (com
 * `usuarios.ver`), documento (tipo e número) e pessoa (cliente ou fornecedor). Colunas do export do Nuvem3 — data e
 * hora, Ref. Interna, produto, tipo de movimento (com o id do Nuvem3 quando há), saldo anterior, quantidade e saldo
 * atual, unidade do documento, usuário, loja — mais a unidade da quantidade (a do produto), o custo (só com
 * `produtos.ver_custo`), o documento com o link e o cliente/fornecedor. O local pode ser um inativo (marcado). Os saldos são **recalculados na ordem da data**; quando diferem dos gravados no lançamento (a
 * venda offline que chegou depois, o "Definir" na hora da contagem), o ícone ao lado mostra os gravados. A visão
 * sintética e a exportação chegam no F2-B33.
 */
export function MovimentacaoEstoque() {
  const pode = usePode();
  const { lojaId } = useLojaContexto();
  const operadores = useOpcoesOperadores();
  // Também os inativos (marcados): o histórico de um local que deixou de ser usado é caso de auditoria (16.5).
  const estoques = useQuery({
    queryKey: ['opcoes', 'estoques', 'com-inativos'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'todos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    staleTime: 60_000,
  });
  const tipos = useQuery({
    queryKey: ['opcoes', 'tipos-movimento-estoque'],
    queryFn: () => apiErp.get<TipoMovimentoEstoqueOpcao[]>('/referencias/tipos-movimento-estoque'),
    staleTime: 5 * 60_000,
  });
  // Os nomes do produto e da pessoa escolhidos (o seletor reaberto pelo link): da última resposta.
  const [referencias, setReferencias] = useState<RespostaMovimentacaoEstoque['referencias'] | null>(null);
  const verCusto = pode('produtos.ver_custo');
  const verProdutos = pode('produtos.ver');
  const verPessoas = pode('pessoas.ver');
  // O estoque ativo da loja de contexto (ERP 3.1); sem ela, o primeiro ativo permitido. O local é obrigatório (sem
  // "Todas"); o inativo só é escolhido à mão.
  const ativos = estoques.data?.itens.filter((e) => e.ativo) ?? [];
  const estoquePadrao = ativos.find((e) => lojaId && e.lojaId === lojaId)?.id ?? ativos[0]?.id ?? '';
  const { inicio, hoje } = diasPadrao();

  const config = useMemo<ConfigRelatorio<LinhaMovimentacaoEstoque>>(() => {
    // O seletor só usa o id, o código e o nome do produto conhecido (o rótulo da opção).
    const produtoConhecido = referencias?.produto
      ? ({ ...referencias.produto, ativo: true } as unknown as ProdutoOpcao)
      : null;
    const filtros: FiltroListagem[] = [
      {
        campo: 'estoqueId',
        rotulo: 'Local de estoque',
        tipo: 'selecao',
        padrao: estoquePadrao,
        opcoes: (estoques.data?.itens ?? []).map((e) => ({
          value: e.id,
          label: e.ativo ? e.nome : `${e.nome} (inativo)`,
        })),
      },
      { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data', padrao: inicio },
      { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data', padrao: hoje },
      {
        campo: 'tiposMovimento',
        rotulo: 'Tipos de movimento',
        tipo: 'multisselecao',
        opcoes: (tipos.data ?? []).map((t) => ({ value: t.codigo, label: t.nome })),
      },
    ];
    if (verProdutos)
      filtros.push({
        campo: 'produtoId',
        rotulo: 'Produto',
        tipo: 'componente',
        descrever: (v) =>
          referencias?.produto?.id === v ? `${referencias.produto.codigo} - ${referencias.produto.nome}` : v,
        renderizar: ({ filtro, valor, aoMudar }) => (
          <SeletorProduto
            label={filtro.rotulo}
            placeholder="Todos (nome, código ou EAN)"
            value={valor || null}
            produto={produtoConhecido}
            onChange={(id) => aoMudar(id ?? '')}
            comboboxProps={{ withinPortal: true }}
          />
        ),
      });
    if (operadores)
      filtros.push({ campo: 'usuarioId', rotulo: 'Usuário', tipo: 'selecao', opcoes: operadores });
    filtros.push(
      {
        campo: 'documentoTipo',
        rotulo: 'Documento',
        tipo: 'selecao',
        opcoes: DOCUMENTOS_MOVIMENTACAO.map((d) => ({ value: d, label: ROTULOS_DOCUMENTO_MOVIMENTACAO[d] })),
      },
      { campo: 'documentoNumero', rotulo: 'Nº do documento', tipo: 'texto', placeholder: 'Ex.: 42' },
    );
    if (verPessoas)
      filtros.push({
        campo: 'pessoaId',
        rotulo: 'Pessoa (cliente ou fornecedor)',
        tipo: 'componente',
        descrever: (v) =>
          referencias?.pessoa?.id === v ? `${referencias.pessoa.codigo} - ${referencias.pessoa.nome}` : v,
        renderizar: ({ filtro, valor, aoMudar }) => (
          <SeletorPessoa
            label={filtro.rotulo}
            placeholder="Todas"
            value={valor || null}
            pessoa={
              referencias?.pessoa && referencias.pessoa.id === valor
                ? {
                    id: referencias.pessoa.id,
                    codigo: referencias.pessoa.codigo,
                    nome: referencias.pessoa.nome,
                    tipo: 'PJ',
                    apelido: null,
                    cpfCnpj: null,
                    ativa: true,
                    excluida: false,
                  }
                : null
            }
            onChange={(id) => aoMudar(id ?? '')}
            comboboxProps={{ withinPortal: true }}
          />
        ),
      });

    const nuvem3 = new Map((tipos.data ?? []).map((t) => [t.codigo, t.idNuvem3]));
    const colunas: ColunaRelatorio<LinhaMovimentacaoEstoque>[] = [
      { campo: 'dataMovimento', rotulo: 'Data/hora', formato: (l) => formatarDataHora(l.dataMovimento) },
      { campo: 'codigoInterno', rotulo: 'Ref. Interna', formato: (l) => l.codigoInterno ?? '—' },
      {
        campo: 'produto',
        rotulo: 'Produto',
        formato: (l) => (
          <Anchor component={Link} to={`${ROTA_PRODUTOS}/${l.produtoId}`} c="inherit" size="sm">
            {l.produtoCodigo} - {l.produtoNome}
            {l.variacaoNome ? ` · ${l.variacaoNome}` : ''}
          </Anchor>
        ),
      },
      {
        campo: 'tipoMovimento',
        rotulo: 'Tipo de movimento',
        formato: (l) => {
          const id = l.idNuvem3 ?? nuvem3.get(l.tipoMovimento) ?? null;
          return id === null ? (
            l.tipoMovimentoNome
          ) : (
            <Tooltip label={`Tipo ${id} no Nuvem3`}>
              <span>{l.tipoMovimentoNome}</span>
            </Tooltip>
          );
        },
      },
      { campo: 'tipoEstoqueNome', rotulo: 'Tipo de estoque', formato: (l) => l.tipoEstoqueNome },
      {
        campo: 'saldoAnterior',
        rotulo: 'Est. anterior',
        alinhamento: 'right',
        formato: (l) => qtd(l.saldoAnterior),
      },
      {
        campo: 'quantidade',
        rotulo: 'Qtd. movimentada',
        alinhamento: 'right',
        formato: (l) => (
          <Text span size="sm" fw={600} c={Number(l.quantidade) < 0 ? 'red' : 'teal'}>
            {Number(l.quantidade) > 0 ? '+' : ''}
            {qtd(l.quantidade)}
          </Text>
        ),
      },
      {
        campo: 'saldoPosterior',
        rotulo: 'Est. atual',
        alinhamento: 'right',
        formato: (l) => <SaldoPosterior linha={l} />,
      },
      // A quantidade e os saldos estão na unidade do produto; a do documento (com o fator) vem ao lado, como no
      // Nuvem3 (2 CX ×12 entram como 24 UN).
      { campo: 'unidadeBase', rotulo: 'Unidade', formato: (l) => l.unidadeBase },
      { campo: 'sigla', rotulo: 'Unid. do documento', formato: (l) => unidadeDocumento(l) },
      ...(verCusto
        ? [
            {
              campo: 'custoUnitario',
              rotulo: 'Custo unit.',
              alinhamento: 'right' as const,
              formato: (l: LinhaMovimentacaoEstoque) => reais4(l.custoUnitario),
            },
            {
              campo: 'custoTotal',
              rotulo: 'Custo total',
              alinhamento: 'right' as const,
              formato: (l: LinhaMovimentacaoEstoque) => reais(l.custoTotal),
            },
          ]
        : []),
      { campo: 'documento', rotulo: 'Documento', formato: (l) => <LinkDocumento linha={l} pode={pode} /> },
      {
        campo: 'pessoa',
        rotulo: 'Cliente/Fornecedor',
        formato: (l) => l.pessoaVenda ?? l.fornecedor ?? '—',
      },
      { campo: 'usuarioNome', rotulo: 'Usuário', formato: (l) => l.usuarioNome ?? '—' },
      { campo: 'lojaNome', rotulo: 'Loja', formato: (l) => l.lojaNome ?? '—' },
    ];

    return {
      nome: RELATORIO_MOVIMENTACAO_ESTOQUE,
      titulo: 'Movimentação de Estoque',
      filtros,
      colunas,
      paginacao: 'cursor',
      chaveLinha: (l) => l.id,
      nota:
        'Est. anterior e Est. atual são recalculados na ordem da data e hora de cada movimento. Podem diferir do ' +
        'saldo gravado no lançamento quando uma venda offline chega depois ou um acerto é lançado com a hora da ' +
        'contagem no passado: o ícone ao lado do saldo mostra o gravado. As quantidades e os saldos estão na ' +
        'Unidade do produto; a do documento vem ao lado com o fator (2 CX ×12 entram como 24).',
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaMovimentacaoEstoque>(
          `/relatorios/movimentacao-estoque${query(p)}`,
          { sinal },
        );
        setReferencias(r.referencias);
        return { linhas: r.itens, proximoCursor: r.proximoCursor };
      },
    };
  }, [
    estoques.data,
    tipos.data,
    operadores,
    estoquePadrao,
    inicio,
    hoje,
    referencias,
    verCusto,
    verProdutos,
    verPessoas,
    pode,
  ]);

  return <Relatorio config={config} />;
}

/** O saldo depois do movimento; com o ícone e os gravados quando o recálculo pela data difere do lançamento. */
function SaldoPosterior({ linha }: { linha: LinhaMovimentacaoEstoque }) {
  const numero = (
    <Text span size="sm" fw={600} c={Number(linha.saldoPosterior) < 0 ? 'red' : undefined}>
      {qtd(linha.saldoPosterior)}
    </Text>
  );
  const difere =
    Number(linha.saldoAnterior) !== Number(linha.saldoAnteriorGravado) ||
    Number(linha.saldoPosterior) !== Number(linha.saldoPosteriorGravado);
  if (!difere) return numero;
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      <Tooltip
        multiline
        w={260}
        label={`Gravado no lançamento: anterior ${qtd(linha.saldoAnteriorGravado)}, atual ${qtd(linha.saldoPosteriorGravado)}. A ordem do lançamento difere da data (venda offline que chegou depois ou lançamento com data no passado).`}
      >
        <IconInfoCircle
          size={14}
          color="var(--mantine-color-orange-6)"
          aria-label={`Saldo gravado no lançamento: ${qtd(linha.saldoPosteriorGravado)}`}
        />
      </Tooltip>
      {numero}
    </Group>
  );
}

/** O documento com o link para a tela dele (com a permissão de ver), ou só o rótulo. */
function LinkDocumento({ linha, pode }: { linha: LinhaMovimentacaoEstoque; pode: (p: string) => boolean }) {
  const d = DOCUMENTOS[linha.documento.tipo];
  const rotulo = rotuloDocumento(linha.documento);
  if (!d?.rota || !linha.documento.id || (d.permissao && !pode(d.permissao))) return <>{rotulo}</>;
  return (
    <Anchor component={Link} to={`${d.rota}/${linha.documento.id}`} size="sm">
      {rotulo}
    </Anchor>
  );
}
