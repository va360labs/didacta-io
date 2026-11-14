/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@didacta/database';
import {
  PayoutsReportsService,
  creatorReceives,
  type PayoutsDbPort,
  type PayoutsTx,
  type SaleView,
} from '@didacta/mod-payouts';
import { PayoutsRuntime } from '../modules/payouts/payouts-runtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant, runGlobalWithoutTenant } from '../tenancy/tenant-context.storage';
import {
  SALE_ID,
  SALE_STATUSES,
  type SaleDetailView,
  type SaleEvent,
  type SaleRow,
  type SaleStatus,
  type SalesFilters,
  type SalesPageView,
  type SalesProductOption,
} from './sales-ledger.types';

/**
 * «Ventas» con los datos de cada venta (comprador, producto, cupón o
 * referido, comisiones, neto, estado y país), con búsqueda, filtros y
 * exportación.
 *
 * Composición en el host a propósito, como `admin-business-metrics` y
 * `course-sale-checker`: junta tablas de varios módulos (billing,
 * subscriptions, payouts, referrals) y del core (personas, cursos), algo que
 * ningún módulo puede hacer por contrato. Solo LEE, y siempre filtrando por
 * `tenant_id` además de la RLS: cada consulta corre en una transacción con el
 * contexto del aula (la extensión de Prisma pone el `set_config` primero).
 *
 * La venta de verdad es la orden o la factura cobrada (existen en los dos
 * modos de cobro); el reparto de la plataforma se le une cuando existe. El
 * estado, lo devuelto y si se puede reembolsar los decide `mod.payouts`
 * (`PayoutsReportsService.salesByIds`): aquí no se recalcula ningún importe.
 */

/** Tope de filas de una exportación: más que esto es un trabajo, no una descarga. */
export const SALES_EXPORT_MAX_ROWS = 50_000;

/** Fila tal como sale de la consulta (columnas en snake_case de Postgres). */
interface LedgerSqlRow {
  kind: 'order' | 'subscription';
  source_id: string;
  source_ref: string;
  user_id: string | null;
  course_id: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  at: Date;
  amount: number;
  currency: string;
  checkout_email: string | null;
  country: string | null;
  coupon: number | null;
  credit: number | null;
  origin_refunded: boolean;
  origin_refunded_at: Date | null;
  hosted_invoice_url: string | null;
  period_start: Date | null;
  period_end: Date | null;
  user_name: string | null;
  user_email: string | null;
  user_deleted: boolean | null;
  course_title: string | null;
  option_name: string | null;
  plan_name: string | null;
  interval_months: number | null;
  payout_id: string | null;
  presentment_amount: number | null;
  presentment_currency: string | null;
  customer_credit_applied: number | null;
  payout_email: string | null;
  referrer_user_id: string | null;
  referrer_name: string | null;
  referral_code: string | null;
  commission_cents: number | null;
  commission_currency: string | null;
  commission_status: string | null;
  status: SaleStatus;
  total?: bigint | number;
}

/** El escape de un término para `ILIKE`: `%`, `_` y `\` literales. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Las ventas del aula como una sola tabla. `base` une órdenes completadas o
 * devueltas y cuotas cobradas; `ledger` le pone comprador, producto, reparto,
 * reclamación, referido y el estado que entiende el creador.
 */
