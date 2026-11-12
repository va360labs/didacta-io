/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Base en memoria para los tests de liquidación, conciliador e informes de
 * mod.payouts. Imita lo justo de Prisma (filtros, orden, `createMany` con
 * `skipDuplicates`, `updateMany` con `increment`, `groupBy`) y dos cosas de
 * Postgres que el dominio necesita:
 *
 *  - RLS: un cliente «de tenant» solo ve y toca filas de ese tenant; el
 *    global, todas.
 *  - Transacciones: se ejecutan de una en una (como si fueran SERIALIZABLE) y
 *    se deshacen enteras si la función lanza.
 *
 * La concurrencia DE VERDAD (cerrojos, unicidad, RLS forzada como
 * `didacta_app`) la prueban los tests de integración contra Postgres.
 */

import { randomUUID } from 'node:crypto';
import type { PayoutsDbPort } from '../../src/accounts.service.js';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface ModelSpec {
  readonly tenantScoped: boolean;
  readonly primary: string;
  readonly unique: readonly string[];
  readonly defaults: () => Row;
}

const MODELS: Record<string, ModelSpec> = {
  modPayoutsSale: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id', 'stripeChargeId', 'stripeTransferId'],
    defaults: () => ({
      id: randomUUID(),
      description: null,
      buyerEmail: null,
      stripePaymentIntentId: null,
      stripeInvoiceId: null,
      stripeBalanceTransactionId: null,
      gross: null,
      stripeFee: null,
      feeBpsApplied: null,
      platformFee: null,
      creatorNet: null,
      debtNetted: 0,
      transferAmount: null,
      currency: null,
      stripeTransferId: null,
      status: 'AWAITING_FEE',
      refundedAmount: 0,
      reversedAmount: 0,
      availableOn: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      chargedAt: null,
      transferredAt: null,
    }),
  },
  modPayoutsAccount: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id', 'stripeAccountId'],
    defaults: () => ({
      id: randomUUID(),
      stripeAccountId: null,
      status: 'NOT_CONNECTED',
      payoutSchedule: null,
      closedAt: null,
      livemode: false,
      defaultCurrency: null,
    }),
  },
  modPayoutsDebt: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id'],
    defaults: () => ({ id: randomUUID(), status: 'OPEN', originSaleId: null }),
  },
  modPayoutsLedgerEntry: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id', 'idempotencyKey'],
    defaults: () => ({
      id: randomUUID(),
      saleId: null,
      stripeObjectId: null,
      stripeBalanceTransactionId: null,
      metadata: {},
    }),
  },
  modPayoutsSettings: {
    tenantScoped: true,
    primary: 'tenantId',
    unique: ['tenantId'],
    defaults: () => ({ feeBps: 500, updatedBy: null }),
  },
  modPayoutsObjectRef: {
    tenantScoped: true,
    primary: 'stripeObjectId',
    unique: ['stripeObjectId'],
    defaults: () => ({ localRef: null, parentObjectId: null, livemode: false }),
  },
  modPayoutsWebhookEvent: {
    tenantScoped: true,
    primary: 'stripeEventId',
    unique: ['stripeEventId'],
    defaults: () => ({
      tenantId: null,
      objectId: null,
      payload: {},
      processedAt: null,
      errorMessage: null,
      attempts: 0,
    }),
  },
  modPayoutsRefund: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id', 'stripeRefundId'],
    defaults: () => ({
      id: randomUUID(),
      status: 'pending',
      stripeRefundId: null,
      reversalTarget: null,
      stripeReversalId: null,
      reversalStatus: null,
      initiatedBy: null,
      reason: null,
    }),
  },
  modPayoutsDispute: {
    tenantScoped: true,
    primary: 'id',
    unique: ['id', 'stripeDisputeId'],
    defaults: () => ({
      id: randomUUID(),
      fee: 0,
      reason: null,
      evidenceDueBy: null,
      stripeReversalId: null,
      outcome: null,
    }),
  },
};

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  return (av as number | string) < (bv as number | string) ? -1 : 1;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)
  );
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, cond as Where)) return false;
      continue;
    }
    const value = row[key];
    if (isOperatorObject(cond)) {
      for (const [op, arg] of Object.entries(cond)) {
        if (arg === undefined) continue;
        switch (op) {
          case 'equals':
            if (!same(value, arg)) return false;
            break;
          case 'in':
            if (!(arg as unknown[]).some((v) => same(value, v))) return false;
            break;
          case 'notIn':
            if ((arg as unknown[]).some((v) => same(value, v))) return false;
            break;
          case 'not':
            if (same(value, arg)) return false;
            break;
          case 'lt':
            if (value === null || value === undefined || compare(value, arg) >= 0) return false;
            break;
          case 'lte':
            if (value === null || value === undefined || compare(value, arg) > 0) return false;
            break;
          case 'gt':
            if (value === null || value === undefined || compare(value, arg) <= 0) return false;
            break;
          case 'gte':
            if (value === null || value === undefined || compare(value, arg) < 0) return false;
            break;
          case 'contains':
            if (typeof value !== 'string' || !value.includes(String(arg))) return false;
            break;
          case 'startsWith':
            if (typeof value !== 'string' || !value.startsWith(String(arg))) return false;
            break;
          default:
            throw new Error(`fake-payouts-db: operador no soportado ${op}`);
        }
      }
      continue;
    }
    if (!same(value ?? null, cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, unknown>>;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const sort = typeof dir === 'string' ? dir : (dir as { sort: string }).sort;
        const nulls =
          typeof dir === 'object'
            ? (dir as { nulls?: string }).nulls
            : sort === 'asc'
              ? 'last'
              : 'first';
        const av = a[field];
        const bv = b[field];
        if ((av ?? null) === null && (bv ?? null) === null) continue;
        if ((av ?? null) === null) return nulls === 'first' ? -1 : 1;
        if ((bv ?? null) === null) return nulls === 'first' ? 1 : -1;
        const c = compare(av, bv);
        if (c !== 0) return sort === 'desc' ? -c : c;
      }
    }
    return 0;
  });
}

