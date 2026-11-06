import { PERMISSOES, type DefinicaoPermissao } from '@genesis/shared';
import {
  ActionIcon,
  Badge,
  Checkbox,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconSearch, IconX } from '@tabler/icons-react';
import { useState } from 'react';

export const ACOES_MENU = ['ver', 'criar', 'editar', 'excluir', 'exportar'] as const;
const ROTULO_ACAO: Record<(typeof ACOES_MENU)[number], string> = {
  ver: 'Ver',
  criar: 'Criar',
  editar: 'Editar',
  excluir: 'Excluir',
  exportar: 'Exportar',
};

interface LinhaMenu {
  recurso: string;
  nome: string;
  grupo: string;
  acoes: Partial<Record<(typeof ACOES_MENU)[number], DefinicaoPermissao>>;
}

/**
 * Divide o catálogo (ERP 11.2/11.4): "Menus do sistema" = ações padrão de recurso do ERP (ver/criar/editar/excluir/
 * exportar); "Permissões Gerais" = as demais ações do ERP e todas as do PDV, por grupo.
 */
export function dividirCatalogo(): { menus: LinhaMenu[]; gerais: Map<string, DefinicaoPermissao[]> } {
  const menus = new Map<string, LinhaMenu>();
  const gerais = new Map<string, DefinicaoPermissao[]>();
  for (const p of PERMISSOES) {
    const i = p.chave.lastIndexOf('.');
    const recurso = p.chave.slice(0, i);
    const acao = p.chave.slice(i + 1) as (typeof ACOES_MENU)[number];
    if (p.modulo === 'erp' && (ACOES_MENU as readonly string[]).includes(acao)) {
      const linha = menus.get(recurso) ?? {
        recurso,
        nome: p.descricao.split(':')[0]!.trim(),
        grupo: p.grupo,
        acoes: {},
      };
      linha.acoes[acao] = p;
      menus.set(recurso, linha);
    } else {
      gerais.set(p.grupo, [...(gerais.get(p.grupo) ?? []), p]);
    }
  }
  return { menus: [...menus.values()], gerais };
}

const CATALOGO = dividirCatalogo();

export type Ajuste = 'conceder' | 'negar';

type Props =
  | {
      modo: 'perfil';
      /** Permissões marcadas. */
      valor: ReadonlySet<string>;
      aoMudar: (v: Set<string>) => void;
      somenteLeitura?: boolean;
      /** Seção exibida (`menus` ou `gerais`). */
      secao: 'menus' | 'gerais';
    }
  | {
      modo: 'usuario';
      /** Permissões herdadas do perfil. */
      doPerfil: ReadonlySet<string>;
      ajustes: ReadonlyMap<string, Ajuste>;
      aoMudar: (v: Map<string, Ajuste>) => void;
      somenteLeitura?: boolean;
      secao: 'menus' | 'gerais';
    };

/**
 * Editor das abas "Menus do sistema" e "Permissões Gerais" (ERP 11.2, 11.3). No perfil, dois estados (marcado ou
 * não; desmarcar "Ver" desmarca as demais ações do item). No usuário, três: herdado do perfil (✓ cinza), concedido
 * individualmente (✓ azul) e negado individualmente (✗ vermelho); o clique alterna herdado → ajuste → herdado.
 */
