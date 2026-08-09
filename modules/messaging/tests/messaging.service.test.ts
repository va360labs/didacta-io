import { beforeEach, describe, expect, it } from 'vitest';
import {
  MessagingService,
  type MessagingCaller,
  type MessagingPublicUser,
  type MessagingSpaceSummary,
} from '../src/messaging.service.js';
import {
  ConversationNotFoundError,
  MessageBodyInvalidError,
  NotParticipantError,
  SelfDmError,
  SpaceNotFoundError,
  StaffFacultyError,
  TargetUserNotFoundError,
} from '../src/errors.js';

/**
 * Tests del dominio de mod.messaging con un MockPrisma in-memory (sin BD),
 * mismo patrón que modules/referrals: arrays como storage, P2002 simulado
 * para uniques y $transaction sin rollback real.
 */

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';

interface ConvRow {
  id: string;
  tenantId: string;
  type: 'SPACE' | 'DM' | 'FACULTY';
  spaceId: string | null;
  studentId: string | null;
  dmKey: string | null;
  lastMessageAt: Date | null;
}
interface PartRow {
  id: string;
  tenantId: string;
  conversationId: string;
  userId: string;
  lastReadAt: Date | null;
}
interface MsgRow {
  id: string;
  tenantId: string;
  conversationId: string;
  authorId: string;
  authorDisplayName: string | null;
  kind: string;
  body: string;
  mediaKey: string | null;
  durationMs: number | null;
  deletedAt: Date | null;
  createdAt: Date;
}

