import { Center, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { usePode, type Pode } from './permissoes';
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

/**
 * Página que exige uma permissão de acesso (o menu já a esconde; isto cobre o link digitado). Com `acesso`, vale a
 * regra dele (o mesmo `acesso` do item do menu) e `permissao` é só a citada na tela "Sem permissão".
 */
export function ExigePermissao({
  permissao,
  acesso,
  children,
}: {
  permissao: string;
  acesso?: (pode: Pode) => boolean;
  children: ReactNode;
}) {
  const pode = usePode();
  return (acesso ? acesso(pode) : pode(permissao)) ? <>{children}</> : <SemPermissao permissao={permissao} />;
}
