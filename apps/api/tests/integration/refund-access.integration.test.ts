/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Retirada del acceso tras el reembolso de un curso, contra Postgres REAL y
 * conectando como `didacta_app` (NOSUPERUSER, NOBYPASSRLS), como el runtime y
 * como el script de corrección en producción.
 *
 * Origen: venta real del 14-nov-2026 en aula-pruebas. El comprador terminó el
 * curso, se le reembolsó, y el registro dijo «reembolso sin matrícula de compra
 * viva (no-op)»: se quedó el curso y el certificado.
 *
 * Se prueba por el script de corrección (`repairRefundedPurchases`), que pasa
 * cada orden por la MISMA función que el puente del evento
 * (`withdrawRefundedPurchaseAccess`) con los servicios reales de los módulos:
 *
 *  - curso TERMINADO y reembolsado → matrícula CANCELLED, certificado revocado
 *    (no borrado) y la verificación pública dice que no es válido;
 *  - el ensayo (por defecto) no deja nada escrito; la segunda pasada, nada que
 *    cambiar (idempotente);
 *  - controles: matrícula dada a mano, otra compra cobrada del mismo curso y un
 *    grupo que sigue dando el curso NO pierden el acceso;
 *  - otra aula no ve ni toca nada (RLS);
 *  - volver a comprar devuelve la matrícula COMPLETED y el certificado.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, withTenantContext } from '@didacta/database';
