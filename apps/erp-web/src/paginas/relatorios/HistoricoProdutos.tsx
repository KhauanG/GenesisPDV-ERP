import {
  RELATORIO_HISTORICO_PRODUTOS,
  ROTULOS_TIPO_HISTORICO_PRODUTO,
  TIPOS_HISTORICO_PRODUTO,
  type DetalheHistoricoProduto,
  type LinhaHistoricoProduto,
  type ProdutoOpcao,
  type RespostaHistoricoProdutos,
  type TipoHistoricoProduto,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import type { FiltroListagem } from '../../componentes/listagem/Listagem';
import {
  exportarPelaApi,
  Relatorio,
  type ColunaRelatorio,
  type ConfigRelatorio,
} from '../../componentes/relatorio/Relatorio';
import { SeletorProduto } from '../../componentes/seletores';
import { formatarDataHora } from '../../util/formato';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';
import { useOpcoesOperadores } from '../vendas/comum';

export const ROTA_HISTORICO_PRODUTOS = '/relatorios/historico-produtos';

const COR_TIPO: Record<TipoHistoricoProduto, string> = { G: 'blue', E: 'red', R: 'teal', I: 'grape' };

/** O dia `AAAA-MM-DD` no fuso da empresa (o de Brasília, como `formatarDataHora`). */
const diaNaEmpresa = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

/** O produto da linha, com o link para abrir (o excluído só com o nome, marcado). */
function ProdutoDaLinha({ produto, link }: { produto: LinhaHistoricoProduto['produto']; link: boolean }) {
  if (!produto) return <>—</>;
  const nome = `${produto.codigo} - ${produto.nome}`;
  if (produto.excluido)
    return (
      <Group gap="xs" wrap="nowrap">
        <Text span size="sm">
          {nome}
        </Text>
        <Badge variant="light" size="xs" color="gray">
          Excluído
        </Badge>
      </Group>
    );
  return link ? (
    <Anchor component={Link} to={`${ROTA_PRODUTOS}/${produto.id}`} size="sm" aria-label={`Abrir ${nome}`}>
      {nome}
    </Anchor>
  ) : (
    <>{nome}</>
  );
}

/**
 * "Ver diferença completa": todos os campos que mudaram na linha (a filha no rótulo: "Loja Centro › Preço de venda"),
 * com o antes e o depois, no mesmo corte da API (o custo só com `produtos.ver_custo`, as lojas permitidas).
 */
export function ModalDiferenca({ linha, aoFechar }: { linha: LinhaHistoricoProduto; aoFechar: () => void }) {
  const detalhe = useQuery({
    queryKey: ['historico-produtos', linha.id, linha.ocorridoEm],
    queryFn: ({ signal }) =>
      apiErp.get<DetalheHistoricoProduto>(
        `/relatorios/historico-produtos/${linha.id}${query({ ocorridoEm: linha.ocorridoEm })}`,
        { sinal: signal },
      ),
  });
  return (
    <Modal opened onClose={aoFechar} title="Diferença completa" size="xl">
      <Stack gap="sm">
        <Text size="sm">
          {linha.usuarioNome ?? '—'}, {formatarDataHora(linha.ocorridoEm)}, {linha.localizacao} —{' '}
          {ROTULOS_TIPO_HISTORICO_PRODUTO[linha.tipo]}
        </Text>
        {detalhe.isPending && <Loader size="sm" aria-label="Carregando a diferença" />}
        {detalhe.isError && (
          <Alert color="red" title="Não foi possível abrir a diferença">
            {detalhe.error.message}
          </Alert>
        )}
        {detalhe.data &&
          (detalhe.data.alteracoes.length ? (
            <Table striped withTableBorder aria-label="Campos alterados">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Campo</Table.Th>
                  <Table.Th>Antes</Table.Th>
                  <Table.Th>Depois</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {detalhe.data.alteracoes.map((a, i) => (
                  <Table.Tr key={`${a.campo}-${i}`}>
                    <Table.Td>{a.campo}</Table.Td>
                    <Table.Td>{a.antes}</Table.Td>
                    <Table.Td>{a.depois}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed">
              {detalhe.data.historico}
            </Text>
          ))}
      </Stack>
    </Modal>
  );
}

/**
 * Relatório **Histórico de produtos** (ERP 16.2; Fase 2, F2-B42; README do ERP › decisão 76): quem mudou o quê no
 * cadastro do produto, sobre a auditoria, paginado no servidor. O **período** é obrigatório (padrão: do primeiro dia do
 * mês até hoje; até 366 dias: a auditoria é particionada por mês). Filtros: histórico (texto contido, sem acento),
 * usuário (com `usuarios.ver`), tipo (a legenda G/E/R/I) e produto (com `produtos.ver`). Colunas do Nuvem3 — usuário,
 * tipo, localização, data/hora e o histórico em texto legível — mais o produto, com o link para abrir, e a ação "Ver
 * diferença" (a tabela campo × antes × depois). O texto e a tabela vêm prontos da API no corte de quem consulta (o
 * custo só com `produtos.ver_custo`, o que é de loja só das permitidas). Sem exportação neste bloco.
 */
export function HistoricoProdutos() {
  const pode = usePode();
  const operadores = useOpcoesOperadores();
  const verProdutos = pode('produtos.ver');
  const [aberta, setAberta] = useState<LinhaHistoricoProduto | null>(null);
  // O nome do produto escolhido (o seletor reaberto pelo link): da última resposta.
  const [produtoConhecido, setProdutoConhecido] = useState<LinhaHistoricoProduto['produto']>(null);
  const hoje = diaNaEmpresa(new Date());

  const config = useMemo<ConfigRelatorio<LinhaHistoricoProduto>>(() => {
    const filtros: FiltroListagem[] = [
      { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data', padrao: `${hoje.slice(0, 8)}01` },
      { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data', padrao: hoje },
      {
        campo: 'texto',
        rotulo: 'Histórico',
        tipo: 'texto',
        placeholder: 'Texto contido (ex.: Preço de venda)',
      },
    ];
    if (operadores)
      filtros.push({ campo: 'usuarioId', rotulo: 'Usuário', tipo: 'selecao', opcoes: operadores });
    filtros.push({
      campo: 'tipo',
      rotulo: 'Tipo',
      tipo: 'selecao',
      placeholder: 'Todos',
      opcoes: TIPOS_HISTORICO_PRODUTO.map((t) => ({
        value: t,
        label: `${t} – ${ROTULOS_TIPO_HISTORICO_PRODUTO[t]}`,
      })),
    });
    if (verProdutos)
      filtros.push({
        campo: 'produtoId',
        rotulo: 'Produto',
        tipo: 'componente',
        descrever: (v) =>
          produtoConhecido?.id === v ? `${produtoConhecido.codigo} - ${produtoConhecido.nome}` : v,
        renderizar: ({ filtro, valor, aoMudar }) => (
          <SeletorProduto
            label={filtro.rotulo}
            placeholder="Todos (nome, código ou EAN)"
            value={valor || null}
            produto={
              produtoConhecido ? ({ ...produtoConhecido, ativo: true } as unknown as ProdutoOpcao) : null
            }
            onChange={(id) => aoMudar(id ?? '')}
            comboboxProps={{ withinPortal: true }}
          />
        ),
      });

    const colunas: ColunaRelatorio<LinhaHistoricoProduto>[] = [
      { campo: 'usuarioNome', rotulo: 'Usuário', formato: (l) => l.usuarioNome ?? '—' },
      {
        campo: 'tipo',
        rotulo: 'Tipo',
        alinhamento: 'center',
        formato: (l) => (
          <Tooltip label={ROTULOS_TIPO_HISTORICO_PRODUTO[l.tipo]}>
            <Badge
              variant="light"
              color={COR_TIPO[l.tipo]}
              aria-label={ROTULOS_TIPO_HISTORICO_PRODUTO[l.tipo]}
            >
              {l.tipo}
            </Badge>
          </Tooltip>
        ),
      },
      { campo: 'localizacao', rotulo: 'Localização', formato: (l) => l.localizacao },
      { campo: 'ocorridoEm', rotulo: 'Data/hora', formato: (l) => formatarDataHora(l.ocorridoEm) },
      {
        campo: 'produto',
        rotulo: 'Produto',
        formato: (l) => <ProdutoDaLinha produto={l.produto} link={verProdutos} />,
      },
      {
        campo: 'historico',
        rotulo: 'Histórico',
        formato: (l) => (
          <Text span size="sm" style={{ whiteSpace: 'normal' }}>
            {l.historico}
          </Text>
        ),
      },
      {
        campo: 'acoes',
        rotulo: 'Ações',
        formato: (l) => (
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setAberta(l)}
            aria-label={`Ver diferença completa de ${formatarDataHora(l.ocorridoEm)}`}
          >
            Ver diferença
          </Button>
        ),
      },
    ];

    return {
      nome: RELATORIO_HISTORICO_PRODUTOS,
      titulo: 'Histórico de produtos',
      filtros,
      colunas,
      paginacao: 'pagina',
      chaveLinha: (l) => l.id,
      exportar: exportarPelaApi(RELATORIO_HISTORICO_PRODUTOS),
      nota: 'G = Gravação (criação ou alteração), E = Exclusão, R = Restauração, I = Importação. O filtro "Histórico" procura no texto gravado (sem os valores de custo nem os dados de loja).',
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaHistoricoProdutos>(`/relatorios/historico-produtos${query(p)}`, {
          sinal,
        });
        const escolhido = p.produtoId ? r.itens.find((l) => l.produto?.id === p.produtoId)?.produto : null;
        if (escolhido) setProdutoConhecido(escolhido);
        return { linhas: r.itens, total: r.total };
      },
    };
  }, [hoje, operadores, verProdutos, produtoConhecido]);

  return (
    <>
      <Relatorio config={config} />
      {aberta && <ModalDiferenca linha={aberta} aoFechar={() => setAberta(null)} />}
    </>
  );
}