function baseCte(tenantId: string): Prisma.Sql {
  const t = Prisma.sql`${tenantId}::uuid`;
  return Prisma.sql`
    base AS (
      SELECT 'order'::text AS kind,
             o.id AS source_id,
             o.id::text AS source_ref,
             'ORDER'::text AS payout_kind,
             o.user_id,
             o.course_id,
             NULL::uuid AS plan_id,
             o.product_id AS option_id,
             NULL::uuid AS subscription_id,
             COALESCE(o.completed_at, o.created_at) AS at,
             COALESCE(o.amount_paid, 0) AS amount,
             lower(o.currency) AS currency,
             o.customer_email AS checkout_email,
             o.customer_country AS country,
             o.discount_amount AS coupon,
             NULL::int AS credit,
             (o.status = 'REFUNDED') AS origin_refunded,
             o.refunded_at AS origin_refunded_at,
             NULL::text AS hosted_invoice_url,
             NULL::timestamp AS period_start,
             NULL::timestamp AS period_end
        FROM mod_billing_order o
       WHERE o.tenant_id = ${t}
         AND o.status IN ('COMPLETED', 'REFUNDED')
      UNION ALL
      SELECT 'subscription'::text,
             i.id,
             i.stripe_invoice_id,
             'SUBSCRIPTION_INVOICE'::text,
             s.user_id,
             s.course_id,
             s.plan_id,
             NULL::uuid,
             s.id,
             COALESCE(i.paid_at, i.created_at),
             i.amount,
             lower(i.currency),
             NULL::text,
             s.customer_country,
             NULL::int,
             NULLIF(i.credit_applied_cents, 0),
             false,
             NULL::timestamp,
             i.hosted_invoice_url,
             i.period_start,
             i.period_end
        FROM mod_subscriptions_invoice i
        JOIN mod_subscriptions_subscription s
          ON s.id = i.subscription_id AND s.tenant_id = ${t}
       WHERE i.tenant_id = ${t}
         AND i.status = 'PAID'
         AND i.amount > 0
    )`;
}

function ledgerCte(tenantId: string): Prisma.Sql {
  const t = Prisma.sql`${tenantId}::uuid`;
  return Prisma.sql`
    ${baseCte(tenantId)},
    ledger AS (
      SELECT b.*,
             u.name AS user_name,
             u.email AS user_email,
             (u.deleted_at IS NOT NULL) AS user_deleted,
             c.title AS course_title,
             NULLIF(bp.name, '') AS option_name,
             pl.name AS plan_name,
             pl.interval_months,
             p.id AS payout_id,
             p.presentment_amount,
             p.presentment_currency,
             NULLIF(p.customer_credit_applied, 0) AS customer_credit_applied,
             p.buyer_email AS payout_email,
             ref.referrer_user_id,
             ru.name AS referrer_name,
             ref.code AS referral_code,
             ref.commission_cents,
             ref.commission_currency,
             ref.commission_status,
             CASE
               WHEN p.id IS NOT NULL AND (COALESCE(d.open, false) OR d.last_outcome = 'lost')
                 THEN 'disputed'
               WHEN b.origin_refunded OR COALESCE(p.refunded_amount, 0) > 0 THEN 'refunded'
               WHEN p.status::text IN ('HELD', 'FAILED') THEN 'held'
               WHEN p.status::text IN ('TRANSFERRED', 'SETTLED_NETTED') THEN 'transferred'
               ELSE 'paid'
             END AS status
        FROM base b
        LEFT JOIN "user" u ON u.id = b.user_id AND u.tenant_id = ${t}
        LEFT JOIN mod_courses_course c ON c.id = b.course_id AND c.tenant_id = ${t}
        LEFT JOIN mod_billing_product bp ON bp.id = b.option_id AND bp.tenant_id = ${t}
        LEFT JOIN mod_subscriptions_plan pl ON pl.id = b.plan_id AND pl.tenant_id = ${t}
        LEFT JOIN LATERAL (
          SELECT ps.id, ps.status, ps.presentment_amount, ps.presentment_currency,
                 ps.customer_credit_applied, ps.buyer_email, ps.refunded_amount
            FROM mod_payouts_sale ps
           WHERE ps.tenant_id = ${t}
             AND ps.source_kind = b.payout_kind::"PayoutsSaleSourceKind"
             AND ps.source_ref = b.source_ref
           ORDER BY ps.charged_at DESC NULLS LAST
           LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT bool_or(pd.outcome IS NULL) AS open,
                 (array_agg(pd.outcome ORDER BY pd.updated_at DESC)
                    FILTER (WHERE pd.outcome IS NOT NULL))[1] AS last_outcome
            FROM mod_payouts_dispute pd
           WHERE pd.tenant_id = ${t} AND pd.sale_id = p.id
        ) d ON true
        LEFT JOIN LATERAL (
          SELECT rc.referrer_user_id,
                 rc.amount_cents AS commission_cents,
                 rc.currency AS commission_currency,
                 rc.status::text AS commission_status,
                 rr.code
            FROM mod_referrals_commission rc
            JOIN mod_referrals_referral rr ON rr.id = rc.referral_id AND rr.tenant_id = ${t}
           WHERE rc.tenant_id = ${t}
             AND rc.kind = 'COMMISSION'
             AND rc.stripe_invoice_id =
                 CASE WHEN b.kind = 'order' THEN 'order:' || b.source_id::text ELSE b.source_ref END
           ORDER BY rc.created_at ASC
           LIMIT 1
        ) ref ON true
        LEFT JOIN "user" ru ON ru.id = ref.referrer_user_id AND ru.tenant_id = ${t}
    )`;
}

