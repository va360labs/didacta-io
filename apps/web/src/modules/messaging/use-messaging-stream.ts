'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useRef, useState } from 'react';
import { messagingApi, type MessagingStreamEvent } from './client';

/**
 * Transporte SSE de mensajería con degradación a polling — clon del patrón de
 * `use-notifications-stream` (máquina de estados pura + hook), adaptado al
 * stream de mod.messaging: URL propia, discriminador `kind` dentro del JSON y
 * de-dup por `message.id`.
 */

/** Polling de respaldo cuando el push no está disponible (ms). */
export const MESSAGING_POLL_MS = 60_000;

const MAX_BACKOFF_MS = 30_000;
const MAX_FAILURES_BEFORE_FALLBACK = 4;

export type MessagingStreamStatus = 'connecting' | 'push' | 'degraded';

/** Callback de evento. `null` señala "re-haz el catch-up" (tick de fallback). */
export type MessagingEventHandler = (event: MessagingStreamEvent | null) => void;

interface EventSourceLike {
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: string }) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  close: () => void;
}

interface StreamController {
  dispose: () => void;
}

interface StreamDeps {
  getTicket: () => Promise<{ ticket: string }>;
  createEventSource: (url: string) => EventSourceLike;
  onStatus: (status: MessagingStreamStatus) => void;
  onEvent: MessagingEventHandler;
}

export function createMessagingStream(deps: StreamDeps): StreamController {
  let disposed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  const seen = new Set<string>();

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (disposed || pollTimer !== null) return;
    deps.onStatus('degraded');
    pollTimer = setInterval(() => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      deps.onEvent(null);
    }, MESSAGING_POLL_MS);
  }

  function handleFailure() {
    failures += 1;
    if (failures >= MAX_FAILURES_BEFORE_FALLBACK) {
      startPolling();
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearReconnect();
    const base = Math.min(2 ** (failures - 1) * 1000, MAX_BACKOFF_MS);
    const jitter = Math.random() * base * 0.25;
    reconnectTimer = setTimeout(() => {
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
        `/api/v1/modules/messaging/stream?ticket=${encodeURIComponent(ticket)}`,
      );
    } catch {
      handleFailure();
      return;
    }
    source = es;

    es.onopen = () => {
      if (disposed) return;
      const wasReconnect = failures > 0;
      failures = 0;
      stopPolling();
      deps.onStatus('push');
      // Tras una reconexión pudo haber mensajes en el hueco sin stream:
      // señal de catch-up (null = "re-sincroniza lista y conversación abierta").
      if (wasReconnect) deps.onEvent(null);
    };

    es.onmessage = (ev: { data: string }) => {
      if (disposed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      const event = parsed as MessagingStreamEvent;
      if (event.kind === 'ping') return;
      // «Está escribiendo» (ADR-019): efímero y sin id, así que NO pasa por el
      // de-dup de mensajes — ese `seen` es por `message.id` y aquí no hay.
      // Repetirlo es lo normal: cada aviso renueva el TTL en el receptor.
      if (event.kind === 'typing') {
        if (typeof event.conversationId !== 'string' || typeof event.userId !== 'string') return;
        deps.onEvent(event);
        return;
      }
      if (event.kind !== 'message.created') return;
      const id = event.message?.id;
      if (typeof id !== 'string' || seen.has(id)) return;
      seen.add(id);
      deps.onEvent(event);
    };

    es.onerror = () => {
      // La auto-reconexión nativa reutilizaría el ticket YA caducado (60s):
      // cerramos y reintentamos a mano con ticket fresco.
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
  enabled?: boolean;
}

export function useMessagingStream(
  onEvent: MessagingEventHandler,
  options: Options = {},
): MessagingStreamStatus {
  const { enabled = true } = options;
  const [status, setStatus] = useState<MessagingStreamStatus>('connecting');

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === 'undefined') {
      setStatus('degraded');
      const id = setInterval(() => onEventRef.current(null), MESSAGING_POLL_MS);
      return () => clearInterval(id);
    }

    const controller = createMessagingStream({
      getTicket: () => messagingApi.getStreamTicket(),
      createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
      onStatus: setStatus,
      onEvent: (ev) => onEventRef.current(ev),
    });

    return () => controller.dispose();
  }, [enabled]);

  return status;
}
