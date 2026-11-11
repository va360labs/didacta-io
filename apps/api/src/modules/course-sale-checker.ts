/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import type { CourseSaleChecker } from '@didacta/mod-learning';

/**
 * Lo que este comprobador lee de la base. Son catálogos de CUATRO módulos
 * (billing, subscriptions, access-groups y payment-connections) y solo esta
 * capa de composición puede mirarlos a la vez sin saltarse el contrato
 * modular: `mod.learning` recibe la respuesta, no las tablas.
 *
 * Solo lectura, siempre filtrando por `tenantId`. Se tipa contra el cliente
 * Prisma de verdad (y no contra una interfaz propia) para que un campo o una
 * relación mal escritos no compilen.
 */
export type CourseSaleCatalogDb = Pick<
  PrismaClient,
  | 'modBillingProduct'
  | 'modSubscriptionsSubscription'
  | 'modAccessGroup'
  | 'modSubscriptionsMembershipConfig'
  | 'modPaymentConnectionsTier'
>;

/**
 * ¿El tenant COBRA por este curso? Un curso por el que se cobra no admite que
 * el alumno se matricule solo: ni con `POST /modules/learning/enrollments/me`
 * ni al apuntarse a una ruta de aprendizaje que lo contenga.
 *
 * Hay tres formas de cobrar por un curso dentro de Didacta, y las tres cuentan:
 *
 *  1. **Precio propio** — un `ModBillingProduct` activo para el curso.
 *  2. **Suscripción al curso** — existe una suscripción por ese curso.
 *  3. **Se entrega con algo que se paga** — el curso pertenece a un grupo de
 *     acceso que se concede a cambio de dinero:
 *       - el grupo de la MEMBRESÍA (`/unete`, `mod.subscriptions`), o
 *       - un grupo vinculado a un TIER de pago (`linkedTierName`, que el sync
 *         de `mod.payment-connections` reparte a quien tiene la suscripción en
 *         Stripe/PayPal/WooCommerce).
 *
 * La tercera es la que faltaba. Sin ella, en una academia que vende «membresía
 * = todos los cursos» ningún curso tenía producto propio, así que TODOS
 * pasaban por gratuitos: quien no pagaba la membresía se los llevaba igual.
 *
 * Lo que NO cuenta, a propósito:
 *  - Un grupo sin vínculo de pago (alta manual, grupo por defecto al aprobar
 *    la inscripción): reparte acceso, pero no hay dinero de por medio. Tratar
 *    esos cursos como «de pago» cerraría la automatrícula de academias que no
 *    venden nada solo por tener un grupo «Equipo» con todos los cursos.
 *  - Un grupo vinculado a un tier marcado como GRATUITO (`isFree`).
 *
 * Un tier que no está en el catálogo se trata como de pago: los vínculos
 * nacen del nombre del plan de la pasarela, y ante la duda no se regala.
 * La página de compra externa (`externalPurchaseUrl`) no se mira aquí: es un
 * dato del propio curso y lo comprueba `LearningService`.
 */
export function buildCourseSaleChecker(getDb: () => CourseSaleCatalogDb): CourseSaleChecker {
  return async (tenantId, courseId) => {
    const db = getDb();
    const [producto, suscripcion] = await Promise.all([
      db.modBillingProduct.findFirst({
        where: { tenantId, courseId, active: true },
        select: { id: true },
      }),
      db.modSubscriptionsSubscription.findFirst({
        where: { tenantId, courseId },
        select: { id: true },
      }),
    ]);
    if (producto !== null || suscripcion !== null) return true;
    return deliveredByPaidGroup(db, tenantId, courseId);
  };
}

async function deliveredByPaidGroup(
  db: CourseSaleCatalogDb,
  tenantId: string,
  courseId: string,
): Promise<boolean> {
  // Grupos vivos que entregan este curso: los que lo listan y los que
  // entregan TODOS los cursos.
  const groups = await db.modAccessGroup.findMany({
    where: {
      tenantId,
      deletedAt: null,
      OR: [{ kind: 'ALL_COURSES' }, { courses: { some: { courseId } } }],
    },
    select: { id: true, linkedTierName: true },
  });
  if (groups.length === 0) return false;

  // El grupo de la membresía cuenta en cuanto está configurado, esté o no
  // activa la página de venta: quien ya la compró sigue pagándola aunque el
  // admin haya pausado las altas nuevas.
  const membership = await db.modSubscriptionsMembershipConfig.findUnique({
    where: { tenantId },
    select: { accessGroupId: true },
  });
  if (membership?.accessGroupId && groups.some((g) => g.id === membership.accessGroupId)) {
    return true;
  }

  const linkedTierNames = [
    ...new Set(groups.map((g) => g.linkedTierName).filter((n): n is string => !!n)),
  ];
  if (linkedTierNames.length === 0) return false;
  const tiers = await db.modPaymentConnectionsTier.findMany({
    where: { tenantId, name: { in: linkedTierNames } },
    select: { name: true, isFree: true },
  });
  const freeTierNames = new Set(tiers.filter((t) => t.isFree).map((t) => t.name));
  return linkedTierNames.some((name) => !freeTierNames.has(name));
}
