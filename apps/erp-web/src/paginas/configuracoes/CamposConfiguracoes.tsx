import { CHAVES_TIPO_PRODUTO, type ValorConfiguracao } from '@genesis/shared';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBuildingStore, IconDeviceFloppy } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { CHAVE_TIPOS_HABILITADOS } from '../../api/produtos';
import type { RotuloConfiguracao, TipoCampo } from './rotulos';

/** Valor de tela → valor do catálogo (dinheiro "1500.00", percentual "3.5", inteiro, nulo quando vazio). */
export function paraCatalogo(tipo: TipoCampo, v: unknown): unknown {
  if (v === '' || v === undefined || v === null) return null;
  if (tipo === 'dinheiro') return Number(v).toFixed(2);
  if (tipo === 'pct') return String(Number(Number(v).toFixed(4)));
  if (tipo === 'int') return Math.trunc(Number(v));
  return v;
}

const exibir = (tipo: TipoCampo, v: unknown): unknown => {
  if (v === null || v === undefined) return tipo === 'bool' ? false : '';
  if (tipo === 'dinheiro' || tipo === 'pct') return Number(v);
  return v;
};

function Campo({
  def,
  valor,
  aoMudar,
  desabilitado,
}: {
  def: RotuloConfiguracao;
  valor: unknown;
  aoMudar: (v: unknown) => void;
  desabilitado?: boolean;
}) {
  const t = def.tipo;
  const comum = { 'aria-label': def.rotulo, disabled: desabilitado, size: 'xs' as const };
  if (t === 'bool')
    return <Switch {...comum} checked={!!valor} onChange={(e) => aoMudar(e.currentTarget.checked)} />;
  if (t === 'int')
    return (
      <NumberInput
        {...comum}
        w={140}
        allowDecimal={false}
        min={0}
        value={valor as number | ''}
        onChange={aoMudar}
      />
    );
  if (t === 'dinheiro')
    return (
      <NumberInput
        {...comum}
        w={160}
        min={0}
        decimalScale={2}
        fixedDecimalScale
        decimalSeparator=","
        thousandSeparator="."
        prefix="R$ "
        value={valor as number | ''}
        onChange={aoMudar}
      />
    );
  if (t === 'pct')
    return (
      <NumberInput
        {...comum}
        w={120}
        min={0}
        max={100}
        decimalScale={4}
        decimalSeparator=","
        suffix=" %"
        value={valor as number | ''}
        onChange={aoMudar}
      />
    );
  if (t === 'hora')
    return (
      <TextInput
        {...comum}
        w={100}
        placeholder="hh:mm"
        value={String(valor ?? '')}
        onChange={(e) => aoMudar(e.currentTarget.value)}
      />
    );
  if (t === 'texto')
    return (
      <TextInput
        {...comum}
        w={160}
        value={String(valor ?? '')}
        onChange={(e) => aoMudar(e.currentTarget.value)}
      />
    );
  return (
    <Select
      {...comum}
      w={220}
      allowDeselect={false}
      data={t.opcoes.map(([value, label]) => ({ value, label }))}
      value={String(valor ?? '')}
      onChange={aoMudar}
    />
  );
}

/**
 * Bloco de configurações com o próprio Gravar (ERP 9: cada aba grava separado). Sem `lojaId` edita o valor da
 * empresa (🏬 = alguma loja sobrepõe); com `lojaId` é a aba Parâmetros da loja (10.3.9): Herdar × Personalizar.
 */
