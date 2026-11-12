/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { SUPPORT_USER_EMAIL } from '../tenancy/support-access';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import type { TenantSenderDirectory } from './tenant-smtp-resolver.service';

/** Lo mínimo de Prisma que hace falta (evita acoplar el directorio a PrismaService). */
export interface SenderDirectoryPrisma {
  user: {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, 'asc' | 'desc'>;
      select: { email: true };
    }): Promise<{ email: string } | null>;
  };
}

/**
 * Administrador principal de un aula = el primer administrador ACTIVO y no
 * borrado DE ESA AULA, por fecha de alta. En Didacta Cloud es el creador (el
 * aprovisionamiento lo da de alta como `tenant_admin`); en una instalación
 * propia, quien la instaló (el arranque lo crea `super_admin`). Los usuarios
 * son por aula, así que el operador de otra aula nunca entra en la cuenta.
 *
 * Se excluye el usuario de acceso de soporte (`soporte@didacta.invalid`, que
 * también es `tenant_admin`): si el creador se diera de baja, las respuestas
 * de sus alumnos acabarían en una dirección que no existe.
 *
 * La consulta corre con el contexto del PROPIO aula (`runAsTenant`): el
 * emisor puede venir de un worker sin contexto y, con RLS forzada, sin él no
 * vería ninguna fila y dejaría un hueco en el log.
 */
export function prismaTenantSenderDirectory(prisma: SenderDirectoryPrisma): TenantSenderDirectory {
  return {
    async primaryAdminEmail(tenantId: string): Promise<string | null> {
      const admin = await runAsTenant(
        tenantId,
        () =>
          prisma.user.findFirst({
            where: {
              tenantId,
              status: 'ACTIVE',
              deletedAt: null,
              email: { not: SUPPORT_USER_EMAIL },
              roles: { some: { role: { name: { in: ['tenant_admin', 'super_admin'] } } } },
            },
            orderBy: { createdAt: 'asc' },
            select: { email: true },
          }),
        { traceLabel: 'smtp-reply-to' },
      );
      return admin?.email ?? null;
    },
  };
}
