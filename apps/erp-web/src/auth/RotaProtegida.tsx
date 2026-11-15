import { Center, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import { usePode, type Pode } from './permissoes';
import { useSessao } from './sessao';
import { idValido } from '../api/caminho';
import { NaoEncontrado, SemPermissao } from '../paginas/Erros';

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
    const semVoltar =
      (local.pathname === '/' && !local.search) ||
      estado.motivo === 'saiu' ||
      estado.motivo === 'saida_pendente';
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

/**
 * Página de um registro (`:id` na rota): o parâmetro só chega à tela quando é um id de registro (UUID) — ou o formato
 * de `valido` —, senão é "não encontrado" sem nenhuma chamada à API (README do ERP › decisão 85).
 */
export function ExigeIdValido({
  parametro = 'id',
  valido = idValido,
  inicio,
  children,
}: {
  parametro?: string;
  valido?: (valor: string) => boolean;
  /** Para onde o "Voltar ao início" da tela "não encontrado" leva (a listagem do cadastro). */
  inicio?: string;
  children: ReactNode;
}) {
  const valor = useParams()[parametro];
  return valor === undefined || valido(valor) ? <>{children}</> : <NaoEncontrado inicio={inicio} />;
}
