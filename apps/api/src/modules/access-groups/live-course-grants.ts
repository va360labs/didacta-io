/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Concesiones VIVAS de un curso a una persona, sumando todos sus grupos. Es el
 * refcount de los grupos: con 0, ningún grupo le da el curso. Una sola
 * definición para la revocación por grupo (`revokeCourseFromUser`) y para la
 * retirada tras un reembolso (`withdrawRefundedPurchaseAccess`).
 */
export function countLiveCourseGrants(
  db: {
    modAccessGroupGrant: {
      count(args: {
        where: { tenantId: string; userId: string; courseId: string; revokedAt: null };
      }): Promise<number>;
    };
  },
  tenantId: string,
  userId: string,
  courseId: string,
): Promise<number> {
  return db.modAccessGroupGrant.count({ where: { tenantId, userId, courseId, revokedAt: null } });
}
