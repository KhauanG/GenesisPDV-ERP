import { useEffect, useRef } from 'react';
import { Navigate } from 'react-router';
import { Carregando } from '../auth/RotaProtegida';
import { useSessao } from '../auth/sessao';

/** `/sair` (ERP 4.4): encerra a sessão na API e volta ao login com o código da empresa preenchido. */
export function Sair() {
  const { estado, sair } = useSessao();
  const iniciado = useRef(false);
  useEffect(() => {
    if (iniciado.current || estado.status !== 'autenticado') return;
    iniciado.current = true;
    void sair();
  }, [estado.status, sair]);
  if (estado.status === 'anonimo') return <Navigate to="/login" replace />;
  return <Carregando />;
}
