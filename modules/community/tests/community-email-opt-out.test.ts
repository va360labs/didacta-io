/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { CommunityService } from '../src/community.service.js';

/**
 * Darse de baja de los correos de la comunidad es UNA decisión.
 *
 * Hay dos marcas por historia: `digestOptOut` (el interruptor «Comunidad ·
 * Email» de /cuenta) y `broadcastOptOut` (el enlace de baja de un correo). Cada
 * una cortaba solo lo suyo: quien pulsaba «darse de baja» en un aviso seguía
 * recibiendo el resumen semanal, y quien apagaba el interruptor seguía
 * recibiendo los avisos.
 *
 * Y a una cuenta eliminada no se le escribe: `status` solo no basta, porque hay
 * borrados que no lo tocan.
 *
 * El Prisma de mentira evalúa los `where` de verdad (igualdades, `in`, `gt`,
 * `OR`, `deletedAt: null`) para que estos tests sirvan igual contra la consulta
 * de antes que contra la nueva: lo que cambia es el resultado, no la forma.
 */

const TENANT = 't1';
const BROADCAST = 'b1';

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  status: string;
  deletedAt: Date | null;
}

interface PrefRow {
  id?: string;
  tenantId: string;
  userId: string;
  digestOptOut: boolean;
  broadcastOptOut: boolean;
}

type PrefWhere = {
  tenantId?: string;
  userId?: { in: string[] };
  digestOptOut?: boolean;
  broadcastOptOut?: boolean;
  OR?: PrefWhere[];
};

function matchPref(p: PrefRow, where: PrefWhere): boolean {
  if (where.tenantId !== undefined && p.tenantId !== where.tenantId) return false;
  if (where.userId?.in && !where.userId.in.includes(p.userId)) return false;
  if (where.digestOptOut !== undefined && p.digestOptOut !== where.digestOptOut) return false;
  if (where.broadcastOptOut !== undefined && p.broadcastOptOut !== where.broadcastOptOut)
    return false;
  if (where.OR && !where.OR.some((clause) => matchPref(p, clause))) return false;
  return true;
}

type UserWhere = {
  tenantId?: string;
  status?: string;
  deletedAt?: null;
  id?: { gt: string };
};

function matchUser(u: UserRow, where: UserWhere): boolean {
  if (where.tenantId !== undefined && u.tenantId !== where.tenantId) return false;
  if (where.status !== undefined && u.status !== where.status) return false;
  if ('deletedAt' in where && where.deletedAt === null && u.deletedAt !== null) return false;
  if (where.id?.gt !== undefined && !(u.id > where.id.gt)) return false;
  return true;
}

function user(id: string, over: Partial<UserRow> = {}): UserRow {
  return {
    id,
    tenantId: TENANT,
    email: `${id}@example.test`,
    status: 'ACTIVE',
    deletedAt: null,
    ...over,
  };
}

