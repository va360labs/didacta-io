/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Retención de mod.gamification (desbloqueo por nivel, rachas, insignias,
 * premios automáticos y celebraciones) contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS): con la RLS forzada de verdad, cada
 * aula solo ve y toca lo suyo, y el gate de mod.learning cierra y abre el
 * contenido con la misma composición que el host.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { GamificationService, RetentionService } from '@didacta/mod-gamification';
import { LearningService, LevelContentLockedError } from '@didacta/mod-learning';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb(
  'Retención (niveles, rachas, insignias, premios) — Postgres real como didacta_app',
  () => {
    let admin: PrismaClient;
    let prisma: PrismaService;
    let closeModule: () => Promise<void>;
    let points: GamificationService;
    let retention: RetentionService;
    let learning: LearningService;
    const published: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const stamp = Date.now();
    const t = { a: '', b: '' };
    const u: Record<string, string> = {};
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const prepared = await prepareDidactaAppRole();
      admin = prepared.admin;
      const previousUrl = process.env['DATABASE_URL'];
      const previousMode = process.env['RLS_ENFORCEMENT'];
      process.env['DATABASE_URL'] = prepared.appUrl;
      process.env['RLS_ENFORCEMENT'] = 'on';
      try {
        const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
        await moduleRef.init();
        prisma = moduleRef.get(PrismaService);
        closeModule = () => moduleRef.close();
      } finally {
        process.env['DATABASE_URL'] = previousUrl;
        if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
        else process.env['RLS_ENFORCEMENT'] = previousMode;
      }

      for (const k of ['a', 'b'] as const) {
        t[k] = (
          await admin.tenant.create({
            data: { id: randomUUID(), slug: `retencion-${k}-${stamp}`, name: `Aula ${k} ${stamp}` },
          })
        ).id;
      }
      for (const [key, tenantId] of [
        ['ana', t.a],
        ['bruno', t.a],
        ['compradora', t.a],
        ['zoe', t.b],
      ] as const) {
        u[key] = (
          await admin.user.create({
            data: { tenantId, email: `${key}-${stamp}@example.com`, name: key, status: 'ACTIVE' },
          })
        ).id;
      }

      // Curso del aula A: sección «Básico» [L0] y sección «Avanzado» [L1].
      const course = await admin.modCoursesCourse.create({
        data: { tenantId: t.a, slug: `curso-${stamp}`, title: 'Curso de A', status: 'PUBLISHED' },
      });
      ids['course'] = course.id;
      const basic = await admin.modCoursesModule.create({
        data: { tenantId: t.a, courseId: course.id, title: 'Básico', position: 0 },
      });
      const advanced = await admin.modCoursesModule.create({
        data: { tenantId: t.a, courseId: course.id, title: 'Avanzado', position: 1 },
      });
      ids['basic'] = basic.id;
      ids['advanced'] = advanced.id;
      ids['L0'] = (
        await admin.modCoursesLesson.create({
          data: { tenantId: t.a, moduleId: basic.id, title: 'L0', type: 'TEXT', position: 0 },
        })
      ).id;
      ids['L1'] = (
        await admin.modCoursesLesson.create({
          data: { tenantId: t.a, moduleId: advanced.id, title: 'L1', type: 'TEXT', position: 0 },
        })
      ).id;
      // Ana entra por el grupo de la comunidad; la compradora lo pagó.
      for (const [key, source] of [
        ['ana', 'GROUP'],
        ['compradora', 'PURCHASE'],
      ] as const) {
        await admin.modLearningEnrollment.create({
          data: { tenantId: t.a, userId: u[key]!, courseId: course.id, status: 'ACTIVE', source },
        });
      }

      const publisher = {
        publish: async (
          _t: string,
          _a: string | null,
          name: string,
          payload: Record<string, unknown>,
        ) => {
          published.push({ name, payload });
        },
      };
      points = new GamificationService(prisma as never, publisher);
      retention = new RetentionService(prisma as never, publisher);
      const ctx = {
        eventBus: { publish: async () => undefined, subscribe: () => () => undefined },
        auditLog: { record: async () => undefined },
        config: { get: async () => undefined },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
      };
      // La misma composición que `ModuleRegistryService`: el gate de learning
      // pregunta a la retención (sin leer sus tablas).
      learning = new LearningService(
        prisma as never,
        ctx as never,
        async () => false,
        async (tenantId, userId, courseId) => {
          const gate = await retention.courseGate(tenantId, userId, courseId);
          if (!gate) return null;
          const info = (s: {
            levelNumber: number;
            levelName: string;
            minPoints: number;
            pointsMissing: number;
          }) => ({
            levelNumber: s.levelNumber,
            levelName: s.levelName,
            minPoints: s.minPoints,
            pointsMissing: s.pointsMissing,
          });
          return {
            course: gate.course ? info(gate.course) : null,
            modules: Object.fromEntries(Object.entries(gate.modules).map(([k, v]) => [k, info(v)])),
          };
        },
      );
    }, 120_000);

    afterAll(async () => {
      for (const tenantId of Object.values(t).filter(Boolean)) {
        for (const table of [
          'modGamificationContentUnlock',
          'modGamificationContentLock',
          'modGamificationRewardGrant',
          'modGamificationReward',
          'modGamificationUserBadge',
          'modGamificationBadge',
          'modGamificationActivityDay',
          'modGamificationStreak',
          'modGamificationSettings',
          'modGamificationMemberPrefs',
          'modGamificationCelebration',
          'modGamificationCelebrationMark',
          'modGamificationLedgerEntry',
          'modGamificationProfile',
          'modGamificationLevel',
          'modLearningEnrollment',
          'modCoursesLesson',
          'modCoursesModule',
          'modCoursesCourse',
        ] as const) {
          await (admin[table] as unknown as { deleteMany: (a: unknown) => Promise<unknown> })
            .deleteMany({ where: { tenantId } })
            .catch(() => undefined);
        }
        await admin.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
        await admin.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      }
      await admin?.$disconnect();
      await closeModule?.();
    });

    const inA = <T>(fn: () => Promise<T>) => runAsTenant(t.a, fn);
    const inB = <T>(fn: () => Promise<T>) => runAsTenant(t.b, fn);

    it('niveles y cierre del curso: cerrado por debajo del nivel, abierto al llegar; lo comprado no se cierra', async () => {
      await inA(async () => {
        await points.createLevel({ tenantId: t.a, key: 'novato', name: 'Novato', minPoints: 0 });
        const pro = await points.createLevel({
          tenantId: t.a,
          key: 'pro',
          name: 'Pro',
          minPoints: 100,
        });
        ids['pro'] = pro.id;
        await retention.setLock(t.a, {
          targetKind: 'COURSE',
          targetId: ids['course']!,
          courseId: ids['course']!,
          levelId: pro.id,
        });
      });

      const closed = await inA(() =>
        learning.getCourseAvailability(t.a, u['ana']!, ids['course']!),
      );
      expect(closed.level).toMatchObject({ levelNumber: 2, levelName: 'Pro', pointsMissing: 100 });
      expect(closed.lessons[ids['L0']!]).toMatchObject({ available: false, reason: 'LEVEL' });
      await expect(
        inA(() => learning.assertLessonAccessible(t.a, u['ana']!, ids['L1']!)),
      ).rejects.toBeInstanceOf(LevelContentLockedError);

      // Control: la compradora (PURCHASE) entra aunque no tenga el nivel.
      const bought = await inA(() =>
        learning.getCourseAvailability(t.a, u['compradora']!, ids['course']!),
      );
      expect(bought.level).toBeUndefined();
      expect(bought.drip).toBe(false);

      // Ana suma 120 puntos → sube a Pro → el curso se abre y se registra UNA vez.
      const award = await inA(() =>
        points.award({
          tenantId: t.a,
          userId: u['ana']!,
          ruleKey: 'challenge',
          sourceKey: `x:${stamp}`,
          points: 120,
        }),
      );
      expect(award.levelChange?.to).toBe('pro');
      const open = await inA(() => learning.getCourseAvailability(t.a, u['ana']!, ids['course']!));
      expect(open.level).toBeUndefined();
      expect(open.drip).toBe(false);
      const unlocked = await inA(() => retention.collectUnlocks(t.a, u['ana']!, 0));
      expect(unlocked).toHaveLength(1);
      expect(await inA(() => retention.collectUnlocks(t.a, u['ana']!, 0))).toHaveLength(0);
      expect(published.filter((p) => p.name === 'gamification.content.unlocked')).toHaveLength(1);
    });

    it('cierre de una sección: solo sus lecciones', async () => {
      await inA(async () => {
        const master = await points.createLevel({
          tenantId: t.a,
          key: 'master',
          name: 'Máster',
          minPoints: 500,
        });
        ids['master'] = master.id;
        await retention.setLock(t.a, {
          targetKind: 'MODULE',
          targetId: ids['advanced']!,
          courseId: ids['course']!,
          levelId: master.id,
        });
      });
      const res = await inA(() => learning.getCourseAvailability(t.a, u['ana']!, ids['course']!));
      expect(res.lessons[ids['L0']!]).toBeUndefined();
      expect(res.lessons[ids['L1']!]).toMatchObject({ reason: 'LEVEL', level: { levelNumber: 3 } });
    });

    it('borrar un nivel que cierra contenido no abre nada en silencio: conflicto', async () => {
      await expect(inA(() => points.deleteLevel(t.a, ids['master']!))).rejects.toMatchObject({
        code: 'GAMIFICATION_CONFLICT',
      });
    });

    it('aislamiento: el aula B no ve ni usa los cierres, niveles ni premios de A', async () => {
      expect(await inB(() => retention.listLocks(t.b))).toEqual([]);
      expect(await inB(() => retention.courseGate(t.b, u['zoe']!, ids['course']!))).toBeNull();
      // Intentar cerrar algo en B con el nivel de A: el nivel «no existe» para B.
      await expect(
        inB(() =>
          retention.setLock(t.b, {
            targetKind: 'COURSE',
            targetId: ids['course']!,
            courseId: ids['course']!,
            levelId: ids['pro']!,
          }),
        ),
      ).rejects.toMatchObject({ code: 'GAMIFICATION_NOT_FOUND' });
      // Y con la RLS real, B ni siquiera ve las filas de A aunque pregunte por id.
      const leaked = await inB(() =>
        prisma.modGamificationContentLock.findMany({ where: { courseId: ids['course']! } }),
      );
      expect(leaked).toEqual([]);
    });

    it('premios automáticos: se entregan una vez, con copia, y el código no se ve antes de ganarlo', async () => {
      const reward = await inA(() =>
        retention.createReward(t.a, {
          title: 'Descuento del 20 %',
          triggerKind: 'POINTS',
          points: 200,
          kind: 'CODE',
          code: 'NIVEL20',
          message: 'Úsalo en tu próxima compra',
        }),
      );
      const before = await inA(() => retention.myRewards(t.a, u['ana']!));
      expect(before.earned).toEqual([]);
      expect(before.upcoming[0]).toMatchObject({ title: 'Descuento del 20 %', pointsMissing: 80 });
      expect(JSON.stringify(before.upcoming)).not.toContain('NIVEL20');
      expect(await inA(() => retention.grantDueRewards(t.a, u['ana']!))).toEqual([]);

      await inA(() =>
        points.award({
          tenantId: t.a,
          userId: u['ana']!,
          ruleKey: 'challenge',
          sourceKey: `y:${stamp}`,
          points: 100,
        }),
      );
      const granted = await inA(() => retention.grantDueRewards(t.a, u['ana']!));
      expect(granted).toHaveLength(1);
      expect(granted[0]!.delivered).toMatchObject({ code: 'NIVEL20' });
      expect(await inA(() => retention.grantDueRewards(t.a, u['ana']!))).toEqual([]);

      // El creador cambia el código después: el registro sigue diciendo lo entregado.
      await inA(() => retention.updateReward(t.a, reward.id, { code: 'OTRO30' }));
      const after = await inA(() => retention.myRewards(t.a, u['ana']!));
      expect(after.earned[0]!.delivered.code).toBe('NIVEL20');
      // Ya entregado → no se borra, se desactiva.
      await expect(inA(() => retention.deleteReward(t.a, reward.id))).rejects.toMatchObject({
        code: 'GAMIFICATION_CONFLICT',
      });
      expect(await inB(() => retention.listGrants(t.b))).toEqual([]);
    });

    it('insignias desde lo que ya consta (libro de puntos, nivel) y racha en la zona de la persona', async () => {
      await inA(() =>
        admin.modGamificationLedgerEntry.create({
          data: {
            tenantId: t.a,
            userId: u['bruno']!,
            ruleKey: 'community.post',
            points: 10,
            sourceKey: `community.post:${randomUUID()}`,
            occurredAt: new Date('2026-11-10T10:00:00Z'),
          },
        }),
      );
      const earned = await inA(() => retention.evaluateBadges(t.a, u['bruno']!));
      expect(earned.map((b) => b.key)).toContain('first_post');
      expect(await inA(() => retention.evaluateBadges(t.a, u['bruno']!))).toEqual([]);

      // 3 días seguidos en São Paulo, con eventos a deshoras en UTC.
      for (const at of ['2026-11-12T23:30:00Z', '2026-11-14T01:00:00Z', '2026-11-14T20:00:00Z']) {
        await inA(() =>
          retention.recordActivity(t.a, u['bruno']!, new Date(at), 'America/Sao_Paulo'),
        );
      }
      const streak = await inA(() =>
        retention.streakOf(t.a, u['bruno']!, new Date('2026-11-14T21:00:00Z'), 'America/Sao_Paulo'),
      );
      expect(streak).toMatchObject({ currentDays: 3, bestDays: 3, activeToday: true });

      // Primera participación: Bruno ya había publicado el 10 → un comentario
      // nuevo NO es su presentación; Zoe (otra aula) no cuenta para nada.
      expect(
        await inA(() =>
          retention.isFirstParticipation(t.a, u['bruno']!, 'community.comment:nuevo', new Date()),
        ),
      ).toBe(false);
      expect(
        await inA(() =>
          retention.isFirstParticipation(t.a, u['ana']!, 'community.comment:primero', new Date()),
        ),
      ).toBe(true);
    });

    it('celebraciones: apagadas de serie; un post por día y tipo; idempotentes; quien no quiere salir no sale', async () => {
      const entry = { userId: u['ana']!, name: 'Ana', detail: 'Curso de A' };
      expect(
        await inA(() => retention.planCelebration(t.a, 'course', 'ana:c1', entry, '2026-11-14')),
      ).toEqual({
        action: 'skip',
        reason: 'disabled',
      });
      await inA(() => retention.updateSettings(t.a, { celebrateCourses: true }));
      const first = await inA(() =>
        retention.planCelebration(t.a, 'course', 'ana:c1', entry, '2026-11-14'),
      );
      expect(first).toMatchObject({ action: 'create' });
      // El mismo hecho otra vez (reentrega del bus): no se celebra dos veces.
      expect(
        await inA(() => retention.planCelebration(t.a, 'course', 'ana:c1', entry, '2026-11-14')),
      ).toMatchObject({ action: 'skip', reason: 'duplicate' });
      // Otra persona el mismo día, mientras el post aún se publica → espera.
      const second = await inA(() =>
        retention.planCelebration(
          t.a,
          'course',
          'bruno:c1',
          { ...entry, userId: u['bruno']!, name: 'Bruno' },
          '2026-11-14',
        ),
      );
      expect(second).toMatchObject({ action: 'wait' });
      if (first.action !== 'create') throw new Error('debía crear');
      const postId = randomUUID();
      const entries = await inA(() =>
        retention.attachCelebrationPost(t.a, first.celebrationId, postId),
      );
      expect(entries.map((e) => e.name)).toEqual(['Ana', 'Bruno']);
      // Ya publicado: la siguiente lo actualiza (mismo post, no uno nuevo).
      await inA(() => retention.updatePrefs(t.a, u['compradora']!, { celebrate: false }));
      expect(
        await inA(() =>
          retention.planCelebration(
            t.a,
            'course',
            'compradora:c1',
            { ...entry, userId: u['compradora']!, name: 'C' },
            '2026-11-14',
          ),
        ),
      ).toMatchObject({ action: 'skip', reason: 'opted_out' });
      // Bruno se anima (otro curso): actualiza el post del día.
      const third = await inA(() =>
        retention.planCelebration(
          t.a,
          'course',
          'bruno:c2',
          { ...entry, userId: u['bruno']!, name: 'Bruno', detail: 'Otro' },
          '2026-11-14',
        ),
      );
      expect(third).toMatchObject({ action: 'update', postId });
      // Otro día → otro post.
      expect(
        await inA(() => retention.planCelebration(t.a, 'course', 'ana:c9', entry, '2026-11-15')),
      ).toMatchObject({ action: 'create' });
      // El aula B no ve las celebraciones de A.
      expect(await inB(() => prisma.modGamificationCelebration.findMany({}))).toEqual([]);
    });
  },
);
