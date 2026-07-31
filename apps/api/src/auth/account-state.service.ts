/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ¿Sigue siendo válida esta credencial AHORA?
 *
 * El JWT dice quién eres y se verifica con una firma, pero no sabe nada de lo
 * que ha pasado desde que se emitió. Sin esta comprobación, suspender a
 * alguien, borrarle la cuenta o cerrarle la sesión no surtía efecto hasta que
 * su access token caducaba solo.
 *
 * Mismo TTL (30 s) y mismo criterio que `RestrictionService`: corre en cada
 * petición autenticada, así que sin caché sería una query por request en el
 * camino más caliente de la API.
 */
const CACHE_TTL_MS = 30_000;

/** Motivos de corte. El front usa el `code` para dar un mensaje decente. */
export type AccountRejection =
  | { code: 'account_suspended'; message: string }
  | { code: 'account_deleted'; message: string }
  | { code: 'session_revoked'; message: string };

interface UserEntry {
  ok: boolean;
  rejection: AccountRejection | null;
  expiresAt: number;
}

interface SessionEntry {
  ok: boolean;
  expiresAt: number;
}

@Injectable()
export class AccountStateService {
  private readonly users = new Map<string, UserEntry>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve el motivo de rechazo, o null si la credencial sigue siendo buena.
   *
   * `sid` es opcional: los tokens emitidos antes de que existiera el registro
   * de sesiones no lo llevan. Para ellos se valida el estado de la cuenta pero
   * no la sesión concreta — así el despliegue no echa a todo el mundo de golpe.
   */
  async check(userId: string, sid?: string): Promise<AccountRejection | null> {
    const userRejection = await this.checkUser(userId);
    if (userRejection) return userRejection;

    if (sid && !(await this.checkSession(sid, userId))) {
      return {
        code: 'session_revoked',
        message: 'Esta sesión se ha cerrado. Vuelve a iniciar sesión.',
      };
    }
    return null;
  }

  private async checkUser(userId: string): Promise<AccountRejection | null> {
    const now = Date.now();
    const cached = this.users.get(userId);
    if (cached && cached.expiresAt > now) return cached.rejection;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, deletedAt: true },
    });

    let rejection: AccountRejection | null = null;
    if (!user || user.deletedAt) {
      rejection = { code: 'account_deleted', message: 'Esta cuenta ya no existe.' };
    } else if (user.status !== 'ACTIVE') {
      rejection = {
        code: 'account_suspended',
        message: 'Tu cuenta está suspendida. Contacta con el administrador.',
      };
    }

    this.users.set(userId, {
      ok: rejection === null,
      rejection,
      expiresAt: now + CACHE_TTL_MS,
    });
    return rejection;
  }

  private async checkSession(sid: string, userId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.sessions.get(sid);
    if (cached && cached.expiresAt > now) return cached.ok;

    const session = await this.prisma.session.findFirst({
      where: { id: sid, userId, revokedAt: null, expiresAt: { gt: new Date(now) } },
      select: { id: true },
    });

    const ok = session !== null;
    this.sessions.set(sid, { ok, expiresAt: now + CACHE_TTL_MS });
    return ok;
  }

  /**
   * Invalida la caché. Lo llaman los sitios que cambian el estado (suspender,
   * reactivar, cerrar sesión) para que el corte sea inmediato en esta
   * instancia en vez de tardar hasta 30 s.
   */
  invalidateUser(userId: string): void {
    this.users.delete(userId);
  }

  invalidateSession(sid: string): void {
    this.sessions.delete(sid);
  }

  /** Tras un «cerrar todas mis sesiones» no merece la pena ir una por una. */
  invalidateAllSessions(): void {
    this.sessions.clear();
  }
}
