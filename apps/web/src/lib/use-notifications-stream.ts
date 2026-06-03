'use client';

import { useEffect, useRef, useState } from 'react';
import { notificationsApi } from '@/lib/notifications';

/**
 * Evento de notificación que viaja por el stream SSE. El backend emite líneas
 * `data:` con este shape JSON. También emite `{ type: 'ping' }` como keep-alive
 * que el hook ignora.
 */
export interface NotificationStreamEvent {
  id: string;
  templateKey: string;
  subject: string | null;
  createdAt: string;
}

/** Polling de respaldo cuando el push no está disponible (ms). */
export const POLL_MS = 60_000;

/** Backoff máximo entre reintentos de reconexión (ms). */
const MAX_BACKOFF_MS = 30_000;

/** Tras este número de fallos consecutivos degradamos a polling. */
const MAX_FAILURES_BEFORE_FALLBACK = 4;

/**
 * Estado del transporte de notificaciones:
 *  - `connecting`: abriendo (o reabriendo) el EventSource.
 *  - `push`: stream SSE activo, recibiendo en tiempo real.
 *  - `degraded`: SSE no disponible (sin soporte o demasiados fallos); usando
 *    polling cada `POLL_MS`.
 */
export type NotificationsStreamStatus = 'connecting' | 'push' | 'degraded';

/** Callback de evento. `null` señala "re-haz el catch-up" (tick de fallback). */
export type StreamEventHandler = (event: NotificationStreamEvent | null) => void;

/**
 * Dependencias inyectables del controlador, para poder testearlo sin React ni
 * un DOM real. En producción se cablean a las globales del browser.
 */
export interface StreamDeps {
  getTicket: () => Promise<{ ticket: string }>;
  createEventSource: (url: string) => EventSourceLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Jitter [0,1). Inyectable para tests deterministas. */
  random: () => number;
  onStatus: (status: NotificationsStreamStatus) => void;
  onEvent: StreamEventHandler;
}

/** Subconjunto de `EventSource` que el controlador necesita. */
export interface EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: string }) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  close: () => void;
}

/** Handle de control del transporte. */
export interface StreamController {
  /** Cierra el transporte y cancela timers pendientes. */
  dispose: () => void;
}

/**
 * Núcleo del transporte SSE con degradación a polling. Es una máquina de
 * estados pura (sin React) para que pueda testearse con EventSource mockeado
 * y timers falsos.
 *
 * Flujo normal:
 *  1. Pide un ticket JWT (`getTicket`).
 *  2. Abre el EventSource same-origin con el ticket en la query.
 *  3. `onmessage`: parsea JSON, ignora `{type:'ping'}`, de-duplica por `id` y
 *     llama `onEvent`.
 *  4. `onerror`: cierra y reintenta con backoff exponencial + jitter
 *     (1, 2, 4, … cap 30s), pidiendo un ticket NUEVO en cada reintento.
 *
 * Degradación: si no se puede crear el EventSource, o tras
 * `MAX_FAILURES_BEFORE_FALLBACK` fallos consecutivos, cae a polling
 * (`onEvent(null)` cada `POLL_MS`, estado `degraded`). Una reconexión
 * posterior con éxito vuelve a `push`.
 */
