import { describe, expect, it, vi } from 'vitest';
import { MessagingPresenceService, PRESENCE_WINDOW_MS } from './messaging-presence.service';

/**
 * Presencia efímera (ADR-019). En test no hay Redis (`NODE_ENV=test` evita
 * abrir cliente), así que se ejercita el espejo local — que es exactamente el
 * modo de degradación que corre en dev sin `REDIS_URL`.
 */
describe('MessagingPresenceService (sin Redis)', () => {
  it('cuenta a quien acaba de latir', async () => {
    const service = new MessagingPresenceService();
    service.onModuleInit();
    service.touch('t1', 'u1');
    service.touch('t1', 'u2');

    const snapshot = await service.snapshot('t1');
    expect(snapshot.onlineCount).toBe(2);
    expect([...snapshot.onlineUserIds].sort()).toEqual(['u1', 'u2']);
  });

  it('un usuario con varias pestañas cuenta UNA vez', async () => {
    const service = new MessagingPresenceService();
    service.onModuleInit();
    service.touch('t1', 'u1');
    service.touch('t1', 'u1');
    service.touch('t1', 'u1');

    const snapshot = await service.snapshot('t1');
    expect(snapshot.onlineCount).toBe(1);
  });

  it('caduca por ventana, sin borrado explícito', async () => {
    vi.useFakeTimers();
    try {
      const service = new MessagingPresenceService();
      service.onModuleInit();
      service.touch('t1', 'u1');

      // Justo dentro de la ventana: sigue presente.
      vi.advanceTimersByTime(PRESENCE_WINDOW_MS - 1_000);
      expect((await service.snapshot('t1')).onlineCount).toBe(1);

      // Pasada la ventana sin latir: desaparece solo.
      vi.advanceTimersByTime(2_000);
      expect((await service.snapshot('t1')).onlineCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un latido dentro de la ventana renueva la presencia', async () => {
    vi.useFakeTimers();
    try {
      const service = new MessagingPresenceService();
      service.onModuleInit();
      service.touch('t1', 'u1');
      vi.advanceTimersByTime(PRESENCE_WINDOW_MS - 1_000);
      service.touch('t1', 'u1');
      vi.advanceTimersByTime(PRESENCE_WINDOW_MS - 1_000);

      expect((await service.snapshot('t1')).onlineCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no filtra presencia entre tenants', async () => {
    const service = new MessagingPresenceService();
    service.onModuleInit();
    service.touch('t1', 'u1');
    service.touch('t2', 'u2');

    expect((await service.snapshot('t1')).onlineUserIds).toEqual(['u1']);
    expect((await service.snapshot('t2')).onlineUserIds).toEqual(['u2']);
  });

  it('un tenant sin nadie dentro devuelve cero, no revienta', async () => {
    const service = new MessagingPresenceService();
    service.onModuleInit();
    expect(await service.snapshot('desconocido')).toEqual({ onlineCount: 0, onlineUserIds: [] });
  });
});
