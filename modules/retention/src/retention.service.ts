/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Prisma, PrismaClient } from '@didacta/database';
import {
  RetentionAutomationNotFoundError,
  RetentionBodyInvalidError,
  RetentionDaysInvalidError,
  RetentionMemberNotEligibleError,
  RetentionRecoveryNotConfiguredError,
  RetentionSenderInvalidError,
  RetentionSettingsInvalidError,
  RetentionSubjectInvalidError,
  RetentionTemplateNotFoundError,
} from './errors.js';
import {
  activityReference,
  anniversaryOccurrences,
  daysAfterJoinOccurrences,
  inactiveOccurrences,
  welcomeOccurrences,
  type Occurrence,
} from './occurrences.js';
import type {
  RetentionAcademy,
  RetentionEnrollmentSignal,
  RetentionLink,
  RetentionMember,
  RetentionPorts,
  RetentionStaffMember,
} from './ports.js';
import {
  DAY_MS,
  HOUR_MS,
  isValidTimeZone,
  isWithinWindow,
  localDayKey,
  nextDayWindowStart,
  nextWindowStart,
  utcDayKey,
  wholeDaysBetween,
  type SendWindow,
} from './schedule.js';
import { findTemplate, RETENTION_TEMPLATES, type RetentionTemplateKey } from './templates.js';
import {
  assertVariables,
  firstNameOf,
  renderText,
  type RetentionLocale,
  type RetentionTriggerName,
  type RetentionVariableKey,
} from './variables.js';

/**
 * Servicio de dominio de mod.retention: los mensajes automáticos que programa
 * quien administra el aula y el panel de miembros en riesgo.
 *
 * El servicio es puro respecto al host: no conoce NestJS, ni Redis, ni las
 * tablas de los demás módulos. Lo que necesita del aula se lo dan los puertos
 * (`RetentionPorts`); lo que le pasa al aula le llega por eventos.
 *
 * ── Cómo sale un mensaje ──────────────────────────────────────────────────────
 *  1. Una OCURRENCIA crea una fila PENDING en `mod_retention_delivery`, única
 *     por (aula, mensaje, persona, ocurrencia): el barrido de cada 5 minutos
 *     para lo que depende del tiempo, el evento para lo que depende de un hecho.
 *     Recalcular o recibir un evento dos veces no duplica nada.
 *  2. El mismo barrido envía las pendientes con las reglas anti-spam:
 *     - nunca al equipo del aula ni a una cuenta que ya no está activa;
 *     - solo en la franja horaria del alumno (su zona, 9–21 h por defecto);
 *     - como mucho UN mensaje automático por persona y día (el resto espera
 *       al día siguiente, en orden de prioridad: la bienvenida va primero);
 *     - no si alguien del equipo le escribió a mano en las últimas 24 h;
 *     - la recuperación no sale si la persona ya ha vuelto.
 *  3. Antes de mandar se marca SENDING: si el proceso muere a mitad, queda en
 *     FAILED y no se repite. Antes perder uno que mandar dos.
 */

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface RetentionEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface RetentionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const RETENTION_EVENT = {
  MESSAGE_SENT: 'retention.message.sent',
} as const;

export const RETENTION_MODULE = 'mod.retention';

export const RETENTION_DEFAULTS = {
  manualCooldownHours: 24,
  sendWindowStartHour: 9,
  sendWindowEndHour: 21,
} as const;

/** Lo que más importa sale primero cuando a alguien le tocan dos el mismo día. */
const PRIORITY: Readonly<Record<RetentionTriggerName, number>> = {
  WELCOME: 0,
  COURSE_COMPLETED: 1,
  FIRST_POST: 2,
  LEVEL_UP: 3,
  DAYS_AFTER_JOIN: 4,
  ANNIVERSARY: 5,
  INACTIVE: 6,
};

const TIME_TRIGGERS = new Set<RetentionTriggerName>([
  'WELCOME',
  'DAYS_AFTER_JOIN',
  'INACTIVE',
  'ANNIVERSARY',
]);

/** Una pendiente que lleva una semana sin poder salir ya no tiene sentido. */
const MAX_PENDING_MS = 7 * DAY_MS;
/** Una marca SENDING más vieja que esto es un envío interrumpido. */
const STALE_SENDING_MS = 10 * 60 * 1000;
const PROCESS_BATCH = 300;
const RECEIPTS_WINDOW_MS = 30 * DAY_MS;
const RECEIPTS_BATCH = 500;
/** Sin fecha de pago reciente no es «pagó y no empezó»: le damos 2 días. */
const PAID_GRACE_DAYS = 2;
export const MESSAGE_BODY_MAX = 4000;
const SUBJECT_MAX = 200;
const NAME_MAX = 120;

export interface RetentionSettingsView {
  /** Quién firma (el elegido o, sin elegir, la primera persona que administra). */
  sender: RetentionStaffMember | null;
  /** Lo elegido explícitamente (null = automático). */
  senderUserId: string | null;
  staff: RetentionStaffMember[];
  manualCooldownHours: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
}

export interface RetentionSettingsPatch {
  senderUserId?: string | null;
  manualCooldownHours?: number;
  sendWindowStartHour?: number;
  sendWindowEndHour?: number;
}

export interface AutomationStats {
  sent: number;
  read: number;
  replied: number;
  pending: number;
  skipped: number;
  failed: number;
  emailed: number;
}

export interface AutomationView {
  id: string;
  trigger: RetentionTriggerName;
  name: string;
  templateKey: string | null;
  days: number | null;
  resendAfterDays: number | null;
  body: string;
  emailEnabled: boolean;
  emailSubject: string | null;
  enabled: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: AutomationStats;
}

export interface AutomationInput {
  trigger: RetentionTriggerName;
  name?: string | null;
  templateKey?: string | null;
  days?: number | null;
  resendAfterDays?: number | null;
  body: string;
  emailEnabled?: boolean;
  emailSubject?: string | null;
  enabled?: boolean;
}

export type AutomationPatch = Partial<Omit<AutomationInput, 'trigger' | 'templateKey'>>;

export interface TemplateView {
  key: RetentionTemplateKey;
  trigger: RetentionTriggerName;
  days: number | null;
  resendAfterDays: number | null;
  name: string;
  subject: string;
  body: string;
  /** Módulo que hace falta y está apagado en el aula: no se puede activar. */
  unavailableReason: 'module_disabled' | null;
  /** Mensaje del aula creado desde esta plantilla (si lo hay). */
  automationId: string | null;
}

