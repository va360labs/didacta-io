/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DomainEvent, EventBus, ModuleContext } from '@didacta/core-kernel';
import { withTenantContext, type PrismaClient } from '@didacta/database';
import { BillingService } from '@didacta/mod-billing';
import { CertificatesService } from '@didacta/mod-certificates';
import { LearningService } from '@didacta/mod-learning';
import { countLiveCourseGrants } from '../modules/access-groups/live-course-grants';
import {
  withdrawRefundedPurchaseAccess,
  type RefundAccessOutcome,
} from '../modules/billing/refund-access';

/**
 * Corrección de los reembolsos hechos ANTES del arreglo de la retirada de
 * acceso: el reembolso de un curso que el alumno ya había TERMINADO no cancelaba
 * su matrícula ni revocaba su certificado (venta real del 14-nov-2026 en
 * aula-pruebas: «reembolso sin matrícula de compra viva (no-op)»).
 *
 * Recorre las órdenes REEMBOLSADAS y pasa cada una por la MISMA función que usa
 * el puente del evento (`withdrawRefundedPurchaseAccess`), con los MISMOS
 * servicios de los módulos. No hay SQL propio: el criterio (otra compra viva,
 * grupo que sigue dando el curso, matrícula dada a mano…) es el del arreglo.
 *
 * Ensayo por defecto: cada orden se procesa dentro de una transacción con el
 * tenant fijado (RLS) que se DESHACE al final; se informa de lo que habría
 * pasado sin dejar nada escrito. Con `apply`, se confirma.
 *
 * Idempotente: una segunda pasada encuentra las matrículas ya canceladas y los
 * certificados ya revocados y no cambia nada (todas las órdenes salen «sin
 * cambios»).
 */

export interface RepairOptions {
  readonly apply: boolean;
  /** Solo este aula (uuid). */
  readonly tenantId?: string | null;
  /** Solo este aula (slug, p. ej. `aula-pruebas`). */
  readonly tenantSlug?: string | null;
  /** Solo esta orden. */
  readonly orderId?: string | null;
}

export interface RepairRow {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly orderId: string;
  readonly userId: string | null;
  readonly courseId: string;
  readonly refundedAt: Date | null;
  readonly outcome: RefundAccessOutcome | null;
  /** ¿Esta orden cambia algo (o lo cambiaría, en el ensayo)? */
  readonly changes: boolean;
  readonly error: string | null;
}

export interface RepairReport {
  readonly apply: boolean;
  readonly rows: RepairRow[];
  readonly changed: number;
  readonly errors: number;
}

/** ¿El resultado cambia algo? Es lo que se cuenta y lo que se lista primero. */
export function outcomeChanges(outcome: RefundAccessOutcome): boolean {
  switch (outcome.outcome) {
    case 'withdrawn':
    case 'kept_by_group':
      return true;
    case 'already_withdrawn':
      return outcome.certificatesRevoked > 0;
    default:
      return false;
  }
}

/** Lanzada para deshacer la transacción del ensayo llevándose el resultado. */
class DryRunRollback extends Error {
  constructor(readonly outcome: RefundAccessOutcome) {
    super('ensayo: se deshace');
  }
}

/**
 * Bus de eventos del script: escribe el evento en el outbox PENDIENTE, como
 * hace el bus persistente de la API, pero sin despacharlo aquí (en este proceso
 * no hay nadie suscrito: se marcaría «sin entregar»). Lo entrega la API en
 * marcha con su barrido de pendientes (`OutboxRecoveryWorker`). En el ensayo,
 * la fila se deshace con la transacción.
 */
class OutboxOnlyEventBus implements EventBus {
  constructor(private readonly tx: PrismaClient) {}

  async publish<TPayload>(event: DomainEvent<TPayload>): Promise<void> {
    await this.tx.outboxEvent.upsert({
      where: {
        tenantId_idempotencyKey: {
          tenantId: event.metadata.tenantId,
          idempotencyKey: event.metadata.idempotencyKey,
        },
      },
      create: {
        tenantId: event.metadata.tenantId,
        eventName: event.name,
        payloadVersion: event.version,
        payload: event.data as never,
        metadata: event.metadata as never,
        idempotencyKey: event.metadata.idempotencyKey,
      },
      update: {},
    });
  }

  subscribe(): () => void {
    throw new Error('refund-access-repair: el bus del script no admite suscripciones');
  }
}

/**
 * Contexto mínimo de los módulos: el retiro solo publica eventos. Cualquier otra
 * pieza del contexto que se use por error falla en alto, no en silencio.
 */
