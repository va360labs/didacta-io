import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ClientContext } from './client-context';
import { PrismaService } from '../prisma/prisma.service';
import { loadAuthConfig } from './auth.config';
import { TokenService, type SessionClaims, type SignedTokens } from './token.service';

/**
 * Registro de sesiones. Emite los tokens y deja constancia en `session`.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * La tabla `session` llevaba desde siempre sin que NADIE escribiera en ella:
 * solo se leía y se borraba. Consecuencias que esto arregla:
 *
 *  - Suspender a un usuario borraba sus sesiones… que no existían. El endpoint
 *    prometía «invalida sus sessions activas» y en la práctica no echaba a
 *    nadie: el suspendido seguía operando hasta que su access token caducaba.
 *  - «Sesiones activas» en /cuenta salía siempre vacío y «cerrar sesión» no
 *    hacía nada.
 *
 * Emitir el token y registrar la sesión pasan a ser la MISMA operación, para
 * que no vuelvan a separarse: todos los flujos que autentican (password, MFA,
 * SSO OIDC/SAML/WP, signup, setup y el refresh) llaman aquí.
 */
@Injectable()
export class SessionRegistryService {
  private readonly config = loadAuthConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Firma los tokens y registra la sesión que los respalda.
   *
   * El `sid` se genera ANTES de firmar porque viaja dentro del propio token:
   * es lo que después permite revocarlo.
   */
  async issue(
    claims: Omit<SessionClaims, 'sid'>,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<SignedTokens> {
    const sid = randomUUID();
    const signed = await this.tokens.sign({ ...claims, sid });

    await this.prisma.session.create({
      data: {
        id: sid,
        tenantId: claims.tenantId,
        userId: claims.sub,
        tokenHash: hashToken(signed.refreshToken),
        expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1000),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    return signed;
  }

  /**
   * Rota los tokens de una sesión existente conservando su `sid`.
   *
   * Se usa en el refresh: si cada renovación creara una sesión nueva, la lista
   * de «sesiones activas» del usuario se llenaría de duplicados fantasma —
   * una fila por hora y dispositivo.
   *
   * Si el refresh viene sin `sid` (token emitido antes de este cambio) o su
   * fila ya no existe, se abre una sesión nueva: así los usuarios con sesión
   * abierta durante el despliegue quedan registrados sin tener que volver a
   * entrar.
   */
  async rotate(
    sid: string | undefined,
    claims: Omit<SessionClaims, 'sid'>,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<SignedTokens> {
    if (!sid) return this.issue(claims, ctx);

    const existing = await this.prisma.session.findFirst({
      where: { id: sid, userId: claims.sub, revokedAt: null },
    });
    if (!existing) return this.issue(claims, ctx);

    const signed = await this.tokens.sign({ ...claims, sid });
    await this.prisma.session.update({
      where: { id: sid },
      data: {
        tokenHash: hashToken(signed.refreshToken),
        expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1000),
      },
    });
    return signed;
  }
}

/**
 * SHA-256 del refresh token. Nunca se guarda el token en claro: la fila solo
 * sirve para reconocerlo y para poder revocarlo.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
