import { ActionIcon, AppShell, Badge, Button, Group, Menu, Text } from '@mantine/core';
import { IconLogout, IconMenu2 } from '@tabler/icons-react';
import { Link, Navigate, NavLink, Outlet } from 'react-router';
import { Carregando } from '../auth/RotaProtegida';
import { ProvedorPermissoes } from '../auth/permissoes';
import { useSessaoPlataforma } from './sessao';

const ROTULO_PAPEL = {
  superadmin: 'Superadmin',
  suporte: 'Suporte',
  financeiro: 'Financeiro',
  somente_leitura: 'Somente leitura',
} as const;

const MENU = [
  { rota: '/plataforma/empresas', rotulo: 'Empresas' },
  { rota: '/plataforma/planos', rotulo: 'Planos' },
  { rota: '/plataforma/migracoes', rotulo: 'Migrações' },
] as const;

/** Casca do painel da plataforma: separado do ERP (token, cookie e menus próprios). */
export function LayoutPlataforma() {
  const { estado, sair } = useSessaoPlataforma();
  if (estado.status === 'carregando') return <Carregando />;
  if (estado.status === 'anonimo') return <Navigate to="/plataforma/login" replace />;
  return (
    <ProvedorPermissoes value={() => true}>
      <AppShell header={{ height: 56 }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Group gap="sm">
              <Menu position="bottom-start">
                <Menu.Target>
                  <ActionIcon variant="subtle" hiddenFrom="xs" aria-label="Menu da plataforma">
                    <IconMenu2 size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {MENU.map((m) => (
                    <Menu.Item key={m.rota} component={Link} to={m.rota}>
                      {m.rotulo}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
              <Text
                fw={700}
                c="genesis"
                size="lg"
                component={Link}
                to="/plataforma/empresas"
                style={{ textDecoration: 'none' }}
              >
                GenesisPDV
              </Text>
              <Badge variant="filled" color="dark" visibleFrom="sm">
                Plataforma
              </Badge>
              <Group component="nav" aria-label="Menu da plataforma" gap={4} ml="md" visibleFrom="xs">
                {MENU.map((m) => (
                  <Button
                    key={m.rota}
                    component={NavLink}
                    to={m.rota}
                    variant="subtle"
                    size="xs"
                    className="menu-plataforma"
                  >
                    {m.rotulo}
                  </Button>
                ))}
              </Group>
            </Group>
            <Group gap="sm">
              <Text size="sm" visibleFrom="sm">
                {estado.admin.nome}
              </Text>
              <Badge variant="light">{ROTULO_PAPEL[estado.admin.papel]}</Badge>
              <Button
                variant="subtle"
                size="xs"
                leftSection={<IconLogout size={14} />}
                onClick={() => void sair()}
              >
                Sair
              </Button>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Main>
          <Outlet />
        </AppShell.Main>
      </AppShell>
    </ProvedorPermissoes>
  );
}
