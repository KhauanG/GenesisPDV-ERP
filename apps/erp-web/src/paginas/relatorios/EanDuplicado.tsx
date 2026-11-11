import {
  RELATORIO_EAN_DUPLICADO,
  type LinhaEanDuplicado,
  type ProdutoEanDuplicado,
  type RespostaEanDuplicado,
} from '@genesis/shared';
import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import {
  exportarPelaApi,
  Relatorio,
  type ColunaRelatorio,
  type ConfigRelatorio,
} from '../../componentes/relatorio/Relatorio';
import { formatarInteiro } from '../../util/formato';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';

export const ROTA_EAN_DUPLICADO = '/relatorios/ean-duplicado';
/** A aba Geral das Configurações, onde fica a chave `geral.ean_duplicado`. */
const ROTA_CONFIGURACOES_GERAL = '/cadastros/configuracoes/geral';

/** Um produto do código: o link para editar, a variação, e se é o EAN principal ou uma embalagem. */
function ProdutoDoCodigo({ p }: { p: ProdutoEanDuplicado }) {
  const fator = Number(p.fator);
  return (
    <Group gap="xs" wrap="nowrap">
      <Anchor
        component={Link}
        to={`${ROTA_PRODUTOS}/${p.produtoId}`}
        size="sm"
        aria-label={`Editar ${p.produtoCodigo} - ${p.produtoNome}`}
      >
        {p.produtoCodigo} - {p.produtoNome}
        {p.variacaoNome ? ` (${p.variacaoNome})` : ''}
      </Anchor>
      {p.codigoInterno && (
        <Text span size="xs" c="dimmed">
          Ref. {p.codigoInterno}
        </Text>
      )}
      {p.principal ? (
        <Badge variant="light" size="xs">
          EAN principal
        </Badge>
      ) : (
        <Badge variant="light" size="xs" color="grape">
          {p.descricao ?? 'Embalagem'}
          {fator !== 1 ? ` × ${formatarDecimal(fator, 3)} ${p.unidadeSigla}` : ''}
        </Badge>
      )}
      {!p.ativo && (
        <Badge variant="light" size="xs" color="gray">
          Inativo
        </Badge>
      )}
    </Group>
  );
}

/**
 * Relatório **EAN duplicado** (Fase 2, F2-B38; MD 3.6.5; ERP 8.2 "Regras", 20 item 2; README do ERP › decisão 72): os
 * códigos de barras que estão em mais de um produto, cada um com os produtos dele (o link abre o produto para
 * corrigir: tirar o código repetido ou trocar pelo certo), paginado no servidor pelos códigos, com a exportação pela
 * API. Filtros: o começo do EAN e o nome (o código achado pelo nome de um produto vem com todos). Quando zera, a
 * empresa volta Configurações › Geral › "EAN duplicado" de "Avisar" para "Bloquear" (o card mostra a regra de agora).
 * Gera ao abrir (é leve: só os códigos repetidos). O atalho vem do filtro "EAN duplicado" da listagem de produtos.
 */
export function EanDuplicado() {
  const pode = usePode();
  const verConfiguracoes = pode('configuracoes.ver');

  const config = useMemo<ConfigRelatorio<LinhaEanDuplicado>>(() => {
    const colunas: ColunaRelatorio<LinhaEanDuplicado>[] = [
      { campo: 'codigo', rotulo: 'EAN', formato: (l) => l.codigo },
      {
        campo: 'quantidadeProdutos',
        rotulo: 'Produtos',
        alinhamento: 'right',
        formato: (l) => formatarInteiro(l.quantidadeProdutos),
      },
      {
        campo: 'produtos',
        rotulo: 'Produtos com o EAN',
        formato: (l) => (
          <Stack gap={4}>
            {l.produtos.map((p) => (
              <ProdutoDoCodigo key={p.codigoBarrasId} p={p} />
            ))}
          </Stack>
        ),
      },
    ];
    return {
      nome: RELATORIO_EAN_DUPLICADO,
      titulo: 'EAN duplicado',
      filtros: [
        { campo: 'ean', rotulo: 'EAN', tipo: 'texto', placeholder: 'Começo do código, ex.: 7891' },
        { campo: 'nome', rotulo: 'Produto', tipo: 'texto', placeholder: 'Nome, código interno ou EAN' },
      ],
      colunas,
      paginacao: 'pagina',
      gerarAoAbrir: true,
      chaveLinha: (l) => l.codigo,
      exportar: exportarPelaApi(RELATORIO_EAN_DUPLICADO),
      // Fragmento, não `<Text>`: o `<Relatorio>` já põe a nota num `<Text size="xs" c="dimmed">` (um `<p>`), e
      // `<p>` dentro de `<p>` não vale no HTML. O link herda o tamanho (`inherit`) das notas dos outros relatórios.
      nota: (
        <>
          Corrija cada produto: tire o código repetido ou troque pelo certo. Quando o relatório zerar, volte{' '}
          {verConfiguracoes ? (
            <Anchor component={Link} to={ROTA_CONFIGURACOES_GERAL} inherit>
              Configurações › Geral › EAN duplicado
            </Anchor>
          ) : (
            'Configurações › Geral › EAN duplicado'
          )}{' '}
          para &quot;Bloquear&quot;.
        </>
      ),
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaEanDuplicado>(`/relatorios/ean-duplicado${query(p)}`, { sinal });
        return {
          linhas: r.itens,
          total: r.total,
          resumo: [
            { rotulo: 'EAN repetidos', valor: formatarInteiro(r.total) },
            { rotulo: 'Regra de agora', valor: r.modo === 'avisar' ? 'Avisar' : 'Bloquear' },
          ],
        };
      },
    };
  }, [verConfiguracoes]);

  return <Relatorio config={config} />;
}
