/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
   * Abre la sesión de un acceso de soporte (U8) y devuelve su access token.
   *
   * Se registra en `session` como cualquier otra —y por eso se puede cortar en
   * el acto revocando la concesión— pero con dos diferencias deliberadas:
   * caduca cuando caduca la ventana (no a los 30 días del refresh) y no hay
   * refresh token que guardar, así que lo que se hashea es el propio access
   * token, que también es único.
   */
  async issueSupportAccess(
    claims: Omit<SessionClaims, 'sid'> & { sup: string },
    ttlSeconds: number,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<{ accessToken: string; expiresIn: number; sid: string; expiresAt: Date }> {
    const sid = randomUUID();
    const { accessToken, expiresIn } = await this.tokens.signSupportAccess(
      { ...claims, sid },
      ttlSeconds,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.prisma.session.create({
      data: {
        id: sid,
        tenantId: claims.tenantId,
        userId: claims.sub,
        tokenHash: hashToken(accessToken),
        expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    return { accessToken, expiresIn, sid, expiresAt };
  }

  /**
   * Rota los tokens de una sesión existente conservando su `sid`.
   *
   * Se usa en el refresh: si cada renovación creara una sesión nueva, la lista
   * de «sesiones activas» del usuario se llenaría de duplicados fantasma —
   * una fila por hora y dispositivo.
   *
   * ── Por qué esto es lo que hace que «cerrar sesión» cierre la sesión ──────
   * El `tokenHash` se escribía en cada emisión pero no se leía en NINGÚN
   * `where`, y una sesión inexistente o revocada se trataba como «token
   * legacy» y abría una nueva. El resultado: pulsar «cerrar sesión» (borra la
   * fila) o cambiar la contraseña (borra todas) no impedía que un
   * `POST /auth/refresh` con el refresh token —válido 30 días— acuñara tokens
   * frescos. La sesión revocada resucitaba.
   *
   * Ahora la fila manda:
   *  - `sid` con fila borrada o revocada → 401. Es el caso de logout, cambio
   *    de contraseña, suspensión y revocación de soporte.
   *  - `sid` con fila viva pero cuyo `tokenHash` no es el del token
   *    presentado → 401. Un refresh token ya rotado (o robado y adelantado
   *    por el legítimo) deja de servir.
   *  - Sin `sid`: token emitido antes de que existiera el registro de
   *    sesiones. Se sigue admitiendo para no echar a quien tenía sesión
   *    abierta durante el despliegue; esos tokens caducan solos a los 30 días
   *    y desde entonces todo lleva `sid`. Es el único hueco que queda y se
   *    cierra por caducidad.
   */
  async rotate(
    sid: string | undefined,
    claims: Omit<SessionClaims, 'sid'>,
    /** El refresh token presentado, para cotejarlo con el `tokenHash` guardado. */
    presentedRefreshToken: string | null,
    ctx: ClientContext = { ip: null, userAgent: null },
  ): Promise<SignedTokens> {
    if (!sid) return this.issue(claims, ctx);

    const existing = await this.prisma.session.findFirst({
      where: { id: sid, userId: claims.sub, revokedAt: null },
    });
    if (!existing) throw new SessionRevokedError();

    if (presentedRefreshToken !== null && existing.tokenHash !== hashToken(presentedRefreshToken)) {
      throw new SessionRevokedError();
    }

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
 * La sesión que respalda el refresh token ya no vale: se cerró, se revocó, o
 * el token presentado no es el último emitido para ella.
 */
export class SessionRevokedError extends Error {
  constructor() {
    super('La sesión ya no está activa');
    this.name = 'SessionRevokedError';
  }
}

/**
 * SHA-256 del refresh token. Nunca se guarda el token en claro: la fila solo
 * sirve para reconocerlo y para poder revocarlo.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