function setup(opts: { users: UserRow[]; prefs?: PrefRow[] }) {
  const users = opts.users;
  const prefs: PrefRow[] = opts.prefs ?? [];
  const broadcasts = [
    {
      id: BROADCAST,
      tenantId: TENANT,
      status: 'PENDING',
      cursorUserId: null as string | null,
      important: false,
      total: 0,
    },
  ];

  const prisma = {
    user: {
      async findMany(args: { where: UserWhere; take?: number }) {
        return users
          .filter((u) => matchUser(u, args.where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, args.take ?? 50_000);
      },
      async count(args: { where: UserWhere }) {
        return users.filter((u) => matchUser(u, args.where)).length;
      },
    },
    modCommunityUserPref: {
      async findMany(args: { where: PrefWhere }) {
        return prefs.filter((p) => matchPref(p, args.where));
      },
      async findUnique(args: { where: { tenantId_userId: { tenantId: string; userId: string } } }) {
        const k = args.where.tenantId_userId;
        return prefs.find((p) => p.tenantId === k.tenantId && p.userId === k.userId) ?? null;
      },
      async upsert(args: {
        where: { tenantId_userId: { tenantId: string; userId: string } };
        create: Partial<PrefRow> & { tenantId: string; userId: string };
        update: Partial<PrefRow>;
      }) {
        const k = args.where.tenantId_userId;
        const found = prefs.find((p) => p.tenantId === k.tenantId && p.userId === k.userId);
        if (found) {
          Object.assign(found, args.update);
          return found;
        }
        // Los defaults de la tabla: las dos marcas nacen en `false`.
        const row: PrefRow = { digestOptOut: false, broadcastOptOut: false, ...args.create };
        prefs.push(row);
        return row;
      },
    },
    modCommunityBroadcast: {
      async findUnique(args: { where: { id: string } }) {
        return broadcasts.find((b) => b.id === args.where.id) ?? null;
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const b = broadcasts.find((x) => x.id === args.where.id)!;
        Object.assign(b, args.data);
        return b;
      },
      async create(args: { data: Record<string, unknown> }) {
        return { id: 'nuevo', ...args.data };
      },
    },
  };
  const ctx = { eventBus: { publish: async () => {} } } as never;
  const service = new CommunityService(prisma as never, ctx);

  /** A quién le llegaría el resumen semanal. */
  const digestRecipients = async () =>
    (await service.listActiveUsersForDigest()).map((u) => u.userId).sort();

  /** A quién le llegaría un aviso masivo NO importante. */
  const broadcastRecipients = async () => {
    const { recipients } = await service.claimBroadcastBatch(BROADCAST, 100);
    return recipients
      .filter((r) => !r.optedOut)
      .map((r) => r.userId)
      .sort();
  };

  return { service, prefs, digestRecipients, broadcastRecipients };
}

describe('baja de los correos de la comunidad · una baja corta los dos correos', () => {
  it('CONTROL: sin ninguna baja, resumen y aviso llegan a todos', async () => {
    const t = setup({ users: [user('u1'), user('u2')] });
    expect(await t.digestRecipients()).toEqual(['u1', 'u2']);
    expect(await t.broadcastRecipients()).toEqual(['u1', 'u2']);
  });

  it('el enlace de baja de un correo corta el aviso Y el resumen semanal', async () => {
    const t = setup({ users: [user('u1'), user('u2')] });

    await t.service.setCommunityEmailOptOut(TENANT, 'u2', true);

    expect(await t.broadcastRecipients()).toEqual(['u1']);
    // Antes solo se marcaba `broadcastOptOut` y el resumen seguía saliendo.
    expect(await t.digestRecipients()).toEqual(['u1']);
  });

  it('una baja antigua hecha solo desde un aviso (broadcastOptOut) también corta el resumen', async () => {
    // Filas que ya existen en instalaciones en marcha: se dieron de baja con el
    // enlace cuando solo marcaba una de las dos.
    const t = setup({
      users: [user('u1'), user('u2')],
      prefs: [{ tenantId: TENANT, userId: 'u2', digestOptOut: false, broadcastOptOut: true }],
    });
    expect(await t.digestRecipients()).toEqual(['u1']);
  });

  it('una baja antigua hecha solo desde /cuenta (digestOptOut) también corta los avisos', async () => {
    const t = setup({
      users: [user('u1'), user('u2')],
      prefs: [{ tenantId: TENANT, userId: 'u2', digestOptOut: true, broadcastOptOut: false }],
    });
    expect(await t.broadcastRecipients()).toEqual(['u1']);
  });

  it('apagar el interruptor de /cuenta corta el resumen Y los avisos', async () => {
    const t = setup({ users: [user('u1'), user('u2')] });

    const out = await t.service.updateUserPreferences(TENANT, 'u2', { digestOptOut: true });

    expect(out).toEqual({ digestOptOut: true });
    expect(await t.digestRecipients()).toEqual(['u1']);
    expect(await t.broadcastRecipients()).toEqual(['u1']);
  });

  it('/cuenta enseña apagado el interruptor de quien se dio de baja por enlace', async () => {
    const t = setup({
      users: [user('u1')],
      prefs: [{ tenantId: TENANT, userId: 'u1', digestOptOut: false, broadcastOptOut: true }],
    });
    expect(await t.service.getUserPreferences(TENANT, 'u1')).toEqual({ digestOptOut: true });
  });

  it('volver a encenderlo en /cuenta reactiva los dos correos, también tras una baja por enlace', async () => {
    const t = setup({ users: [user('u1')] });
    await t.service.setCommunityEmailOptOut(TENANT, 'u1', true);
    expect(await t.digestRecipients()).toEqual([]);

    const out = await t.service.updateUserPreferences(TENANT, 'u1', { digestOptOut: false });

    expect(out).toEqual({ digestOptOut: false });
    expect(t.prefs[0]).toMatchObject({ digestOptOut: false, broadcastOptOut: false });
    expect(await t.digestRecipients()).toEqual(['u1']);
    expect(await t.broadcastRecipients()).toEqual(['u1']);
  });

  it('un patch sin `digestOptOut` no toca ninguna de las dos marcas', async () => {
    const t = setup({
      users: [user('u1')],
      prefs: [{ tenantId: TENANT, userId: 'u1', digestOptOut: true, broadcastOptOut: true }],
    });
    expect(await t.service.updateUserPreferences(TENANT, 'u1', {})).toEqual({
      digestOptOut: true,
    });
    expect(t.prefs[0]).toMatchObject({ digestOptOut: true, broadcastOptOut: true });
  });

  it('los avisos `important` siguen viendo la baja como dato: quien decide es el worker', async () => {
    const t = setup({ users: [user('u1')] });
    await t.service.setCommunityEmailOptOut(TENANT, 'u1', true);
    const { recipients } = await t.service.claimBroadcastBatch(BROADCAST, 100);
    // El destinatario SIGUE en el lote, marcado: un aviso importante se le
    // manda igual y uno normal se salta.
    expect(recipients).toEqual([{ userId: 'u1', email: 'u1@example.test', optedOut: true }]);
  });
});

describe('correos de la comunidad · a una cuenta eliminada no se le escribe', () => {
  const eliminada = user('u2', { deletedAt: new Date('2026-01-10T10:00:00.000Z') });

  it('el resumen semanal no sale para una cuenta eliminada que sigue ACTIVE', async () => {
    const t = setup({ users: [user('u1'), eliminada] });
    expect(await t.digestRecipients()).toEqual(['u1']);
  });

  it('el aviso masivo tampoco, ni siquiera entra en el lote', async () => {
    const t = setup({ users: [user('u1'), eliminada] });
    const { recipients } = await t.service.claimBroadcastBatch(BROADCAST, 100);
    expect(recipients.map((r) => r.userId)).toEqual(['u1']);
  });

  it('el total del aviso cuenta solo a quien se le va a escribir', async () => {
    const t = setup({
      users: [user('u1'), eliminada, user('u3', { status: 'SUSPENDED' })],
    });
    const created = await t.service.createBroadcast(TENANT, 'admin', {
      subject: 'Aviso',
      bodyText: 'Hola',
    });
    expect((created as unknown as { total: number }).total).toBe(1);
  });
});