function pick(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
  return out;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakePayoutsDb {
  readonly tables: Record<string, Row[]> = Object.fromEntries(
    Object.keys(MODELS).map((name) => [name, [] as Row[]]),
  );
  /** Reloj de las columnas `createdAt`/`updatedAt`. */
  clock: () => Date = () => new Date();
  private queue: Promise<unknown> = Promise.resolve();
  transactions = 0;

  /** Inserta filas tal cual (con los valores por defecto del modelo). */
  insert(model: keyof typeof MODELS & string, ...rows: Row[]): Row[] {
    const spec = MODELS[model]!;
    return rows.map((row) => {
      const now = this.clock();
      const full = { ...spec.defaults(), createdAt: now, updatedAt: now, ...row };
      this.tables[model]!.push(full);
      return full;
    });
  }

  rows(model: keyof typeof MODELS & string, where?: Where): Row[] {
    return this.tables[model]!.filter((row) => matches(row, where)).map((r) => ({ ...r }));
  }

  /** Cliente visto desde un tenant (`null` = acceso global). */
  client(tenantId: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = {
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
    };
    for (const name of Object.keys(MODELS)) out[name] = this.model(name, tenantId);
    return out;
  }

  port(): PayoutsDbPort {
    return {
      inTenant: (tenantId, fn) => this.transaction(() => fn(this.client(tenantId) as never)),
      global: (fn) => this.transaction(() => fn(this.client(null) as never)),
    };
  }

  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.transactions += 1;
      const snapshot = clone(this.tables);
      try {
        return await fn();
      } catch (err) {
        for (const key of Object.keys(this.tables)) this.tables[key] = snapshot[key]!;
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private model(name: string, tenantId: string | null) {
    const spec = MODELS[name]!;
    const table = () => this.tables[name]!;
    const visible = () =>
      tenantId === null || !spec.tenantScoped
        ? table()
        : table().filter((row) => row['tenantId'] === tenantId);
    const find = (where: Where | undefined) => visible().filter((row) => matches(row, where));
    const conflict = (row: Row) =>
      table().some((existing) =>
        spec.unique.some(
          (key) => row[key] !== undefined && row[key] !== null && same(existing[key], row[key]),
        ),
      );
    const applyData = (row: Row, data: Row) => {
      for (const [key, value] of Object.entries(data)) {
        if (isOperatorObject(value) && 'increment' in value) {
          row[key] = (row[key] as number) + (value['increment'] as number);
        } else if (value !== undefined) {
          row[key] = value;
        }
      }
      row['updatedAt'] = this.clock();
    };
    const assertTenant = (row: Row) => {
      if (spec.tenantScoped && tenantId !== null && row['tenantId'] !== tenantId) {
        throw new Error(`RLS: ${name} con tenant ${String(row['tenantId'])} desde ${tenantId}`);
      }
    };

    return {
      findFirst: async (
        args: { where?: Where; orderBy?: unknown; select?: Record<string, unknown> } = {},
      ) => {
        const found = sortRows(find(args.where), args.orderBy)[0];
        return found ? pick(found, args.select) : null;
      },
      findFirstOrThrow: async (args: { where?: Where; select?: Record<string, unknown> } = {}) => {
        const found = find(args.where)[0];
        if (!found) throw new Error(`${name}: no encontrado`);
        return pick(found, args.select);
      },
      findUnique: async (args: { where: Where; select?: Record<string, unknown> }) => {
        const found = find(args.where)[0];
        return found ? pick(found, args.select) : null;
      },
      findUniqueOrThrow: async (args: { where: Where; select?: Record<string, unknown> }) => {
        const found = find(args.where)[0];
        if (!found) throw new Error(`${name}: no encontrado`);
        return pick(found, args.select);
      },
      findMany: async (
        args: {
          where?: Where;
          orderBy?: unknown;
          skip?: number;
          take?: number;
          select?: Record<string, unknown>;
        } = {},
      ) => {
        const sorted = sortRows(find(args.where), args.orderBy);
        const sliced = sorted.slice(
          args.skip ?? 0,
          (args.skip ?? 0) + (args.take ?? sorted.length),
        );
        return sliced.map((row) => pick(row, args.select));
      },
      count: async (args: { where?: Where } = {}) => find(args.where).length,
      create: async (args: { data: Row }) => {
        const now = this.clock();
        const row = { ...spec.defaults(), createdAt: now, updatedAt: now, ...args.data };
        assertTenant(row);
        if (conflict(row)) throw new Error(`${name}: unique violation`);
        table().push(row);
        return { ...row };
      },
      createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          const now = this.clock();
          const row = { ...spec.defaults(), createdAt: now, updatedAt: now, ...data };
          assertTenant(row);
          if (conflict(row)) {
            if (args.skipDuplicates) continue;
            throw new Error(`${name}: unique violation`);
          }
          table().push(row);
          count += 1;
        }
        return { count };
      },
      update: async (args: { where: Where; data: Row }) => {
        const found = find(args.where)[0];
        if (!found) throw new Error(`${name}: no encontrado para update`);
        applyData(found, args.data);
        return { ...found };
      },
      updateMany: async (args: { where?: Where; data: Row }) => {
        const found = find(args.where);
        for (const row of found) applyData(row, args.data);
        return { count: found.length };
      },
      upsert: async (args: { where: Where; create: Row; update: Row }) => {
        const found = find(args.where)[0];
        if (found) {
          applyData(found, args.update);
          return { ...found };
        }
        const now = this.clock();
        const row = { ...spec.defaults(), createdAt: now, updatedAt: now, ...args.create };
        table().push(row);
        return { ...row };
      },
      groupBy: async (args: {
        by: string[];
        where?: Where;
        _sum?: Record<string, boolean>;
        _count?: { _all?: boolean };
        orderBy?: unknown;
      }) => {
        const groups = new Map<string, Row[]>();
        for (const row of find(args.where)) {
          const key = JSON.stringify(args.by.map((field) => row[field] ?? null));
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        const out = [...groups.values()].map((rows) => {
          const group: Row = {};
          for (const field of args.by) group[field] = rows[0]![field] ?? null;
          if (args._sum) {
            const sums: Row = {};
            for (const field of Object.keys(args._sum)) {
              const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
              sums[field] = values.length ? (values as number[]).reduce((a, b) => a + b, 0) : null;
            }
            group['_sum'] = sums;
          }
          if (args._count) group['_count'] = { _all: rows.length };
          return group;
        });
        return sortRows(out, args.orderBy);
      },
    };
  }
}
