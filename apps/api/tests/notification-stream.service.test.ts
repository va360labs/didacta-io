import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { NotificationStreamService } from '../src/modules/notifications/realtime/notification-stream.service';
import { channelFor } from '../src/modules/notifications/realtime/notification-realtime.types';

const noopLogger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as never;

/** Acceso al método privado de ruteo para simular un pmessage de Redis. */
function dispatch(
  svc: NotificationStreamService,
  tenantId: string,
  userId: string,
  payload: object,
) {
  (svc as unknown as { dispatchLocal(ch: string, msg: string): void }).dispatchLocal(
    channelFor(tenantId, userId),
    JSON.stringify(payload),
  );
}

function makeService(): NotificationStreamService {
  // NODE_ENV=test → onModuleInit no crea subscriber Redis; igual setea heartbeat.
  const svc = new NotificationStreamService(noopLogger);
  svc.onModuleInit();
  return svc;
}

describe('NotificationStreamService', () => {
  let active: NotificationStreamService[] = [];

  afterEach(async () => {
    for (const s of active) await s.onApplicationShutdown();
    active = [];
  });

  function track(s: NotificationStreamService): NotificationStreamService {
    active.push(s);
    return s;
  }

  it('dos streams del mismo (tenant,user) reciben el mismo evento', () => {
    const svc = track(makeService());
    const a: MessageEvent[] = [];
    const b: MessageEvent[] = [];
    const subA = svc.register('t1', 'u1').subscribe((e) => a.push(e));
    const subB = svc.register('t1', 'u1').subscribe((e) => b.push(e));

    dispatch(svc, 't1', 'u1', { id: 'n-1', templateKey: 'k', subject: 's', createdAt: 'iso' });

    const notifA = a.filter((e) => e.type === 'notification');
    const notifB = b.filter((e) => e.type === 'notification');
    expect(notifA).toHaveLength(1);
    expect(notifB).toHaveLength(1);
    expect((notifA[0]!.data as { id: string }).id).toBe('n-1');

    subA.unsubscribe();
    subB.unsubscribe();
  });

  it('aislamiento por tenant: un evento de t1 no llega a u1 de t2', () => {
    const svc = track(makeService());
    const t1: MessageEvent[] = [];
    const t2: MessageEvent[] = [];
    const subT1 = svc.register('t1', 'u1').subscribe((e) => t1.push(e));
    const subT2 = svc.register('t2', 'u1').subscribe((e) => t2.push(e));

    dispatch(svc, 't1', 'u1', { id: 'n-1', templateKey: 'k', subject: null, createdAt: 'iso' });

    expect(t1.filter((e) => e.type === 'notification')).toHaveLength(1);
    expect(t2.filter((e) => e.type === 'notification')).toHaveLength(0);

    subT1.unsubscribe();
    subT2.unsubscribe();
  });

  it('aislamiento por user: un evento de u1 no llega a u2', () => {
    const svc = track(makeService());
    const u1: MessageEvent[] = [];
    const u2: MessageEvent[] = [];
    const s1 = svc.register('t1', 'u1').subscribe((e) => u1.push(e));
    const s2 = svc.register('t1', 'u2').subscribe((e) => u2.push(e));

    dispatch(svc, 't1', 'u2', { id: 'n-9', templateKey: 'k', subject: null, createdAt: 'iso' });

    expect(u1.filter((e) => e.type === 'notification')).toHaveLength(0);
    expect(u2.filter((e) => e.type === 'notification')).toHaveLength(1);

    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('cleanup: tras unsubscribe, el evento ya no se entrega', () => {
    const svc = track(makeService());
    const received: MessageEvent[] = [];
    const sub: Subscription = svc.register('t1', 'u1').subscribe((e) => received.push(e));

    dispatch(svc, 't1', 'u1', { id: 'n-1', templateKey: 'k', subject: null, createdAt: 'iso' });
    expect(received.filter((e) => e.type === 'notification')).toHaveLength(1);

    sub.unsubscribe();
    // El Set del userKey queda vacío → dispatchLocal no entrega nada.
    dispatch(svc, 't1', 'u1', { id: 'n-2', templateKey: 'k', subject: null, createdAt: 'iso' });
    expect(received.filter((e) => e.type === 'notification')).toHaveLength(1);
  });

  it('JSON inválido en dispatch no rompe', () => {
    const svc = track(makeService());
    const received: MessageEvent[] = [];
    const sub = svc.register('t1', 'u1').subscribe((e) => received.push(e));
    (svc as unknown as { dispatchLocal(ch: string, msg: string): void }).dispatchLocal(
      channelFor('t1', 'u1'),
      '{no-json',
    );
    expect(received.filter((e) => e.type === 'notification')).toHaveLength(0);
    sub.unsubscribe();
  });

  it('onApplicationShutdown completa los streams abiertos', async () => {
    const svc = makeService();
    let completed = false;
    const sub = svc.register('t1', 'u1').subscribe({ complete: () => (completed = true) });
    await svc.onApplicationShutdown();
    expect(completed).toBe(true);
    sub.unsubscribe();
  });
});