function scriptContext(tx: PrismaClient): ModuleContext {
  const eventBus = new OutboxOnlyEventBus(tx);
  return new Proxy({ eventBus } as unknown as ModuleContext, {
    get(target, prop) {
      if (prop in target) return (target as unknown as Record<string | symbol, unknown>)[prop];
      if (prop === 'then') return undefined;
      throw new Error(`refund-access-repair: el contexto del script no tiene «${String(prop)}»`);
    },
  });
}

/** Los mismos servicios que usa el puente, sobre la transacción del tenant. */
function depsFor(tx: PrismaClient) {
  const ctx = scriptContext(tx);
  const unavailable = async (): Promise<never> => {
    throw new Error('refund-access-repair: el script no habla con Stripe');
  };
  return {
    billing: new BillingService(
      tx,
      unavailable,
      { publish: unavailable },
      {
        successUrl: () => '',
        cancelUrl: () => '',
      },
    ),
    learning: new LearningService(tx, ctx),
    certificates: new CertificatesService(tx, ctx),
    groups: {
      hasLiveCourseGrant: async (tenantId: string, userId: string, courseId: string) =>
        (await countLiveCourseGrants(tx, tenantId, userId, courseId)) > 0,
    },
  };
}

export async function repairRefundedPurchases(
  prisma: PrismaClient,
  opts: RepairOptions,
): Promise<RepairReport> {
  // `tenant` no tiene RLS: se listan todas las aulas vivas (o la pedida).
  const tenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      ...(opts.tenantId ? { id: opts.tenantId } : {}),
      ...(opts.tenantSlug ? { slug: opts.tenantSlug } : {}),
    },
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });

  const rows: RepairRow[] = [];
  for (const tenant of tenants) {
    const orders = await withTenantContext(prisma, tenant.id, (tx) =>
      tx.modBillingOrder.findMany({
        where: {
          tenantId: tenant.id,
          status: 'REFUNDED',
          ...(opts.orderId ? { id: opts.orderId } : {}),
        },
        select: { id: true, userId: true, courseId: true, refundedAt: true },
        orderBy: { refundedAt: 'asc' },
      }),
    );

    for (const order of orders) {
      const base = {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        orderId: order.id,
        userId: order.userId,
        courseId: order.courseId,
        refundedAt: order.refundedAt,
      };
      try {
        const outcome = await withTenantContext(prisma, tenant.id, async (tx) => {
          const result = await withdrawRefundedPurchaseAccess(depsFor(tx as PrismaClient), {
            tenantId: tenant.id,
            orderId: order.id,
            userId: order.userId,
            courseId: order.courseId,
          });
          if (!opts.apply) throw new DryRunRollback(result);
          return result;
        }).catch((err: unknown) => {
          if (err instanceof DryRunRollback) return err.outcome;
          throw err;
        });
        rows.push({ ...base, outcome, changes: outcomeChanges(outcome), error: null });
      } catch (err) {
        rows.push({
          ...base,
          outcome: null,
          changes: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    apply: opts.apply,
    rows,
    changed: rows.filter((r) => r.changes).length,
    errors: rows.filter((r) => r.error !== null).length,
  };
}

/** Una línea por orden, para la consola. Sin datos personales: solo ids. */
export function describeRow(row: RepairRow, apply: boolean): string {
  const head = `${row.tenantSlug} · orden ${row.orderId} · curso ${row.courseId} · alumno ${row.userId ?? '—'}`;
  if (row.error) return `ERROR   ${head}: ${row.error}`;
  const o = row.outcome!;
  const verb = apply ? '' : '(ensayo) ';
  switch (o.outcome) {
    case 'withdrawn':
      return `CAMBIA  ${head}: ${verb}matrícula ${o.previousStatus} → CANCELLED; certificados revocados: ${o.certificatesRevoked}`;
    case 'already_withdrawn':
      return o.certificatesRevoked > 0
        ? `CAMBIA  ${head}: ${verb}matrícula ya cancelada; certificados revocados: ${o.certificatesRevoked}`
        : `igual   ${head}: matrícula ya cancelada y sin certificados vigentes`;
    case 'kept_by_group':
      return `CAMBIA  ${head}: ${verb}un grupo sigue dando el curso: la matrícula vuelve a GROUP (sigue viva)`;
    case 'other_purchase':
      return `igual   ${head}: otra compra cobrada del curso (${o.otherOrderId}) la respalda`;
    case 'not_by_purchase':
      return `igual   ${head}: sin matrícula de compra (dada a mano, por grupo, o no la tiene)`;
    case 'no_buyer':
      return `igual   ${head}: orden sin comprador`;
  }
}
