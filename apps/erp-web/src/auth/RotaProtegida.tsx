import { Center, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { usePode } from './permissoes';
import { useSessao } from './sessao';
import { SemPermissao } from '../paginas/Erros';

export function Carregando() {
  return (
    <Center h="100vh">
      <Loader aria-label="Carregando" />
    </Center>
  );
}

/** Área autenticada: sem sessão → `/login?voltar=<rota>`; senha provisória → troca obrigatória (ERP 4.1). */
export function RotaProtegida() {
  const { estado } = useSessao();
  const local = useLocation();
  if (estado.status === 'carregando') return <Carregando />;
  if (estado.status === 'anonimo') {
    const semVoltar = (local.pathname === '/' && !local.search) || estado.motivo === 'saiu';
    const voltar = semVoltar ? '' : `?voltar=${encodeURIComponent(local.pathname + local.search)}`;
    return <Navigate to={`/login${voltar}`} replace state={{ motivo: estado.motivo }} />;
  }
  if (estado.trocarSenha) {
    return <Navigate to="/trocar-senha" replace state={{ voltar: local.pathname + local.search }} />;
  }
  return <Outlet />;
}

/** Página que exige uma permissão de acesso (o menu já a esconde; isto cobre o link digitado). */
export function ExigePermissao({ permissao, children }: { permissao: string; children: ReactNode }) {
  const pode = usePode();
  return pode(permissao) ? <>{children}</> : <SemPermissao permissao={permissao} />;
}