export interface PreviewInput {
  trigger: RetentionTriggerName;
  body: string;
  subject?: string | null;
  /** Para quién se previsualiza; sin él, para quien mira. */
  userId?: string | null;
}

export interface PreviewView {
  body: string;
  subject: string;
  recipient: { id: string; name: string };
}

export type AtRiskReasonKind = 'inactive' | 'paid_not_started' | 'stalled';

export type AtRiskReason =
  | { kind: 'inactive'; days: number; neverEntered: boolean }
  | { kind: 'paid_not_started'; paidAt: string }
  | {
      kind: 'stalled';
      courseTitle: string;
      courseUrl: string;
      progressPercent: number;
      lastActivityAt: string | null;
    };

export interface AtRiskRow {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  joinedAt: string;
  lastActiveAt: string | null;
  reasons: AtRiskReason[];
  lastAutomatedAt: string | null;
  /** Tiene un mensaje de recuperación pendiente o enviado en este episodio. */
  inRecovery: boolean;
}

export interface AtRiskQuery {
  days?: number;
  reason?: AtRiskReasonKind | null;
  search?: string | null;
  limit?: number;
}

export interface AtRiskView {
  days: number;
  rows: AtRiskRow[];
  counts: Record<'all' | AtRiskReasonKind, number>;
  recovery: { automationId: string | null };
}

export interface RunStats {
  created: number;
  sent: number;
  postponed: number;
  skipped: number;
  failed: number;
}

