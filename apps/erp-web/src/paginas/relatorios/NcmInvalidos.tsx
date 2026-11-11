import {
  LIMITE_DEFINIR_NCM,
  RELATORIO_NCM_INVALIDOS,
  ROTULOS_MOTIVO_NCM_INVALIDO,
  type LinhaNcmInvalido,
  type MotivoNcmInvalido,
  type RespostaNcmInvalidos,
  type ResultadoDefinirNcm,
} from '@genesis/shared';
import { Alert, Anchor, Badge, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { BuscaNcm } from '../../componentes/campos/BuscaNcm';
import {
  exportarPelaApi,
  Relatorio,
  type ColunaRelatorio,
  type ConfigRelatorio,
} from '../../componentes/relatorio/Relatorio';
import { formatarInteiro } from '../../util/formato';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';

export const ROTA_NCM_INVALIDOS = '/relatorios/ncm-invalidos';

const COR_MOTIVO: Record<MotivoNcmInvalido, string> = {
  vazio: 'gray',
  inexistente: 'red',
  fora_vigencia: 'orange',
  cest_incompativel: 'grape',
};
const mascara = (c: string | null) =>
  c === null ? '—' : c.length === 8 ? `${c.slice(0, 4)}.${c.slice(4, 6)}.${c.slice(6)}` : c;

/**
 * As mensagens do erro da API, cada uma com a chave dela (`produtos.N.j`, única mesmo com mensagens repetidas). A de
 * `produtos.N` que ainda não traz o produto ganha o "código - nome" de `produtos[N]`, para o usuário saber qual marcado
 * falhou (a lista do modal não mostra o índice).
 */
function itensDoErro(
  campos: Record<string, string[]> | undefined,
  produtos: Pick<LinhaNcmInvalido, 'produtoCodigo' | 'produtoNome'>[],
): Array<{ chave: string; texto: string }> {
  return Object.entries(campos ?? {}).flatMap(([campo, msgs]) => {
    const p = /^produtos\.(\d+)$/.exec(campo)?.[1];
    const produto = p === undefined ? undefined : produtos[Number(p)];
    const nome = produto && `${produto.produtoCodigo} - ${produto.produtoNome}`;
    return msgs.map((m, j) => ({
      chave: `${campo}.${j}`,
      texto: nome && !m.startsWith(`${produto.produtoCodigo} - `) ? `${nome}: ${m}` : m,
    }));
  });
}

/**
 * Modal do "Definir NCM" em lote: o `<BuscaNcm>` e a lista dos produtos marcados; grava tudo ou nada (a API devolve os
 * erros por produto, na ordem da lista: `produtos.N`).
 */
function ModalDefinirNcm({
  produtos,
  aoFechar,
  aoGravar,
}: {
  produtos: LinhaNcmInvalido[];
  aoFechar: () => void;
  aoGravar: (r: ResultadoDefinirNcm) => Promise<void>;
}) {
  const [ncm, setNcm] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<{
    mensagem: string;
    itens: Array<{ chave: string; texto: string }>;
  } | null>(null);
  const gravar = async () => {
    if (!ncm) return setErro({ mensagem: 'Escolha o NCM.', itens: [] });
    setSalvando(true);
    setErro(null);
    try {
      const r = await apiErp.post<ResultadoDefinirNcm>('/relatorios/ncm-invalidos/definir-ncm', {
        ncm,
        produtos: produtos.map((p) => ({ id: p.produtoId, versao: p.versao })),
      });
      await aoGravar(r);
    } catch (e) {
      setErro(
        e instanceof ErroRequisicao
          ? { mensagem: e.message, itens: itensDoErro(e.campos, produtos) }
          : { mensagem: (e as Error).message, itens: [] },
      );
    } finally {
      setSalvando(false);
    }
  };
  return (
    <Modal
      opened
      onClose={aoFechar}
      title={`Definir NCM de ${formatarInteiro(produtos.length)} produto(s)`}
      size="lg"
    >
      <Stack>
        {erro && (
          <Alert color="red" data-testid="erro-definir-ncm">
            <Text size="sm">{erro.mensagem}</Text>
            {erro.itens.length > 0 && (
              <List size="sm" mt="xs">
                {erro.itens.map((m) => (
                  <List.Item key={m.chave}>{m.texto}</List.Item>
                ))}
              </List>
            )}
          </Alert>
        )}
        <BuscaNcm
          label="NCM"
          description="O mesmo NCM para todos os produtos marcados"
          required
          value={ncm}
          onChange={setNcm}
          data-autofocus
        />
        <Text size="sm" c="dimmed">
          Cada produto é gravado como no cadastro (com a auditoria dele) e o novo NCM desce aos caixas na
          próxima sincronização.
        </Text>
        <List size="sm" spacing={2} style={{ maxHeight: 220, overflowY: 'auto' }}>
          {produtos.map((p) => (
            <List.Item key={p.produtoId}>
              {p.produtoCodigo} - {p.produtoNome} ({mascara(p.ncm)})
            </List.Item>
          ))}
        </List>
        <Group justify="flex-end">
          <Button variant="default" onClick={aoFechar} disabled={salvando}>
            Fechar
          </Button>
          <Button onClick={gravar} loading={salvando}>
            Gravar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Relatório **NCMs inválidos** (ERP 16.3; Fase 2, F2-B41; README do ERP › decisão 75): os produtos (sem combo e
 * serviço) com o NCM vazio, inexistente ou fora de vigência e, com a tabela de CEST carregada, o CEST incompatível com
 * o NCM — para limpar o cadastro antes da fase fiscal. Sem filtros (como no Nuvem3), gera ao abrir, paginado no
 * servidor (50 por página), com a exportação pela API. **Editar** abre o produto; com `produtos.editar`, a seleção de
 * linhas da página leva ao **"Definir NCM"** em lote (o `<BuscaNcm>`), que grava cada produto pelo cadastro, com a
 * versão que o relatório mostrou (se alguém mexeu depois, nada é gravado e pede para gerar de novo).
 */
export function NcmInvalidos() {
  const pode = usePode();
  const cliente = useQueryClient();
  const podeEditar = pode('produtos.editar');
  const [lote, setLote] = useState<{ produtos: LinhaNcmInvalido[]; limpar: () => void } | null>(null);

  const config = useMemo<ConfigRelatorio<LinhaNcmInvalido>>(() => {
    const colunas: ColunaRelatorio<LinhaNcmInvalido>[] = [
      {
        campo: 'produto',
        rotulo: 'Produto',
        formato: (l) => (
          <Group gap="xs" wrap="nowrap">
            <Text span size="sm">
              {l.produtoCodigo} - {l.produtoNome}
            </Text>
            {!l.ativo && (
              <Badge variant="light" size="xs" color="gray">
                Inativo
              </Badge>
            )}
          </Group>
        ),
      },
      { campo: 'codigoInterno', rotulo: 'Código interno', formato: (l) => l.codigoInterno ?? '—' },
      { campo: 'codigoBarras', rotulo: 'EAN', formato: (l) => l.codigoBarras ?? '—' },
      { campo: 'ncm', rotulo: 'NCM atual', formato: (l) => mascara(l.ncm) },
      { campo: 'cest', rotulo: 'CEST', formato: (l) => l.cest ?? '—' },
      {
        campo: 'motivo',
        rotulo: 'Motivo',
        formato: (l) => (
          <Stack gap={2}>
            <Badge variant="light" size="sm" color={COR_MOTIVO[l.motivo]}>
              {ROTULOS_MOTIVO_NCM_INVALIDO[l.motivo]}
            </Badge>
            {l.detalhe && (
              <Text size="xs" c="dimmed">
                {l.detalhe}
              </Text>
            )}
          </Stack>
        ),
      },
      {
        campo: 'editar',
        rotulo: 'Ação',
        formato: (l) => (
          <Anchor
            component={Link}
            to={`${ROTA_PRODUTOS}/${l.produtoId}`}
            size="sm"
            aria-label={`Editar ${l.produtoCodigo} - ${l.produtoNome}`}
          >
            Editar
          </Anchor>
        ),
      },
    ];
    return {
      nome: RELATORIO_NCM_INVALIDOS,
      titulo: 'NCMs inválidos',
      filtros: [],
      colunas,
      paginacao: 'pagina',
      tamanhoPadrao: 50,
      gerarAoAbrir: true,
      chaveLinha: (l) => l.produtoId,
      exportar: exportarPelaApi(RELATORIO_NCM_INVALIDOS),
      ...(podeEditar
        ? {
            selecao: {
              rotuloLinha: (l: LinhaNcmInvalido) => `${l.produtoCodigo} - ${l.produtoNome}`,
              acoes: (selecionadas: LinhaNcmInvalido[], limpar: () => void) => (
                <Button
                  size="xs"
                  disabled={selecionadas.length > LIMITE_DEFINIR_NCM}
                  onClick={() => setLote({ produtos: selecionadas, limpar })}
                >
                  Definir NCM
                </Button>
              ),
            },
          }
        : {}),
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaNcmInvalidos>(`/relatorios/ncm-invalidos${query(p)}`, { sinal });
        return {
          linhas: r.itens,
          total: r.total,
          resumo: [
            { rotulo: 'Produtos', valor: formatarInteiro(r.total) },
            ...(['vazio', 'inexistente', 'fora_vigencia'] as const).map((m) => ({
              rotulo: ROTULOS_MOTIVO_NCM_INVALIDO[m],
              valor: formatarInteiro(r.porMotivo[m]),
            })),
            {
              rotulo: ROTULOS_MOTIVO_NCM_INVALIDO.cest_incompativel,
              valor: r.cestCarregado
                ? formatarInteiro(r.porMotivo.cest_incompativel)
                : 'Tabela não carregada',
            },
          ],
        };
      },
    };
  }, [podeEditar]);

  return (
    <>
      <Relatorio config={config} />
      {lote && (
        <ModalDefinirNcm
          produtos={lote.produtos}
          aoFechar={() => setLote(null)}
          aoGravar={async (r) => {
            notifications.show({
              color: 'green',
              message: `NCM definido em ${formatarInteiro(r.atualizados.length)} produto(s)${r.semMudanca ? ` (${formatarInteiro(r.semMudanca)} já tinham o NCM)` : ''}.`,
            });
            lote.limpar();
            setLote(null);
            await cliente.invalidateQueries({ queryKey: ['relatorio', RELATORIO_NCM_INVALIDOS] });
          }}
        />
      )}
    </>
  );
}
