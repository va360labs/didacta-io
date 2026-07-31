/**
 * Tests del núcleo del transporte SSE de notificaciones
 * (`createNotificationsStream`).
 *
 * Cobertura:
 *  - De-dup por `id`: un evento repetido no dispara `onEvent` dos veces.
 *  - Ignora keep-alive `{type:'ping'}` y JSON inválido.
 *  - Pide un ticket NUEVO en cada (re)conexión.
 *  - Fallback a polling tras N (=4) errores consecutivos → estado `degraded`
 *    y ticks `onEvent(null)` cada POLL_MS.
 *  - Reanudación: un `onopen` posterior detiene el polling y vuelve a `push`.
 *  - `dispose` cierra el EventSource y no emite más.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNotificationsStream,
  POLL_MS,
  type EventSourceLike,
  type NotificationsStreamStatus,
  type StreamDeps,
} from './use-notifications-stream';

/** EventSource falso controlable desde el test. */
class FakeEventSource implements EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null = null;
  onmessage: ((this: unknown, ev: { data: string }) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  open() {
    this.onopen?.(undefined);
  }
  fail() {
    this.onerror?.(undefined);
  }
}

interface Harness {
  controller: ReturnType<typeof createNotificationsStream>;
  sources: FakeEventSource[];
  events: Array<unknown>;
  statuses: NotificationsStreamStatus[];
  ticketCalls: () => number;
  flush: () => Promise<void>;
}

function makeHarness(overrides: Partial<StreamDeps> = {}): Harness {
  const sources: FakeEventSource[] = [];
  const events: unknown[] = [];
  const statuses: NotificationsStreamStatus[] = [];
  let ticketCount = 0;

  const deps: StreamDeps = {
    getTicket: vi.fn(async () => {
      ticketCount += 1;
      return { ticket: `ticket-${ticketCount}` };
    }),
    createEventSource: (url: string) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as StreamDeps['setTimeout'],
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as StreamDeps['setInterval'],
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    random: () => 0, // jitter determinista (cero)
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    ...overrides,
  };

  const controller = createNotificationsStream(deps);
  return {
    controller,
    sources,
    events,
    statuses,
    ticketCalls: () => ticketCount,
    // Vacía la microtask queue para que el `await getTicket()` resuelva.
    flush: async () => {
      await vi.runOnlyPendingTimersAsync();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createNotificationsStream', () => {
  it('pide ticket y abre el EventSource con el ticket en la query', async () => {
    const h = makeHarness();
    await vi.runOnlyPendingTimersAsync();

    expect(h.ticketCalls()).toBe(1);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.url).toContain('ticket=ticket-1');

    h.sources[0]?.open();
    expect(h.statuses).toContain('push');
    h.controller.dispose();
  });

  it('de-duplica eventos por id', async () => {
    const h = makeHarness();
    await vi.runOnlyPendingTimersAsync();
    const es = h.sources[0]!;
    es.open();

    const evt = { id: 'n1', templateKey: 'k', subject: 's', createdAt: 'now' };
    es.emit(evt);
    es.emit(evt); // mismo id → ignorado
    es.emit({ id: 'n2', templateKey: 'k', subject: null, createdAt: 'now' });

    expect(h.events).toHaveLength(2);
    expect((h.events[0] as { id: string }).id).toBe('n1');
    expect((h.events[1] as { id: string }).id).toBe('n2');
    h.controller.dispose();
  });

  it('ignora pings y JSON inválido', async () => {
    const h = makeHarness();
    await vi.runOnlyPendingTimersAsync();
    const es = h.sources[0]!;
    es.open();

    es.emit({ type: 'ping' });
    es.onmessage?.({ data: 'no-es-json{' });
    es.emit({ templateKey: 'k' }); // sin id → ignorado

    expect(h.events).toHaveLength(0);
    h.controller.dispose();
  });

  it('cae a polling tras 4 errores y emite ticks null cada POLL_MS', async () => {
    const h = makeHarness();

    // 4 ciclos: cada uno abre un ES, falla, y reprograma (o degrada al 4º).
    for (let i = 0; i < 4; i += 1) {
      await vi.runOnlyPendingTimersAsync();
      const es = h.sources[h.sources.length - 1]!;
      es.fail();
      // Avanza el backoff para disparar el siguiente reintento.
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_FALLBACK_TICK);
    }

    expect(h.statuses).toContain('degraded');
    // Cada reconexión pidió un ticket nuevo.
    expect(h.ticketCalls()).toBeGreaterThanOrEqual(4);

    const before = h.events.length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.events.length).toBe(before + 1);
    expect(h.events[h.events.length - 1]).toBeNull();
    h.controller.dispose();
  });

  it('reanuda push tras reconectar OK desde degraded', async () => {
    const h = makeHarness();

    // 4 fallos consecutivos → degrada a polling, pero sigue reintentando.
    for (let i = 0; i < 4; i += 1) {
      await vi.runOnlyPendingTimersAsync();
      h.sources[h.sources.length - 1]!.fail();
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_FALLBACK_TICK);
    }
    expect(h.statuses).toContain('degraded');

    // El reintento en segundo plano abrió un ES nuevo (con ticket nuevo).
    await vi.runOnlyPendingTimersAsync();
    const ticketsAtDegrade = h.ticketCalls();
    const live = h.sources[h.sources.length - 1]!;
    live.open(); // reconexión OK

    // Vuelve a push y el polling se detiene (no más ticks null).
    expect(h.statuses[h.statuses.length - 1]).toBe('push');
    const eventsBefore = h.events.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.ticketCalls()).toBe(ticketsAtDegrade); // no reintenta ya conectado
    h.controller.dispose();
  });

  it('reconexión OK detiene el polling y vuelve a push (3 fallos, sin degradar)', async () => {
    const h = makeHarness();
    await vi.runOnlyPendingTimersAsync();

    // 3 fallos: NO degrada (umbral es 4), reprograma cada vez.
    for (let i = 0; i < 3; i += 1) {
      h.sources[h.sources.length - 1]!.fail();
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_FALLBACK_TICK);
    }
    // 4ª conexión viva: hacemos open → push, contador reseteado.
    const live = h.sources[h.sources.length - 1]!;
    live.open();
    expect(h.statuses[h.statuses.length - 1]).toBe('push');
    expect(h.statuses).not.toContain('degraded');
    h.controller.dispose();
  });

  it('dispose cierra el EventSource y no emite más', async () => {
    const h = makeHarness();
    await vi.runOnlyPendingTimersAsync();
    const es = h.sources[0]!;
    es.open();
    h.controller.dispose();

    expect(es.closed).toBe(true);
    es.emit({ id: 'n9', templateKey: 'k', subject: null, createdAt: 'now' });
    expect(h.events).toHaveLength(0);
  });
});

// Backoff suficiente para superar el cap (30s) + jitter (0 en tests).
const MAX_BACKOFF_FALLBACK_TICK = 31_000;
