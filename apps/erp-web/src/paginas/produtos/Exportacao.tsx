import {
  type EstoqueResumo,
  type ExportacaoEmTarefa,
  type FormatoExportacao,
  type Pagina,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconUsers } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query, type ArquivoBaixado } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { ExportacaoEmAndamento } from '../../componentes/relatorio/Relatorio';
import { CHAVE_LISTA_TAREFAS } from '../../componentes/tarefas/tarefas';
import { useLojaContexto } from '../../layout/lojaContexto';
import { podeExportarCadastro } from '../../menu';
import { salvarArquivo } from '../../util/arquivos';
import { formatarInteiro } from '../../util/formato';
import { ROTA_IMPORTACAO } from '../importacao/Importacao';

export const ROTA_EXPORTACAO = '/produtos/exportacao';

/** O "Todas" do seletor (sem as colunas da loja); as opções são `loja:<id>` e `estoque:<id>` (o estoque sem loja). */
const TODAS = 'todas';

const ehTarefa = (r: ArquivoBaixado | ExportacaoEmTarefa): r is ExportacaoEmTarefa => 'tarefaId' in r;

/**
 * Exportação de produtos e clientes (ERP 8.5; Fase 2, F2-B40; README do ERP › decisão 74): a planilha no layout da
 * Importação ("ida e volta": exportar, editar no Excel e reimportar; o que não mudou fica "Sem alteração"). A loja dá
 * o preço da loja, o estoque mínimo e o estoque atual; o CD (estoque sem loja), só o estoque atual; "Todas", nenhum
 * deles. Até 5.000 linhas o arquivo baixa na hora; acima, vira tarefa em segundo plano e o link aparece aqui e no
 * ícone Tarefas. O custo só sai para quem vê o custo; a API confere a loja e o estoque permitidos.
 */