function uniqueViolation(): Error {
  const err = new Error('Unique constraint failed');
  (err as Error & { code: string }).code = 'P2002';
  return err;
}

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; gt?: unknown };
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
      if ('not' in c) {
        if (c.not === null) {
          if (value === null) return false;
        } else if (value === c.not) return false;
      }
      if ('gt' in c && !((value as Date) > (c.gt as Date))) return false;
    } else if (cond instanceof Date) {
      if ((value as Date)?.getTime() !== cond.getTime()) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

class MockPrisma {
  conversations: ConvRow[] = [];
  participants: PartRow[] = [];
  messages: MsgRow[] = [];

  modMessagingConversation = {
    findMany: async (args: never) => {
      const { where } = args as { where: Where };
      return this.conversations.filter((r) => matches(r as never, where));
    },
    findFirst: async (args: never) => {
      const { where } = args as { where: Where };
      return this.conversations.find((r) => matches(r as never, where)) ?? null;
    },
    create: async (args: never) => {
      const { data } = args as { data: Partial<ConvRow> };
      const dup = this.conversations.find(
        (r) =>
          r.tenantId === data.tenantId &&
          ((data.dmKey && r.dmKey === data.dmKey) ||
            (data.spaceId && r.spaceId === data.spaceId) ||
            (data.studentId && r.studentId === data.studentId)),
      );
      if (dup) throw uniqueViolation();
      const row: ConvRow = {
        id: data.id as string,
        tenantId: data.tenantId as string,
        type: data.type as ConvRow['type'],
        spaceId: data.spaceId ?? null,
        studentId: data.studentId ?? null,
        dmKey: data.dmKey ?? null,
        lastMessageAt: null,
      };
      this.conversations.push(row);
      return row;
    },
    update: async (args: never) => {
      const { where, data } = args as { where: { id: string }; data: Partial<ConvRow> };
      const row = this.conversations.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  modMessagingParticipant = {
    findMany: async (args: never) => {
      const { where } = args as { where: Where };
      return this.participants.filter((r) => matches(r as never, where));
    },
    findFirst: async (args: never) => {
      const { where } = args as { where: Where };
      return this.participants.find((r) => matches(r as never, where)) ?? null;
    },
    create: async (args: never) => {
      const { data } = args as { data: Partial<PartRow> };
      const dup = this.participants.find(
        (r) => r.conversationId === data.conversationId && r.userId === data.userId,
      );
      if (dup) throw uniqueViolation();
      const row: PartRow = {
        id: data.id as string,
        tenantId: data.tenantId as string,
        conversationId: data.conversationId as string,
        userId: data.userId as string,
        lastReadAt: data.lastReadAt ?? null,
      };
      this.participants.push(row);
      return row;
    },
    update: async (args: never) => {
      const { where, data } = args as { where: { id: string }; data: Partial<PartRow> };
      const row = this.participants.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  modMessagingMessage = {
    findMany: async (args: never) => {
      const a = args as {
        where: Where;
        orderBy?: unknown;
        take?: number;
        cursor?: { id: string };
        skip?: number;
      };
      let rows = this.messages.filter((r) => matches(r as never, a.where));
      rows = rows.sort((x, y) => {
        const t = y.createdAt.getTime() - x.createdAt.getTime();
        return t !== 0 ? t : y.id.localeCompare(x.id);
      });
      if (a.cursor) {
        const idx = rows.findIndex((r) => r.id === a.cursor?.id);
        rows = idx >= 0 ? rows.slice(idx + (a.skip ?? 0)) : [];
      }
      if (a.take !== undefined) rows = rows.slice(0, a.take);
      return rows;
    },
    findFirst: async (args: never) => {
      const a = args as { where: Where };
      const rows = this.messages
        .filter((r) => matches(r as never, a.where))
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
      return rows[0] ?? null;
    },
    create: async (args: never) => {
      const { data } = args as { data: Partial<MsgRow> };
      const row: MsgRow = {
        id: data.id as string,
        tenantId: data.tenantId as string,
        conversationId: data.conversationId as string,
        authorId: data.authorId as string,
        authorDisplayName: data.authorDisplayName ?? null,
        kind: (data.kind as string) ?? 'TEXT',
        body: data.body as string,
        mediaKey: null,
        durationMs: null,
        deletedAt: null,
        createdAt: (data.createdAt as Date) ?? new Date(),
      };
      this.messages.push(row);
      return row;
    },
    count: async (args: never) => {
      const { where } = args as { where: Where };
      return this.messages.filter((r) => matches(r as never, where)).length;
    },
    groupBy: async (args: never) => {
      const a = args as {
        by: string[];
        where: Where;
        _max?: { createdAt?: boolean };
        _count?: { _all?: boolean };
      };
      const rows = this.messages.filter((r) => matches(r as never, a.where));
      const byConv = new Map<string, MsgRow[]>();
      for (const r of rows) {
        const list = byConv.get(r.conversationId) ?? [];
        list.push(r);
        byConv.set(r.conversationId, list);
      }
      return [...byConv.entries()].map(([conversationId, list]) => ({
        conversationId,
        ...(a._max
          ? {
              _max: {
                createdAt: list.reduce<Date | null>(
                  (acc, m) => (acc === null || m.createdAt > acc ? m.createdAt : acc),
                  null,
                ),
              },
            }
          : {}),
        ...(a._count ? { _count: { _all: list.length } } : {}),
      }));
    },
  };

  $transaction = async (ops: unknown): Promise<unknown> => {
    if (Array.isArray(ops)) return Promise.all(ops);
    return (ops as (tx: this) => Promise<unknown>)(this);
  };
}

interface PublishedEvent {
  tenantId: string;
  actorId: string | null;
  name: string;
  payload: Record<string, unknown>;
}

function buildPublisher() {
  const events: PublishedEvent[] = [];
  return {
    events,
    publisher: {
      publish: async (
        tenantId: string,
        actorId: string | null,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        events.push({ tenantId, actorId, name, payload });
      },
    },
  };
}

const SPACE_GENERAL: MessagingSpaceSummary = {
  id: 'cccccccc-0000-0000-0000-00000000000a',
  slug: 'general',
  title: 'General',
  icon: '#',
  color: 'var(--didacta-trust)',
  sortOrder: 0,
};
const SPACE_AYUDA: MessagingSpaceSummary = {
  id: 'cccccccc-0000-0000-0000-00000000000b',
  slug: 'ayuda',
  title: 'Ayuda',
  icon: '?',
  color: 'blue',
  sortOrder: 1,
};

const USERS: Record<string, MessagingPublicUser> = {
  alice: { id: 'dddddddd-0000-0000-0000-00000000000a', name: 'Alice Alumna', avatarUrl: null },
  bob: { id: 'dddddddd-0000-0000-0000-00000000000b', name: 'Bob Miembro', avatarUrl: null },
  profe: { id: 'dddddddd-0000-0000-0000-00000000000c', name: 'Profe Uno', avatarUrl: null },
};

function callerOf(key: keyof typeof USERS, roles: string[] = ['alumno']): MessagingCaller {
  return { userId: USERS[key]!.id, displayName: USERS[key]!.name, roles };
}

describe('MessagingService', () => {
  let prisma: MockPrisma;
  let events: PublishedEvent[];
  let service: MessagingService;
  let spaces: MessagingSpaceSummary[];

  beforeEach(() => {
    prisma = new MockPrisma();
    const built = buildPublisher();
    events = built.events;
    spaces = [SPACE_GENERAL, SPACE_AYUDA];
    service = new MessagingService(
      prisma as never,
      built.publisher,
      async () => spaces,
      async (_tenantId, ids) => Object.values(USERS).filter((u) => ids.includes(u.id)),
      async () => [USERS.profe!.id],
    );
  });

  describe('openDm', () => {
    it('crea el DM una sola vez por par (idempotente)', async () => {
      const first = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      expect(first.created).toBe(true);
      const second = await service.openDm(TENANT, callerOf('bob'), USERS.alice!.id);
      expect(second.created).toBe(false);
      expect(second.conversationId).toBe(first.conversationId);
      expect(prisma.conversations.filter((c) => c.type === 'DM')).toHaveLength(1);
      expect(prisma.participants).toHaveLength(2);
      expect(events.filter((e) => e.name === 'messaging.conversation.created')).toHaveLength(1);
    });

    it('rechaza el DM con uno mismo', async () => {
      await expect(service.openDm(TENANT, callerOf('alice'), USERS.alice!.id)).rejects.toThrow(
        SelfDmError,
      );
    });

    it('rechaza destinatario inexistente en el tenant', async () => {
      await expect(
        service.openDm(TENANT, callerOf('alice'), 'eeeeeeee-0000-0000-0000-000000000099'),
      ).rejects.toThrow(TargetUserNotFoundError);
    });

    it('resuelve la carrera P2002 devolviendo el DM existente', async () => {
      await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      // Fuerza la rama de carrera: findFirst inicial "no lo ve".
      const original = prisma.modMessagingConversation.findFirst;
      let calls = 0;
      prisma.modMessagingConversation.findFirst = (async (args: never) => {
        calls += 1;
        if (calls === 1) return null;
        return original(args);
      }) as never;
      const raced = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      expect(raced.created).toBe(false);
      expect(prisma.conversations.filter((c) => c.type === 'DM')).toHaveLength(1);
    });
  });

  describe('sendMessage', () => {
    it('valida el cuerpo (vacío y >4000)', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await expect(
        service.sendMessage(TENANT, callerOf('alice'), conversationId, '   '),
      ).rejects.toThrow(MessageBodyInvalidError);
      await expect(
        service.sendMessage(TENANT, callerOf('alice'), conversationId, 'x'.repeat(4001)),
      ).rejects.toThrow(MessageBodyInvalidError);
    });

    it('persiste, actualiza lastMessageAt y devuelve al otro como destinatario', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      const result = await service.sendMessage(
        TENANT,
        callerOf('alice'),
        conversationId,
        'Hola 👋',
      );
      expect(result.message.body).toBe('Hola 👋');
      expect(result.message.authorDisplayName).toBe('Alice Alumna');
      expect(result.recipientUserIds).toEqual([USERS.bob!.id]);
      const conv = prisma.conversations.find((c) => c.id === conversationId);
      expect(conv?.lastMessageAt).not.toBeNull();
      expect(events.some((e) => e.name === 'messaging.message.sent')).toBe(true);
    });

    it('rechaza a quien no participa del DM', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await expect(
        service.sendMessage(TENANT, callerOf('profe', ['alumno']), conversationId, 'intruso'),
      ).rejects.toThrow(NotParticipantError);
    });

    it('no encuentra conversaciones de otro tenant (aislamiento)', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await expect(
        service.sendMessage(OTHER_TENANT, callerOf('alice'), conversationId, 'cruce'),
      ).rejects.toThrow(ConversationNotFoundError);
    });
  });

  describe('salas de espacios', () => {
    it('openSpace crea la sala lazy y la reutiliza', async () => {
      const first = await service.openSpace(TENANT, callerOf('alice'), 'general');
      const second = await service.openSpace(TENANT, callerOf('bob'), 'general');
      expect(second.conversationId).toBe(first.conversationId);
      expect(prisma.conversations.filter((c) => c.type === 'SPACE')).toHaveLength(1);
    });

    it('openSpace rechaza slug inexistente', async () => {
      await expect(service.openSpace(TENANT, callerOf('alice'), 'nope')).rejects.toThrow(
        SpaceNotFoundError,
      );
    });

    it('cualquier miembro del tenant puede escribir en la sala', async () => {
      const { conversationId } = await service.openSpace(TENANT, callerOf('alice'), 'general');
      const result = await service.sendMessage(
        TENANT,
        callerOf('bob'),
        conversationId,
        'hola sala',
      );
      // Alice abrió la sala (fila de participante) → recibe el push.
      expect(result.recipientUserIds).toEqual([USERS.alice!.id]);
    });

    it('una sala cuyo espacio ya no existe queda archivada (fuera del listado)', async () => {
      await service.openSpace(TENANT, callerOf('alice'), 'ayuda');
      spaces = [SPACE_GENERAL]; // el espacio "ayuda" se elimina
      const list = await service.listConversations(TENANT, callerOf('alice'));
      expect(list.find((c) => c.space?.slug === 'ayuda')).toBeUndefined();
      // Los mensajes/fila no se borran del storage.
      expect(prisma.conversations.some((c) => c.spaceId === SPACE_AYUDA.id)).toBe(true);
    });
  });

  describe('canal alumno ↔ profesores', () => {
    it('se auto-provisiona al listar para un alumno', async () => {
      const list = await service.listConversations(TENANT, callerOf('alice'));
      const faculty = list.find((c) => c.type === 'FACULTY');
      expect(faculty, 'el alumno siempre tiene su canal Profesores').toBeDefined();
      expect(faculty?.title).toBe('Profesores');
      expect(prisma.conversations.filter((c) => c.type === 'FACULTY')).toHaveLength(1);
    });

    it('el staff no tiene canal propio', async () => {
      await expect(service.openFaculty(TENANT, callerOf('profe', ['formador']))).rejects.toThrow(
        StaffFacultyError,
      );
    });

    it('otro alumno no puede leer el canal ajeno', async () => {
      const { conversationId } = await service.openFaculty(TENANT, callerOf('alice'));
      await expect(service.listMessages(TENANT, callerOf('bob'), conversationId)).rejects.toThrow(
        NotParticipantError,
      );
    });

    it('el staff puede leer y responder, y el push llega a alumno y resto del staff', async () => {
      const { conversationId } = await service.openFaculty(TENANT, callerOf('alice'));
      await service.sendMessage(
        TENANT,
        callerOf('alice'),
        conversationId,
        '¿Duda de la lección 3?',
      );
      const reply = await service.sendMessage(
        TENANT,
        callerOf('profe', ['formador']),
        conversationId,
        'Te respondo ahora mismo',
      );
      expect(reply.recipientUserIds).toContain(USERS.alice!.id);
      expect(reply.recipientUserIds).not.toContain(USERS.profe!.id);
    });

    it('la bandeja del staff solo lista canales con actividad, titulados con el alumno', async () => {
      await service.openFaculty(TENANT, callerOf('alice')); // sin mensajes aún
      const empty = await service.listConversations(TENANT, callerOf('profe', ['formador']));
      expect(empty.filter((c) => c.type === 'FACULTY')).toHaveLength(0);

      const { conversationId } = await service.openFaculty(TENANT, callerOf('alice'));
      await service.sendMessage(TENANT, callerOf('alice'), conversationId, 'Hola profes');
      const inbox = await service.listConversations(TENANT, callerOf('profe', ['formador']));
      const item = inbox.find((c) => c.type === 'FACULTY');
      expect(item?.title).toBe('Alice Alumna');
      expect(item?.unreadCount).toBe(1);
    });
  });

  describe('no-leídos y lectura', () => {
    it('cuenta solo mensajes ajenos posteriores a lastReadAt y markRead los limpia', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await service.sendMessage(TENANT, callerOf('alice'), conversationId, 'uno');
      await service.sendMessage(TENANT, callerOf('alice'), conversationId, 'dos');

      const listBob = await service.listConversations(TENANT, callerOf('bob'));
      expect(listBob.find((c) => c.id === conversationId)?.unreadCount).toBe(2);

      await service.markRead(TENANT, callerOf('bob'), conversationId);
      const after = await service.listConversations(TENANT, callerOf('bob'));
      expect(after.find((c) => c.id === conversationId)?.unreadCount).toBe(0);

      // Los propios mensajes nunca cuentan para el autor.
      const listAlice = await service.listConversations(TENANT, callerOf('alice'));
      expect(listAlice.find((c) => c.id === conversationId)?.unreadCount).toBe(0);
    });

    it('una sala nunca abierta muestra 0 no-leídos aunque tenga histórico', async () => {
      const { conversationId } = await service.openSpace(TENANT, callerOf('alice'), 'general');
      await service.sendMessage(TENANT, callerOf('alice'), conversationId, 'histórico');
      const listBob = await service.listConversations(TENANT, callerOf('bob'));
      const sala = listBob.find((c) => c.space?.slug === 'general');
      expect(sala?.unreadCount).toBe(0);
      expect(sala?.lastMessage?.body).toBe('histórico');
    });
  });

  describe('autoría del último mensaje (píldora del chat flotante)', () => {
    it('el listado expone el authorId del último mensaje', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await service.sendMessage(TENANT, callerOf('alice'), conversationId, 'hola');

      const list = await service.listConversations(TENANT, callerOf('bob'));
      const dm = list.find((c) => c.id === conversationId);
      expect(dm?.lastMessage?.authorId).toBe(USERS.alice!.id);
      expect(dm?.lastMessage?.authorDisplayName).toBe('Alice Alumna');
    });

    it('una sala sin mensajes no inventa autor', async () => {
      const list = await service.listConversations(TENANT, callerOf('alice'));
      const sinMensajes = list.find((c) => c.type === 'SPACE' && c.lastMessage === null);
      expect(sinMensajes?.lastMessage).toBeNull();
    });
  });

  describe('destinatarios del indicador de escritura', () => {
    it('en un directo, el otro participante', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      const recipients = await service.recipientsForTyping(
        TENANT,
        callerOf('alice'),
        conversationId,
      );
      expect(recipients).toEqual([USERS.bob!.id]);
    });

    it('quien no participa no puede anunciar que escribe', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      await expect(
        service.recipientsForTyping(TENANT, callerOf('profe', ['alumno']), conversationId),
      ).rejects.toThrow(NotParticipantError);
    });

    it('en una sala, solo quienes la han abierto', async () => {
      const { conversationId } = await service.openSpace(TENANT, callerOf('alice'), 'general');
      // Bob aún no ha entrado en la sala: no hay a quién avisar.
      expect(await service.recipientsForTyping(TENANT, callerOf('alice'), conversationId)).toEqual(
        [],
      );

      await service.openSpace(TENANT, callerOf('bob'), 'general');
      expect(await service.recipientsForTyping(TENANT, callerOf('alice'), conversationId)).toEqual([
        USERS.bob!.id,
      ]);
    });
  });

  describe('listado e histórico', () => {
    it('incluye salas sin materializar como entradas sintéticas', async () => {
      const list = await service.listConversations(TENANT, callerOf('alice'));
      const salas = list.filter((c) => c.type === 'SPACE');
      expect(salas.map((s) => s.space?.slug).sort()).toEqual(['ayuda', 'general']);
      expect(salas.every((s) => s.id === null)).toBe(true);
    });

    it('pagina el histórico por cursor (50 por página, desc)', async () => {
      const { conversationId } = await service.openDm(TENANT, callerOf('alice'), USERS.bob!.id);
      for (let i = 0; i < 55; i += 1) {
        prisma.messages.push({
          id: `feedf00d-0000-0000-0000-${String(i).padStart(12, '0')}`,
          tenantId: TENANT,
          conversationId,
          authorId: USERS.alice!.id,
          authorDisplayName: 'Alice Alumna',
          kind: 'TEXT',
          body: `msg ${i}`,
          mediaKey: null,
          durationMs: null,
          deletedAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        });
      }
      const page1 = await service.listMessages(TENANT, callerOf('alice'), conversationId);
      expect(page1.messages).toHaveLength(50);
      expect(page1.messages[0]?.body).toBe('msg 54');
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await service.listMessages(
        TENANT,
        callerOf('alice'),
        conversationId,
        page1.nextCursor ?? undefined,
      );
      expect(page2.messages).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();
      expect(page2.messages[page2.messages.length - 1]?.body).toBe('msg 0');
    });
  });
});
