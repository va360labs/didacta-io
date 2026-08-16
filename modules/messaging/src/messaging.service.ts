/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@didacta/database';
import {
  ConversationNotFoundError,
  MessageBodyInvalidError,
  NotParticipantError,
  SelfDmError,
  SpaceNotFoundError,
  StaffFacultyError,
  TargetUserNotFoundError,
} from './errors.js';

/**
 * Servicio de dominio de mod.messaging (US-M1..M3 del PRD `mensajes`).
 *
 * Tres tipos de conversación:
 *  - SPACE: sala 1:1 con un espacio de mod.community. Acceso abierto a todo
 *    miembro del tenant (los espacios no tienen membresía propia). La fila de
 *    conversación se crea lazy al abrir la sala por primera vez.
 *  - DM: directo entre dos miembros. `dmKey` canónica (ids ordenados) hace el
 *    get-or-create idempotente por par.
 *  - FACULTY: canal privado 1 alumno + equipo docente. El staff participa POR
 *    ROL (resuelto vía `staffLookup`), sin filas de participante hasta que
 *    abre el canal (ahí materializa su lastReadAt).
 *
 * El service es puro: no conoce NestJS ni Redis. El host implementa los
 * ports (spacesLookup vía CommunityService, usersLookup/staffLookup vía core)
 * y publica el realtime con los `recipientUserIds` que devuelve sendMessage.
 */

// ── Ports que implementa el host ─────────────────────────────────────────────

export interface MessagingEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface MessagingSpaceSummary {
  id: string;
  slug: string;
  title: string;
  icon: string;
  color: string;
  sortOrder: number;
}

/** Espacios visibles del tenant (mod.community). */
export type MessagingSpacesLookup = (tenantId: string) => Promise<MessagingSpaceSummary[]>;