export function Exportacao() {
  useDocumentTitle('Exportação · GenesisPDV');
  const pode = usePode();
  const eu = useEu();
  const queryClient = useQueryClient();
  const { lojaId: lojaContexto } = useLojaContexto();
  const [local, setLocal] = useState<string>(lojaContexto ? `loja:${lojaContexto}` : TODAS);
  const [formato, setFormato] = useState<FormatoExportacao>('xlsx');
  const [opcoes, setOpcoes] = useState({
    informacoesNf: false,
    ncmInvalido: false,
    estoqueZerado: false,
    somenteAtivos: true,
  });
  const [exportando, setExportando] = useState<'produtos' | 'clientes' | null>(null);
  const [tarefas, setTarefas] = useState<ExportacaoEmTarefa[]>([]);

  const podeProdutos = podeExportarCadastro(pode, 'produtos');
  const podeClientes = podeExportarCadastro(pode, 'pessoas');

  const estoques = useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: pode('estoques.ver'),
    staleTime: 60_000,
  });
  const opcoesLocal = useMemo(
    () => [
      { value: TODAS, label: 'Todas as lojas (sem preço da loja e estoque)' },
      ...eu.lojas
        .filter((l) => l.ativa || `loja:${l.id}` === local)
        .map((l) => ({
          value: `loja:${l.id}`,
          label: `${l.codigo} - ${l.nome}${l.treino ? ' (treino)' : ''}${l.ativa ? '' : ' (inativa)'}`,
        })),
      // O estoque sem loja (o CD): só o estoque atual.
      ...(estoques.data?.itens ?? [])
        .filter((e) => e.lojaId === null)
        .map((e) => ({ value: `estoque:${e.id}`, label: `${e.nome} (só o estoque)` })),
    ],
    [eu.lojas, estoques.data, local],
  );
  const [tipoLocal, idLocal] = local === TODAS ? [null, null] : (local.split(':') as [string, string]);
  const comEstoque = tipoLocal !== null;

  async function baixar(tipo: 'produtos' | 'clientes') {
    setExportando(tipo);
    try {
      const params =
        tipo === 'produtos'
          ? {
              ...(tipoLocal === 'loja' ? { lojaId: idLocal } : {}),
              ...(tipoLocal === 'estoque' ? { estoqueId: idLocal } : {}),
              informacoesNf: String(opcoes.informacoesNf),
              ncmInvalido: String(opcoes.ncmInvalido),
              estoqueZerado: String(comEstoque && opcoes.estoqueZerado),
              somenteAtivos: String(opcoes.somenteAtivos),
              formato,
            }
          : { somenteAtivos: String(opcoes.somenteAtivos), formato };
      const r = await apiErp.baixarOuTarefa(
        `/${tipo === 'produtos' ? 'produtos' : 'pessoas'}/exportacao${query(params)}`,
      );
      if (ehTarefa(r)) {
        setTarefas((t) => [r, ...t]);
        void queryClient.invalidateQueries({ queryKey: CHAVE_LISTA_TAREFAS });
        notifications.show({
          color: 'blue',
          title: 'Exportação em segundo plano',
          message: `${formatarInteiro(r.linhas)} linhas: o arquivo é gerado em segundo plano e o link aparece no ícone Tarefas quando terminar.`,
        });
      } else salvarArquivo(r.blob, r.nome);
    } catch (e) {
      notifications.show({ color: 'red', title: 'Não foi possível exportar', message: (e as Error).message });
    } finally {
      setExportando(null);
    }
  }

  const marcar = (campo: keyof typeof opcoes) => (e: ChangeEvent<HTMLInputElement>) => {
    const marcado = e.currentTarget.checked;
    setOpcoes((o) => ({ ...o, [campo]: marcado }));
  };

  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        Exportação
      </Title>
      <Paper p="md">
        <Stack>
          <Text size="sm" c="dimmed">
            A planilha sai no mesmo layout da{' '}
            <Anchor component={Link} to={ROTA_IMPORTACAO}>
              Importação
            </Anchor>
            : edite no Excel e importe de volta. Nos produtos e nos clientes, o que não mudou aparece como
            &quot;Sem alteração&quot; e não é gravado, e a prévia mostra o que muda em cada linha. Para
            reimportar o estoque, escolha na Importação a mesma loja (ou o mesmo estoque).
          </Text>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Select
              label="Loja"
              description="Define o preço da loja, o estoque mínimo e o estoque atual exportados"
              data={opcoesLocal}
              value={local}
              onChange={(v) => setLocal(v ?? TODAS)}
              allowDeselect={false}
              searchable={opcoesLocal.length > 8}
              comboboxProps={{ withinPortal: true }}
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Formato
              </Text>
              <SegmentedControl
                aria-label="Formato"
                value={formato}
                onChange={(v) => setFormato(v as FormatoExportacao)}
                data={[
                  { value: 'xlsx', label: 'Excel (.xlsx)' },
                  { value: 'csv', label: 'CSV' },
                ]}
                w={{ base: '100%', sm: 280 }}
              />
            </Stack>
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Checkbox
              label="Exportar informações da NF"
              description="NCM, CEST, CFOP, CST/CSOSN, origem e alíquotas gravados"
              checked={opcoes.informacoesNf}
              onChange={marcar('informacoesNf')}
            />
            <Checkbox
              label="Com NCM inválido"
              description="Só os produtos com NCM vazio ou fora da tabela vigente"
              checked={opcoes.ncmInvalido}
              onChange={marcar('ncmInvalido')}
            />
            <Checkbox
              label="Estoque zerado ou negativo"
              description={
                comEstoque
                  ? 'Só os produtos com saldo ≤ 0 no estoque escolhido'
                  : 'Escolha a loja ou o estoque'
              }
              checked={comEstoque && opcoes.estoqueZerado}
              disabled={!comEstoque}
              onChange={marcar('estoqueZerado')}
            />
            <Checkbox
              label="Somente ativos"
              checked={opcoes.somenteAtivos}
              onChange={marcar('somenteAtivos')}
            />
          </SimpleGrid>
          {!podeProdutos && !podeClientes && (
            <Alert color="yellow">Você não tem permissão para exportar produtos nem clientes.</Alert>
          )}
          <Group>
            <Button
              leftSection={<IconDownload size={16} />}
              disabled={!podeProdutos || exportando !== null}
              loading={exportando === 'produtos'}
              onClick={() => void baixar('produtos')}
            >
              Exportar Produtos
            </Button>
            <Button
              variant="default"
              leftSection={<IconUsers size={16} />}
              disabled={!podeClientes || exportando !== null}
              loading={exportando === 'clientes'}
              onClick={() => void baixar('clientes')}
            >
              Exportar Clientes
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Até 5.000 linhas o arquivo baixa na hora; acima, é gerado em segundo plano (ícone Tarefas). O
            custo e o markup só saem para quem vê o custo. Clientes: só a categoria Cliente (o &quot;Somente
            ativos&quot; também vale).
          </Text>
        </Stack>
      </Paper>
      {tarefas.map((t) => (
        <ExportacaoEmAndamento
          key={t.tarefaId}
          exportacao={t}
          aoFechar={() => setTarefas((lista) => lista.filter((x) => x.tarefaId !== t.tarefaId))}
        />
      ))}
    </Stack>
  );
}
