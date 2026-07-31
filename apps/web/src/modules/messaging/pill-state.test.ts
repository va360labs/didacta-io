import { describe, expect, it } from 'vitest';
import type { ConversationView } from './client';
import type { TypingSignal } from './messaging-provider';
import { derivePillState } from './pill-state';

/**
 * Contenido de la píldora del chat flotante (PRD chat-flotante §3.1). Es lógica
 * pura: prioridad del copy, orden de las caras y estado vacío, sin DOM.
 */

const NOW = 1_800_000_000_000;
const VIEWER = 'viewer-1';

function room(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'conv-room',
    type: 'SPACE',
    title: 'General',
    space: { slug: 'general', icon: 'hash', color: '#1E5AA8' },
    counterpart: null,
    lastMessage: null,
    lastMessageAt: null,
    unreadCount: 0,
    ...overrides,
  };
}

function dm(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'conv-dm',
    type: 'DM',
    title: 'Ana',
    space: null,
    counterpart: { id: 'ana', name: 'Ana', avatarUrl: null },
    lastMessage: null,
    lastMessageAt: null,
    unreadCount: 0,
    ...overrides,
  };
}

function lastMessage(authorId: string, at: string) {
  return { body: 'hola', kind: 'TEXT', authorId, authorDisplayName: 'Alguien', createdAt: at };
}

function typing(overrides: Partial<TypingSignal> = {}): TypingSignal {
  return {
    conversationId: 'conv-room',
    userId: 'alejandro',
    displayName: 'Alejandro',
    expiresAt: NOW + 5_000,
    ...overrides,
  };
}

describe('derivePillState — línea 1 por prioridad', () => {
  it('escribiendo en una sala gana a los no-leídos y nombra el canal', () => {
    const state = derivePillState({
      conversations: [room({ unreadCount: 3, lastMessageAt: '2026-07-30T10:00:00Z' })],
      typing: [typing()],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('typing');
    expect(state.line1.prefix).toBe('Alejandro escribe en ');
    expect(state.line1.target).toBe('#general');
  });

  it('escribiendo en un directo no inventa sala', () => {
    const state = derivePillState({
      conversations: [dm()],
      typing: [typing({ conversationId: 'conv-dm' })],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.prefix).toBe('Alejandro te escribe');
    expect(state.line1.target).toBeNull();
  });

  it('una señal de escritura caducada ya no cuenta', () => {
    const state = derivePillState({
      conversations: [room({ unreadCount: 2, lastMessageAt: '2026-07-30T10:00:00Z' })],
      typing: [typing({ expiresAt: NOW - 1 })],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('unread');
    expect(state.line1.prefix).toBe('2 mensajes nuevos en ');
    expect(state.line1.target).toBe('#general');
  });

  it('sin typing, describe los no-leídos de la conversación más reciente', () => {
    const state = derivePillState({
      conversations: [
        room({ id: 'a', unreadCount: 5, lastMessageAt: '2026-07-30T09:00:00Z' }),
        dm({ id: 'b', unreadCount: 1, lastMessageAt: '2026-07-30T11:00:00Z' }),
      ],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.prefix).toBe('1 mensaje nuevo de ');
    expect(state.line1.target).toBe('Ana');
  });

  it('todo leído: línea neutra', () => {
    const state = derivePillState({
      conversations: [room({ lastMessage: lastMessage('otro', '2026-07-30T10:00:00Z') })],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1).toEqual({ kind: 'idle', prefix: 'Mensajes', target: null });
  });

  it('la escritura del propio usuario se ignora', () => {
    const state = derivePillState({
      conversations: [room()],
      typing: [typing({ userId: VIEWER })],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('idle');
    expect(state.avatarUserIds).toEqual([]);
  });
});

describe('derivePillState — caras', () => {
  it('toma los últimos autores distintos, más reciente primero, sin el propio', () => {
    const state = derivePillState({
      conversations: [
        room({
          id: 'a',
          lastMessage: lastMessage('u1', '2026-07-30T12:00:00Z'),
          lastMessageAt: '2026-07-30T12:00:00Z',
        }),
        dm({
          id: 'b',
          lastMessage: lastMessage(VIEWER, '2026-07-30T11:00:00Z'),
          lastMessageAt: '2026-07-30T11:00:00Z',
        }),
        room({
          id: 'c',
          lastMessage: lastMessage('u2', '2026-07-30T10:00:00Z'),
          lastMessageAt: '2026-07-30T10:00:00Z',
        }),
      ],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.avatarUserIds).toEqual(['u1', 'u2']);
  });

  it('quien escribe ahora va delante: es lo más reciente que hay', () => {
    const state = derivePillState({
      conversations: [
        room({
          id: 'a',
          lastMessage: lastMessage('u1', '2026-07-30T12:00:00Z'),
          lastMessageAt: '2026-07-30T12:00:00Z',
        }),
      ],
      typing: [typing({ userId: 'alejandro' })],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.avatarUserIds).toEqual(['alejandro', 'u1']);
  });

  it('nunca pinta más de tres ni repite persona', () => {
    const conversations = ['u1', 'u2', 'u1', 'u3', 'u4'].map((author, i) =>
      room({
        id: `c${i}`,
        lastMessage: lastMessage(author, `2026-07-30T1${9 - i}:00:00Z`),
        lastMessageAt: `2026-07-30T1${9 - i}:00:00Z`,
      }),
    );
    const state = derivePillState({ conversations, typing: [], viewerId: VIEWER, now: NOW });
    expect(state.avatarUserIds).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('derivePillState — línea 2 y estado vacío', () => {
  it('resume salas y conversaciones sin leer', () => {
    const state = derivePillState({
      conversations: [
        room({ id: 'a', unreadCount: 2, lastMessage: lastMessage('u1', '2026-07-30T10:00:00Z') }),
        room({ id: 'b' }),
        dm({ id: 'c', unreadCount: 1, lastMessage: lastMessage('u2', '2026-07-30T09:00:00Z') }),
      ],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line2).toBe('2 salas · 2 sin leer');
    expect(state.unreadConversations).toBe(2);
  });

  it('con todo leído no hay segunda línea: la píldora se queda en una', () => {
    const state = derivePillState({
      conversations: [room({ lastMessage: lastMessage('u1', '2026-07-30T10:00:00Z') })],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('idle');
    expect(state.line2).toBeNull();
  });

  it('escribiendo sin nada pendiente tampoco arrastra resumen', () => {
    const state = derivePillState({
      conversations: [
        room({ lastMessage: lastMessage('u1', '2026-07-30T10:00:00Z') }),
        room({ id: 'otra' }),
      ],
      typing: [typing()],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('typing');
    expect(state.line2).toBeNull();
  });

  it('sin ninguna conversación con mensajes invita a empezar — no inventa contadores', () => {
    const state = derivePillState({
      conversations: [room(), dm()],
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('idle');
    expect(state.line2).toBe('Empieza una conversación');
    expect(state.avatarUserIds).toEqual([]);
  });

  it('mientras carga no afirma nada', () => {
    const state = derivePillState({
      conversations: null,
      typing: [],
      viewerId: VIEWER,
      now: NOW,
    });
    expect(state.line1.kind).toBe('idle');
    expect(state.line2).toBeNull();
  });
});
