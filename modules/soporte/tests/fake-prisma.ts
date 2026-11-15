/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Prisma en memoria para los tests del servicio: implementa solo lo que usa
 * `SoporteService` (create, findFirst, findMany, count, updateMany,
 * `$transaction` interactiva y el `$executeRaw` del candado) con los
 * operadores de `where` que aparecen en él. `ops` guarda el orden de las
 * llamadas para comprobar que el candado va antes de contar y crear. Un operador que no conoce hace
 * fallar el test en vez de ignorarse. Copiado del de Community (VA360): los
 * módulos no se importan entre sí.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return x < y ? -1 : 1;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return cmp(a, b) === 0;
  return a === b;
}

function matchField(val: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(val, cond);
  const ops = cond as Record<string, unknown>;
  const insensitive = ops['mode'] === 'insensitive';
  for (const [op, arg] of Object.entries(ops)) {
    if (arg === undefined || op === 'mode') continue;
    switch (op) {
      case 'equals':
        if (!same(val, arg)) return false;
        break;
      case 'in':
        if (!(arg as unknown[]).some((a) => same(val, a))) return false;
        break;
      case 'notIn':
        if ((arg as unknown[]).some((a) => same(val, a))) return false;
        break;
      case 'not':
        if (same(val, arg)) return false;
        break;
      case 'gt':
        if (val === null || cmp(val, arg) <= 0) return false;
        break;
      case 'gte':
        if (val === null || cmp(val, arg) < 0) return false;
        break;
      case 'lt':
        if (val === null || cmp(val, arg) >= 0) return false;
        break;
      case 'lte':
        if (val === null || cmp(val, arg) > 0) return false;
        break;
      case 'has':
        if (!Array.isArray(val) || !val.includes(arg)) return false;
        break;
      case 'contains': {
        const s = String(val ?? '');
        const needle = String(arg);
        const ok = insensitive
          ? s.toLowerCase().includes(needle.toLowerCase())
          : s.includes(needle);
        if (!ok) return false;
        break;
      }
      default:
        throw new Error(`fake-prisma: operador no soportado «${op}»`);
    }
  }
  return true;
}

export function matches(row: Row, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (k === 'OR') {
      if (!(v as Where[]).some((w) => matches(row, w))) return false;
    } else if (k === 'AND') {
      if (!(v as Where[]).every((w) => matches(row, w))) return false;
    } else if (!matchField(row[k], v)) {
      return false;
    }
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [field, dir] = Object.entries(o)[0]!;
      const c = cmp(a[field], b[field]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

function table(rows: Row[], defaults: () => Row, ops: string[]) {
  return {
    rows,
    create: async ({ data }: { data: Row }) => {
      ops.push('create');
      const row = { ...defaults(), ...data };
      rows.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where?: Where }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: { where?: Where; orderBy?: unknown; take?: number } = {}) => {
      const filtered = sortRows(
        rows.filter((x) => matches(x, where)),
        orderBy,
      );
      // Copias, como Prisma: una escritura posterior no cambia lo ya leído.
      return filtered.slice(0, take).map((r) => ({ ...r }));
    },
    count: async ({ where }: { where?: Where } = {}) => {
      ops.push('count');
      return rows.filter((x) => matches(x, where)).length;
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      ops.push('updateMany');
      const hit = rows.filter((x) => matches(x, where));
      for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
      return { count: hit.length };
    },
  };
}

/** Un `$executeRaw` recibido: el SQL con `$n` en los huecos y los valores ligados. */
export interface RawCall {
  sql: string;
  values: unknown[];
}

export function fakePrisma() {
  const tickets: Row[] = [];
  const ops: string[] = [];
  const raws: RawCall[] = [];
  const modSoporteTicket = table(
    tickets,
    () => ({
      id: randomUUID(),
      estado: 'NUEVO',
      contextoUrl: null,
      contextoUserAgent: null,
      contextoViewport: null,
      contextoAt: null,
      capturaKey: null,
      capturaContentType: null,
      capturaNombre: null,
      capturaSize: null,
      notaInterna: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    ops,
  );
  const db = {
    tickets,
    ops,
    raws,
    modSoporteTicket,
    /** Como el tagged template de Prisma: el SQL va aparte de los valores. */
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      ops.push('lock');
      raws.push({
        sql: strings.reduce((acc, part, i) => (i === 0 ? part : `${acc}$${i}${part}`), ''),
        values,
      });
      return 1;
    },
    /** Interactiva: se pasa a sí mismo como `tx` (sin aislamiento real). */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      ops.push('begin');
      const r = await fn(db);
      ops.push('commit');
      return r;
    },
  };
  return db;
}

export type FakePrisma = ReturnType<typeof fakePrisma>;