export function CamposConfiguracoes({
  itens,
  lojaId,
  somenteLeitura,
}: {
  itens: RotuloConfiguracao[];
  lojaId?: string;
  somenteLeitura?: boolean;
}) {
  const queryClient = useQueryClient();
  const grupos = [...new Set(itens.map((i) => i.chave.split('.')[0]))].join(',');
  const chave = ['configuracoes', grupos, lojaId ?? null];
  const dados = useQuery({
    queryKey: chave,
    queryFn: () => apiErp.get<ValorConfiguracao[]>(`/configuracoes${query({ grupos, lojaId })}`),
  });
  const porChave = useMemo(() => new Map((dados.data ?? []).map((v) => [v.chave, v])), [dados.data]);
  const visiveis = itens.filter((i) => porChave.has(i.chave));

  const inicial = useMemo(() => {
    const valores: Record<string, unknown> = {};
    const personalizado: Record<string, boolean> = {};
    for (const i of itens) {
      const v = porChave.get(i.chave);
      if (!v) continue;
      valores[i.chave] = exibir(i.tipo, v.valor);
      personalizado[i.chave] = v.valorLoja !== undefined;
    }
    return { valores, personalizado };
  }, [itens, porChave]);
  // Só as edições ficam no estado; o resto vem do servidor (gravou → limpa e relê).
  const [edicoesValores, setValores] = useState<Record<string, unknown>>({});
  const [edicoesPersonalizado, setPersonalizado] = useState<Record<string, boolean>>({});
  const [erros, setErros] = useState<Record<string, string>>({});
  const valores = { ...inicial.valores, ...edicoesValores };
  const personalizado = { ...inicial.personalizado, ...edicoesPersonalizado };

  const alteradas = itens.filter((i) => {
    if (!porChave.has(i.chave)) return false;
    if (lojaId && personalizado[i.chave] !== inicial.personalizado[i.chave]) return true;
    return (
      JSON.stringify(paraCatalogo(i.tipo, valores[i.chave])) !==
      JSON.stringify(paraCatalogo(i.tipo, inicial.valores[i.chave]))
    );
  });

  const gravar = useMutation({
    mutationFn: async () => {
      const corpo: Record<string, unknown> = {};
      for (const i of alteradas) {
        corpo[i.chave] = lojaId && !personalizado[i.chave] ? null : paraCatalogo(i.tipo, valores[i.chave]);
      }
      await apiErp.put<ValorConfiguracao[]>('/configuracoes', { lojaId: lojaId ?? null, valores: corpo });
      return Object.keys(corpo);
    },
    onSuccess: (gravadas) => {
      setErros({});
      setValores({});
      setPersonalizado({});
      void queryClient.invalidateQueries({ queryKey: ['configuracoes'] });
      // Chave de tipo de produto (F2-B1) ou do bloco Fornecedores (F2-B13): o cadastro guarda as duas por 5 min; relê já.
      const chavesTipo = [...Object.values(CHAVES_TIPO_PRODUTO), 'geral.produto_usa_fornecedores'];
      if (gravadas.some((c) => chavesTipo.includes(c))) {
        void queryClient.invalidateQueries({ queryKey: CHAVE_TIPOS_HABILITADOS });
      }
      notifications.show({ color: 'green', message: 'Configurações gravadas' });
    },
    onError: (e) => {
      if (e instanceof ErroRequisicao && e.campos) {
        setErros(Object.fromEntries(Object.entries(e.campos).map(([k, v]) => [k, v[0] ?? ''])));
      }
      notifications.show({ color: 'red', message: (e as Error).message });
    },
  });

  if (dados.isPending) return <Loader />;
  if (dados.isError) return <Alert color="red">{(dados.error as Error).message}</Alert>;
  const blocos = [...new Set(visiveis.map((i) => i.bloco))];

  return (
    <Stack gap="md">
      {blocos.map((bloco) => (
        <Paper key={bloco} withBorder p="sm">
          <Title order={5} mb="xs">
            {bloco}
          </Title>
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {visiveis
                .filter((i) => i.bloco === bloco)
                .map((i) => {
                  const info = porChave.get(i.chave)!;
                  const herdando = !!lojaId && !personalizado[i.chave];
                  return (
                    <Table.Tr key={i.chave} data-chave={i.chave}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm">{i.rotulo}</Text>
                          {i.fut && (
                            <Badge size="xs" variant="outline" color="gray">
                              módulo futuro
                            </Badge>
                          )}
                          {!lojaId && info.lojasSobrepondo > 0 && (
                            <Tooltip
                              label={`${info.lojasSobrepondo} loja(s) com valor próprio (Lojas › Parâmetros)`}
                            >
                              <IconBuildingStore size={16} aria-label="Sobreposto por loja" />
                            </Tooltip>
                          )}
                        </Group>
                        {i.ajuda && (
                          <Text size="xs" c="dimmed">
                            {i.ajuda}
                          </Text>
                        )}
                        {erros[i.chave] && (
                          <Text size="xs" c="red">
                            {erros[i.chave]}
                          </Text>
                        )}
                      </Table.Td>
                      {lojaId && (
                        <Table.Td w={230}>
                          <SegmentedControl
                            size="xs"
                            disabled={somenteLeitura}
                            data={[
                              { value: 'herdar', label: 'Herdar da empresa' },
                              { value: 'personalizar', label: 'Personalizar' },
                            ]}
                            value={herdando ? 'herdar' : 'personalizar'}
                            onChange={(v) =>
                              setPersonalizado((p) => ({ ...p, [i.chave]: v === 'personalizar' }))
                            }
                          />
                        </Table.Td>
                      )}
                      <Table.Td w={240}>
                        <Campo
                          def={i}
                          valor={
                            herdando ? exibir(i.tipo, info.valorEmpresa ?? info.padrao) : valores[i.chave]
                          }
                          aoMudar={(v) => setValores((s) => ({ ...s, [i.chave]: v }))}
                          desabilitado={somenteLeitura || herdando}
                        />
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
            </Table.Tbody>
          </Table>
        </Paper>
      ))}
      {!somenteLeitura && (
        <Group justify="flex-end">
          <Text size="sm" c="dimmed">
            {alteradas.length ? `${alteradas.length} alteração(ões) não gravada(s)` : 'Sem alterações'}
          </Text>
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!alteradas.length}
            loading={gravar.isPending}
            onClick={() => gravar.mutate()}
          >
            Gravar
          </Button>
        </Group>
      )}
    </Stack>
  );
}