type AutomationRow = {
  id: string;
  tenantId: string;
  trigger: RetentionTriggerName;
  name: string;
  templateKey: string | null;
  days: number | null;
  resendAfterDays: number | null;
  body: string;
  emailEnabled: boolean;
  emailSubject: string | null;
  enabled: boolean;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type DeliveryRow = {
  id: string;
  tenantId: string;
  automationId: string;
  userId: string;
  occurrenceKey: string;
  status: string;
  dueAt: Date;
  context: unknown;
  manual: boolean;
  createdAt: Date;
  automation: AutomationRow;
};

interface SettingsRow {
  senderUserId: string | null;
  manualCooldownHours: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
}

const EMPTY_STATS: AutomationStats = {
  sent: 0,
  read: 0,
  replied: 0,
  pending: 0,
  skipped: 0,
  failed: 0,
  emailed: 0,
};

function contextOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export class RetentionService {
  constructor(
    private readonly prisma: PrismaClient,
    /**
     * Los puertos se piden al usarlos y no al construir: el host los cablea
     * cuando su grafo de dependencias ya existe (la mensajería en tiempo real
     * vive en otro módulo de Nest).
     */
    private readonly portsOf: () => RetentionPorts,
    private readonly publisher?: RetentionEventPublisher,
    private readonly logger?: RetentionLogger,
  ) {}

  private get ports(): RetentionPorts {
    return this.portsOf();
  }

  // ── Ajustes ──────────────────────────────────────────────────────────────

  private async settingsRow(tenantId: string): Promise<SettingsRow> {
    const row = (await this.prisma.modRetentionSettings.findUnique({
      where: { tenantId },
    })) as SettingsRow | null;
    return (
      row ?? {
        senderUserId: null,
        manualCooldownHours: RETENTION_DEFAULTS.manualCooldownHours,
        sendWindowStartHour: RETENTION_DEFAULTS.sendWindowStartHour,
        sendWindowEndHour: RETENTION_DEFAULTS.sendWindowEndHour,
      }
    );
  }

  /** El elegido si sigue en el equipo; si no, la primera persona que administra. */
  private resolveSender(
    senderUserId: string | null,
    staff: RetentionStaffMember[],
  ): RetentionStaffMember | null {
    if (senderUserId) {
      const chosen = staff.find((s) => s.id === senderUserId);
      if (chosen) return chosen;
    }
    return staff[0] ?? null;
  }

  async getSettings(tenantId: string): Promise<RetentionSettingsView> {
    const [row, staff] = await Promise.all([
      this.settingsRow(tenantId),
      this.ports.listStaff(tenantId),
    ]);
    return {
      sender: this.resolveSender(row.senderUserId, staff),
      senderUserId: row.senderUserId,
      staff,
      manualCooldownHours: row.manualCooldownHours,
      sendWindowStartHour: row.sendWindowStartHour,
      sendWindowEndHour: row.sendWindowEndHour,
    };
  }

  async updateSettings(
    tenantId: string,
    actorId: string,
    patch: RetentionSettingsPatch,
  ): Promise<RetentionSettingsView> {
    const current = await this.settingsRow(tenantId);
    const next: SettingsRow = {
      senderUserId:
        patch.senderUserId === undefined ? current.senderUserId : (patch.senderUserId ?? null),
      manualCooldownHours: patch.manualCooldownHours ?? current.manualCooldownHours,
      sendWindowStartHour: patch.sendWindowStartHour ?? current.sendWindowStartHour,
      sendWindowEndHour: patch.sendWindowEndHour ?? current.sendWindowEndHour,
    };
    if (
      !isInt(next.manualCooldownHours) ||
      next.manualCooldownHours < 0 ||
      next.manualCooldownHours > 168 ||
      !isInt(next.sendWindowStartHour) ||
      !isInt(next.sendWindowEndHour) ||
      next.sendWindowStartHour < 0 ||
      next.sendWindowEndHour > 24 ||
      next.sendWindowEndHour - next.sendWindowStartHour < 2
    ) {
      throw new RetentionSettingsInvalidError();
    }
    if (next.senderUserId) {
      const staff = await this.ports.listStaff(tenantId);
      if (!staff.some((s) => s.id === next.senderUserId)) throw new RetentionSenderInvalidError();
    }
    await this.prisma.modRetentionSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...next, updatedById: actorId },
      update: { ...next, updatedById: actorId },
    });
    return this.getSettings(tenantId);
  }

  // ── Plantillas ───────────────────────────────────────────────────────────

  async listTemplates(tenantId: string, locale?: RetentionLocale): Promise<TemplateView[]> {
    const lang = locale ?? (await this.ports.academy(tenantId)).locale;
    const existing = (await this.prisma.modRetentionAutomation.findMany({
      where: { tenantId, deletedAt: null, templateKey: { not: null } },
      select: { id: true, templateKey: true },
    })) as Array<{ id: string; templateKey: string | null }>;
    const byKey = new Map(existing.map((e) => [e.templateKey, e.id]));
    const out: TemplateView[] = [];
    for (const t of RETENTION_TEMPLATES) {
      const disabled = t.requiresModule
        ? !(await this.ports.isModuleEnabled(tenantId, t.requiresModule))
        : false;
      const copy = t.copy[lang];
      out.push({
        key: t.key,
        trigger: t.trigger,
        days: t.days ?? null,
        resendAfterDays: t.resendAfterDays ?? null,
        name: copy.name,
        subject: copy.subject,
        body: copy.body,
        unavailableReason: disabled ? 'module_disabled' : null,
        automationId: byKey.get(t.key) ?? null,
      });
    }
    return out;
  }

  /**
   * «Activar con un clic»: crea el mensaje desde la plantilla, en el idioma
   * del aula y ya encendido. Si ya existe uno de esa plantilla, lo enciende en
   * vez de crear otro igual.
   */
  async activateTemplate(
    tenantId: string,
    actorId: string,
    templateKey: string,
    now = new Date(),
  ): Promise<AutomationView> {
    const template = findTemplate(templateKey);
    if (!template) throw new RetentionTemplateNotFoundError();
    const existing = (await this.prisma.modRetentionAutomation.findFirst({
      where: { tenantId, templateKey, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    })) as AutomationRow | null;
    if (existing) {
      if (!existing.enabled) {
        await this.prisma.modRetentionAutomation.update({
          where: { id: existing.id },
          data: { enabled: true, activatedAt: now },
        });
      }
      return this.getAutomation(tenantId, existing.id);
    }
    const { locale } = await this.ports.academy(tenantId);
    const copy = template.copy[locale];
    return this.createAutomation(
      tenantId,
      actorId,
      {
        trigger: template.trigger,
        templateKey: template.key,
        name: copy.name,
        days: template.days ?? null,
        resendAfterDays: template.resendAfterDays ?? null,
        body: copy.body,
        emailEnabled: false,
        emailSubject: copy.subject,
        enabled: true,
      },
      now,
    );
  }

  // ── Mensajes automáticos (CRUD) ──────────────────────────────────────────

  private normalize(
    input: AutomationInput,
    fallbackName: string,
  ): Omit<AutomationInput, 'enabled' | 'templateKey'> & { name: string } {
    const trigger = input.trigger;
    let days: number | null = null;
    let resendAfterDays: number | null = null;
    if (trigger === 'DAYS_AFTER_JOIN') {
      if (!isInt(input.days) || input.days < 1 || input.days > 730) {
        throw new RetentionDaysInvalidError();
      }
      days = input.days;
    } else if (trigger === 'INACTIVE') {
      if (!isInt(input.days) || input.days < 3 || input.days > 365) {
        throw new RetentionDaysInvalidError();
      }
      days = input.days;
      if (input.resendAfterDays !== null && input.resendAfterDays !== undefined) {
        if (
          !isInt(input.resendAfterDays) ||
          input.resendAfterDays < 1 ||
          input.resendAfterDays > 90
        ) {
          throw new RetentionDaysInvalidError();
        }
        resendAfterDays = input.resendAfterDays;
      }
    }
    const body = (input.body ?? '').trim();
    if (body.length < 1 || body.length > MESSAGE_BODY_MAX) throw new RetentionBodyInvalidError();
    assertVariables(body, trigger);
    const subject = (input.emailSubject ?? '').trim();
    if (subject.length > SUBJECT_MAX) throw new RetentionSubjectInvalidError();
    if (subject) assertVariables(subject, trigger);
    const name = ((input.name ?? '').trim() || fallbackName).slice(0, NAME_MAX);
    return {
      trigger,
      name,
      days,
      resendAfterDays,
      body,
      emailEnabled: Boolean(input.emailEnabled),
      emailSubject: subject || null,
    };
  }

  /** Nombre de respaldo: el de la primera plantilla de ese disparador. */
  private async defaultName(tenantId: string, trigger: RetentionTriggerName): Promise<string> {
    const { locale } = await this.ports.academy(tenantId);
    return RETENTION_TEMPLATES.find((t) => t.trigger === trigger)?.copy[locale].name ?? trigger;
  }

  async createAutomation(
    tenantId: string,
    actorId: string,
    input: AutomationInput,
    now = new Date(),
  ): Promise<AutomationView> {
    if (input.templateKey && !findTemplate(input.templateKey)) {
      throw new RetentionTemplateNotFoundError();
    }
    const data = this.normalize(input, await this.defaultName(tenantId, input.trigger));
    const enabled = Boolean(input.enabled);
    const row = (await this.prisma.modRetentionAutomation.create({
      data: {
        tenantId,
        trigger: data.trigger,
        name: data.name,
        templateKey: input.templateKey ?? null,
        days: data.days ?? null,
        resendAfterDays: data.resendAfterDays ?? null,
        body: data.body,
        emailEnabled: Boolean(data.emailEnabled),
        emailSubject: data.emailSubject ?? null,
        enabled,
        activatedAt: enabled ? now : null,
        createdById: actorId,
      },
    })) as AutomationRow;
    return this.getAutomation(tenantId, row.id);
  }

  private async findAutomation(tenantId: string, id: string): Promise<AutomationRow> {
    const row = (await this.prisma.modRetentionAutomation.findFirst({
      where: { id, tenantId, deletedAt: null },
    })) as AutomationRow | null;
    if (!row) throw new RetentionAutomationNotFoundError();
    return row;
  }

  async getAutomation(tenantId: string, id: string): Promise<AutomationView> {
    const row = await this.findAutomation(tenantId, id);
    const stats = await this.statsFor(tenantId, [row.id]);
    return this.toView(row, stats.get(row.id) ?? EMPTY_STATS);
  }

  /**
   * Edita un mensaje. Encenderlo, o cambiarle los días estando encendido,
   * reinicia `activatedAt`: la regla «desde que se activa» se cuenta desde el
   * cambio, y pasar de 30 a 7 días no le escribe de golpe a todos los que
   * cumplieron 7 días entre medias. Apagarlo cancela lo pendiente.
   */
  async updateAutomation(
    tenantId: string,
    actorId: string,
    id: string,
    patch: AutomationPatch,
    now = new Date(),
  ): Promise<AutomationView> {
    const row = await this.findAutomation(tenantId, id);
    const merged: AutomationInput = {
      trigger: row.trigger,
      name: patch.name !== undefined ? patch.name : row.name,
      days: patch.days !== undefined ? patch.days : row.days,
      resendAfterDays:
        patch.resendAfterDays !== undefined ? patch.resendAfterDays : row.resendAfterDays,
      body: patch.body !== undefined ? patch.body : row.body,
      emailEnabled: patch.emailEnabled !== undefined ? patch.emailEnabled : row.emailEnabled,
      emailSubject: patch.emailSubject !== undefined ? patch.emailSubject : row.emailSubject,
    };
    const data = this.normalize(merged, row.name);
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : row.enabled;
    const paramsChanged = data.days !== row.days || data.resendAfterDays !== row.resendAfterDays;
    let activatedAt = row.activatedAt;
    if (enabled && (!row.enabled || paramsChanged || !row.activatedAt)) activatedAt = now;
    await this.prisma.modRetentionAutomation.update({
      where: { id: row.id },
      data: {
        name: data.name,
        days: data.days ?? null,
        resendAfterDays: data.resendAfterDays ?? null,
        body: data.body,
        emailEnabled: Boolean(data.emailEnabled),
        emailSubject: data.emailSubject ?? null,
        enabled,
        activatedAt,
      },
    });
    if (row.enabled && !enabled) await this.cancelPending(tenantId, row.id, 'automation_off');
    this.logger?.info('mod.retention: mensaje actualizado', { tenantId, id, actorId, enabled });
    return this.getAutomation(tenantId, row.id);
  }

  async deleteAutomation(tenantId: string, id: string, now = new Date()): Promise<void> {
    const row = await this.findAutomation(tenantId, id);
    await this.prisma.modRetentionAutomation.update({
      where: { id: row.id },
      data: { deletedAt: now, enabled: false },
    });
    await this.cancelPending(tenantId, row.id, 'automation_off');
  }

  private async cancelPending(tenantId: string, automationId: string, reason: string) {
    await this.prisma.modRetentionDelivery.updateMany({
      where: { tenantId, automationId, status: 'PENDING' },
      data: { status: 'SKIPPED', skipReason: reason },
    });
  }

  async listAutomations(tenantId: string, now = new Date()): Promise<AutomationView[]> {
    // Las lecturas y respuestas se ponen al día al mirar la lista: el número
    // que ve la creadora es el de ahora, no el del último barrido.
    try {
      await this.syncReceipts(tenantId, now);
    } catch (err) {
      this.logger?.warn('mod.retention: no se pudieron actualizar las lecturas', {
        tenantId,
        error: (err as Error).message,
      });
    }
    const rows = (await this.prisma.modRetentionAutomation.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    })) as AutomationRow[];
    const stats = await this.statsFor(
      tenantId,
      rows.map((r) => r.id),
    );
    return rows
      .map((r) => this.toView(r, stats.get(r.id) ?? EMPTY_STATS))
      .sort((a, b) => PRIORITY[a.trigger] - PRIORITY[b.trigger] || (a.days ?? 0) - (b.days ?? 0));
  }

  private async statsFor(tenantId: string, ids: string[]): Promise<Map<string, AutomationStats>> {
    const out = new Map<string, AutomationStats>();
    if (ids.length === 0) return out;
    const base = { tenantId, automationId: { in: ids } };
    const [byStatus, read, replied, emailed] = await Promise.all([
      this.prisma.modRetentionDelivery.groupBy({
        by: ['automationId', 'status'],
        where: base,
        _count: { _all: true },
      }),
      this.prisma.modRetentionDelivery.groupBy({
        by: ['automationId'],
        where: { ...base, readAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.modRetentionDelivery.groupBy({
        by: ['automationId'],
        where: { ...base, repliedAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.modRetentionDelivery.groupBy({
        by: ['automationId'],
        where: { ...base, emailSentAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const get = (id: string) => {
      let s = out.get(id);
      if (!s) {
        s = { ...EMPTY_STATS };
        out.set(id, s);
      }
      return s;
    };
    for (const g of byStatus as Array<{
      automationId: string;
      status: string;
      _count: { _all: number };
    }>) {
      const s = get(g.automationId);
      const n = g._count._all;
      if (g.status === 'SENT') s.sent += n;
      else if (g.status === 'PENDING' || g.status === 'SENDING') s.pending += n;
      else if (g.status === 'SKIPPED') s.skipped += n;
      else if (g.status === 'FAILED') s.failed += n;
    }
    for (const g of read as Array<{ automationId: string; _count: { _all: number } }>) {
      get(g.automationId).read = g._count._all;
    }
    for (const g of replied as Array<{ automationId: string; _count: { _all: number } }>) {
      get(g.automationId).replied = g._count._all;
    }
    for (const g of emailed as Array<{ automationId: string; _count: { _all: number } }>) {
      get(g.automationId).emailed = g._count._all;
    }
    return out;
  }

  private toView(row: AutomationRow, stats: AutomationStats): AutomationView {
    return {
      id: row.id,
      trigger: row.trigger,
      name: row.name,
      templateKey: row.templateKey,
      days: row.days,
      resendAfterDays: row.resendAfterDays,
      body: row.body,
      emailEnabled: row.emailEnabled,
      emailSubject: row.emailSubject,
      enabled: row.enabled,
      activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      stats,
    };
  }

  // ── Variables y vista previa ─────────────────────────────────────────────

  /** El curso del que hablar: el terminado, el que tiene a medias o el primero. */
  private async courseFor(
    tenantId: string,
    userId: string,
    context: Record<string, unknown>,
  ): Promise<RetentionLink | null> {
    if (typeof context['courseId'] === 'string') {
      const link = await this.ports.courseLink(tenantId, context['courseId']);
      if (link) return link;
    }
    const enrollments = await this.ports.enrollmentSignals(tenantId, [userId]);
    const ordered = [...enrollments].sort(
      (a, b) =>
        (b.lastActivityAt ?? b.enrolledAt).getTime() - (a.lastActivityAt ?? a.enrolledAt).getTime(),
    );
    const inProgress = ordered.find((e) => !e.completedAt);
    const pick = inProgress ?? ordered[0];
    if (pick) return { title: pick.courseTitle, url: pick.courseUrl };
    return this.ports.firstPublishedCourse(tenantId);
  }

  /**
   * Valores de las variables para una persona. Con `forPreview`, lo que no
   * existe se queda SIN valor (y la variable se ve escrita); al enviar, todo
   * tiene valor aunque sea vacío.
   */
  private async valuesFor(
    tenantId: string,
    academy: RetentionAcademy,
    member: Pick<RetentionMember, 'id' | 'name' | 'email'>,
    trigger: RetentionTriggerName,
    context: Record<string, unknown>,
    forPreview = false,
  ): Promise<Partial<Record<RetentionVariableKey, string>>> {
    const course = await this.courseFor(tenantId, member.id, context);
    let level: string | undefined =
      typeof context['levelName'] === 'string' ? context['levelName'] : undefined;
    if (level === undefined && trigger === 'LEVEL_UP' && forPreview) {
      level = (await this.ports.levelName(tenantId, member.id)) ?? undefined;
    }
    const missing = forPreview ? undefined : '';
    return {
      name: firstNameOf(member.name, member.email),
      academy: academy.name,
      course: course?.title ?? missing,
      courseLink: course?.url ?? academy.coursesUrl,
      introLink: academy.introUrl,
      communityLink: academy.communityUrl,
      academyLink: academy.webBaseUrl,
      level: level ?? missing,
    };
  }

  async preview(tenantId: string, viewerId: string, input: PreviewInput): Promise<PreviewView> {
    const body = (input.body ?? '').trim();
    if (body.length < 1 || body.length > MESSAGE_BODY_MAX) throw new RetentionBodyInvalidError();
    assertVariables(body, input.trigger);
    const subjectRaw = (input.subject ?? '').trim();
    if (subjectRaw.length > SUBJECT_MAX) throw new RetentionSubjectInvalidError();
    if (subjectRaw) assertVariables(subjectRaw, input.trigger);
    const targetId = input.userId || viewerId;
    const [member] = await this.ports.getMembers(tenantId, [targetId]);
    if (!member) throw new RetentionMemberNotEligibleError();
    const academy = await this.ports.academy(tenantId);
    const values = await this.valuesFor(tenantId, academy, member, input.trigger, {}, true);
    return {
      body: renderText(body, values),
      subject: renderText(subjectRaw, values),
      recipient: { id: member.id, name: member.name?.trim() || member.email },
    };
  }

  // ── Eventos ──────────────────────────────────────────────────────────────

  private async enqueueEvent(
    tenantId: string,
    trigger: RetentionTriggerName,
    userId: string,
    occurrenceKey: string,
    context: Record<string, unknown>,
    now: Date,
    precheck?: () => Promise<boolean>,
  ): Promise<number> {
    const automations = (await this.prisma.modRetentionAutomation.findMany({
      where: { tenantId, trigger, enabled: true, deletedAt: null },
      select: { id: true },
    })) as Array<{ id: string }>;
    if (automations.length === 0) return 0;
    if (!(await this.ports.isModuleEnabled(tenantId, RETENTION_MODULE))) return 0;
    if (precheck && !(await precheck())) return 0;
    const [member] = await this.ports.getMembers(tenantId, [userId]);
    if (!member || member.isStaff) return 0;
    const result = await this.prisma.modRetentionDelivery.createMany({
      data: automations.map((a) => ({
        tenantId,
        automationId: a.id,
        userId,
        occurrenceKey,
        dueAt: now,
        context: context as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** `learning.course.completed`: una vez por curso terminado. */
  async onCourseCompleted(
    tenantId: string,
    userId: string,
    courseId: string,
    now = new Date(),
  ): Promise<number> {
    return this.enqueueEvent(
      tenantId,
      'COURSE_COMPLETED',
      userId,
      `course:${courseId}`,
      { courseId },
      now,
    );
  }

  /** `community.post.created`: solo si es SU primera publicación. */
  async onPostCreated(
    tenantId: string,
    authorId: string,
    postId: string,
    now = new Date(),
  ): Promise<number> {
    return this.enqueueEvent(tenantId, 'FIRST_POST', authorId, 'first-post', { postId }, now, () =>
      this.ports.isFirstPost(tenantId, authorId, postId),
    );
  }

  /** `gamification.level.changed`: una vez por nivel alcanzado. */
  async onLevelChanged(
    tenantId: string,
    userId: string,
    levelKey: string,
    levelName: string,
    now = new Date(),
  ): Promise<number> {
    return this.enqueueEvent(
      tenantId,
      'LEVEL_UP',
      userId,
      `level:${levelKey}`,
      { levelKey, levelName },
      now,
    );
  }

  // ── Barrido ──────────────────────────────────────────────────────────────

  /**
   * Aulas con algún mensaje encendido. Es una lectura de TODAS las aulas: el
   * host la envuelve en el acceso global sancionado.
   */
  async listActiveTenantIds(): Promise<string[]> {
    const rows = (await this.prisma.modRetentionAutomation.findMany({
      where: { enabled: true, deletedAt: null },
      select: { tenantId: true },
      distinct: ['tenantId'],
    })) as Array<{ tenantId: string }>;
    return rows.map((r) => r.tenantId);
  }

  /**
   * Un paso del barrido para UN aula: calcula ocurrencias, envía lo que toca y
   * pone al día lecturas y respuestas. Un aula sin mensajes encendidos no hace
   * nada más que esta primera consulta.
   */
  async runTenant(tenantId: string, now = new Date()): Promise<RunStats> {
    const stats: RunStats = { created: 0, sent: 0, postponed: 0, skipped: 0, failed: 0 };
    const automations = (await this.prisma.modRetentionAutomation.findMany({
      where: { tenantId, enabled: true, deletedAt: null },
    })) as AutomationRow[];
    if (automations.length === 0) return stats;
    // Módulo apagado en el aula: sus mensajes se quedan quietos (y lo pendiente
    // caduca solo si sigue apagado una semana).
    if (!(await this.ports.isModuleEnabled(tenantId, RETENTION_MODULE))) return stats;
    stats.created = await this.scan(tenantId, automations, now);
    const processed = await this.processDue(tenantId, now);
    stats.sent = processed.sent;
    stats.postponed = processed.postponed;
    stats.skipped = processed.skipped;
    stats.failed = processed.failed;
    await this.syncReceipts(tenantId, now);
    return stats;
  }

  private async firstInactiveSends(
    tenantId: string,
    automationId: string,
  ): Promise<Map<string, { occurrenceKey: string; sentAt: Date }>> {
    const rows = (await this.prisma.modRetentionDelivery.findMany({
      where: {
        tenantId,
        automationId,
        status: 'SENT',
        occurrenceKey: { startsWith: 'inactive:', not: { endsWith: ':resend' } },
      },
      select: { userId: true, occurrenceKey: true, sentAt: true },
      orderBy: { sentAt: 'asc' },
    })) as Array<{ userId: string; occurrenceKey: string; sentAt: Date | null }>;
    const out = new Map<string, { occurrenceKey: string; sentAt: Date }>();
    for (const r of rows) {
      if (r.sentAt) out.set(r.userId, { occurrenceKey: r.occurrenceKey, sentAt: r.sentAt });
    }
    return out;
  }

  private async scan(tenantId: string, automations: AutomationRow[], now: Date): Promise<number> {
    const timeBased = automations.filter(
      (a) => TIME_TRIGGERS.has(a.trigger) && a.activatedAt !== null,
    );
    if (timeBased.length === 0) return 0;
    const members = await this.ports.listMembers(tenantId);
    const memberMap = new Map(members.map((m) => [m.id, m]));
    let starts: Array<{ userId: string; startedAt: Date }> | null = null;
    const rows: Array<{
      tenantId: string;
      automationId: string;
      userId: string;
      occurrenceKey: string;
      dueAt: Date;
      context: Prisma.InputJsonValue;
    }> = [];
    for (const a of timeBased) {
      const activatedAt = a.activatedAt as Date;
      let occ: Occurrence[] = [];
      if (a.trigger === 'WELCOME') {
        occ = welcomeOccurrences(members, activatedAt, now);
      } else if (a.trigger === 'DAYS_AFTER_JOIN' && a.days) {
        occ = daysAfterJoinOccurrences(members, a.days, activatedAt, now);
      } else if (a.trigger === 'INACTIVE' && a.days) {
        const firstSends = a.resendAfterDays
          ? await this.firstInactiveSends(tenantId, a.id)
          : new Map<string, { occurrenceKey: string; sentAt: Date }>();
        occ = inactiveOccurrences(members, a.days, a.resendAfterDays, activatedAt, now, firstSends);
      } else if (a.trigger === 'ANNIVERSARY') {
        starts ??= await this.ports.subscriptionStarts(tenantId);
        occ = anniversaryOccurrences(starts, memberMap, activatedAt, now);
      }
      for (const o of occ) {
        rows.push({
          tenantId,
          automationId: a.id,
          userId: o.userId,
          occurrenceKey: o.occurrenceKey,
          dueAt: now,
          context: o.context as Prisma.InputJsonValue,
        });
      }
    }
    let created = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await this.prisma.modRetentionDelivery.createMany({
        data: rows.slice(i, i + 500),
        skipDuplicates: true,
      });
      created += res.count;
    }
    return created;
  }

  /** Zona del alumno; si no tiene una propia válida, la del aula; si no, UTC. */
  private timeZoneOf(member: RetentionMember, academy: RetentionAcademy): string {
    if (isValidTimeZone(member.timezone) && member.timezone !== 'UTC') return member.timezone;
    if (isValidTimeZone(academy.timezone)) return academy.timezone;
    return 'UTC';
  }

  private async processDue(
    tenantId: string,
    now: Date,
  ): Promise<{ sent: number; postponed: number; skipped: number; failed: number }> {
    const out = { sent: 0, postponed: 0, skipped: 0, failed: 0 };
    // Un envío que se quedó a medias (el proceso murió entre la marca y la
    // confirmación) NO se reintenta: puede que el mensaje sí saliera.
    await this.prisma.modRetentionDelivery.updateMany({
      where: {
        tenantId,
        status: 'SENDING',
        updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) },
      },
      data: { status: 'FAILED', lastError: 'interrupted' },
    });
    const due = (await this.prisma.modRetentionDelivery.findMany({
      where: { tenantId, status: 'PENDING', dueAt: { lte: now } },
      include: { automation: true },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: PROCESS_BATCH,
    })) as unknown as DeliveryRow[];
    if (due.length === 0) return out;

    const settings = await this.settingsRow(tenantId);
    const staff = await this.ports.listStaff(tenantId);
    const sender = this.resolveSender(settings.senderUserId, staff);
    if (!sender) {
      this.logger?.warn('mod.retention: el aula no tiene a nadie que firme los mensajes', {
        tenantId,
      });
      return out;
    }
    const staffIds = staff.map((s) => s.id);
    const userIds = [...new Set(due.map((d) => d.userId))];
    const members = new Map((await this.ports.getMembers(tenantId, userIds)).map((m) => [m.id, m]));
    const academy = await this.ports.academy(tenantId);
    const window: SendWindow = {
      startHour: settings.sendWindowStartHour,
      endHour: settings.sendWindowEndHour,
    };
    const lookbackMs = Math.max(26 * HOUR_MS, settings.manualCooldownHours * HOUR_MS);
    const recentSent = (await this.prisma.modRetentionDelivery.findMany({
      where: {
        tenantId,
        userId: { in: userIds },
        status: 'SENT',
        sentAt: { gte: new Date(now.getTime() - lookbackMs) },
      },
      select: { userId: true, sentAt: true, messageId: true },
    })) as Array<{ userId: string; sentAt: Date | null; messageId: string | null }>;

    const ordered = [...due].sort(
      (a, b) =>
        PRIORITY[a.automation.trigger] - PRIORITY[b.automation.trigger] ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const sentThisRun = new Set<string>();

    const skip = async (d: DeliveryRow, reason: string) => {
      await this.prisma.modRetentionDelivery.updateMany({
        where: { id: d.id, status: 'PENDING' },
        data: { status: 'SKIPPED', skipReason: reason },
      });
      out.skipped++;
    };
    const postpone = async (d: DeliveryRow, until: Date) => {
      await this.prisma.modRetentionDelivery.updateMany({
        where: { id: d.id, status: 'PENDING' },
        data: { dueAt: until },
      });
      out.postponed++;
    };

    for (const d of ordered) {
      const a = d.automation;
      if (!a.enabled || a.deletedAt) {
        await skip(d, 'automation_off');
        continue;
      }
      const m = members.get(d.userId);
      if (!m || m.isStaff || m.id === sender.id) {
        await skip(d, 'not_eligible');
        continue;
      }
      if (now.getTime() - d.createdAt.getTime() > MAX_PENDING_MS) {
        await skip(d, 'expired');
        continue;
      }
      const context = contextOf(d.context);
      if (a.trigger === 'INACTIVE' && typeof context['reference'] === 'string') {
        // Ha vuelto desde que se calculó: ya no hace falta recuperarla.
        if (activityReference(m).getTime() > Date.parse(context['reference'])) {
          await skip(d, 'came_back');
          continue;
        }
      }
      const tz = this.timeZoneOf(m, academy);
      if (!isWithinWindow(now, tz, window)) {
        await postpone(d, nextWindowStart(now, tz, window));
        continue;
      }
      const today = localDayKey(now, tz);
      const alreadyToday =
        sentThisRun.has(m.id) ||
        recentSent.some(
          (r) => r.userId === m.id && r.sentAt && localDayKey(r.sentAt, tz) === today,
        );
      if (alreadyToday) {
        await postpone(d, nextDayWindowStart(now, tz, window));
        continue;
      }
      if (settings.manualCooldownHours > 0) {
        const since = new Date(now.getTime() - settings.manualCooldownHours * HOUR_MS);
        const own = new Set(
          recentSent
            .filter((r) => r.userId === m.id && r.messageId)
            .map((r) => r.messageId as string),
        );
        const recent = await this.ports.recentDirectMessages(tenantId, staffIds, m.id, since);
        if (recent.some((r) => !own.has(r.messageId))) {
          await skip(d, 'recent_manual_message');
          continue;
        }
      }

      const claimed = await this.prisma.modRetentionDelivery.updateMany({
        where: { id: d.id, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      if (claimed.count !== 1) continue;

      const values = await this.valuesFor(tenantId, academy, m, a.trigger, context);
      const body = renderText(a.body, values).trim();
      let sent: { conversationId: string; messageId: string };
      try {
        sent = await this.ports.sendDirectMessage(tenantId, sender.id, m.id, body);
      } catch (err) {
        await this.prisma.modRetentionDelivery.update({
          where: { id: d.id },
          data: { status: 'FAILED', lastError: (err as Error).message.slice(0, 500) },
        });
        out.failed++;
        this.logger?.warn('mod.retention: no se pudo enviar el mensaje directo', {
          tenantId,
          deliveryId: d.id,
          error: (err as Error).message,
        });
        continue;
      }
      await this.prisma.modRetentionDelivery.update({
        where: { id: d.id },
        data: {
          status: 'SENT',
          sentAt: now,
          conversationId: sent.conversationId,
          messageId: sent.messageId,
        },
      });
      out.sent++;
      sentThisRun.add(m.id);
      recentSent.push({ userId: m.id, sentAt: now, messageId: sent.messageId });
      try {
        await this.publisher?.publish(tenantId, sender.id, RETENTION_EVENT.MESSAGE_SENT, {
          deliveryId: d.id,
          automationId: a.id,
          trigger: a.trigger,
          userId: m.id,
        });
      } catch {
        // El evento es informativo: el mensaje ya salió.
      }
      if (a.emailEnabled) await this.sendEmailCopy(tenantId, d.id, m.id, a, values, body);
    }
    return out;
  }

  private async sendEmailCopy(
    tenantId: string,
    deliveryId: string,
    userId: string,
    automation: AutomationRow,
    values: Partial<Record<RetentionVariableKey, string>>,
    body: string,
  ): Promise<void> {
    const subject = renderText(automation.emailSubject?.trim() || automation.name, values).trim();
    try {
      const outcome = await this.ports.sendEmail(tenantId, userId, { subject, body });
      await this.prisma.modRetentionDelivery.update({
        where: { id: deliveryId },
        data: outcome === 'sent' ? { emailSentAt: new Date() } : { emailSkipReason: outcome },
      });
    } catch (err) {
      await this.prisma.modRetentionDelivery.update({
        where: { id: deliveryId },
        data: { emailSkipReason: 'error' },
      });
      this.logger?.warn('mod.retention: no se pudo enviar la copia por correo', {
        tenantId,
        deliveryId,
        error: (err as Error).message,
      });
    }
  }

  /** Lecturas y respuestas de lo enviado en los últimos 30 días. */
  async syncReceipts(tenantId: string, now = new Date()): Promise<number> {
    const rows = (await this.prisma.modRetentionDelivery.findMany({
      where: {
        tenantId,
        status: 'SENT',
        conversationId: { not: null },
        sentAt: { gte: new Date(now.getTime() - RECEIPTS_WINDOW_MS) },
        OR: [{ readAt: null }, { repliedAt: null }],
      },
      select: {
        id: true,
        userId: true,
        conversationId: true,
        sentAt: true,
        readAt: true,
        repliedAt: true,
      },
      orderBy: { sentAt: 'desc' },
      take: RECEIPTS_BATCH,
    })) as Array<{
      id: string;
      userId: string;
      conversationId: string | null;
      sentAt: Date | null;
      readAt: Date | null;
      repliedAt: Date | null;
    }>;
    if (rows.length === 0) return 0;
    const receipts = await this.ports.receipts(
      tenantId,
      rows.map((r) => ({
        conversationId: r.conversationId as string,
        userId: r.userId,
        since: r.sentAt as Date,
      })),
    );
    let updated = 0;
    for (const [i, r] of rows.entries()) {
      const rec = receipts[i];
      if (!rec) continue;
      const sentAt = r.sentAt as Date;
      const repliedAt =
        r.repliedAt ?? (rec.repliedAt && rec.repliedAt >= sentAt ? rec.repliedAt : null);
      let readAt = r.readAt ?? (rec.lastReadAt && rec.lastReadAt >= sentAt ? rec.lastReadAt : null);
      // Quien contesta lo ha leído.
      if (!readAt && repliedAt) readAt = repliedAt;
      if (
        readAt?.getTime() !== r.readAt?.getTime() ||
        repliedAt?.getTime() !== r.repliedAt?.getTime()
      ) {
        await this.prisma.modRetentionDelivery.update({
          where: { id: r.id },
          data: { readAt, repliedAt },
        });
        updated++;
      }
    }
    return updated;
  }

  // ── Miembros en riesgo ───────────────────────────────────────────────────

  async atRisk(tenantId: string, query: AtRiskQuery = {}, now = new Date()): Promise<AtRiskView> {
    const days = isInt(query.days) && query.days >= 1 && query.days <= 365 ? query.days : 14;
    const limit = isInt(query.limit) && query.limit > 0 ? Math.min(query.limit, 500) : 200;
    const [members, enrollments, paid, recovery] = await Promise.all([
      this.ports.listMembers(tenantId),
      this.ports.enrollmentSignals(tenantId),
      this.ports.paidAccess(tenantId),
      this.prisma.modRetentionAutomation.findFirst({
        where: { tenantId, trigger: 'INACTIVE', enabled: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }) as Promise<{ id: string } | null>,
    ]);
    const enrollmentsByUser = new Map<string, RetentionEnrollmentSignal[]>();
    for (const e of enrollments) {
      const list = enrollmentsByUser.get(e.userId) ?? [];
      list.push(e);
      enrollmentsByUser.set(e.userId, list);
    }
    const firstPaid = new Map<string, Date>();
    for (const p of paid) {
      const prev = firstPaid.get(p.userId);
      if (!prev || p.paidAt < prev) firstPaid.set(p.userId, p.paidAt);
    }
    const threshold = now.getTime() - days * DAY_MS;

    const candidates: Array<{ m: RetentionMember; reasons: AtRiskReason[]; idle: number }> = [];
    for (const m of members) {
      if (m.isStaff) continue;
      const reasons: AtRiskReason[] = [];
      const reference = activityReference(m);
      const idle = wholeDaysBetween(reference, now);
      if (reference.getTime() <= threshold) {
        reasons.push({ kind: 'inactive', days: idle, neverEntered: m.lastActiveAt === null });
      }
      const mine = enrollmentsByUser.get(m.id) ?? [];
      const paidAt =
        firstPaid.get(m.id) ??
        mine
          .filter((e) => e.paid)
          .map((e) => e.enrolledAt)
          .sort((a, b) => a.getTime() - b.getTime())[0];
      const started = mine.some((e) => e.startedAt !== null || e.progressPercent > 0);
      if (paidAt && !started && wholeDaysBetween(paidAt, now) >= PAID_GRACE_DAYS) {
        reasons.push({ kind: 'paid_not_started', paidAt: paidAt.toISOString() });
      }
      const stalled = mine
        .filter(
          (e) =>
            !e.completedAt &&
            (e.startedAt !== null || e.progressPercent > 0) &&
            e.progressPercent < 100 &&
            (e.lastActivityAt ?? e.startedAt ?? e.enrolledAt).getTime() <= threshold,
        )
        .sort((a, b) => b.progressPercent - a.progressPercent)[0];
      if (stalled) {
        reasons.push({
          kind: 'stalled',
          courseTitle: stalled.courseTitle,
          courseUrl: stalled.courseUrl,
          progressPercent: stalled.progressPercent,
          lastActivityAt: stalled.lastActivityAt ? stalled.lastActivityAt.toISOString() : null,
        });
      }
      if (reasons.length > 0) candidates.push({ m, reasons, idle });
    }

    const counts: AtRiskView['counts'] = {
      all: candidates.length,
      inactive: 0,
      paid_not_started: 0,
      stalled: 0,
    };
    for (const c of candidates) for (const r of c.reasons) counts[r.kind]++;

    const search = (query.search ?? '').trim().toLowerCase();
    const filtered = candidates
      .filter((c) => !query.reason || c.reasons.some((r) => r.kind === query.reason))
      .filter(
        (c) =>
          !search ||
          (c.m.name ?? '').toLowerCase().includes(search) ||
          c.m.email.toLowerCase().includes(search),
      )
      .sort((a, b) => b.idle - a.idle)
      .slice(0, limit);

    const ids = filtered.map((c) => c.m.id);
    const deliveries = ids.length
      ? ((await this.prisma.modRetentionDelivery.findMany({
          where: { tenantId, userId: { in: ids }, status: { in: ['PENDING', 'SENDING', 'SENT'] } },
          select: {
            userId: true,
            status: true,
            sentAt: true,
            occurrenceKey: true,
            automationId: true,
          },
        })) as Array<{
          userId: string;
          status: string;
          sentAt: Date | null;
          occurrenceKey: string;
          automationId: string;
        }>)
      : [];

    const rows: AtRiskRow[] = filtered.map(({ m, reasons }) => {
      const mine = deliveries.filter((d) => d.userId === m.id);
      const last = mine
        .filter((d) => d.sentAt)
        .map((d) => d.sentAt as Date)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const episodeDay = utcDayKey(activityReference(m));
      const inRecovery = mine.some(
        (d) =>
          recovery !== null &&
          d.automationId === recovery.id &&
          d.occurrenceKey.includes(episodeDay),
      );
      return {
        id: m.id,
        name: m.name?.trim() || m.email,
        email: m.email,
        avatarUrl: m.avatarUrl,
        joinedAt: m.joinedAt.toISOString(),
        lastActiveAt: m.lastActiveAt ? m.lastActiveAt.toISOString() : null,
        reasons,
        lastAutomatedAt: last ? last.toISOString() : null,
        inRecovery,
      };
    });

    return { days, rows, counts, recovery: { automationId: recovery?.id ?? null } };
  }

  /**
   * «Añadir a recuperación»: le pone en cola el mensaje de recuperación del
   * aula aunque no haya cruzado el umbral (o lo cruzara antes de activarlo).
   * Sigue las mismas reglas anti-spam que cualquier otro envío.
   */
  async addToRecovery(
    tenantId: string,
    userId: string,
    now = new Date(),
  ): Promise<{ queued: boolean; automationId: string }> {
    const recovery = (await this.prisma.modRetentionAutomation.findFirst({
      where: { tenantId, trigger: 'INACTIVE', enabled: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })) as { id: string } | null;
    if (!recovery) throw new RetentionRecoveryNotConfiguredError();
    const [member] = await this.ports.getMembers(tenantId, [userId]);
    if (!member || member.isStaff) throw new RetentionMemberNotEligibleError();
    const reference = activityReference(member);
    const result = await this.prisma.modRetentionDelivery.createMany({
      data: [
        {
          tenantId,
          automationId: recovery.id,
          userId,
          occurrenceKey: `manual:${utcDayKey(reference)}`,
          dueAt: now,
          manual: true,
          context: { reference: reference.toISOString() } as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return { queued: result.count === 1, automationId: recovery.id };
  }
}
