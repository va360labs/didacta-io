/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La clave de idempotencia de un evento tiene que CABER en el índice único de
 * `outbox_event (tenant_id, idempotency_key)`.
 *
 * Cada módulo la componía como `${name}:${JSON.stringify(data)}:${Date.now()}`,
 * con el payload entero dentro. La fila de un índice btree de Postgres no pasa
 * de 2.704 bytes: con un payload grande el INSERT del outbox falla, y falla
 * DESPUÉS de que la acción ya se haya hecho. El caso real es cancelar una clase
 * en directo: `zoom.session.cancelled` lleva en el payload a todos los
 * inscritos, así que con unas setenta personas la clase quedaba cancelada y
 * nadie recibía el aviso.
 *
 * Esto solo se reproduce contra un Postgres real: un doble en memoria no tiene
 * índice. Requiere `docker compose -f docker-compose.test.yml up -d` (o
 * `TEST_DATABASE_URL` apuntando a cualquier Postgres con el esquema aplicado).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventIdempotencyKey } from '@didacta/core-kernel';
import { PrismaClient } from '@didacta/database';
import { PersistentEventBus } from '../../src/modules/persistent-event-bus';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://didacta_test:didacta_test@localhost:5433/didacta_test?schema=public';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** La clave tal y como la componían los módulos. */
const claveAntigua = (name: string, data: unknown) =>
  `${name}:${JSON.stringify(data)}:${Date.now()}`;

describe('outbox: la clave de idempotencia cabe en el índice único', () => {
  let prisma: PrismaClient;
  let bus: PersistentEventBus;
  const tenantId = randomUUID();

  /** El payload de cancelar una clase con `n` inscritos. */
  const cancelacion = (n: number) => ({
    sessionId: randomUUID(),
    topic: 'Clase en directo',
    startTime: '2026-08-01T08:00:00.000Z',
    timezone: 'Europe/Madrid',
    registeredUserIds: Array.from({ length: n }, () => randomUUID()),
  });

  const evento = (name: string, data: unknown, idempotencyKey: string) => ({
    name,
    version: 1,
    data,
    metadata: {
      tenantId,
      timestamp: new Date().toISOString(),
      traceId: randomUUID(),
      idempotencyKey,
    },
  });

  const guardados = (name: string) =>
    prisma.outboxEvent.findMany({ where: { tenantId, eventName: name } });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
    await prisma.tenant.create({
      data: { id: tenantId, slug: `outbox-key-${tenantId.slice(0, 8)}`, name: 'Outbox key' },
    });
    bus = new PersistentEventBus(prisma as never, silentLogger as never);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('CONTROL: con la clave antigua, cancelar una clase con 200 inscritos no se puede publicar', async () => {
    const data = cancelacion(200);

    await expect(
      bus.publish(
        evento(
          'zoom.session.cancelled.control',
          data,
          claveAntigua('zoom.session.cancelled', data),
        ),
      ),
    ).rejects.toThrow(/index row|exceeds|maximum/i);

    // El evento NO existe: nadie va a avisar a esos 200 inscritos.
    expect(await guardados('zoom.session.cancelled.control')).toHaveLength(0);
  });

  it('con la clave acotada, el mismo evento se guarda con su payload ENTERO', async () => {
    const data = cancelacion(200);

    await bus.publish(
      evento('zoom.session.cancelled', data, eventIdempotencyKey('zoom.session.cancelled', data)),
    );

    const filas = await guardados('zoom.session.cancelled');
    expect(filas).toHaveLength(1);
    expect(filas[0]!.idempotencyKey.length).toBeLessThanOrEqual(256);
    // Acotar la clave no recorta lo que viaja: los 200 siguen en el payload.
    expect((filas[0]!.payload as { registeredUserIds: string[] }).registeredUserIds).toEqual(
      data.registeredUserIds,
    );
  });

  it('un payload de 1 MB de texto libre tampoco es problema', async () => {
    const data = { courseId: randomUUID(), reason: 'x'.repeat(1_000_000) };

    await bus.publish(
      evento(
        'ai-tutor.course.index-failed',
        data,
        eventIdempotencyKey('ai-tutor.course.index-failed', data),
      ),
    );

    expect(await guardados('ai-tutor.course.index-failed')).toHaveLength(1);
  });

  it('sigue deduplicando: la misma ocurrencia publicada dos veces es UNA fila', async () => {
    const data = { orderId: 'o-1' };
    const key = eventIdempotencyKey('billing.order.completed', data, 'o-1');

    await bus.publish(evento('billing.order.completed', data, key));
    await bus.publish(evento('billing.order.completed', data, key));

    expect(await guardados('billing.order.completed')).toHaveLength(1);
  });

  it('y no confunde dos eventos distintos del mismo instante', async () => {
    const ahora = Date.now();
    const a = { userId: randomUUID() };
    const b = { userId: randomUUID() };

    await bus.publish(
      evento(
        'learning.enrollment.created',
        a,
        eventIdempotencyKey('learning.enrollment.created', a, ahora),
      ),
    );
    await bus.publish(
      evento(
        'learning.enrollment.created',
        b,
        eventIdempotencyKey('learning.enrollment.created', b, ahora),
      ),
    );

    expect(await guardados('learning.enrollment.created')).toHaveLength(2);
  });
});
