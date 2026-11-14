/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';

/**
 * Prisma en memoria para las tres tablas de mod.retention. Solo entiende los
 * operadores que usa el servicio (igualdad, in, not, gte/lte/lt, startsWith,
 * endsWith, OR) y simula las claves únicas: lo justo para probar el dominio
 * sin base de datos. La prueba contra Postgres de verdad (RLS como
 * `didacta_app`) está en apps/api/tests/integration.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function cmp(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== 'object') return value === cond;
  const c = cond as Record<string, unknown>;
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case 'in':
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case 'not':
        if (arg !== null && typeof arg === 'object' && !(arg instanceof Date)) {
          if (cmp(value, arg)) return false;
        } else if (arg === null ? value === null || value === undefined : value === arg) {
          return false;
        }
        break;
      case 'gte':
        if (!(value instanceof Date) || value.getTime() < (arg as Date).getTime()) return false;
        break;
      case 'lte':
        if (!(value instanceof Date) || value.getTime() > (arg as Date).getTime()) return false;
        break;
      case 'lt':
        if (!(value instanceof Date) || value.getTime() >= (arg as Date).getTime()) return false;
        break;
      case 'gt':
        if (!(value instanceof Date) || value.getTime() <= (arg as Date).getTime()) return false;
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !value.startsWith(arg as string)) return false;
        break;
      case 'endsWith':
        if (typeof value !== 'string' || !value.endsWith(arg as string)) return false;
        break;
      default:
        throw new Error(`fake-prisma: operador no soportado ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (!cmp(row[key], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0] as [string, 'asc' | 'desc'];
      const av = a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number | string);
      const bv = b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number | string);
      if (av === bv) continue;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const r = av < bv ? -1 : 1;
      return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

function pick(row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const k of Object.keys(select)) out[k] = row[k];
  return out;
}

class Table {
  rows: Row[] = [];
  constructor(
    private readonly defaults: () => Row,
    private readonly uniqueKey?: (r: Row) => string,
    private readonly include?: (r: Row, inc: Record<string, unknown>) => Row,
  ) {}

  private withInclude(r: Row, args: { include?: Record<string, unknown> }): Row {
    return args.include && this.include ? this.include({ ...r }, args.include) : { ...r };
  }

  async findUnique(args: { where: Where; select?: Record<string, unknown> }) {
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? pick(r, args.select) : null;
  }

  async findFirst(args: {
    where?: Where;
    orderBy?: unknown;
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  }) {
    const r = sortRows(
      this.rows.filter((x) => matches(x, args.where)),
      args.orderBy,
    )[0];
    return r ? pick(this.withInclude(r, args), args.select) : null;
  }

  async findMany(
    args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
      distinct?: string[];
    } = {},
  ) {
    let rows = sortRows(
      this.rows.filter((x) => matches(x, args.where)),
      args.orderBy,
    );
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = args.distinct!.map((d) => String(r[d])).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => pick(this.withInclude(r, args), args.select));
  }

  async create(args: { data: Row }) {
    const row = { ...this.defaults(), ...args.data };
    if (this.uniqueKey && this.rows.some((r) => this.uniqueKey!(r) === this.uniqueKey!(row))) {
      const err = new Error('Unique constraint failed') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    }
    this.rows.push(row);
    return { ...row };
  }

  async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
    let count = 0;
    for (const d of args.data) {
      const row = { ...this.defaults(), ...d };
      if (this.uniqueKey && this.rows.some((r) => this.uniqueKey!(r) === this.uniqueKey!(row))) {
        if (args.skipDuplicates) continue;
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      this.rows.push(row);
      count++;
    }
    return { count };
  }

  async update(args: { where: Where; data: Row }) {
    const r = this.rows.find((x) => matches(x, args.where));
    if (!r) throw new Error('fake-prisma: update sin fila');
    Object.assign(r, args.data, 'updatedAt' in r ? { updatedAt: new Date() } : {});
    return { ...r };
  }

  async updateMany(args: { where: Where; data: Row }) {
    let count = 0;
    for (const r of this.rows) {
      if (matches(r, args.where)) {
        Object.assign(r, args.data, 'updatedAt' in r ? { updatedAt: new Date() } : {});
        count++;
      }
    }
    return { count };
  }

  async upsert(args: { where: Where; create: Row; update: Row }) {
    const r = this.rows.find((x) => matches(x, args.where));
    if (r) {
      Object.assign(r, args.update);
      return { ...r };
    }
    return this.create({ data: args.create });
  }

  async groupBy(args: { by: string[]; where?: Where; _count: { _all: true } }) {
    const groups = new Map<string, Row>();
    for (const r of this.rows.filter((x) => matches(x, args.where))) {
      const key = args.by.map((b) => String(r[b])).join('|');
      let g = groups.get(key);
      if (!g) {
        g = Object.fromEntries(args.by.map((b) => [b, r[b]]));
        g['_count'] = { _all: 0 };
        groups.set(key, g);
      }
      (g['_count'] as { _all: number })._all++;
    }
    return [...groups.values()];
  }
}

export function createFakePrisma() {
  const automations = new Table(() => ({
    id: randomUUID(),
    templateKey: null,
    days: null,
    resendAfterDays: null,
    emailEnabled: false,
    emailSubject: null,
    enabled: false,
    activatedAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }));
  const deliveries = new Table(
    () => ({
      id: randomUUID(),
      status: 'PENDING',
      context: {},
      manual: false,
      sentAt: null,
      conversationId: null,
      messageId: null,
      emailSentAt: null,
      emailSkipReason: null,
      readAt: null,
      repliedAt: null,
      skipReason: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    (r) => `${r['tenantId']}|${r['automationId']}|${r['userId']}|${r['occurrenceKey']}`,
    (r, inc) => {
      if (inc['automation']) {
        r['automation'] = automations.rows.find((a) => a['id'] === r['automationId']);
      }
      return r;
    },
  );
  const settings = new Table(
    () => ({ createdAt: new Date(), updatedAt: new Date(), updatedById: null }),
    (r) => String(r['tenantId']),
  );
  return {
    modRetentionAutomation: automations,
    modRetentionDelivery: deliveries,
    modRetentionSettings: settings,
  };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;
