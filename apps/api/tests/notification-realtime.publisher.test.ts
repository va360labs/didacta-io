import { describe, expect, it, vi } from 'vitest';
import {
  NotificationRealtimePublisher,
  type RealtimePublisherRedis,
} from '../src/modules/notifications/realtime/notification-realtime.publisher';
import { channelFor } from '../src/modules/notifications/realtime/notification-realtime.types';

const noopLogger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as never;

describe('NotificationRealtimePublisher', () => {
  it('publica en el canal correcto con el payload serializado', async () => {
    const publish = vi.fn(async () => 1);
    const redis: RealtimePublisherRedis = { publish };
    const pub = new NotificationRealtimePublisher(redis, noopLogger);

    const createdAt = new Date('2026-06-03T10:00:00.000Z');
    await pub.publishInApp('t1', 'u1', {
      id: 'n-1',
      templateKey: 'enrollment.created',
      subject: 'Te matriculaste',
      createdAt,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0];
    expect(channel).toBe(channelFor('t1', 'u1'));
    expect(channel).toBe('didacta:rt:notif:t1:u1');
    const parsed = JSON.parse(message as string);
    expect(parsed).toEqual({
      id: 'n-1',
      templateKey: 'enrollment.created',
      subject: 'Te matriculaste',
      createdAt: createdAt.toISOString(),
    });
  });

  it('serializa createdAt string tal cual', async () => {
    const publish = vi.fn(async () => 1);
    const pub = new NotificationRealtimePublisher({ publish }, noopLogger);
    await pub.publishInApp('t1', 'u1', {
      id: 'n-2',
      templateKey: 'k',
      subject: null,
      createdAt: '2026-06-03T11:00:00.000Z',
    });
    const parsed = JSON.parse(publish.mock.calls[0][1] as string);
    expect(parsed.createdAt).toBe('2026-06-03T11:00:00.000Z');
    expect(parsed.subject).toBeNull();
  });

  it('redis null → no lanza y no intenta publicar', async () => {
    const pub = new NotificationRealtimePublisher(null, noopLogger);
    await expect(
      pub.publishInApp('t1', 'u1', {
        id: 'n-3',
        templateKey: 'k',
        subject: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('publish que rechaza NO rompe el caller (failsafe)', async () => {
    const publish = vi.fn(async () => {
      throw new Error('redis down');
    });
    const pub = new NotificationRealtimePublisher({ publish }, noopLogger);
    await expect(
      pub.publishInApp('t1', 'u1', {
        id: 'n-4',
        templateKey: 'k',
        subject: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