export interface MessagingPublicUser {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Resolución batch de nombre+avatar de usuarios del tenant. */
export type MessagingUsersLookup = (
  tenantId: string,
  ids: string[],
) => Promise<MessagingPublicUser[]>;

/** IDs de usuarios del tenant con rol de staff (formador/admin). */
export type MessagingStaffLookup = (tenantId: string) => Promise<string[]>;

// ── Constantes públicas ──────────────────────────────────────────────────────

export const MESSAGING_STAFF_ROLES = ['formador', 'tenant_admin', 'super_admin'] as const;

export const MESSAGING_EVENT = {
  CONVERSATION_CREATED: 'messaging.conversation.created',
  MESSAGE_SENT: 'messaging.message.sent',
} as const;

export const MESSAGE_MAX_LENGTH = 4000;
const PAGE_SIZE = 50;
/** Tope de la bandeja de consultas del staff (canales FACULTY con actividad). */
const FACULTY_INBOX_LIMIT = 100;

// ── Tipos de entrada/salida ──────────────────────────────────────────────────

/** Identidad del llamante, resuelta por el host una vez por request. */
export interface MessagingCaller {
  userId: string;
  displayName: string | null;
  roles: string[];
}

export type ConversationType = 'SPACE' | 'DM' | 'FACULTY';

export interface ConversationView {
  /** Null solo en salas SPACE aún no materializadas (sin mensajes). */
  id: string | null;
  type: ConversationType;
  title: string;
  space: { slug: string; icon: string; color: string } | null;
  /** DM: el otro usuario. FACULTY en vista staff: el alumno. */
  counterpart: MessagingPublicUser | null;
  lastMessage: {
    body: string;
    kind: string;
    /**
     * Autor del último mensaje. Necesario para resolver su avatar real en la
     * píldora del chat flotante (el nombre solo no basta: el avatar se pide por
     * id al perfil público).
     */
    authorId: string;
    authorDisplayName: string | null;
    createdAt: string;
  } | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  authorId: string;
  authorDisplayName: string | null;
  kind: string;
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface MessagesPage {
  messages: MessageView[];
  nextCursor: string | null;
}

export interface SendResult {
  message: MessageView;
  /** Destinatarios del push realtime (sin el autor). */
  recipientUserIds: string[];
}

interface ConversationRow {
  id: string;
  tenantId: string;
  type: ConversationType;
  spaceId: string | null;
  studentId: string | null;
  dmKey: string | null;
  lastMessageAt: Date | null;
}

interface MessageRow {
  id: string;
  conversationId: string;
  authorId: string;
  authorDisplayName: string | null;
  kind: string;
  body: string;
  createdAt: Date;
  deletedAt: Date | null;
}

function isStaff(roles: string[]): boolean {
  return roles.some((r) => (MESSAGING_STAFF_ROLES as readonly string[]).includes(r));
}

function dmKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002';
}

function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    kind: row.kind,
    body: row.deletedAt ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export class MessagingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: MessagingEventPublisher,
    private readonly spacesLookup: MessagingSpacesLookup,
    private readonly usersLookup: MessagingUsersLookup,
    private readonly staffLookup: MessagingStaffLookup,
  ) {}

  // ── Listado ────────────────────────────────────────────────────────────────

  /**
   * Lista todas las conversaciones visibles del llamante: salas de espacios
   * (materializadas o no), su canal de profesores (auto-provisionado si es
   * alumno), la bandeja de consultas (si es staff) y sus DMs.
   */
  async listConversations(tenantId: string, caller: MessagingCaller): Promise<ConversationView[]> {
    const staff = isStaff(caller.roles);
    const spaces = await this.spacesLookup(tenantId);
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    // Auto-provisión del canal de profesores del alumno (AC1 UC-M301).
    if (!staff) {
      await this.ensureFacultyConversation(tenantId, caller.userId);
    }

    // SPACE: todas las materializadas del tenant cuyo espacio siga existiendo.
    const spaceConvs = (await this.prisma.modMessagingConversation.findMany({
      where: { tenantId, type: 'SPACE' },
    })) as ConversationRow[];

    // DM + FACULTY propias (por fila de participante).
    const myParticipations = (await this.prisma.modMessagingParticipant.findMany({
      where: { tenantId, userId: caller.userId },
      select: { conversationId: true, lastReadAt: true },
    })) as Array<{ conversationId: string; lastReadAt: Date | null }>;
    const lastReadByConv = new Map(myParticipations.map((p) => [p.conversationId, p.lastReadAt]));

    const memberConvs = (await this.prisma.modMessagingConversation.findMany({
      where: {
        tenantId,
        id: { in: myParticipations.map((p) => p.conversationId) },
        type: { in: ['DM', 'FACULTY'] },
      },
    })) as ConversationRow[];

    // Staff: bandeja de consultas — canales FACULTY con actividad (AC1 UC-M302).
    // Acotada a los 100 más recientes: sin tope, un tenant grande convertiría
    // cada listado del staff en una carga O(alumnos).
    let facultyInbox: ConversationRow[] = [];
    if (staff) {
      facultyInbox = (await this.prisma.modMessagingConversation.findMany({
        where: { tenantId, type: 'FACULTY', lastMessageAt: { not: null } },
        orderBy: { lastMessageAt: 'desc' },
        take: FACULTY_INBOX_LIMIT,
      })) as ConversationRow[];
    }

    // Unión sin duplicados (el staff puede tener fila de participante en un
    // canal FACULTY que también sale por la bandeja).
    const byId = new Map<string, ConversationRow>();
    for (const c of [...spaceConvs, ...memberConvs, ...facultyInbox]) byId.set(c.id, c);
    const rows = [...byId.values()].filter(
      (c) => c.type !== 'SPACE' || spaceById.has(c.spaceId ?? ''),
    );

    // Resolución batch de nombres (DM: el otro; FACULTY: el alumno).
    const counterpartIds = new Set<string>();
    const dmOthers = new Map<string, string>();
    for (const c of rows) {
      if (c.type === 'FACULTY' && c.studentId) counterpartIds.add(c.studentId);
      if (c.type === 'DM' && c.dmKey) {
        const [a, b] = c.dmKey.split(':');
        const other = a === caller.userId ? b : a;
        if (other) {
          dmOthers.set(c.id, other);
          counterpartIds.add(other);
        }
      }
    }
    const users = await this.usersLookup(tenantId, [...counterpartIds]);
    const userById = new Map(users.map((u) => [u.id, u]));

    // Batch: último mensaje y no-leídos de TODAS las conversaciones en 3
    // queries agregadas (antes: 2 por conversación → O(N) contra el pool).
    const lastByConv = await this.fetchLastMessages(tenantId, rows);
    const unreadByConv = await this.fetchUnreadCounts(
      tenantId,
      rows,
      caller,
      lastReadByConv,
      staff,
    );

    const views: ConversationView[] = rows.map((c): ConversationView => {
      const lastMessage = lastByConv.get(c.id) ?? null;
      const unreadCount = unreadByConv.get(c.id) ?? 0;

      let title: string;
      let space: ConversationView['space'] = null;
      let counterpart: MessagingPublicUser | null = null;
      if (c.type === 'SPACE') {
        const s = spaceById.get(c.spaceId ?? '');
        title = s?.title ?? 'Sala';
        space = s ? { slug: s.slug, icon: s.icon, color: s.color } : null;
      } else if (c.type === 'FACULTY') {
        if (staff && c.studentId !== caller.userId) {
          counterpart = userById.get(c.studentId ?? '') ?? null;
          title = counterpart?.name ?? 'Alumno';
        } else {
          title = 'Profesores';
        }
      } else {
        const otherId = dmOthers.get(c.id);
        counterpart = otherId ? (userById.get(otherId) ?? null) : null;
        title = counterpart?.name ?? 'Miembro';
      }

      return {
        id: c.id,
        type: c.type,
        title,
        space,
        counterpart,
        lastMessage: lastMessage
          ? {
              body: lastMessage.deletedAt ? '' : lastMessage.body,
              kind: lastMessage.kind,
              // Un mensaje borrado conserva autor: la cara sigue en la píldora,
              // el texto lo sustituye el placeholder del cliente.
              authorId: lastMessage.authorId,
              authorDisplayName: lastMessage.authorDisplayName,
              createdAt: lastMessage.createdAt.toISOString(),
            }
          : null,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        unreadCount,
      } satisfies ConversationView;
    });

    // Salas de espacios aún sin materializar: entrada sintética (id null).
    const materializedSpaceIds = new Set(
      rows.filter((c) => c.type === 'SPACE').map((c) => c.spaceId ?? ''),
    );
    for (const s of [...spaces].sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (!materializedSpaceIds.has(s.id)) {
        views.push({
          id: null,
          type: 'SPACE',
          title: s.title,
          space: { slug: s.slug, icon: s.icon, color: s.color },
          counterpart: null,
          lastMessage: null,
          lastMessageAt: null,
          unreadCount: 0,
        });
      }
    }

    // Orden: actividad más reciente primero; sin actividad al final.
    views.sort((a, b) => {
      const ta = a.lastMessageAt ?? '';
      const tb = b.lastMessageAt ?? '';
      return tb.localeCompare(ta);
    });
    return views;
  }

  /** Último mensaje por conversación en 2 queries agregadas (groupBy + fetch). */
  private async fetchLastMessages(
    tenantId: string,
    rows: ConversationRow[],
  ): Promise<Map<string, MessageRow>> {
    const result = new Map<string, MessageRow>();
    const ids = rows.map((c) => c.id);
    if (ids.length === 0) return result;

    const maxRows = (await this.prisma.modMessagingMessage.groupBy({
      by: ['conversationId'],
      where: { tenantId, conversationId: { in: ids } },
      _max: { createdAt: true },
    } as never)) as Array<{ conversationId: string; _max: { createdAt: Date | null } }>;

    const pairs = maxRows
      .filter((r) => r._max.createdAt !== null)
      .map((r) => ({ conversationId: r.conversationId, createdAt: r._max.createdAt as Date }));
    if (pairs.length === 0) return result;

    const lastRows = (await this.prisma.modMessagingMessage.findMany({
      where: { tenantId, OR: pairs },
    })) as MessageRow[];
    for (const m of lastRows) {
      // Con empates de createdAt gana el id mayor (mismo criterio que el orden
      // del histórico).
      const prev = result.get(m.conversationId);
      if (
        !prev ||
        m.createdAt > prev.createdAt ||
        (m.createdAt.getTime() === prev.createdAt.getTime() && m.id > prev.id)
      ) {
        result.set(m.conversationId, m);
      }
    }
    return result;
  }

  /**
   * No-leídos por conversación en 1 groupBy (OR con el umbral de lectura de
   * cada una). Sin fila de participante: SPACE → 0 (no castigamos con el
   * histórico); FACULTY visto por staff → cuenta todo lo ajeno.
   */
  private async fetchUnreadCounts(
    tenantId: string,
    rows: ConversationRow[],
    caller: MessagingCaller,
    lastReadByConv: Map<string, Date | null>,
    staff: boolean,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const orClauses: Array<Record<string, unknown>> = [];
    for (const c of rows) {
      const hasRow = lastReadByConv.has(c.id);
      const lastReadAt = lastReadByConv.get(c.id) ?? null;
      if (hasRow) {
        orClauses.push({
          conversationId: c.id,
          authorId: { not: caller.userId },
          ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
        });
      } else if (c.type === 'FACULTY' && staff && c.studentId !== caller.userId) {
        orClauses.push({ conversationId: c.id, authorId: { not: caller.userId } });
      }
    }
    if (orClauses.length === 0) return result;

    const counts = (await this.prisma.modMessagingMessage.groupBy({
      by: ['conversationId'],
      where: { tenantId, OR: orClauses },
      _count: { _all: true },
    } as never)) as Array<{ conversationId: string; _count: { _all: number } }>;
    for (const r of counts) result.set(r.conversationId, r._count._all);
    return result;
  }

  // ── Apertura / creación ────────────────────────────────────────────────────

  /** Get-or-create de la sala de un espacio (lazy, AC1 UC-M201). */
  async openSpace(
    tenantId: string,
    caller: MessagingCaller,
    spaceSlug: string,
  ): Promise<{ conversationId: string }> {
    const spaces = await this.spacesLookup(tenantId);
    const space = spaces.find((s) => s.slug === spaceSlug);
    if (!space) throw new SpaceNotFoundError(spaceSlug);

    let conv = (await this.prisma.modMessagingConversation.findFirst({
      where: { tenantId, type: 'SPACE', spaceId: space.id },
      select: { id: true },
    })) as { id: string } | null;
    if (!conv) {
      try {
        conv = (await this.prisma.modMessagingConversation.create({
          data: { id: randomUUID(), tenantId, type: 'SPACE', spaceId: space.id },
          select: { id: true },
        })) as { id: string };
        await this.publisher.publish(
          tenantId,
          caller.userId,
          MESSAGING_EVENT.CONVERSATION_CREATED,
          {
            conversationId: conv.id,
            type: 'SPACE',
            spaceId: space.id,
          },
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        conv = (await this.prisma.modMessagingConversation.findFirst({
          where: { tenantId, type: 'SPACE', spaceId: space.id },
          select: { id: true },
        })) as { id: string };
      }
    }
    await this.touchParticipant(tenantId, conv.id, caller.userId, { markRead: true });
    return { conversationId: conv.id };
  }

  /** Get-or-create del DM con otro miembro (idempotente por par, AC1 UC-M101). */
  async openDm(
    tenantId: string,
    caller: MessagingCaller,
    targetUserId: string,
  ): Promise<{ conversationId: string; created: boolean }> {
    if (targetUserId === caller.userId) throw new SelfDmError();
    const targets = await this.usersLookup(tenantId, [targetUserId]);
    if (targets.length === 0) throw new TargetUserNotFoundError();

    const key = dmKeyOf(caller.userId, targetUserId);
    const existing = (await this.prisma.modMessagingConversation.findFirst({
      where: { tenantId, type: 'DM', dmKey: key },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) {
      await this.touchParticipant(tenantId, existing.id, caller.userId, { markRead: false });
      return { conversationId: existing.id, created: false };
    }

    const id = randomUUID();
    try {
      await this.prisma.$transaction([
        this.prisma.modMessagingConversation.create({
          data: { id, tenantId, type: 'DM', dmKey: key },
        }),
        this.prisma.modMessagingParticipant.create({
          data: { id: randomUUID(), tenantId, conversationId: id, userId: caller.userId },
        }),
        this.prisma.modMessagingParticipant.create({
          data: { id: randomUUID(), tenantId, conversationId: id, userId: targetUserId },
        }),
      ]);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = (await this.prisma.modMessagingConversation.findFirst({
        where: { tenantId, type: 'DM', dmKey: key },
        select: { id: true },
      })) as { id: string };
      return { conversationId: raced.id, created: false };
    }
    await this.publisher.publish(tenantId, caller.userId, MESSAGING_EVENT.CONVERSATION_CREATED, {
      conversationId: id,
      type: 'DM',
      participantIds: [caller.userId, targetUserId],
    });
    return { conversationId: id, created: true };
  }

  /** Get-or-create del canal de profesores del alumno llamante. */
  async openFaculty(
    tenantId: string,
    caller: MessagingCaller,
  ): Promise<{ conversationId: string }> {
    if (isStaff(caller.roles)) throw new StaffFacultyError();
    const id = await this.ensureFacultyConversation(tenantId, caller.userId);
    await this.touchParticipant(tenantId, id, caller.userId, { markRead: true });
    return { conversationId: id };
  }

  private async ensureFacultyConversation(tenantId: string, studentId: string): Promise<string> {
    const existing = (await this.prisma.modMessagingConversation.findFirst({
      where: { tenantId, type: 'FACULTY', studentId },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) return existing.id;
    const id = randomUUID();
    try {
      await this.prisma.$transaction([
        this.prisma.modMessagingConversation.create({
          data: { id, tenantId, type: 'FACULTY', studentId },
        }),
        this.prisma.modMessagingParticipant.create({
          data: { id: randomUUID(), tenantId, conversationId: id, userId: studentId },
        }),
      ]);
      await this.publisher.publish(tenantId, studentId, MESSAGING_EVENT.CONVERSATION_CREATED, {
        conversationId: id,
        type: 'FACULTY',
        studentId,
      });
      return id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = (await this.prisma.modMessagingConversation.findFirst({
        where: { tenantId, type: 'FACULTY', studentId },
        select: { id: true },
      })) as { id: string };
      return raced.id;
    }
  }

  // ── Mensajes ───────────────────────────────────────────────────────────────

  /** Histórico paginado por cursor, del más reciente al más antiguo (AC2 UC-M102). */
  async listMessages(
    tenantId: string,
    caller: MessagingCaller,
    conversationId: string,
    cursor?: string,
  ): Promise<MessagesPage> {
    const conv = await this.getConversationOrThrow(tenantId, conversationId);
    await this.assertAccess(conv, caller);

    const rows = (await this.prisma.modMessagingMessage.findMany({
      where: { tenantId, conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as MessageRow[];

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      messages: page.map(toMessageView),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Envía un mensaje de texto y devuelve los destinatarios del push (AC1 UC-M102). */
  async sendMessage(
    tenantId: string,
    caller: MessagingCaller,
    conversationId: string,
    body: string,
  ): Promise<SendResult> {
    const trimmed = body.trim();
    if (trimmed.length < 1 || trimmed.length > MESSAGE_MAX_LENGTH) {
      throw new MessageBodyInvalidError();
    }
    const conv = await this.getConversationOrThrow(tenantId, conversationId);
    await this.assertAccess(conv, caller);

    const now = new Date();
    const messageId = randomUUID();
    await this.prisma.$transaction([
      this.prisma.modMessagingMessage.create({
        data: {
          id: messageId,
          tenantId,
          conversationId,
          authorId: caller.userId,
          authorDisplayName: caller.displayName,
          kind: 'TEXT',
          body: trimmed,
          createdAt: now,
        },
      }),
      this.prisma.modMessagingConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now },
      }),
    ]);
    // El autor queda al día (su propio mensaje no cuenta como no-leído).
    await this.touchParticipant(tenantId, conversationId, caller.userId, { markRead: true });

    const recipientUserIds = await this.resolveRecipients(tenantId, conv, caller.userId);
    await this.publisher.publish(tenantId, caller.userId, MESSAGING_EVENT.MESSAGE_SENT, {
      conversationId,
      messageId,
      type: conv.type,
      recipients: recipientUserIds.length,
    });

    return {
      message: {
        id: messageId,
        conversationId,
        authorId: caller.userId,
        authorDisplayName: caller.displayName,
        kind: 'TEXT',
        body: trimmed,
        createdAt: now.toISOString(),
        deletedAt: null,
      },
      recipientUserIds,
    };
  }

  /** Marca la conversación como leída (AC3 UC-M102). */
  async markRead(tenantId: string, caller: MessagingCaller, conversationId: string): Promise<void> {
    const conv = await this.getConversationOrThrow(tenantId, conversationId);
    await this.assertAccess(conv, caller);
    await this.touchParticipant(tenantId, conversationId, caller.userId, { markRead: true });
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async getConversationOrThrow(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const conv = (await this.prisma.modMessagingConversation.findFirst({
      where: { id: conversationId, tenantId },
    })) as ConversationRow | null;
    if (!conv) throw new ConversationNotFoundError();
    return conv;
  }

  private async assertAccess(conv: ConversationRow, caller: MessagingCaller): Promise<void> {
    if (conv.type === 'SPACE') return; // abierta a todo el tenant
    if (conv.type === 'FACULTY') {
      if (conv.studentId === caller.userId || isStaff(caller.roles)) return;
      throw new NotParticipantError();
    }
    // DM: hay que estar en la dmKey.
    const [a, b] = (conv.dmKey ?? '').split(':');
    if (a === caller.userId || b === caller.userId) return;
    throw new NotParticipantError();
  }

  /** Crea/actualiza la fila de participante; con markRead sella lastReadAt. */
  private async touchParticipant(
    tenantId: string,
    conversationId: string,
    userId: string,
    opts: { markRead: boolean },
  ): Promise<void> {
    const existing = (await this.prisma.modMessagingParticipant.findFirst({
      where: { tenantId, conversationId, userId },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) {
      if (opts.markRead) {
        await this.prisma.modMessagingParticipant.update({
          where: { id: existing.id },
          data: { lastReadAt: new Date() },
        });
      }
      return;
    }
    try {
      await this.prisma.modMessagingParticipant.create({
        data: {
          id: randomUUID(),
          tenantId,
          conversationId,
          userId,
          lastReadAt: opts.markRead ? new Date() : null,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Carrera benigna: otra request creó la fila; si tocaba sellar lectura,
      // reintenta el update.
      if (opts.markRead) {
        const raced = (await this.prisma.modMessagingParticipant.findFirst({
          where: { tenantId, conversationId, userId },
          select: { id: true },
        })) as { id: string } | null;
        if (raced) {
          await this.prisma.modMessagingParticipant.update({
            where: { id: raced.id },
            data: { lastReadAt: new Date() },
          });
        }
      }
    }
  }

  /**
   * Destinatarios del indicador «está escribiendo» (ADR-019): los mismos que
   * los de un mensaje, tras verificar que el llamante participa. El evento no
   * persiste nada — el host solo lo publica y se acabó.
   */
  async recipientsForTyping(
    tenantId: string,
    caller: MessagingCaller,
    conversationId: string,
  ): Promise<string[]> {
    const conv = await this.getConversationOrThrow(tenantId, conversationId);
    await this.assertAccess(conv, caller);
    return this.resolveRecipients(tenantId, conv, caller.userId);
  }

  /** Destinatarios del push realtime, sin el autor. */
  private async resolveRecipients(
    tenantId: string,
    conv: ConversationRow,
    authorId: string,
  ): Promise<string[]> {
    if (conv.type === 'DM') {
      const [a, b] = (conv.dmKey ?? '').split(':');
      return [a, b].filter((u): u is string => Boolean(u) && u !== authorId);
    }
    if (conv.type === 'FACULTY') {
      const staff = await this.staffLookup(tenantId);
      const set = new Set<string>(staff);
      if (conv.studentId) set.add(conv.studentId);
      set.delete(authorId);
      return [...set];
    }
    // SPACE: quienes han abierto la sala alguna vez (fila de participante).
    const rows = (await this.prisma.modMessagingParticipant.findMany({
      where: { tenantId, conversationId: conv.id, userId: { not: authorId } },
      select: { userId: true },
    })) as Array<{ userId: string }>;
    return rows.map((r) => r.userId);
  }
}
