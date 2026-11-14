/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  RetentionDaysInvalidError,
  RetentionRecoveryNotConfiguredError,
  RetentionUnknownVariableError,
  RetentionVariableNotAvailableError,
} from '../src/errors.js';
import type {
  RetentionAcademy,
  RetentionEmailOutcome,
  RetentionEnrollmentSignal,
  RetentionMember,
  RetentionPorts,
} from '../src/ports.js';
import { RetentionService } from '../src/retention.service.js';
import { createFakePrisma, type FakePrisma } from './fake-prisma.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Viernes 14-nov-2026, 12:00 UTC = 13:00 en Madrid (dentro de la franja). */
const NOON = new Date('2026-11-14T12:00:00Z');

interface SentDm {
  tenantId: string;
  senderId: string;
  toUserId: string;
  body: string;
  messageId: string;
}

class FakePorts implements RetentionPorts {
  members = new Map<string, RetentionMember[]>();
  staff = new Map<string, Array<{ id: string; name: string; avatarUrl: null }>>();
  sent: SentDm[] = [];
  emails: Array<{ tenantId: string; to: string; subject: string; body: string }> = [];
  emailOutcome: RetentionEmailOutcome = 'sent';
  manual: Array<{ tenantId: string; author: string; to: string; messageId: string; at: Date }> = [];
  firstPost = true;
  enrollments: RetentionEnrollmentSignal[] = [];
  paid: Array<{ userId: string; paidAt: Date }> = [];
  disabledModules = new Set<string>();
  readAt = new Map<string, Date>();
  replies = new Map<string, Date>();
  failNext = false;
  locale: 'es' | 'en' | 'pt' = 'es';

  async academy(tenantId: string): Promise<RetentionAcademy> {
    const web = `https://${tenantId.slice(0, 4)}.example.com`;
    return {
      name: tenantId === A ? 'Primer Sorbo' : 'Otra Aula',
      locale: this.locale,
      timezone: 'Europe/Madrid',
      webBaseUrl: web,
      introUrl: `${web}/spaces/general`,
      communityUrl: `${web}/community`,
      coursesUrl: `${web}/courses`,
    };
  }
  async listMembers(tenantId: string) {
    return this.members.get(tenantId) ?? [];
  }
  async getMembers(tenantId: string, ids: string[]) {
    return (this.members.get(tenantId) ?? []).filter((m) => ids.includes(m.id));
  }
  async listStaff(tenantId: string) {
    return this.staff.get(tenantId) ?? [];
  }
  async isModuleEnabled(_tenantId: string, name: string) {
    return !this.disabledModules.has(name);
  }
  async enrollmentSignals(tenantId: string, userIds?: string[]) {
    void tenantId;
    return this.enrollments.filter((e) => !userIds || userIds.includes(e.userId));
  }
  async firstPublishedCourse() {
    return { title: 'Cata para principiantes', url: 'https://aaaa.example.com/courses/cata' };
  }
  async courseLink(_t: string, courseId: string) {
    return { title: `Curso ${courseId}`, url: `https://aaaa.example.com/courses/${courseId}` };
  }
  async levelName() {
    return 'Sumiller';
  }
  async paidAccess() {
    return this.paid;
  }
  async subscriptionStarts() {
    return [];
  }
  async isFirstPost() {
    return this.firstPost;
  }
  async sendDirectMessage(tenantId: string, senderId: string, toUserId: string, body: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mensajería caída');
    }
    const messageId = `msg-${this.sent.length + 1}`;
    this.sent.push({ tenantId, senderId, toUserId, body, messageId });
    return { conversationId: `conv-${senderId}-${toUserId}`, messageId };
  }
  async recentDirectMessages(tenantId: string, authorIds: string[], to: string, since: Date) {
    const fromAutomated = this.sent
      .filter((s) => s.tenantId === tenantId && s.toUserId === to)
      .map((s) => ({ messageId: s.messageId, createdAt: since }));
    const manual = this.manual
      .filter((m) => m.tenantId === tenantId && m.to === to && authorIds.includes(m.author))
      .filter((m) => m.at >= since)
      .map((m) => ({ messageId: m.messageId, createdAt: m.at }));
    return [...fromAutomated, ...manual];
  }
  async receipts(
    _t: string,
    items: Array<{ conversationId: string; userId: string; since: Date }>,
  ) {
    return items.map((i) => ({
      conversationId: i.conversationId,
      userId: i.userId,
      lastReadAt: this.readAt.get(i.userId) ?? null,
      repliedAt: this.replies.get(i.userId) ?? null,
    }));
  }
  async sendEmail(tenantId: string, to: string, m: { subject: string; body: string }) {
    if (this.emailOutcome === 'sent') this.emails.push({ tenantId, to, ...m });
    return this.emailOutcome;
  }
}