function whereFilters(filters: SalesFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  // Las columnas son `timestamp` (UTC, sin zona): el literal ISO se lee como
  // hora UTC sea cual sea la zona de la sesión de Postgres.
  if (filters.from) parts.push(Prisma.sql`l.at >= ${filters.from.toISOString()}::timestamp`);
  if (filters.to) parts.push(Prisma.sql`l.at < ${filters.to.toISOString()}::timestamp`);
  if (filters.status) parts.push(Prisma.sql`l.status = ${filters.status}`);
  if (filters.product) {
    const [kind, id] = filters.product.split(':') as ['course' | 'plan', string];
    parts.push(
      kind === 'plan'
        ? Prisma.sql`l.plan_id = ${id}::uuid`
        : Prisma.sql`(l.course_id = ${id}::uuid AND l.plan_id IS NULL)`,
    );
  }
  const q = filters.q?.trim();
  if (q) {
    const like = likePattern(q);
    parts.push(Prisma.sql`(
      l.user_name ILIKE ${like} OR l.user_email ILIKE ${like} OR
      l.checkout_email ILIKE ${like} OR l.payout_email ILIKE ${like} OR
      l.course_title ILIKE ${like} OR l.plan_name ILIKE ${like}
    )`);
  }
  return Prisma.join(parts, ' AND ');
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

/** Fila de la consulta + su venta de `mod.payouts` → lo que ve el creador. */
export function toSaleRow(row: LedgerSqlRow, payout: SaleView | null): SaleRow {
  const isMembership = row.plan_id !== null;
  const productRef = isMembership
    ? `plan:${row.plan_id}`
    : row.course_id
      ? `course:${row.course_id}`
      : null;
  const accountEmail = row.user_deleted ? null : row.user_email;
  const paidEmail = row.checkout_email ?? row.payout_email;
  const email = accountEmail ?? paidEmail ?? null;
  const amount = intOrNull(row.presentment_amount) ?? Number(row.amount);
  const currency = (row.presentment_currency ?? row.currency).toLowerCase();
  const refundState: SaleRow['refundState'] = payout
    ? payout.refundState
    : row.origin_refunded
      ? 'full'
      : 'none';
  const status = (SALE_STATUSES as readonly string[]).includes(row.status) ? row.status : 'paid';
  return {
    id: `${row.kind === 'order' ? 'order' : 'invoice'}:${row.source_id}`,
    kind: row.kind,
    at: new Date(row.at).toISOString(),
    buyer: {
      userId: row.user_id,
      name: row.user_name,
      email,
      checkoutEmail:
        paidEmail && email && paidEmail.toLowerCase() !== email.toLowerCase() ? paidEmail : null,
      country: row.country,
      deleted: row.user_deleted === true,
    },
    product: {
      kind: isMembership ? 'membership' : 'course',
      ref: productRef,
      title: isMembership ? row.plan_name : row.course_title,
      option: row.option_name,
      intervalMonths: row.kind === 'subscription' ? (intOrNull(row.interval_months) ?? 1) : null,
    },
    amount,
    currency,
    coupon: intOrNull(row.coupon),
    referralCredit: intOrNull(row.customer_credit_applied) ?? intOrNull(row.credit),
    referral:
      row.referrer_user_id && row.commission_cents !== null
        ? {
            referrerUserId: row.referrer_user_id,
            referrerName: row.referrer_name,
            code: row.referral_code,
            commission: Number(row.commission_cents),
            commissionCurrency: (row.commission_currency ?? currency).toLowerCase(),
            commissionStatus: row.commission_status ?? 'PENDING',
          }
        : null,
    settlement: payout
      ? {
          currency: payout.currency,
          gross: payout.gross,
          cardFee: payout.stripeFee,
          platformFee: payout.platformFee,
          net: creatorReceives(payout),
          debtNetted: payout.debtNetted,
          refunded: payout.refundedAmount,
        }
      : null,
    status,
    refundState,
    payoutSaleId: row.payout_id,
  };
}

@Injectable()
export class SalesLedgerService {
  private readonly payoutReports: PayoutsReportsService;

  constructor(
    private readonly prisma: PrismaService,
    // Solo existe con el modo plataforma encendido (`PayoutsModule`, global).
    @Optional() private readonly payouts?: PayoutsRuntime,
  ) {
    // El reparto se LEE siempre con el servicio de `mod.payouts` (sus tablas
    // existen en cualquier instalación): un aula que cobró por la plataforma y
    // luego pasó a sus claves sigue viendo el reparto de entonces.
    const db: PayoutsDbPort = {
      inTenant: <T>(tenantId: string, fn: (tx: PayoutsTx) => Promise<T>) =>
        runAsTenant(
          tenantId,
          () => this.prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx)),
          { traceLabel: 'sales' },
        ),
      global: <T>(fn: (tx: PayoutsTx) => Promise<T>) =>
        runGlobalWithoutTenant(() =>
          this.prisma.$transaction((tx) => fn(tx as unknown as PayoutsTx)),
        ),
    };
    this.payoutReports = new PayoutsReportsService(db);
  }

  /** Consulta cruda en una transacción con el contexto del aula (RLS). */
  private query<T>(tenantId: string, sql: Prisma.Sql): Promise<T[]> {
    return runAsTenant(tenantId, () => this.prisma.$transaction((tx) => tx.$queryRaw<T[]>(sql)), {
      traceLabel: 'sales',
    });
  }

  /** Quién cobra y cuánto se queda, si el aula cobra por la plataforma. */
  async platformInfo(tenantId: string): Promise<{ operatorName: string; feeBps: number } | null> {
    if (!this.payouts) return null;
    const settings = await this.payouts.settings.get(tenantId);
    return { operatorName: this.payouts.config.displayName, feeBps: settings.feeBps };
  }

  private async payoutViews(
    tenantId: string,
    rows: readonly LedgerSqlRow[],
  ): Promise<Map<string, SaleView>> {
    const ids = rows.map((r) => r.payout_id).filter((id): id is string => !!id);
    const out = new Map<string, SaleView>();
    for (let i = 0; i < ids.length; i += 1000) {
      const views = await this.payoutReports.salesByIds(tenantId, ids.slice(i, i + 1000));
      for (const v of views) out.set(v.id, v);
    }
    return out;
  }

  private async rows(
    tenantId: string,
    filters: SalesFilters,
    page: { limit: number; offset: number },
  ): Promise<{ rows: LedgerSqlRow[]; total: number }> {
    const rows = await this.query<LedgerSqlRow>(
      tenantId,
      Prisma.sql`
        WITH ${ledgerCte(tenantId)}
        SELECT l.*, COUNT(*) OVER () AS total
          FROM ledger l
         WHERE ${whereFilters(filters)}
         ORDER BY l.at DESC, l.source_id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
    );
    return { rows, total: rows.length ? Number(rows[0]!.total) : 0 };
  }

  async list(
    tenantId: string,
    filters: SalesFilters,
    paging: { page: number; pageSize: number },
  ): Promise<SalesPageView> {
    const pageSize = Math.min(Math.max(paging.pageSize, 1), 100);
    const page = Math.max(paging.page, 1);
    const [{ rows, total }, totals, products, platform] = await Promise.all([
      this.rows(tenantId, filters, { limit: pageSize, offset: (page - 1) * pageSize }),
      this.query<{ currency: string; count: bigint; amount: bigint | null }>(
        tenantId,
        Prisma.sql`
          WITH ${ledgerCte(tenantId)}
          SELECT lower(COALESCE(l.presentment_currency, l.currency)) AS currency,
                 COUNT(*) AS count,
                 SUM(COALESCE(l.presentment_amount, l.amount)) AS amount
            FROM ledger l
           WHERE ${whereFilters(filters)}
           GROUP BY 1
           ORDER BY COUNT(*) DESC, 1`,
      ),
      this.products(tenantId),
      this.platformInfo(tenantId),
    ]);
    // Si se pide una página más allá del final, la cuenta sale de otra consulta.
    const realTotal =
      rows.length === 0 && page > 1
        ? (await this.rows(tenantId, filters, { limit: 1, offset: 0 })).total
        : total;
    const payouts = await this.payoutViews(tenantId, rows);
    return {
      items: rows.map((r) => toSaleRow(r, r.payout_id ? (payouts.get(r.payout_id) ?? null) : null)),
      page,
      pageSize,
      total: realTotal,
      totals: totals.map((t) => ({
        currency: t.currency,
        count: Number(t.count),
        amount: Number(t.amount ?? 0),
      })),
      products,
      platform,
    };
  }

  /** Productos que tienen ventas, para el filtro. */
  async products(tenantId: string): Promise<SalesProductOption[]> {
    const rows = await this.query<{
      course_id: string | null;
      plan_id: string | null;
      title: string | null;
    }>(
      tenantId,
      Prisma.sql`
        WITH ${baseCte(tenantId)}
        SELECT b.course_id, b.plan_id, MAX(COALESCE(pl.name, c.title)) AS title
          FROM base b
          LEFT JOIN mod_courses_course c
            ON c.id = b.course_id AND c.tenant_id = ${tenantId}::uuid
          LEFT JOIN mod_subscriptions_plan pl
            ON pl.id = b.plan_id AND pl.tenant_id = ${tenantId}::uuid
         GROUP BY b.course_id, b.plan_id
         ORDER BY 3 NULLS LAST`,
    );
    const seen = new Set<string>();
    const out: SalesProductOption[] = [];
    for (const r of rows) {
      const ref = r.plan_id ? `plan:${r.plan_id}` : r.course_id ? `course:${r.course_id}` : null;
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, kind: r.plan_id ? 'membership' : 'course', title: r.title });
    }
    return out;
  }

  /** Todas las ventas filtradas (para exportar), hasta `SALES_EXPORT_MAX_ROWS`. */
  async all(tenantId: string, filters: SalesFilters): Promise<{ rows: SaleRow[]; total: number }> {
    const { rows, total } = await this.rows(tenantId, filters, {
      limit: SALES_EXPORT_MAX_ROWS,
      offset: 0,
    });
    const payouts = await this.payoutViews(tenantId, rows);
    return {
      rows: rows.map((r) => toSaleRow(r, r.payout_id ? (payouts.get(r.payout_id) ?? null) : null)),
      total,
    };
  }

  /** Una venta con su reparto, su historia y su factura. 404 si no es del aula. */
  async detail(tenantId: string, saleId: string): Promise<SaleDetailView> {
    const m = SALE_ID.exec(saleId);
    if (!m) throw notFound();
    const kind = m[1]!.toLowerCase() === 'order' ? 'order' : 'subscription';
    const id = m[2]!.toLowerCase();
    const [row] = await this.query<LedgerSqlRow>(
      tenantId,
      Prisma.sql`
        WITH ${ledgerCte(tenantId)}
        SELECT l.* FROM ledger l
         WHERE l.kind = ${kind} AND l.source_id = ${id}::uuid
         LIMIT 1`,
    );
    if (!row) throw notFound();
    const payout = row.payout_id
      ? ((await this.payoutReports.salesByIds(tenantId, [row.payout_id]))[0] ?? null)
      : null;
    const [events, platform] = await Promise.all([
      this.events(tenantId, row, payout),
      this.platformInfo(tenantId),
    ]);
    return {
      sale: toSaleRow(row, payout),
      payout,
      events,
      hostedInvoiceUrl: row.hosted_invoice_url,
      period:
        row.period_start && row.period_end
          ? {
              start: new Date(row.period_start).toISOString(),
              end: new Date(row.period_end).toISOString(),
            }
          : null,
      platform,
    };
  }

  /** La historia de una venta, de la más antigua a la más reciente. */
  private async events(
    tenantId: string,
    row: LedgerSqlRow,
    payout: SaleView | null,
  ): Promise<SaleEvent[]> {
    const amount = intOrNull(row.presentment_amount) ?? Number(row.amount);
    const currency = (row.presentment_currency ?? row.currency).toLowerCase();
    const events: SaleEvent[] = [
      { type: 'paid', at: new Date(row.at).toISOString(), amount, currency },
    ];
    if (payout) {
      if (payout.transferredAt) {
        events.push({
          type: 'transferred',
          at: payout.transferredAt,
          amount: payout.transferAmount,
          currency: payout.currency,
        });
      }
      const [refunds, disputes] = await Promise.all([
        this.query<{ amount: number; currency: string; created_at: Date }>(
          tenantId,
          Prisma.sql`
            SELECT r.amount, r.currency, r.created_at FROM mod_payouts_refund r
             WHERE r.tenant_id = ${tenantId}::uuid AND r.sale_id = ${payout.id}::uuid
               AND r.status <> 'failed' AND r.status <> 'canceled'
             ORDER BY r.created_at`,
        ),
        this.query<{
          amount: number;
          currency: string;
          created_at: Date;
          updated_at: Date;
          outcome: string | null;
        }>(
          tenantId,
          Prisma.sql`
            SELECT d.amount, d.currency, d.created_at, d.updated_at, d.outcome
              FROM mod_payouts_dispute d
             WHERE d.tenant_id = ${tenantId}::uuid AND d.sale_id = ${payout.id}::uuid
             ORDER BY d.created_at`,
        ),
      ]);
      for (const r of refunds) {
        events.push({
          type: 'refunded',
          at: new Date(r.created_at).toISOString(),
          amount: Number(r.amount),
          currency: r.currency.toLowerCase(),
        });
      }
      for (const d of disputes) {
        events.push({
          type: 'dispute_opened',
          at: new Date(d.created_at).toISOString(),
          amount: Number(d.amount),
          currency: d.currency.toLowerCase(),
        });
        if (d.outcome === 'won' || d.outcome === 'lost') {
          events.push({
            type: d.outcome === 'won' ? 'dispute_won' : 'dispute_lost',
            at: new Date(d.updated_at).toISOString(),
            amount: Number(d.amount),
            currency: d.currency.toLowerCase(),
          });
        }
      }
    } else if (row.origin_refunded) {
      events.push({
        type: 'refunded',
        at: new Date(row.origin_refunded_at ?? row.at).toISOString(),
        amount,
        currency,
      });
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({
    message: 'Esa venta no existe en esta academia.',
    code: 'SALE_NOT_FOUND',
  });
}
