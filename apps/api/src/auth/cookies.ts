import type { Response } from 'express';

export const COOKIE_REFRESH = 'genesis_refresh';
export const COOKIE_REFRESH_PLATAFORMA = 'genesis_refresh_plataforma';

/** Refresh token só em cookie `httpOnly` + `SameSite=Strict`, restrito ao caminho das rotas de sessão (ERP 4.1). */
export function gravarCookie(
  res: Response,
  nome: string,
  valor: string,
  expira: Date,
  caminho: string,
  seguro: boolean,
): void {
  res.cookie(nome, valor, {
    httpOnly: true,
    secure: seguro,
    sameSite: 'strict',
    path: caminho,
    expires: expira,
  });
}

export function limparCookie(res: Response, nome: string, caminho: string, seguro: boolean): void {
  res.clearCookie(nome, { httpOnly: true, secure: seguro, sameSite: 'strict', path: caminho });
}