function student(id: string, over: Partial<RetentionMember> = {}): RetentionMember {
  return {
    id,
    name: `Alumna ${id}`,
    email: `${id}@example.com`,
    avatarUrl: null,
    timezone: 'Europe/Madrid',
    joinedAt: new Date(NOON.getTime() - HOUR),
    lastActiveAt: new Date(NOON.getTime() - HOUR),
    isStaff: false,
    imported: false,
    ...over,
  };
}

describe('RetentionService', () => {
  let prisma: FakePrisma;
  let ports: FakePorts;
  let service: RetentionService;

  beforeEach(() => {
    prisma = createFakePrisma();
    ports = new FakePorts();
    service = new RetentionService(prisma as never, () => ports);
    ports.staff.set(A, [{ id: 'creadora-a', name: 'Lucía', avatarUrl: null }]);
    ports.staff.set(B, [{ id: 'creador-b', name: 'Pablo', avatarUrl: null }]);
  });

  /** Activa la bienvenida «hace un rato» (antes de las altas de prueba). */
  async function welcomeActive(tenantId = A, extra: { emailEnabled?: boolean } = {}) {
    const a = await service.activateTemplate(
      tenantId,
      'admin',
      'welcome',
      new Date(NOON.getTime() - 2 * HOUR),
    );
    if (extra.emailEnabled) {
      await service.updateAutomation(
        tenantId,
        'admin',
        a.id,
        { emailEnabled: true },
        new Date(NOON.getTime() - 2 * HOUR),
      );
    }
    return a;
  }

  describe('plantillas', () => {
    it('se activan con un clic, en el idioma del aula, y no se duplican', async () => {
      ports.locale = 'pt';
      const first = await service.activateTemplate(A, 'admin', 'welcome', NOON);
      expect(first.enabled).toBe(true);
      expect(first.name).toBe('Boas-vindas');
      expect(first.body).toContain('{escola}');
      const again = await service.activateTemplate(A, 'admin', 'welcome', NOON);
      expect(again.id).toBe(first.id);
      expect((await service.listAutomations(A, NOON)).length).toBe(1);
      const templates = await service.listTemplates(A);
      expect(templates.find((t) => t.key === 'welcome')?.automationId).toBe(first.id);
    });

    it('la de subir de nivel no se puede activar sin gamificación', async () => {
      ports.disabledModules.add('mod.gamification');
      const t = await service.listTemplates(A, 'es');
      expect(t.find((x) => x.key === 'level_up')?.unavailableReason).toBe('module_disabled');
      expect(t.find((x) => x.key === 'welcome')?.unavailableReason).toBeNull();
    });
  });

  describe('validación al guardar', () => {
    it('rechaza variables desconocidas y {nivel} fuera de su mensaje', async () => {
      await expect(
        service.createAutomation(A, 'admin', { trigger: 'WELCOME', body: 'Hola {nmbre}' }),
      ).rejects.toBeInstanceOf(RetentionUnknownVariableError);
      await expect(
        service.createAutomation(A, 'admin', { trigger: 'WELCOME', body: 'Eres {nivel}' }),
      ).rejects.toBeInstanceOf(RetentionVariableNotAvailableError);
    });

    it('exige días válidos según el disparador', async () => {
      await expect(
        service.createAutomation(A, 'admin', { trigger: 'DAYS_AFTER_JOIN', body: 'x' }),
      ).rejects.toBeInstanceOf(RetentionDaysInvalidError);
      await expect(
        service.createAutomation(A, 'admin', { trigger: 'INACTIVE', days: 1, body: 'x' }),
      ).rejects.toBeInstanceOf(RetentionDaysInvalidError);
      const ok = await service.createAutomation(A, 'admin', {
        trigger: 'INACTIVE',
        days: 10,
        resendAfterDays: 5,
        body: 'Hola {nombre}',
      });
      expect(ok.days).toBe(10);
      expect(ok.resendAfterDays).toBe(5);
      expect(ok.enabled).toBe(false);
      expect(ok.name).toBe('Te echamos de menos');
    });
  });

  describe('envío', () => {
    it('bienvenida: mensaje directo de quien firma, con variables, una sola vez', async () => {
      await welcomeActive();
      ports.members.set(A, [student('ana', { name: 'Ana Pérez' })]);
      const r1 = await service.runTenant(A, NOON);
      const r2 = await service.runTenant(A, new Date(NOON.getTime() + 5 * 60_000));
      expect(r1.sent).toBe(1);
      expect(r2.sent).toBe(0);
      expect(ports.sent).toHaveLength(1);
      const dm = ports.sent[0]!;
      expect(dm.senderId).toBe('creadora-a');
      expect(dm.toUserId).toBe('ana');
      expect(dm.body).toContain('¡Hola, Ana! Te doy la bienvenida a Primer Sorbo.');
      expect(dm.body).toContain('https://aaaa.example.com/spaces/general');
      expect(dm.body).not.toMatch(/\{[a-z_]+\}/);
      expect(prisma.modRetentionDelivery.rows).toHaveLength(1);
    });

    it('nunca escribe al equipo ni a quien firma', async () => {
      await welcomeActive();
      ports.members.set(A, [
        student('profe', { isStaff: true }),
        student('creadora-a', { isStaff: false }),
      ]);
      await service.runTenant(A, NOON);
      expect(ports.sent).toHaveLength(0);
    });

    it('como mucho uno al día: el segundo espera a mañana a las 9 de SU zona', async () => {
      await welcomeActive();
      await service.activateTemplate(A, 'admin', 'course_completed', NOON);
      ports.members.set(A, [student('ana')]);
      await service.onCourseCompleted(A, 'ana', 'curso-1', NOON);
      const r = await service.runTenant(A, NOON);
      expect(r.sent).toBe(1);
      expect(r.postponed).toBe(1);
      // Va primero la bienvenida.
      expect(ports.sent[0]!.body).toContain('bienvenida');
      const waiting = prisma.modRetentionDelivery.rows.find((d) => d['status'] === 'PENDING')!;
      expect((waiting['dueAt'] as Date).toISOString()).toBe('2026-11-15T08:00:00.000Z');
      // Al día siguiente sale.
      const r2 = await service.runTenant(A, new Date('2026-11-15T08:01:00Z'));
      expect(r2.sent).toBe(1);
      expect(ports.sent[1]!.body).toContain('Curso curso-1');
    });

    it('respeta la hora del alumno: de madrugada en Bogotá, espera a sus 9:00', async () => {
      const madrugada = new Date('2026-11-14T08:00:00Z'); // 03:00 en Bogotá
      await service.activateTemplate(
        A,
        'admin',
        'welcome',
        new Date(madrugada.getTime() - 2 * HOUR),
      );
      ports.members.set(A, [
        student('lucas', {
          timezone: 'America/Bogota',
          joinedAt: new Date(madrugada.getTime() - HOUR),
        }),
      ]);
      const r = await service.runTenant(A, madrugada);
      expect(r.sent).toBe(0);
      expect(r.postponed).toBe(1);
      const d = prisma.modRetentionDelivery.rows[0]!;
      expect((d['dueAt'] as Date).toISOString()).toBe('2026-11-14T14:00:00.000Z');
      expect((await service.runTenant(A, new Date('2026-11-14T14:00:30Z'))).sent).toBe(1);
    });

    it('sin zona propia (UTC por defecto) usa la del aula', async () => {
      await welcomeActive();
      ports.members.set(A, [student('ana', { timezone: 'UTC' })]);
      // 06:30 UTC = 07:30 en Madrid: fuera de la franja del aula.
      const early = new Date('2026-11-14T06:30:00Z');
      prisma.modRetentionAutomation.rows[0]!['activatedAt'] = new Date(early.getTime() - 2 * HOUR);
      ports.members.set(A, [
        student('ana', { timezone: 'UTC', joinedAt: new Date(early.getTime() - HOUR) }),
      ]);
      expect((await service.runTenant(A, early)).sent).toBe(0);
      expect((prisma.modRetentionDelivery.rows[0]!['dueAt'] as Date).toISOString()).toBe(
        '2026-11-14T08:00:00.000Z',
      );
    });

    it('si alguien del equipo le escribió a mano en 24 h, no se envía', async () => {
      await welcomeActive();
      ports.members.set(A, [student('ana')]);
      ports.manual.push({
        tenantId: A,
        author: 'creadora-a',
        to: 'ana',
        messageId: 'manual-1',
        at: new Date(NOON.getTime() - 3 * HOUR),
      });
      const r = await service.runTenant(A, NOON);
      expect(r.sent).toBe(0);
      expect(r.skipped).toBe(1);
      expect(prisma.modRetentionDelivery.rows[0]!['skipReason']).toBe('recent_manual_message');
    });

    it('con la espera a 0 horas, el mensaje a mano no lo frena', async () => {
      await service.updateSettings(A, 'admin', { manualCooldownHours: 0 });
      await welcomeActive();
      ports.members.set(A, [student('ana')]);
      ports.manual.push({ tenantId: A, author: 'creadora-a', to: 'ana', messageId: 'm', at: NOON });
      expect((await service.runTenant(A, NOON)).sent).toBe(1);
    });

    it('apagar un mensaje cancela lo pendiente', async () => {
      const madrugada = new Date('2026-11-14T08:00:00Z'); // 03:00 en Bogotá
      const a = await service.activateTemplate(
        A,
        'admin',
        'welcome',
        new Date(madrugada.getTime() - 2 * HOUR),
      );
      ports.members.set(A, [
        student('ana', {
          timezone: 'America/Bogota',
          joinedAt: new Date(madrugada.getTime() - HOUR),
        }),
      ]);
      await service.runTenant(A, madrugada);
      expect(prisma.modRetentionDelivery.rows[0]!['status']).toBe('PENDING');
      await service.updateAutomation(A, 'admin', a.id, { enabled: false });
      expect(prisma.modRetentionDelivery.rows[0]!['status']).toBe('SKIPPED');
      expect(prisma.modRetentionDelivery.rows[0]!['skipReason']).toBe('automation_off');
    });

    it('un envío interrumpido (SENDING viejo) queda FAILED y no se repite', async () => {
      await welcomeActive();
      ports.members.set(A, [student('ana')]);
      ports.failNext = true;
      const r = await service.runTenant(A, NOON);
      expect(r.failed).toBe(1);
      expect((await service.runTenant(A, new Date(NOON.getTime() + 10 * 60_000))).sent).toBe(0);
      // Una marca SENDING abandonada se cierra como FAILED, nunca vuelve a PENDING.
      prisma.modRetentionDelivery.rows[0]!['status'] = 'SENDING';
      prisma.modRetentionDelivery.rows[0]!['updatedAt'] = new Date(NOON.getTime() - HOUR);
      await service.runTenant(A, NOON);
      expect(prisma.modRetentionDelivery.rows[0]!['status']).toBe('FAILED');
      expect(prisma.modRetentionDelivery.rows[0]!['lastError']).toBe('interrupted');
      expect(ports.sent).toHaveLength(0);
    });

    it('copia por correo: asunto y texto con variables; la baja se respeta', async () => {
      await welcomeActive(A, { emailEnabled: true });
      ports.members.set(A, [student('ana', { name: 'Ana' }), student('bea', { name: 'Bea' })]);
      ports.emailOutcome = 'sent';
      await service.runTenant(A, NOON);
      expect(ports.emails).toHaveLength(2);
      expect(ports.emails[0]!.subject).toBe('Te doy la bienvenida a Primer Sorbo');
      expect(ports.emails[0]!.body).toContain('¡Hola, Ana!');
      const delivered = prisma.modRetentionDelivery.rows.filter((d) => d['emailSentAt']);
      expect(delivered).toHaveLength(2);

      ports.emailOutcome = 'opted_out';
      ports.members.set(A, [student('carla')]);
      await service.runTenant(A, new Date(NOON.getTime() + 60_000));
      const carla = prisma.modRetentionDelivery.rows.find((d) => d['userId'] === 'carla')!;
      expect(carla['status']).toBe('SENT');
      expect(carla['emailSkipReason']).toBe('opted_out');
    });

    it('un aula no toca lo de otra (y el módulo apagado no envía nada)', async () => {
      await welcomeActive(A);
      await welcomeActive(B);
      ports.members.set(A, [student('ana')]);
      ports.members.set(B, [student('bruno')]);
      await service.runTenant(A, NOON);
      expect(ports.sent.map((s) => [s.tenantId, s.toUserId, s.senderId])).toEqual([
        [A, 'ana', 'creadora-a'],
      ]);
      ports.disabledModules.add('mod.retention');
      expect((await service.runTenant(B, NOON)).sent).toBe(0);
      ports.disabledModules.clear();
      await service.runTenant(B, NOON);
      expect(ports.sent.map((s) => [s.tenantId, s.toUserId, s.senderId])).toEqual([
        [A, 'ana', 'creadora-a'],
        [B, 'bruno', 'creador-b'],
      ]);
      expect(ports.sent[1]!.body).toContain('Otra Aula');
    });
  });

  describe('eventos', () => {
    it('primera publicación: solo si de verdad es la primera', async () => {
      await service.activateTemplate(A, 'admin', 'first_post', NOON);
      ports.members.set(A, [student('ana')]);
      ports.firstPost = false;
      expect(await service.onPostCreated(A, 'ana', 'post-2', NOON)).toBe(0);
      ports.firstPost = true;
      expect(await service.onPostCreated(A, 'ana', 'post-1', NOON)).toBe(1);
      // El evento repetido (reintento del outbox) no duplica.
      expect(await service.onPostCreated(A, 'ana', 'post-1', NOON)).toBe(0);
    });

    it('curso terminado: una vez por curso; nunca para el equipo', async () => {
      await service.activateTemplate(A, 'admin', 'course_completed', NOON);
      ports.members.set(A, [student('ana'), student('profe', { isStaff: true })]);
      expect(await service.onCourseCompleted(A, 'ana', 'c1', NOON)).toBe(1);
      expect(await service.onCourseCompleted(A, 'ana', 'c1', NOON)).toBe(0);
      expect(await service.onCourseCompleted(A, 'ana', 'c2', NOON)).toBe(1);
      expect(await service.onCourseCompleted(A, 'profe', 'c1', NOON)).toBe(0);
    });

    it('subida de nivel: el nombre del nivel llega al texto', async () => {
      await service.activateTemplate(A, 'admin', 'level_up', new Date(NOON.getTime() - HOUR));
      ports.members.set(A, [student('ana', { name: 'Ana' })]);
      await service.onLevelChanged(A, 'ana', 'nivel-3', 'Catadora', NOON);
      await service.runTenant(A, NOON);
      expect(ports.sent[0]!.body).toContain('¡Has subido a Catadora, Ana!');
    });

    it('sin mensaje activo de ese tipo, el evento no deja rastro', async () => {
      ports.members.set(A, [student('ana')]);
      expect(await service.onCourseCompleted(A, 'ana', 'c1', NOON)).toBe(0);
      expect(prisma.modRetentionDelivery.rows).toHaveLength(0);
    });
  });

  describe('recuperación', () => {
    it('no sale si la persona ha vuelto antes del envío', async () => {
      const a = await service.activateTemplate(
        A,
        'admin',
        'come_back',
        new Date(NOON.getTime() - 3 * DAY),
      );
      ports.members.set(A, [student('ana', { lastActiveAt: new Date(NOON.getTime() - 15 * DAY) })]);
      // Escaneo de madrugada en su zona: queda pendiente.
      await service.runTenant(A, new Date('2026-11-14T03:00:00Z'));
      expect(prisma.modRetentionDelivery.rows).toHaveLength(1);
      expect(prisma.modRetentionDelivery.rows[0]!['automationId']).toBe(a.id);
      // Vuelve a entrar.
      ports.members.set(A, [student('ana', { lastActiveAt: new Date('2026-11-14T07:00:00Z') })]);
      await service.runTenant(A, NOON);
      expect(ports.sent).toHaveLength(0);
      expect(prisma.modRetentionDelivery.rows[0]!['skipReason']).toBe('came_back');
    });

    it('«Añadir a recuperación» exige el mensaje activo y no duplica', async () => {
      ports.members.set(A, [student('ana', { lastActiveAt: new Date(NOON.getTime() - 60 * DAY) })]);
      await expect(service.addToRecovery(A, 'ana', NOON)).rejects.toBeInstanceOf(
        RetentionRecoveryNotConfiguredError,
      );
      await service.activateTemplate(A, 'admin', 'come_back', NOON);
      expect((await service.addToRecovery(A, 'ana', NOON)).queued).toBe(true);
      expect((await service.addToRecovery(A, 'ana', NOON)).queued).toBe(false);
      await service.runTenant(A, NOON);
      expect(ports.sent).toHaveLength(1);
      expect(ports.sent[0]!.body).toContain('Hace unos días que no te veo');
    });
  });

  describe('métricas', () => {
    it('cuenta enviados, leídos y respondidos', async () => {
      await welcomeActive();
      ports.members.set(A, [student('ana'), student('bea'), student('carla')]);
      await service.runTenant(A, NOON);
      ports.readAt.set('ana', new Date(NOON.getTime() + HOUR));
      ports.readAt.set('bea', new Date(NOON.getTime() + HOUR));
      ports.replies.set('bea', new Date(NOON.getTime() + 2 * HOUR));
      // Leído ANTES del envío no cuenta como leído.
      ports.readAt.set('carla', new Date(NOON.getTime() - HOUR));
      const [w] = await service.listAutomations(A, new Date(NOON.getTime() + 3 * HOUR));
      expect(w!.stats).toMatchObject({ sent: 3, read: 2, replied: 1, pending: 0 });
    });
  });

  describe('miembros en riesgo', () => {
    it('detecta sin entrar, pagó y no empezó y a medias, con filtros', async () => {
      ports.members.set(A, [
        student('dormida', { lastActiveAt: new Date(NOON.getTime() - 20 * DAY) }),
        student('nunca', { lastActiveAt: null, joinedAt: new Date(NOON.getTime() - 30 * DAY) }),
        student('pagadora', { lastActiveAt: NOON }),
        student('amedias', { lastActiveAt: NOON }),
        student('al-dia', { lastActiveAt: NOON }),
        student('profe', { isStaff: true, lastActiveAt: null }),
      ]);
      ports.paid = [{ userId: 'pagadora', paidAt: new Date(NOON.getTime() - 5 * DAY) }];
      ports.enrollments = [
        {
          userId: 'amedias',
          courseId: 'c1',
          courseTitle: 'Cata',
          courseUrl: 'https://x/courses/cata',
          paid: false,
          enrolledAt: new Date(NOON.getTime() - 40 * DAY),
          startedAt: new Date(NOON.getTime() - 39 * DAY),
          completedAt: null,
          progressPercent: 40,
          lastActivityAt: new Date(NOON.getTime() - 20 * DAY),
        },
      ];
      const all = await service.atRisk(A, { days: 14 }, NOON);
      expect(all.counts).toEqual({ all: 4, inactive: 2, paid_not_started: 1, stalled: 1 });
      expect(all.rows.map((r) => r.id)).toEqual(['nunca', 'dormida', 'pagadora', 'amedias']);
      expect(all.rows.find((r) => r.id === 'nunca')!.reasons[0]).toMatchObject({
        kind: 'inactive',
        neverEntered: true,
        days: 30,
      });
      const stalled = await service.atRisk(A, { days: 14, reason: 'stalled' }, NOON);
      expect(stalled.rows.map((r) => r.id)).toEqual(['amedias']);
      expect(stalled.rows[0]!.reasons[0]).toMatchObject({
        courseTitle: 'Cata',
        progressPercent: 40,
      });
      expect((await service.atRisk(A, { search: 'pagad' }, NOON)).rows.map((r) => r.id)).toEqual([
        'pagadora',
      ]);
      expect((await service.atRisk(B, {}, NOON)).rows).toEqual([]);
    });
  });
});
