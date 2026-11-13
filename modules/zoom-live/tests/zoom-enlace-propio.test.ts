/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { ZoomLiveService } from '../src/zoom-live.service.js';
import { ZoomNotConfiguredError } from '../src/errors.js';
import { createSessionSchema, updateSessionSchema } from '../src/dto.js';
import { zoomStubAllowed, hasZoomCredentials } from '../src/zoom-api-client.js';

/**
 * Directos sin credenciales (modo sencillo de Didacta Cloud): el formador pega
 * el enlace de su videollamada, y en producción ya no se guarda nunca el enlace
 * falso `stub-zoom.didacta.dev`.
 */

interface Row {
  id: string;
  tenantId: string;
  zoomMeetingId: string | null;
  joinUrl: string;
  startUrl: string;
  status: string;
  [k: string]: unknown;
}

function fakePrisma() {
  const rows: Row[] = [];
  return {
    rows,
    modZoomSession: {
      async create({ data }: { data: Row }) {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.push(row);
        return { ...row, _count: { registrations: 0 } };
      },
      async findFirst({ where }: { where: { id: string; tenantId: string } }) {
        return rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<Row> }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { ...row, _count: { registrations: 0 } };
      },
    },
  };
}

function ctx(credentials?: unknown) {
  return {
    eventBus: { async publish() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      async get() {
        return credentials;
      },
    },
  };
}

const BASE = {
  topic: 'Clase en directo',
  startTime: '2026-11-20T19:00:00+01:00',
  durationMinutes: 60,
  hostEmail: 'creadora@example.test',
  timezone: 'Europe/Madrid',
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = { NODE_ENV: process.env.NODE_ENV, ZOOM_ALLOW_STUB: process.env.ZOOM_ALLOW_STUB };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe('Directos con enlace propio', () => {
  it('guarda el enlace pegado como enlace de entrada, sin hablar con Zoom', async () => {
    const prisma = fakePrisma();
    const service = new ZoomLiveService(prisma as never, ctx() as never);
    const view = await withEnv({ NODE_ENV: 'production', ZOOM_ALLOW_STUB: undefined }, () =>
      service.create('t1', 'u1', {
        ...BASE,
        externalJoinUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    );
    expect(view.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(prisma.rows[0]?.zoomMeetingId).toBeNull();
    expect(prisma.rows[0]?.startUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('en producción, sin credenciales ni enlace, avisa en vez de inventar un enlace', async () => {
    const prisma = fakePrisma();
    const service = new ZoomLiveService(prisma as never, ctx() as never);
    await withEnv({ NODE_ENV: 'production', ZOOM_ALLOW_STUB: undefined }, async () => {
      await expect(service.create('t1', 'u1', BASE)).rejects.toBeInstanceOf(ZoomNotConfiguredError);
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('control: fuera de producción (o con ZOOM_ALLOW_STUB) sigue usando el cliente de pega', async () => {
    const prisma = fakePrisma();
    const service = new ZoomLiveService(prisma as never, ctx() as never);
    const view = await withEnv({ NODE_ENV: 'production', ZOOM_ALLOW_STUB: 'true' }, () =>
      service.create('t1', 'u1', BASE),
    );
    expect(view.joinUrl).toMatch(/^https:\/\/stub-zoom\.didacta\.dev\//);
  });

  it('el enlace propio se puede cambiar; el de una reunión de Zoom, no', async () => {
    const prisma = fakePrisma();
    const service = new ZoomLiveService(prisma as never, ctx() as never);
    const creada = await service.create('t1', 'u1', {
      ...BASE,
      externalJoinUrl: 'https://zoom.us/j/1',
    });
    await service.update('t1', 'u1', creada.id, {
      externalJoinUrl: 'https://teams.microsoft.com/l/x',
    });
    expect(prisma.rows[0]?.joinUrl).toBe('https://teams.microsoft.com/l/x');

    prisma.rows.push({
      ...prisma.rows[0]!,
      id: 'zoom-1',
      zoomMeetingId: null,
      joinUrl: 'https://zoom.us/j/2',
    });
    prisma.rows[1]!.zoomMeetingId = '999';
    const fixedApi = { async updateMeeting() {} };
    const conZoom = new ZoomLiveService(prisma as never, ctx() as never, fixedApi as never);
    await conZoom.update('t1', 'u1', 'zoom-1', { externalJoinUrl: 'https://otra.example/x' });
    expect(prisma.rows[1]?.joinUrl).toBe('https://zoom.us/j/2');
  });

  it('el esquema solo admite enlaces https', () => {
    expect(
      createSessionSchema.safeParse({ ...BASE, externalJoinUrl: 'https://meet.google.com/x' })
        .success,
    ).toBe(true);
    expect(
      createSessionSchema.safeParse({ ...BASE, externalJoinUrl: 'http://meet.google.com/x' })
        .success,
    ).toBe(false);
    expect(
      createSessionSchema.safeParse({ ...BASE, externalJoinUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(updateSessionSchema.safeParse({ externalJoinUrl: 'https://x.example' }).success).toBe(
      true,
    );
  });

  it('zoomStubAllowed y hasZoomCredentials', () => {
    expect(zoomStubAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(zoomStubAllowed({ NODE_ENV: 'production', ZOOM_ALLOW_STUB: 'true' })).toBe(true);
    expect(zoomStubAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(hasZoomCredentials({ accountId: 'a', clientId: 'b', clientSecret: 'c' })).toBe(true);
    expect(hasZoomCredentials({ accountId: 'a' })).toBe(false);
    expect(hasZoomCredentials(undefined)).toBe(false);
  });
});
