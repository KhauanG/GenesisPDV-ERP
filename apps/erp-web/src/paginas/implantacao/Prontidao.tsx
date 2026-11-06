import {
  GRUPOS_PRONTIDAO,
  ROTULOS_GRUPO_PRONTIDAO,
  type ItemProntidao,
  type Prontidao as DadosProntidao,
  type SituacaoProntidao,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconRefresh } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useEu } from '../../auth/sessao';
import { SeletorLoja } from '../../componentes/seletores/SeletorLoja';
import { useLojaContexto } from '../../layout/lojaContexto';
import { formatarDataHora, formatarInteiro } from '../../util/formato';

export const ROTA_PRONTIDAO = '/cadastros/implantacao/prontidao';

const SITUACAO: Record<
  SituacaoProntidao,
  { cor: string; rotulo: string; icone: typeof IconCircleCheck; ordem: number }
> = {
  falta: { cor: 'red', rotulo: 'Falta', icone: IconCircleX, ordem: 0 },
  aviso: { cor: 'yellow', rotulo: 'Aviso', icone: IconAlertTriangle, ordem: 1 },
  ok: { cor: 'teal', rotulo: 'OK', icone: IconCircleCheck, ordem: 2 },
};

function LinhaItem({ item }: { item: ItemProntidao }) {
  const s = SITUACAO[item.situacao];
  const Icone = s.icone;
  return (
    <Group
      wrap="nowrap"
      align="flex-start"
      gap="sm"
      data-testid={`prontidao-${item.codigo}`}
      data-situacao={item.situacao}
    >
      <ThemeIcon color={s.cor} variant="light" radius="xl" size="md" aria-label={s.rotulo}>
        <Icone size={16} />
      </ThemeIcon>
      <Stack gap={2} style={{ flex: 1 }}>
        <Group gap="xs" wrap="wrap">
          <Text fw={600} size="sm">
            {item.titulo}
          </Text>
          {item.situacao !== 'ok' && (
            <Badge color={s.cor} variant="light" size="sm">
              {s.rotulo}
            </Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {item.mensagem}
        </Text>
      </Stack>
      {item.linkErp && (
        <Anchor component={Link} to={item.linkErp} size="sm" style={{ whiteSpace: 'nowrap' }}>
          {item.situacao === 'ok' ? 'Abrir' : 'Resolver'}
        </Anchor>
      )}
    </Group>
  );
}

/**
 * Implantação › Prontidão da loja (implantação do piloto, I5): o que falta para a loja vender no dia da implantação,
 * agrupado (empresa, loja e caixas, usuários e liberações, formas, catálogo, PDVs, operação da nuvem), com o ícone da
 * situação e o link da tela que resolve. Só leitura (`configuracoes.ver`); a loja vem da URL, do contexto do cabeçalho
 * ou é a primeira permitida. "Só o que falta resolver" esconde os itens ok. O roteiro do piloto
 * (`docs/implantacao/roteiro-piloto.md`) manda conferir esta tela no D-1 e no dia D.
 */
export function Prontidao() {
  useDocumentTitle('Prontidão da loja · GenesisPDV');
  const eu = useEu();
  const { lojaId: lojaContexto } = useLojaContexto();
  const [params, setParams] = useSearchParams();
  const ativas = eu.lojas.filter((l) => l.ativa);
  const lojaId = params.get('lojaId') || lojaContexto || ativas[0]?.id || null;
  const pendencias = params.get('pendencias') === '1';
  const definir = (campo: string, valor: string | null) => {
    const novo = new URLSearchParams(params);
    if (valor) novo.set(campo, valor);
    else novo.delete(campo);
    setParams(novo, { replace: true });
  };

  const consulta = useQuery({
    queryKey: ['implantacao', 'prontidao', lojaId],
    queryFn: () => apiErp.get<DadosProntidao>(`/implantacao/prontidao${query({ lojaId })}`),
    enabled: !!lojaId,
    placeholderData: keepPreviousData,
  });
  const d = consulta.data;
  const visiveis = (d?.itens ?? []).filter((i) => !pendencias || i.situacao !== 'ok');

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Stack gap={2}>
          <Title order={2} size="h3">
            Prontidão da loja
          </Title>
          <Text size="sm" c="dimmed">
            O que falta para a loja vender no piloto. Confira no dia anterior e de novo antes de abrir o
            caixa.
          </Text>
        </Stack>
        <Group align="flex-end" wrap="wrap">
          <SeletorLoja label="Loja" required w={260} value={lojaId} onChange={(v) => definir('lojaId', v)} />
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            loading={consulta.isFetching}
            disabled={!lojaId}
            onClick={() => void consulta.refetch()}
          >
            Conferir de novo
          </Button>
        </Group>
      </Group>

      {!lojaId && <Alert color="gray">Nenhuma loja ativa permitida para você.</Alert>}
      {consulta.isError && (
        <Alert color="red" title="Não deu para conferir a loja">
          {(consulta.error as Error).message}
        </Alert>
      )}
      {lojaId && !d && consulta.isLoading && <Skeleton h={240} />}

      {d && (
        <>
          <Alert
            color={d.pronta ? 'teal' : 'red'}
            icon={d.pronta ? <IconCircleCheck size={18} /> : <IconCircleX size={18} />}
            title={
              d.pronta
                ? `${d.lojaNome}: pronta para vender`
                : `${d.lojaNome}: ${d.resumo.falta === 1 ? 'falta 1 item' : `faltam ${formatarInteiro(d.resumo.falta)} itens`} para vender`
            }
            data-testid="prontidao-resumo"
          >
            <Group gap="xs" wrap="wrap">
              <Badge color="teal" variant="light">
                {formatarInteiro(d.resumo.ok)} ok
              </Badge>
              <Badge color="yellow" variant="light">
                {formatarInteiro(d.resumo.aviso)} {d.resumo.aviso === 1 ? 'aviso' : 'avisos'}
              </Badge>
              <Badge color="red" variant="light">
                {formatarInteiro(d.resumo.falta)} {d.resumo.falta === 1 ? 'falta' : 'faltas'}
              </Badge>
              <Text size="xs" c="dimmed">
                Conferido em {formatarDataHora(d.geradoEm)}. Os avisos não impedem a venda, mas convém olhar.
              </Text>
            </Group>
          </Alert>
          <Switch
            label="Só o que falta resolver"
            checked={pendencias}
            onChange={(e) => definir('pendencias', e.currentTarget.checked ? '1' : null)}
          />
          {GRUPOS_PRONTIDAO.map((g) => {
            const itens = visiveis
              .filter((i) => i.grupo === g)
              .sort((a, b) => SITUACAO[a.situacao].ordem - SITUACAO[b.situacao].ordem);
            if (itens.length === 0) return null;
            return (
              <Paper
                key={g}
                withBorder
                p="md"
                radius="md"
                component="section"
                aria-label={ROTULOS_GRUPO_PRONTIDAO[g]}
              >
                <Title order={3} size="h5" mb="sm">
                  {ROTULOS_GRUPO_PRONTIDAO[g]}
                </Title>
                <Stack gap="sm">
                  {itens.map((i) => (
                    <LinhaItem key={i.codigo} item={i} />
                  ))}
                </Stack>
              </Paper>
            );
          })}
          {pendencias && visiveis.length === 0 && <Alert color="teal">Nada pendente nesta loja.</Alert>}
        </>
      )}
    </Stack>
  );
}
