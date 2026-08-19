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

/**
 * Tope de entradas por caché. No es una política de memoria fina: es el techo
 * que impedía que estos dos mapas crecieran de forma monótona durante toda la
 * vida del proceso — una entrada por usuario y por sesión vistos, sin borrar
 * nunca las caducadas. En un aula con decenas de miles de alumnos, un proceso
 * de larga vida acababa reteniendo todas.
 *
 * 20.000 entradas son de sobra para el pico de concurrencia de cualquier aula
 * y siguen siendo unos pocos MB.
 */
const MAX_ENTRIES = 20_000;

@Injectable()
export class AccountStateService {
  private readonly users = new Map<string, UserEntry>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Guarda una entrada aplicando el techo. Primero barre lo caducado (que es
   * lo que en la práctica libera casi todo, con un TTL de 30 s) y, si aun así
   * se llega al tope, tira la entrada más vieja: `Map` conserva el orden de
   * inserción, así que la primera clave es la que lleva más tiempo dentro.
   */
  private guardar<T extends { expiresAt: number }>(
    cache: Map<string, T>,
    key: string,
    entry: T,
  ): void {
    if (cache.size >= MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (v.expiresAt <= now) cache.delete(k);
      }
      while (cache.size >= MAX_ENTRIES) {
        const primera = cache.keys().next();
        if (primera.done) break;
        cache.delete(primera.value);
      }
    }
    cache.set(key, entry);
  }

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

    this.guardar(this.users, userId, {
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
    this.guardar(this.sessions, sid, { ok, expiresAt: now + CACHE_TTL_MS });
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
