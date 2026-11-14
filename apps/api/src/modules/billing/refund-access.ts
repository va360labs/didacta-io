/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { CERTIFICATE_REVOKE_REASON_REFUND } from '@didacta/mod-certificates';
import type { PurchaseAccessRevocation } from '@didacta/mod-learning';

/**
 * Qué se le quita a quien recibe el reembolso TOTAL de la compra de un curso.
 *
 * Es la ÚNICA implementación: la usa el puente del evento `billing.order.
 * refunded` (`BillingRefundBridge`) y la usa el script de corrección
 * (`maintenance/refund-access-repair.cli.ts`) para los reembolsos que se
 * hicieron antes del arreglo. Si cambia el criterio, cambia para los dos.
 *
 * En orden:
 *
 *  1. **Otra compra cobrada del mismo curso** → no se toca nada. La matrícula es
 *     una por (alumno, curso): si otra compra viva la respalda, es de esa.
 *  2. **Un grupo de acceso sigue dando el curso** (la membresía, un grupo
 *     manual) → la matrícula vuelve a su origen GROUP y sigue viva; el
 *     certificado se queda. Comprar sobre ese acceso la había sellado PURCHASE.
 *  3. Si no, se **cancela la matrícula de compra**, también si estaba COMPLETED
 *     (antes no: quien terminaba el curso se lo quedaba con su certificado), y
 *     se **revocan sus certificados** de ese curso —sin borrarlos: la
 *     verificación pública pasa a decir que no son válidos—.
 *
 * Lo dado a mano (ADMIN), por invitación o por API no es de la compra y no se
 * toca nunca (`revokePurchaseAccess` solo mira `source = PURCHASE`).
 *
 * Idempotente: una segunda pasada encuentra la matrícula ya cancelada y los
 * certificados ya revocados, y no cambia nada.
 */

export interface RefundAccessDeps {
  readonly billing: {
    findOtherLivePurchase(
      tenantId: string,
      userId: string,
      courseId: string,
      excludeOrderId: string,
    ): Promise<string | null>;
  };
  readonly learning: {
    revokePurchaseAccess(
      tenantId: string,
      userId: string,
      courseId: string,
      opts?: { keepAsGroup?: boolean },
    ): Promise<PurchaseAccessRevocation>;
  };
  readonly certificates: {
    revokeForCourse(
      tenantId: string,
      userId: string,
      courseId: string,
      reason: string,
    ): Promise<number>;
  };
  readonly groups: {
    hasLiveCourseGrant(tenantId: string, userId: string, courseId: string): Promise<boolean>;
  };
}

export interface RefundedPurchase {
  readonly tenantId: string;
  readonly orderId: string;
  /** `null` solo en una orden pública que nunca llegó a cobrarse. */
  readonly userId: string | null;
  readonly courseId: string;
}

export type RefundAccessOutcome =
  /** La orden no tiene comprador: nunca hubo acceso que retirar. */
  | { readonly outcome: 'no_buyer' }
  /** Otra compra cobrada del mismo curso respalda la matrícula. */
  | { readonly outcome: 'other_purchase'; readonly otherOrderId: string }
  /** Un grupo de acceso sigue dando el curso: la matrícula vuelve a GROUP. */
  | { readonly outcome: 'kept_by_group'; readonly enrollmentId: string }
  /** No hay matrícula de compra: el curso lo tiene por otra vía, o no lo tiene. */
  | { readonly outcome: 'not_by_purchase' }
  /**
   * Acceso retirado: `withdrawn` si se canceló ahora, `already_withdrawn` si ya
   * lo estaba (reentrega, o el script tras el puente). En los dos se revocan
   * los certificados que siguieran vigentes.
   */
  | {
      readonly outcome: 'withdrawn' | 'already_withdrawn';
      readonly enrollmentId: string;
      readonly previousStatus: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
      readonly certificatesRevoked: number;
    };

export async function withdrawRefundedPurchaseAccess(
  deps: RefundAccessDeps,
  purchase: RefundedPurchase,
): Promise<RefundAccessOutcome> {
  const { tenantId, orderId, userId, courseId } = purchase;
  if (!userId) return { outcome: 'no_buyer' };

  const otherOrderId = await deps.billing.findOtherLivePurchase(
    tenantId,
    userId,
    courseId,
    orderId,
  );
  if (otherOrderId) return { outcome: 'other_purchase', otherOrderId };

  const keepAsGroup = await deps.groups.hasLiveCourseGrant(tenantId, userId, courseId);
  const revoked = await deps.learning.revokePurchaseAccess(tenantId, userId, courseId, {
    keepAsGroup,
  });

  switch (revoked.outcome) {
    case 'none':
      return { outcome: 'not_by_purchase' };
    case 'kept_by_group':
      return { outcome: 'kept_by_group', enrollmentId: revoked.enrollmentId };
    case 'cancelled':
    case 'already_cancelled': {
      // También con la matrícula YA cancelada: si una pasada anterior murió
      // entre los dos pasos, aquí se completa.
      const certificatesRevoked = await deps.certificates.revokeForCourse(
        tenantId,
        userId,
        courseId,
        CERTIFICATE_REVOKE_REASON_REFUND,
      );
      return revoked.outcome === 'cancelled'
        ? {
            outcome: 'withdrawn',
            enrollmentId: revoked.enrollmentId,
            previousStatus: revoked.previousStatus,
            certificatesRevoked,
          }
        : {
            outcome: 'already_withdrawn',
            enrollmentId: revoked.enrollmentId,
            previousStatus: 'CANCELLED',
            certificatesRevoked,
          };
    }
  }
}
