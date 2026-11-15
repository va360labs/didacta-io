/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { StorageService } from '@didacta/core-kernel';
import type { AutorTicket, Caller, SoporteCapturaStorage } from '@didacta/mod-soporte';
import type { SessionClaims } from '../../auth/token.service';

/**
 * Ports de mod.soporte (ADR-039): el módulo no lee las tablas core (`user`,
 * `user_role`) ni conoce el storage del host; el host se los da aquí.
 */

/** Quién administra el aula: ve todos los tickets y recibe el aviso de uno nuevo. */
export const SOPORTE_ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin', 'tenant_admin']);

/** Quién llama, con su id y si administra el aula (por los roles de la sesión). */
export function callerDe(user: SessionClaims): Caller {
  return { id: user.sub, esAdmin: (user.roles ?? []).some((r) => SOPORTE_ADMIN_ROLES.has(r)) };
}

interface UserLookup {
  user: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    findFirst(args: {
      where: Record<string, unknown>;
      select: { name: true };
    }): Promise<{ name: string | null } | null>;
  };
}

/** Administradores del aula a los que avisar: cuentas activas, no borradas. */
export function prismaSoporteAdminIds(prisma: {
  user: Pick<UserLookup['user'], 'findMany'>;
}): (tenantId: string) => Promise<string[]> {
  return async (tenantId) => {
    const rows = await prisma.user.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: [...SOPORTE_ADMIN_ROLES] } } } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  };
}

/**
 * La copia del autor que se guarda con el ticket y ve el equipo. Nombre: el
 * `name` de la cuenta, nunca el email. Sin nombre, «Miembro» (el servicio).
 */
export async function resolverAutorTicket(
  prisma: { user: Pick<UserLookup['user'], 'findFirst'> },
  tenantId: string,
  userId: string,
): Promise<AutorTicket> {
  const u = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
    select: { name: true },
  });
  return { id: userId, nombre: u?.name?.trim() ?? '' };
}

/** Capturas con el storage de cada aula (su S3 propio si lo configuró, o el global). */
export function buildCapturaStorage(
  storageFor: (tenantId: string) => Promise<StorageService>,
): SoporteCapturaStorage {
  return {
    async putImage(tenantId, key, data, contentType) {
      const storage = await storageFor(tenantId);
      const stored = await storage.uploadImage(key, data, contentType);
      return { key: stored.key, contentType: stored.contentType, size: stored.size };
    },
    async get(tenantId, key) {
      const storage = await storageFor(tenantId);
      return storage.download(key);
    },
  };
}

/**
 * `Content-Disposition` de la captura: se pinta dentro de la página (inline).
 * Nombre en ASCII de respaldo y `filename*` en UTF-8.
 */
export function capturaDisposition(nombre: string): string {
  const ascii = nombre.replace(/[^\w.-]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

/**
 * Cabeceras de la respuesta de la captura: el navegador no adivina el tipo
 * (nosniff), no se guarda en cachés compartidas (no-store) y, si alguien la
 * abre suelta, no ejecuta nada (sandbox). Las mismas que los adjuntos del chat.
 */
export const CAPTURA_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
};
