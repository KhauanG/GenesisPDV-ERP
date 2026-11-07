import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Breadcrumbs,
  Burger,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBuildingStore,
  IconBuildingWarehouse,
  IconCash,
  IconChevronDown,
  IconHome,
  IconKey,
  IconLogout,
  IconMoon,
  IconPackage,
  IconReportAnalytics,
  IconSettings,
  IconShoppingCart,
  IconSun,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import { Link, NavLink as RouterNavLink, Outlet, useLocation } from 'react-router';
import { useEu, useSessao } from '../auth/sessao';
import { localizarRota, menuVisivel, type GrupoMenu } from '../menu';
import { SeletorLoja } from '../componentes/seletores/SeletorLoja';
import { IconeTarefas } from '../componentes/tarefas/IconeTarefas';
import { ProvedorLojaContexto, useLojaContexto } from './lojaContexto';

const ICONES: Record<GrupoMenu['icone'], typeof IconHome> = {
  inicio: IconHome,
  pessoas: IconUsers,
  produtos: IconPackage,
  cadastros: IconSettings,
  estoque: IconBuildingWarehouse,
  financeiro: IconCash,
  vendas: IconShoppingCart,
  relatorios: IconReportAnalytics,
};

const AMBIENTE = import.meta.env.VITE_AMBIENTE;

/**
 * Estrutura da página do ERP (ERP 5.1): cabeçalho (com o ícone Tarefas, ERP 3.6), menu lateral recolhível, trilha e
 * conteúdo.
 */
export function Layout() {
  const eu = useEu();
  return (
    <ProvedorLojaContexto
      chave={`genesis:loja-contexto:${eu.empresa.codigo}:${eu.usuario.id}`}
      permitidas={eu.lojas.map((l) => l.id)}
    >
      <Estrutura />
    </ProvedorLojaContexto>
  );
}

function Estrutura() {
  const eu = useEu();
  const { pode } = useSessao();
  const [movelAberto, movel] = useDisclosure(false);
  const [desktopAberto, desktop] = useDisclosure(true);
  const { pathname } = useLocation();
  const grupos = menuVisivel(pode);
  const atual = localizarRota(pathname);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !movelAberto, desktop: !desktopAberto } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={movelAberto}
              onClick={movel.toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label="Abrir menu"
            />
            <Burger
              opened={desktopAberto}
              onClick={desktop.toggle}
              visibleFrom="sm"
              size="sm"
              aria-label="Recolher menu"
            />
            <Text fw={700} c="genesis" size="lg" component={Link} to="/" style={{ textDecoration: 'none' }}>
              GenesisPDV
            </Text>
            <Text size="sm" c="dimmed" visibleFrom="md" truncate maw={280}>
              {eu.empresa.nome} ({eu.empresa.codigo})
            </Text>
            {AMBIENTE && AMBIENTE !== 'producao' && (
              <Badge color="orange" variant="light" visibleFrom="sm">
                {AMBIENTE}
              </Badge>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap">
            <LojaDeContexto />
            <IconeTarefas />
            <AlternarTema />
            <MenuUsuario />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar aria-label="Menu principal">
        <AppShell.Section grow component={ScrollArea} p="xs">
          {grupos.map((g) => {
            const Icone = ICONES[g.icone];
            if (g.itens.length === 1 && g.chave === 'inicio') {
              const item = g.itens[0]!;
              return (
                <NavLink
                  key={g.chave}
                  component={RouterNavLink}
                  to={item.rota}
                  end
                  label={g.rotulo.toUpperCase()}
                  leftSection={<Icone size={18} />}
                  onClick={movel.close}
                  fw={600}
                />
              );
            }
            return (
              <NavLink
                key={g.chave}
                label={g.rotulo.toUpperCase()}
                leftSection={<Icone size={18} />}
                defaultOpened={atual?.grupo.chave === g.chave}
                childrenOffset={28}
                fw={600}
              >
                {g.itens.map((i) => (
                  <NavLink
                    key={i.rota}
                    component={RouterNavLink}
                    to={i.rota}
                    end={i.rota === '/vendas'}
                    label={i.secao && g.chave === 'relatorios' ? `${i.secao}: ${i.rotulo}` : i.rotulo}
                    onClick={movel.close}
                    fw={400}
                  />
                ))}
              </NavLink>
            );
          })}
          <NavLink component={Link} to="/sair" label="SAIR" leftSection={<IconLogout size={18} />} fw={600} />
        </AppShell.Section>
        <AppShell.Section p="xs">
          <Text size="xs" c="dimmed" ta="center">
            v{__VERSAO_ERP__}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {atual && atual.item.rota !== '/' && (
          <Breadcrumbs className="nao-imprimir" mb="sm" separator="›" fz="sm">
            <Text size="sm" c="dimmed">
              {atual.grupo.rotulo}
            </Text>
            <Text size="sm" component={Link} to={atual.item.rota} c="dimmed">
              {atual.item.rotulo}
            </Text>
          </Breadcrumbs>
        )}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

function LojaDeContexto() {
  const eu = useEu();
  const { lojaId, definir } = useLojaContexto();
  return (
    <Tooltip label="Nenhuma loja cadastrada ainda" disabled={eu.lojas.length > 0}>
      <SeletorLoja
        aria-label="Loja de contexto"
        permitirTodas
        leftSection={<IconBuildingStore size={16} />}
        value={lojaId}
        onChange={definir}
        disabled={eu.lojas.length === 0}
        w={{ base: 150, sm: 230 }}
        size="xs"
      />
    </Tooltip>
  );
}

function AlternarTema() {
  const { setColorScheme } = useMantineColorScheme();
  const atual = useComputedColorScheme('light');
  const escuro = atual === 'dark';
  return (
    <Tooltip label={escuro ? 'Tema claro' : 'Tema escuro'}>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label={escuro ? 'Usar tema claro' : 'Usar tema escuro'}
        onClick={() => setColorScheme(escuro ? 'light' : 'dark')}
      >
        {escuro ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

function MenuUsuario() {
  const eu = useEu();
  const iniciais = eu.usuario.nome
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <Menu position="bottom-end" width={220} withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label="Menu do usuário">
          <Group gap={6} wrap="nowrap">
            <Avatar size={30} radius="xl" color="genesis">
              {iniciais}
            </Avatar>
            <Text size="sm" fw={500} visibleFrom="sm" truncate maw={140}>
              {eu.usuario.nome}
            </Text>
            <IconChevronDown size={14} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          {eu.usuario.login} · {eu.usuario.master ? 'Master' : 'Usuário'}
        </Menu.Label>
        <Menu.Item component={Link} to="/minha-conta" leftSection={<IconUserCircle size={16} />}>
          Minha conta
        </Menu.Item>
        <Menu.Item component={Link} to="/minha-conta/senha" leftSection={<IconKey size={16} />}>
          Trocar senha
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item component={Link} to="/sair" color="red" leftSection={<IconLogout size={16} />}>
          Sair
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
