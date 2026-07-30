import { describe, expect, it, vi } from 'vitest';
import { createMessagingStream } from './use-messaging-stream';
import type { MessagingStreamEvent } from './client';

/**
 * Transporte SSE de mensajería. Lo que se prueba aquí es el filtro de eventos:
 * un `kind` nuevo mal filtrado se cae en silencio y la UI parece rota sin que
 * nada falle — que es exactamente lo que pasó con `typing` la primera vez.
 */

interface FakeSource {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close: () => void;
}

function harness() {
  const events: Array<MessagingStreamEvent | null> = [];
  let source: FakeSource | null = null;
  const controller = createMessagingStream({
    getTicket: () => Promise.resolve({ ticket: 't' }),
    createEventSource: () => {
      const es: FakeSource = { onopen: null, onmessage: null, onerror: null, close: () => {} };
      source = es;
      return es;
    },
    onStatus: () => undefined,
    onEvent: (e) => events.push(e),
  });
  return {
    events,
    controller,
    emit: (payload: unknown) => source?.onmessage?.({ data: JSON.stringify(payload) }),
    ready: () => vi.waitFor(() => expect(source).not.toBeNull()),
  };
}

const MESSAGE = {
  kind: 'message.created',
  conversationId: 'c1',
  message: {
    id: 'm1',
    conversationId: 'c1',
    authorId: 'u1',
    authorDisplayName: 'Ana',
    kind: 'TEXT',
    body: 'hola',
    createdAt: '2026-07-30T10:00:00Z',
    deletedAt: null,
  },
};

const TYPING = {
  kind: 'typing',
  conversationId: 'c1',
  userId: 'u1',
  displayName: 'Ana',
  ttlMs: 6000,
};

describe('createMessagingStream — filtro de eventos', () => {
  it('entrega los mensajes nuevos y descarta el duplicado por id', async () => {
    const h = harness();
    await h.ready();
    h.emit(MESSAGE);
    h.emit(MESSAGE);
    expect(h.events).toHaveLength(1);
    h.controller.dispose();
  });

  it('entrega el evento de escritura, y lo repite: cada aviso renueva el TTL', async () => {
    const h = harness();
    await h.ready();
    h.emit(TYPING);
    h.emit(TYPING);
    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({ kind: 'typing', conversationId: 'c1', userId: 'u1' });
    h.controller.dispose();
  });

  it('descarta el latido y los eventos malformados sin romper el stream', async () => {
    const h = harness();
    await h.ready();
    h.emit({ kind: 'ping', t: 1 });
    h.emit({ kind: 'typing', conversationId: 'c1' }); // sin userId
    h.emit({ kind: 'desconocido' });
    h.emit(TYPING);
    expect(h.events).toHaveLength(1);
    h.controller.dispose();
  });
});