export function createNotificationsStream(deps: StreamDeps): StreamController {
  let disposed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: unknown = null;
  let pollTimer: unknown = null;
  let failures = 0;
  const seen = new Set<string>();

  function clearReconnect() {
    if (reconnectTimer !== null) {
      deps.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      deps.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (disposed || pollTimer !== null) return;
    deps.onStatus('degraded');
    pollTimer = deps.setInterval(() => {
      if (disposed) return;
      // En el fallback no tenemos el evento concreto; señalamos al consumidor
      // que re-haga el catch-up (listMine) pasando null.
      deps.onEvent(null);
    }, POLL_MS);
  }

  function handleFailure() {
    failures += 1;
    // A partir del umbral degradamos a polling para no dejar al usuario sin
    // notificaciones, PERO seguimos reintentando el SSE en segundo plano (con
    // el backoff ya capado a 30s). Si un reintento conecta, `onopen` detiene el
    // polling y volvemos a push.
    if (failures >= MAX_FAILURES_BEFORE_FALLBACK) {
      startPolling();
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearReconnect();
    // Backoff exponencial: 1s, 2s, 4s, … cap 30s. `failures` ya viene
    // incrementado. Restamos 1 para que el primer reintento sea ~1s.
    const base = Math.min(2 ** (failures - 1) * 1000, MAX_BACKOFF_MS);
    const jitter = deps.random() * base * 0.25;
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null;
      if (disposed) return;
      void connect();
    }, base + jitter);
  }

  async function connect() {
    if (disposed) return;
    deps.onStatus('connecting');

    let ticket: string;
    try {
      const res = await deps.getTicket();
      ticket = res.ticket;
    } catch {
      handleFailure();
      return;
    }
    if (disposed) return;

    let es: EventSourceLike;
    try {
      es = deps.createEventSource(
        `/api/v1/me/notifications/stream?ticket=${encodeURIComponent(ticket)}`,
      );
    } catch {
      handleFailure();
      return;
    }
    source = es;

    es.onopen = () => {
      if (disposed) return;
      // Conexión OK: reseteamos el contador y, si veníamos de polling,
      // volvemos a push.
      failures = 0;
      stopPolling();
      deps.onStatus('push');
    };

    es.onmessage = (ev: { data: string }) => {
      if (disposed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { type?: unknown }).type === 'ping'
      ) {
        return;
      }
      const event = parsed as Partial<NotificationStreamEvent>;
      if (typeof event.id !== 'string') return;
      if (seen.has(event.id)) return;
      seen.add(event.id);
      deps.onEvent(event as NotificationStreamEvent);
    };

    es.onerror = () => {
      // EventSource intenta reconectar solo, pero no rota el ticket (que ya
      // caducó). Cerramos y gestionamos nosotros el reintento con ticket
      // fresco.
      es.close();
      if (source === es) source = null;
      if (disposed) return;
      handleFailure();
    };
  }

  void connect();

  return {
    dispose() {
      disposed = true;
      clearReconnect();
      stopPolling();
      if (source) {
        source.close();
        source = null;
      }
    },
  };
}

interface Options {
  /** Si es `false`, el hook no abre ningún transporte (p. ej. sin sesión). */
  enabled?: boolean;
}

/**
 * Hook de notificaciones en tiempo real vía SSE con degradación a polling.
 * Envuelve `createNotificationsStream` cableando las globales del browser y
 * exponiendo el estado del transporte.
 *
 * @param onEvent  Callback invocado en cada evento nuevo (de-duplicado). En el
 *   camino de fallback se invoca con `null` para forzar un re-catch-up.
 * @returns estado actual del transporte (`connecting` | `push` | `degraded`).
 */
export function useNotificationsStream(
  onEvent: StreamEventHandler,
  options: Options = {},
): NotificationsStreamStatus {
  const { enabled = true } = options;
  const [status, setStatus] = useState<NotificationsStreamStatus>('connecting');

  // Mantenemos el callback en un ref para no reabrir el stream en cada render
  // por una identidad de función distinta.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    // Sin EventSource (SSR o entorno sin soporte) → degradamos a polling.
    if (typeof EventSource === 'undefined') {
      setStatus('degraded');
      const id = setInterval(() => onEventRef.current(null), POLL_MS);
      return () => clearInterval(id);
    }

    const controller = createNotificationsStream({
      getTicket: () => notificationsApi.getStreamTicket(),
      createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      random: () => Math.random(),
      onStatus: setStatus,
      onEvent: (ev) => onEventRef.current(ev),
    });

    return () => controller.dispose();
  }, [enabled]);

  return status;
}
