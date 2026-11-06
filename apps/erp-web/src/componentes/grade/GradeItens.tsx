import {
  ActionIcon,
  Button,
  Group,
  NativeSelect,
  Paper,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { formatarDecimal, lerDecimal } from './decimal';

export type TipoColunaGrade = 'texto' | 'numero' | 'dinheiro' | 'selecao' | 'leitura';

/** Props que um editor personalizado precisa repassar ao campo para a navegação da grade funcionar. */
export interface PropsCampoGrade {
  ref: (el: HTMLElement | null) => void;
  onKeyDown: (ev: KeyboardEvent<HTMLElement>) => void;
  onPaste: (ev: ClipboardEvent<HTMLElement>) => void;
  'aria-label': string;
  'aria-invalid': boolean;
  disabled: boolean;
}

export interface ColunaGrade<L> {
  campo: keyof L & string;
  rotulo: string;
  /** `numero`/`dinheiro` guardam o texto digitado (vírgula decimal); `leitura` só exibe (ex.: total da linha). */
  tipo: TipoColunaGrade;
  largura?: number | string;
  opcoes?: Array<{ value: string; label: string }>;
  /** Exibição de `leitura` (padrão: o valor do campo). */
  formato?: (linha: L) => ReactNode;
  /** Campo personalizado (ex.: busca de produto na Fase 1). Deve repassar `campo` ao elemento focável. */
  editor?: (p: {
    linha: L;
    valor: unknown;
    aoMudar: (v: unknown) => void;
    campo: PropsCampoGrade;
  }) => ReactNode;
}

export interface RodapeGrade<L> {
  /** Campo somado em "Quantidade" (soma das quantidades). */
  quantidade?: keyof L & string;
  /** Valor de cada linha somado em "Total". */
  total?: (linha: L) => number;
}

export interface PropsGradeItens<L> {
  rotulo: string;
  linhas: L[];
  aoMudar: (linhas: L[]) => void;
  colunas: ColunaGrade<L>[];
  novaLinha: () => L;
  chave: (linha: L) => string;
  /** Erro por campo (ou da linha inteira, em `_linha`); objeto vazio = linha válida. */
  validar?: (linha: L) => Partial<Record<(keyof L & string) | '_linha', string>>;
  /** Linha sem dados: removida sem confirmação e fora da contagem do rodapé. */
  vazia?: (linha: L) => boolean;
  rodape?: RodapeGrade<L>;
  /**
   * "Colar do Excel" (ERP 3.3): cada linha colada (células separadas por tab) vira uma linha da grade, preenchendo
   * estes campos na ordem (ex.: código/EAN, quantidade, preço).
   */
  colarEm?: Array<keyof L & string>;
  /** Mostra os erros de todas as linhas (depois de tentar gravar); sem ele, só das linhas já editadas. */
  mostrarErros?: boolean;
  somenteLeitura?: boolean;
  /**
   * Linhas fixas: os campos editam, mas não se insere nem se remove linha (sem F9, "Inserir item", lixeira nem Delete;
   * o Enter da última coluna da última linha para ali). Ex.: a conferência do recebimento da transferência (F2-B27).
   */
  linhasFixas?: boolean;
  rotuloInserir?: string;
}

/** Erros de todas as linhas não vazias: o formulário bloqueia o Gravar enquanto houver algum (ERP 3.3). */
export function errosDaGrade<L>(
  linhas: L[],
  validar: NonNullable<PropsGradeItens<L>['validar']>,
  vazia?: (linha: L) => boolean,
): Array<{ indice: number; erros: Record<string, string> }> {
  return linhas
    .map((l, indice) => ({ indice, erros: vazia?.(l) ? {} : (validar(l) as Record<string, string>) }))
    .filter((e) => Object.keys(e.erros).length > 0);
}

const editavel = (c: ColunaGrade<unknown>) => c.tipo !== 'leitura';

/**
 * Grade de itens editável (ERP 3.3), base de Acerto, Recebimento, Transferência, Orçamento, Venda e Cadastro em
 * massa: F9 ou "Inserir item" cria a linha e foca a 1ª coluna; Enter avança (na última coluna, vai para a próxima
 * linha, criando-a se preciso); ↑/↓ mudam de linha na mesma coluna; Delete na alça da linha (ou Ctrl+Delete em
 * qualquer campo) remove, confirmando se houver dados; colar várias linhas do Excel preenche a grade.
 */
export function GradeItens<L extends object>({
  rotulo,
  linhas,
  aoMudar,
  colunas,
  novaLinha,
  chave,
  validar,
  vazia,
  rodape,
  colarEm,
  mostrarErros = false,
  somenteLeitura = false,
  linhasFixas = false,
  rotuloInserir = 'Inserir item',
}: PropsGradeItens<L>) {
  /** Sem inserir nem remover linhas (somente leitura ou linhas fixas). */
  const semMudarLinhas = somenteLeitura || linhasFixas;
  const campos = useRef(new Map<string, HTMLElement>());
  // Campo a focar quando a lista nova for renderizada (linha inserida/removida).
  const focoPendente = useRef<{ linha: string; coluna: number } | null>(null);
  const [tocadas, setTocadas] = useState<ReadonlySet<string>>(new Set());
  const editaveis = colunas.map((c, i) => ({ c, i })).filter(({ c }) => editavel(c as ColunaGrade<unknown>));
  const primeira = editaveis[0]?.i ?? 0;

  useEffect(() => {
    const f = focoPendente.current;
    if (!f) return;
    focoPendente.current = null;
    campos.current.get(`${f.linha}:${f.coluna}`)?.focus();
  }, [linhas]);

  function inserir(depoisDe?: number) {
    const nova = novaLinha();
    const lista = [...linhas];
    lista.splice(depoisDe === undefined ? lista.length : depoisDe + 1, 0, nova);
    focoPendente.current = { linha: chave(nova), coluna: primeira };
    aoMudar(lista);
  }

  const aoF9 = useEffectEvent((ev: globalThis.KeyboardEvent) => {
    if (ev.key !== 'F9' || ev.defaultPrevented) return;
    // Com um modal aberto (ex.: confirmação de exclusão), o F9 não é da grade.
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    ev.preventDefault();
    inserir();
  });

  useEffect(() => {
    if (semMudarLinhas) return;
    window.addEventListener('keydown', aoF9);
    return () => window.removeEventListener('keydown', aoF9);
  }, [semMudarLinhas]);

  function alterar(indice: number, campo: string, valor: unknown) {
    const lista = [...linhas];
    lista[indice] = { ...lista[indice]!, [campo]: valor };
    aoMudar(lista);
    const k = chave(lista[indice]!);
    if (!tocadas.has(k)) setTocadas(new Set(tocadas).add(k));
  }

  function remover(indice: number) {
    const linha = linhas[indice]!;
    const executar = () => {
      const lista = linhas.filter((_, i) => i !== indice);
      const vizinha = lista[Math.min(indice, lista.length - 1)];
      if (vizinha) focoPendente.current = { linha: chave(vizinha), coluna: primeira };
      aoMudar(lista);
    };
    if (vazia?.(linha)) return executar();
    modals.openConfirmModal({
      title: 'Remover item',
      children: <Text size="sm">Remover o item da linha {indice + 1}?</Text>,
      labels: { confirm: 'Remover', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: executar,
    });
  }

  function focar(indice: number, coluna: number) {
    const l = linhas[indice];
    if (l) campos.current.get(`${chave(l)}:${coluna}`)?.focus();
  }

  function aoTeclarCampo(indice: number, coluna: number, ev: KeyboardEvent<HTMLElement>) {
    const lista = (ev.target as HTMLElement).getAttribute('aria-expanded') === 'true';
    if (ev.key === 'Enter' && !lista) {
      ev.preventDefault();
      const proxima = editaveis.find(({ i }) => i > coluna);
      if (proxima) focar(indice, proxima.i);
      else if (indice < linhas.length - 1) focar(indice + 1, primeira);
      else if (!linhasFixas) inserir();
    } else if (ev.key === 'ArrowDown' && !lista && indice < linhas.length - 1) {
      ev.preventDefault();
      focar(indice + 1, coluna);
    } else if (ev.key === 'ArrowUp' && !lista && indice > 0) {
      ev.preventDefault();
      focar(indice - 1, coluna);
    } else if (ev.key === 'Delete' && (ev.ctrlKey || ev.metaKey) && !linhasFixas) {
      ev.preventDefault();
      remover(indice);
    }
  }

  function aoColar(indice: number, ev: ClipboardEvent<HTMLElement>) {
    if (!colarEm?.length || linhasFixas) return;
    const texto = ev.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(texto.trim())) return; // um valor só: colagem normal no campo
    ev.preventDefault();
    const novas = texto
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const celulas = l.split('\t');
        const linha = novaLinha() as Record<string, unknown>;
        colarEm.forEach((campo, i) => {
          if (celulas[i] !== undefined) linha[campo] = celulas[i]!.trim();
        });
        return linha as L;
      });
    const lista = [...linhas];
    // A linha de onde se colou, se vazia, dá lugar às coladas.
    const substituir = vazia?.(lista[indice]!) ? 1 : 0;
    lista.splice(indice + 1 - substituir, substituir, ...novas);
    aoMudar(lista);
    setTocadas(new Set([...tocadas, ...novas.map(chave)]));
  }

  const preenchidas = vazia ? linhas.filter((l) => !vazia(l)) : linhas;
  const somaQuantidade = rodape?.quantidade
    ? preenchidas.reduce((s, l) => s + (lerDecimal(String(l[rodape.quantidade!] ?? '')) ?? 0), 0)
    : null;
  const somaTotal = rodape?.total ? preenchidas.reduce((s, l) => s + rodape.total!(l), 0) : null;

  return (
    <Paper p={0} withBorder style={{ overflow: 'hidden' }}>
      <Table.ScrollContainer minWidth={640}>
        <Table aria-label={rotulo} verticalSpacing={4} horizontalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col" w={44} ta="center">
                #
              </Table.Th>
              {colunas.map((c) => (
                <Table.Th
                  key={c.campo}
                  scope="col"
                  w={c.largura}
                  ta={c.tipo === 'numero' || c.tipo === 'dinheiro' ? 'right' : undefined}
                >
                  {c.rotulo}
                </Table.Th>
              ))}
              {!semMudarLinhas && <Table.Th w={44} aria-label="Ações" />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {linhas.map((l, indice) => {
              const k = chave(l);
              const erros: Partial<Record<string, string>> =
                validar && !vazia?.(l) && (mostrarErros || tocadas.has(k)) ? validar(l) : {};
              const comErro = Object.keys(erros).length > 0;
              return (
                <Table.Tr
                  key={k}
                  data-erro={comErro || undefined}
                  aria-invalid={comErro || undefined}
                  style={comErro ? { background: 'var(--mantine-color-red-light)' } : undefined}
                  title={erros._linha}
                >
                  <Table.Td ta="center">
                    <Tooltip label={erros._linha} disabled={!erros._linha}>
                      <Text
                        component="button"
                        type="button"
                        size="xs"
                        c={comErro ? 'red' : 'dimmed'}
                        aria-label={`Linha ${indice + 1}`}
                        className="grade-alca"
                        onKeyDown={(ev: KeyboardEvent<HTMLButtonElement>) => {
                          if (!semMudarLinhas && ev.key === 'Delete') {
                            ev.preventDefault();
                            remover(indice);
                          }
                        }}
                        style={{ background: 'none', border: 0, cursor: 'default', width: '100%' }}
                      >
                        {indice + 1}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  {colunas.map((c, coluna) => (
                    <Table.Td key={c.campo}>
                      <Celula
                        coluna={c}
                        linha={l}
                        erro={erros[c.campo]}
                        somenteLeitura={somenteLeitura}
                        campo={{
                          ref: (el) => {
                            const id = `${k}:${coluna}`;
                            if (el) campos.current.set(id, el);
                            else campos.current.delete(id);
                          },
                          onKeyDown: (ev) => aoTeclarCampo(indice, coluna, ev),
                          onPaste: (ev) => aoColar(indice, ev),
                          'aria-label': `${c.rotulo} da linha ${indice + 1}`,
                          'aria-invalid': !!erros[c.campo],
                          disabled: somenteLeitura,
                        }}
                        aoMudar={(v) => alterar(indice, c.campo, v)}
                      />
                    </Table.Td>
                  ))}
                  {!semMudarLinhas && (
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Remover linha ${indice + 1}`}
                        tabIndex={-1}
                        onClick={() => remover(indice)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Table.Td>
                  )}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {linhas.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" py="md">
          {semMudarLinhas ? 'Nenhum item.' : `Nenhum item. Use “${rotuloInserir}” ou F9.`}
        </Text>
      )}
      <Group
        justify="space-between"
        px="md"
        py="xs"
        wrap="wrap"
        style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
      >
        {!semMudarLinhas ? (
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => inserir()}
            title="F9"
          >
            {rotuloInserir} (F9)
          </Button>
        ) : (
          <span />
        )}
        <Group gap="lg" aria-live="polite">
          <Text size="sm">
            Itens: <b>{preenchidas.length}</b>
          </Text>
          {somaQuantidade !== null && (
            <Text size="sm">
              Quantidade: <b>{formatarDecimal(somaQuantidade, 3)}</b>
            </Text>
          )}
          {somaTotal !== null && (
            <Text size="sm">
              Total: <b>R$ {formatarDecimal(somaTotal, 2)}</b>
            </Text>
          )}
        </Group>
      </Group>
    </Paper>
  );
}

function Celula<L>({
  coluna,
  linha,
  erro,
  campo,
  aoMudar,
  somenteLeitura,
}: {
  coluna: ColunaGrade<L>;
  linha: L;
  erro?: string;
  campo: PropsCampoGrade;
  aoMudar: (v: unknown) => void;
  somenteLeitura: boolean;
}) {
  const valor = (linha as Record<string, unknown>)[coluna.campo];
  if (coluna.tipo === 'leitura') {
    return (
      <Text size="sm" ta="right">
        {coluna.formato ? coluna.formato(linha) : String(valor ?? '')}
      </Text>
    );
  }
  if (coluna.editor) return coluna.editor({ linha, valor, aoMudar, campo });
  const { ref, ...resto } = campo;
  if (coluna.tipo === 'selecao') {
    return (
      <NativeSelect
        ref={ref as (el: HTMLSelectElement | null) => void}
        {...resto}
        size="xs"
        value={String(valor ?? '')}
        onChange={(ev) => aoMudar(ev.currentTarget.value)}
        data={[{ value: '', label: '' }, ...(coluna.opcoes ?? [])]}
        error={erro ? true : undefined}
        title={erro}
      />
    );
  }
  const numerico = coluna.tipo === 'numero' || coluna.tipo === 'dinheiro';
  return (
    <TextInput
      ref={ref as (el: HTMLInputElement | null) => void}
      {...resto}
      size="xs"
      value={String(valor ?? '')}
      readOnly={somenteLeitura}
      onChange={(ev) => aoMudar(ev.currentTarget.value)}
      inputMode={numerico ? 'decimal' : undefined}
      styles={numerico ? { input: { textAlign: 'right' } } : undefined}
      leftSection={coluna.tipo === 'dinheiro' ? <Text size="xs">R$</Text> : undefined}
      error={erro ? true : undefined}
      title={erro}
    />
  );
}
