import { SignJWT, errors, jwtVerify, type JWTPayload } from 'jose';

export type Audiencia = 'erp' | 'plataforma';

export class AssinadorJwt {
  private readonly chave: Uint8Array;

  constructor(
    segredo: string,
    private readonly audiencia: Audiencia,
    private readonly minutos: number,
  ) {
    this.chave = new TextEncoder().encode(segredo);
  }

  async assinar(claims: JWTPayload & { sub: string }): Promise<{ token: string; expiraEm: Date }> {
    const expiraEm = new Date(Date.now() + this.minutos * 60_000);
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('genesis-api')
      .setAudience(this.audiencia)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiraEm.getTime() / 1000))
      .sign(this.chave);
    return { token, expiraEm };
  }

  /** Devolve as claims ou `null` (token inválido, expirado ou de outra audiência). */
  async verificar<T extends JWTPayload>(token: string): Promise<T | null> {
    try {
      const { payload } = await jwtVerify(token, this.chave, {
        issuer: 'genesis-api',
        audience: this.audiencia,
        algorithms: ['HS256'],
      });
      return payload as T;
    } catch (e) {
      if (e instanceof errors.JOSEError) return null;
      throw e;
    }
  }
}