export function EditorPermissoes(p: Props) {
  const { menus, gerais } = CATALOGO;
  const [busca, setBusca] = useState('');
  const termo = busca.trim().toLowerCase();
  const casa = (texto: string) => !termo || texto.toLowerCase().includes(termo);

  const efetiva = (chave: string) =>
    p.modo === 'perfil'
      ? p.valor.has(chave)
      : p.ajustes.get(chave) === 'conceder' || (p.doPerfil.has(chave) && p.ajustes.get(chave) !== 'negar');

  function alternar(chave: string) {
    if (p.somenteLeitura) return;
    if (p.modo === 'perfil') {
      const novo = new Set(p.valor);
      if (novo.has(chave)) {
        novo.delete(chave);
        if (chave.endsWith('.ver')) {
          const recurso = chave.slice(0, -4);
          for (const a of ACOES_MENU) novo.delete(`${recurso}.${a}`);
        }
      } else novo.add(chave);
      p.aoMudar(novo);
    } else {
      const novo = new Map(p.ajustes);
      if (novo.has(chave)) novo.delete(chave);
      else novo.set(chave, p.doPerfil.has(chave) ? 'negar' : 'conceder');
      p.aoMudar(novo);
    }
  }

  const celula = (def: DefinicaoPermissao | undefined, rotulo: string) => {
    if (!def) return null;
    if (p.modo === 'perfil') {
      return (
        <Checkbox
          aria-label={`${rotulo} – ${def.chave}`}
          checked={p.valor.has(def.chave)}
          disabled={p.somenteLeitura}
          onChange={() => alternar(def.chave)}
        />
      );
    }
    const ajuste = p.ajustes.get(def.chave);
    const herdado = p.doPerfil.has(def.chave);
    const estado = ajuste ?? (herdado ? 'herdado' : 'sem');
    const dica = {
      herdado: 'Herdado do perfil (clique para negar)',
      sem: 'Sem a permissão (clique para conceder)',
      conceder: 'Concedido individualmente (clique para voltar ao perfil)',
      negar: 'Negado individualmente (clique para voltar ao perfil)',
    }[estado];
    return (
      <Tooltip label={dica} openDelay={400}>
        <ActionIcon
          aria-label={`${rotulo} – ${def.chave}: ${estado}`}
          data-estado={estado}
          variant={estado === 'sem' ? 'default' : estado === 'herdado' ? 'light' : 'filled'}
          color={estado === 'negar' ? 'red' : estado === 'conceder' ? 'blue' : 'gray'}
          disabled={p.somenteLeitura}
          onClick={() => alternar(def.chave)}
          size="sm"
        >
          {estado === 'negar' ? <IconX size={14} /> : estado === 'sem' ? null : <IconCheck size={14} />}
        </ActionIcon>
      </Tooltip>
    );
  };

  const legenda =
    p.modo === 'usuario' ? (
      <Group gap="md">
        <Badge variant="light" color="gray" leftSection={<IconCheck size={12} />}>
          Herdado do perfil
        </Badge>
        <Badge color="blue" leftSection={<IconCheck size={12} />}>
          Concedido
        </Badge>
        <Badge color="red" leftSection={<IconX size={12} />}>
          Negado
        </Badge>
      </Group>
    ) : null;

  if (p.secao === 'menus') {
    const grupos = [...new Set(menus.map((m) => m.grupo))];
    return (
      <Stack gap="sm">
        <Group justify="space-between">
          <TextInput
            leftSection={<IconSearch size={14} />}
            placeholder="Buscar item"
            value={busca}
            onChange={(e) => setBusca(e.currentTarget.value)}
          />
          {legenda}
        </Group>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item do menu</Table.Th>
              {ACOES_MENU.map((a) => (
                <Table.Th key={a} ta="center" w={80}>
                  {ROTULO_ACAO[a]}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {grupos.map((g) => {
              const linhas = menus.filter((m) => m.grupo === g && casa(`${m.nome} ${m.recurso}`));
              if (!linhas.length) return null;
              return [
                <Table.Tr key={`g-${g}`}>
                  <Table.Td colSpan={6}>
                    <Text fw={700} size="sm">
                      {g}
                    </Text>
                  </Table.Td>
                </Table.Tr>,
                ...linhas.map((m) => (
                  <Table.Tr key={m.recurso}>
                    <Table.Td pl="lg">{m.nome}</Table.Td>
                    {ACOES_MENU.map((a) => (
                      <Table.Td key={a}>
                        <Group justify="center">{celula(m.acoes[a], `${m.nome} ${ROTULO_ACAO[a]}`)}</Group>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                )),
              ];
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <TextInput
          leftSection={<IconSearch size={14} />}
          placeholder="Buscar permissão"
          value={busca}
          onChange={(e) => setBusca(e.currentTarget.value)}
        />
        {legenda}
      </Group>
      {[...gerais.entries()].map(([grupo, itens]) => {
        const visiveis = itens.filter((i) => casa(`${i.descricao} ${i.chave}`));
        if (!visiveis.length) return null;
        return (
          <Stack key={grupo} gap={6}>
            <Title order={5}>
              {grupo.startsWith('PDV') ? grupo : `ERP – ${grupo}`}{' '}
              <Text span size="xs" c="dimmed">
                ({visiveis.filter((i) => efetiva(i.chave)).length}/{visiveis.length})
              </Text>
            </Title>
            {visiveis.map((i) => (
              <Group key={i.chave} gap="sm" wrap="nowrap">
                {celula(i, i.descricao)}
                <Text size="sm">
                  {i.descricao}{' '}
                  <Text span size="xs" c="dimmed" ff="monospace">
                    {i.chave}
                  </Text>
                  {!i.permiteLiberacao && (
                    <Badge ml="xs" size="xs" variant="outline" color="orange">
                      sem liberação
                    </Badge>
                  )}
                </Text>
              </Group>
            ))}
          </Stack>
        );
      })}
    </Stack>
  );
}