import { CertificatesService } from '@didacta/mod-certificates';
import { LearningService } from '@didacta/mod-learning';
import { parseArgs } from '../../src/maintenance/refund-access-repair.cli';
import { repairRefundedPurchases } from '../../src/maintenance/refund-access-repair';
import { PublicCertificatesController } from '../../src/modules/certificates/public-certificates.controller';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Reembolso de un curso — retirada de acceso contra Postgres (didacta_app)', () => {
  let admin: PrismaClient;
  let app: PrismaClient;
  const stamp = Date.now();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `reembolso-${stamp}`;
  const courseId = randomUUID();
  const otherCourseId = randomUUID();

  /** Personas del aula, cada una con su caso. */
  const u = {
    terminado: '',
    aMano: '',
    dosCompras: '',
    conGrupo: '',
    otraAula: '',
  };
  const ids = {
    certTerminado: randomUUID(),
    certGrupo: randomUUID(),
    certOtraAula: randomUUID(),
    orderTerminado: randomUUID(),
    orderAMano: randomUUID(),
    orderDosComprasReembolsada: randomUUID(),
    orderDosComprasViva: randomUUID(),
    orderGrupo: randomUUID(),
    orderOtraAula: randomUUID(),
  };

  async function user(tenant: string, tag: string): Promise<string> {
    return (
      await admin.user.create({
        data: { tenantId: tenant, email: `${tag}-${stamp}@example.test`, status: 'ACTIVE' },
      })
    ).id;
  }

  async function order(
    tenant: string,
    id: string,
    userId: string,
    course: string,
    status: 'REFUNDED' | 'COMPLETED',
  ): Promise<void> {
    await admin.modBillingOrder.create({
      data: {
        id,
        tenantId: tenant,
        userId,
        productId: randomUUID(),
        courseId: course,
        stripeSessionId: `cs_test_${id}`,
        stripePaymentIntentId: `pi_test_${id}`,
        status,
        amountPaid: 100,
        completedAt: new Date('2026-11-14T10:00:00Z'),
        refundedAt: status === 'REFUNDED' ? new Date('2026-11-14T12:00:00Z') : null,
      },
    });
  }

  async function enrollment(
    tenant: string,
    userId: string,
    course: string,
    source: 'PURCHASE' | 'ADMIN',
    status: 'ACTIVE' | 'COMPLETED',
  ): Promise<string> {
    return (
      await admin.modLearningEnrollment.create({
        data: {
          tenantId: tenant,
          userId,
          courseId: course,
          source,
          status,
          progressPercent: status === 'COMPLETED' ? 100 : 30,
          completedAt: status === 'COMPLETED' ? new Date('2026-11-14T11:00:00Z') : null,
        },
      })
    ).id;
  }

  async function certificate(
    tenant: string,
    id: string,
    userId: string,
    course: string,
    enrollmentId: string,
  ): Promise<void> {
    await admin.modCertificatesIssued.create({
      data: {
        id,
        tenantId: tenant,
        userId,
        courseId: course,
        enrollmentId,
        number: `R-${id.slice(0, 8)}`,
        hash: 'x'.repeat(64),
        storageKey: `certificates/${tenant}/${id}.pdf`,
        size: 1,
        snapshot: { studentName: 'Alumna de prueba', courseTitle: 'Curso de 1 €' },
      },
    });
  }

  const enrollmentOf = (userId: string) =>
    admin.modLearningEnrollment.findFirstOrThrow({ where: { tenantId, userId, courseId } });
  const certOf = (id: string) => admin.modCertificatesIssued.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    app = new PrismaClient({ datasources: { db: { url: prepared.appUrl } } });
    await app.$connect();

    await admin.tenant.create({ data: { id: tenantId, slug, name: slug } });
    await admin.tenant.create({
      data: { id: otherTenantId, slug: `${slug}-otra`, name: `${slug}-otra` },
    });
    await admin.modCoursesCourse.create({
      data: {
        id: courseId,
        tenantId,
        slug: `curso-${stamp}`,
        title: 'Curso de 1 €',
        status: 'PUBLISHED',
      },
    });

    u.terminado = await user(tenantId, 'terminado');
    u.aMano = await user(tenantId, 'a-mano');
    u.dosCompras = await user(tenantId, 'dos-compras');
    u.conGrupo = await user(tenantId, 'con-grupo');
    u.otraAula = await user(otherTenantId, 'otra-aula');

    // 1. El caso real: compró, TERMINÓ, tiene certificado, se le reembolsó.
    const enTerminado = await enrollment(tenantId, u.terminado, courseId, 'PURCHASE', 'COMPLETED');
    await certificate(tenantId, ids.certTerminado, u.terminado, courseId, enTerminado);
    await order(tenantId, ids.orderTerminado, u.terminado, courseId, 'REFUNDED');

    // 2. Control: el curso se lo dio el admin a mano (la compra no es su origen).
    await enrollment(tenantId, u.aMano, courseId, 'ADMIN', 'COMPLETED');
    await order(tenantId, ids.orderAMano, u.aMano, courseId, 'REFUNDED');

    // 3. Control: dos compras del curso, solo una reembolsada.
    await enrollment(tenantId, u.dosCompras, courseId, 'PURCHASE', 'ACTIVE');
    await order(tenantId, ids.orderDosComprasReembolsada, u.dosCompras, courseId, 'REFUNDED');
    await order(tenantId, ids.orderDosComprasViva, u.dosCompras, courseId, 'COMPLETED');

    // 4. Control: un grupo (la membresía) sigue dando el curso.
    const enGrupo = await enrollment(tenantId, u.conGrupo, courseId, 'PURCHASE', 'COMPLETED');
    await certificate(tenantId, ids.certGrupo, u.conGrupo, courseId, enGrupo);
    await order(tenantId, ids.orderGrupo, u.conGrupo, courseId, 'REFUNDED');
    const group = await admin.modAccessGroup.create({
      data: { tenantId, slug: `grupo-${stamp}`, name: 'Miembros', kind: 'MULTI_COURSE' },
    });
    await admin.modAccessGroupGrant.create({
      data: { tenantId, groupId: group.id, userId: u.conGrupo, courseId },
    });

    // 5. Otra aula, mismo caso que el 1: el script acotado a la primera no la toca.
    const enOtra = await enrollment(
      otherTenantId,
      u.otraAula,
      otherCourseId,
      'PURCHASE',
      'COMPLETED',
    );
    await certificate(otherTenantId, ids.certOtraAula, u.otraAula, otherCourseId, enOtra);
    await order(otherTenantId, ids.orderOtraAula, u.otraAula, otherCourseId, 'REFUNDED');
  });

  afterAll(async () => {
    await app?.$disconnect();
    await admin?.$disconnect();
  });

  it('los argumentos: ensayo por defecto, --apply escribe y los ids se validan', () => {
    expect(parseArgs([])).toMatchObject({ apply: false });
    expect(parseArgs(['--dry-run', '--tenant-slug', 'aula-pruebas'])).toMatchObject({
      apply: false,
      tenantSlug: 'aula-pruebas',
    });
    expect(parseArgs(['--apply'])).toMatchObject({ apply: true });
    expect(parseArgs(['--tenant', 'no-es-uuid'])).toBe('--tenant tiene que ser un uuid');
    expect(parseArgs(['--borra-todo'])).toBe('Argumento desconocido: --borra-todo');
  });

  it('ensayo (por defecto): informa de lo que haría y no deja NADA escrito', async () => {
    const report = await repairRefundedPurchases(app, { apply: false, tenantSlug: slug });

    const byOrder = new Map(report.rows.map((r) => [r.orderId, r]));
    expect(report.errors).toBe(0);
    expect(byOrder.get(ids.orderTerminado)?.outcome).toMatchObject({
      outcome: 'withdrawn',
      previousStatus: 'COMPLETED',
      certificatesRevoked: 1,
    });
    expect(byOrder.get(ids.orderAMano)?.outcome).toEqual({ outcome: 'not_by_purchase' });
    expect(byOrder.get(ids.orderDosComprasReembolsada)?.outcome).toEqual({
      outcome: 'other_purchase',
      otherOrderId: ids.orderDosComprasViva,
    });
    expect(byOrder.get(ids.orderGrupo)?.outcome).toMatchObject({ outcome: 'kept_by_group' });
    // La otra aula ni aparece.
    expect(byOrder.has(ids.orderOtraAula)).toBe(false);
    expect(report.changed).toBe(2);

    // Nada escrito: ni matrícula, ni certificado, ni evento en el outbox.
    expect((await enrollmentOf(u.terminado)).status).toBe('COMPLETED');
    expect((await certOf(ids.certTerminado)).revokedAt).toBeNull();
    expect((await enrollmentOf(u.conGrupo)).source).toBe('PURCHASE');
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, eventName: 'learning.enrollment.cancelled' },
      }),
    ).toBe(0);
  });

  it('--apply: retira el curso terminado y revoca (sin borrar) su certificado; los controles siguen igual', async () => {
    const report = await repairRefundedPurchases(app, { apply: true, tenantSlug: slug });
    expect(report.errors).toBe(0);
    expect(report.changed).toBe(2);

    // 1. El caso real.
    const terminado = await enrollmentOf(u.terminado);
    expect(terminado.status).toBe('CANCELLED');
    expect(terminado.cancelledAt).toBeInstanceOf(Date);
    expect(terminado.completedAt).toBeInstanceOf(Date); // la historia se conserva
    const cert = await certOf(ids.certTerminado);
    expect(cert.revokedAt).toBeInstanceOf(Date);
    expect(cert.revokeReason).toBe('refund');

    // La verificación pública dice que no es válido (la URL del PDF / LinkedIn).
    const verify = await new PublicCertificatesController(admin as never).verify(ids.certTerminado);
    expect(verify.valid).toBe(false);
    // Control: el certificado del aula de al lado sigue siendo válido.
    const verifyOtra = await new PublicCertificatesController(admin as never).verify(
      ids.certOtraAula,
    );
    expect(verifyOtra.valid).toBe(true);

    // El aviso de baja queda en el outbox PENDIENTE: lo entrega la API en marcha.
    const outbox = await admin.outboxEvent.findMany({
      where: { tenantId, eventName: 'learning.enrollment.cancelled' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.processedAt).toBeNull();

    // 2. A mano: intacta.
    expect(await enrollmentOf(u.aMano)).toMatchObject({ status: 'COMPLETED', source: 'ADMIN' });
    // 3. Otra compra viva: intacta.
    expect(await enrollmentOf(u.dosCompras)).toMatchObject({
      status: 'ACTIVE',
      source: 'PURCHASE',
    });
    // 4. Grupo: sigue viva, vuelve a GROUP, certificado válido.
    expect(await enrollmentOf(u.conGrupo)).toMatchObject({ status: 'COMPLETED', source: 'GROUP' });
    expect((await certOf(ids.certGrupo)).revokedAt).toBeNull();
    // 5. La otra aula: intacta.
    expect(
      (
        await admin.modLearningEnrollment.findFirstOrThrow({
          where: { tenantId: otherTenantId, userId: u.otraAula },
        })
      ).status,
    ).toBe('COMPLETED');
    expect((await certOf(ids.certOtraAula)).revokedAt).toBeNull();
  });

  it('idempotente: una segunda pasada no cambia nada', async () => {
    const certBefore = await certOf(ids.certTerminado);
    const report = await repairRefundedPurchases(app, { apply: true, tenantSlug: slug });
    expect(report.errors).toBe(0);
    expect(report.changed).toBe(0);
    expect(report.rows.find((r) => r.orderId === ids.orderTerminado)?.outcome).toMatchObject({
      outcome: 'already_withdrawn',
      certificatesRevoked: 0,
    });
    expect((await certOf(ids.certTerminado)).revokedAt).toEqual(certBefore.revokedAt);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, eventName: 'learning.enrollment.cancelled' },
      }),
    ).toBe(1);
  });

  it('volver a comprar: la matrícula vuelve COMPLETED y el certificado revocado por el reembolso vuelve a valer', async () => {
    const ctx = {
      eventBus: { publish: async () => undefined, subscribe: () => () => undefined },
    } as never;
    await withTenantContext(app, tenantId, async (tx) => {
      const learning = new LearningService(tx as PrismaClient, ctx);
      const certificates = new CertificatesService(tx as PrismaClient, ctx);
      const again = await learning.enrollFromPurchase(tenantId, u.terminado, courseId);
      expect(again.status).toBe('COMPLETED');
      expect(await certificates.restoreRevokedForRefund(tenantId, u.terminado, courseId)).toBe(1);
    });
    const verify = await new PublicCertificatesController(admin as never).verify(ids.certTerminado);
    expect(verify.valid).toBe(true);
  });
});
