import { MantineProvider } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'dayjs/locale/pt-br';
import { useState, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ErroRequisicao } from './api/http';
import { rotas } from './rotas';
import { tema } from './tema';

export function criarQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // 4xx não melhora repetindo (sem permissão, não encontrado, validação).
        retry: (falhas, erro) =>
          !(erro instanceof ErroRequisicao && erro.status >= 400 && erro.status < 500) && falhas < 2,
      },
    },
  });
}

export function Provedores({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <MantineProvider theme={tema} defaultColorScheme="auto">
      <DatesProvider settings={{ locale: 'pt-br', firstDayOfWeek: 0 }}>
        <ModalsProvider labels={{ confirm: 'Confirmar', cancel: 'Cancelar' }}>
          <Notifications position="top-right" />
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </ModalsProvider>
      </DatesProvider>
    </MantineProvider>
  );
}

export function App() {
  const [queryClient] = useState(criarQueryClient);
  const [router] = useState(() => createBrowserRouter(rotas));
  return (
    <Provedores queryClient={queryClient}>
      <RouterProvider router={router} />
    </Provedores>
  );
}
