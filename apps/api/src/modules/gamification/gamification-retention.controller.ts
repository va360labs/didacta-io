/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { LearningService } from '@didacta/mod-learning';
import type { EarnedBadge, StreakView } from '@didacta/mod-gamification';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';
import { GamificationAnniversaryWorker } from './gamification-anniversary.worker';
import { GamificationRetentionHost } from './gamification-retention.host';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);
const uuid = z.string().uuid();

const settingsSchema = z.object({
  streaksEnabled: z.boolean().optional(),
  badgesEnabled: z.boolean().optional(),
  celebrateCourses: z.boolean().optional(),
  celebrateIntros: z.boolean().optional(),
  celebrateAnniversaries: z.boolean().optional(),
  celebrateLevels: z.boolean().optional(),
});

const prefsSchema = z.object({
  celebrate: z.boolean().optional(),
  showStreak: z.boolean().optional(),
});

const badgeSchema = z.object({
  name: z.string().trim().max(80).nullable().optional(),
  enabled: z.boolean().optional(),
});

const lockSchema = z.object({
  targetKind: z.enum(['COURSE', 'MODULE']),
  targetId: uuid,
  levelId: uuid,
  grantPaid: z.boolean().optional(),
});

const rewardSchema = z.object({
  title: z.string().trim().min(3).max(160),
  triggerKind: z.enum(['LEVEL', 'POINTS']),
  levelId: uuid.nullable().optional(),
  points: z.number().int().min(1).max(1_000_000).nullable().optional(),
  kind: z.enum(['MESSAGE', 'CODE']),
  message: z.string().trim().max(2000).nullable().optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  code: z.string().trim().max(64).nullable().optional(),
  active: z.boolean().optional(),
});
const rewardPatchSchema = rewardSchema.partial();

const idsSchema = z.object({ ids: z.string().max(4000).optional() });

function ensureUuid(id: string): string {
  if (!uuid.safeParse(id).success) {
    throw new NotFoundException({ message: 'No encontrado.', code: 'GAMIF_NOT_FOUND' });
  }
  return id;
}

interface MemberSummary {
  userId: string;
  levelNumber: number;
  levelName: string | null;
  badges: EarnedBadge[];
  /** null si el aula no usa rachas o la persona no quiere enseñarla. */
  streak: StreakView | null;
}

/// Backend HTTP de la retención de `mod.gamification`: desbloqueo por nivel,
/// rachas, insignias, premios automáticos y celebraciones. Capa fina: las
/// decisiones son de `RetentionService`.
@ApiTags('Gamificación')
@Controller('modules/gamification')
export class GamificationRetentionController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly host: GamificationRetentionHost,
    private readonly anniversaries: GamificationAnniversaryWorker,
  ) {}

  private get retention() {
    return this.registry.getRetentionService();
  }

  // ── Miembro ────────────────────────────────────────────────────────────────

  @Get('me/retention')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mi racha, mis insignias (y el catálogo) y mis preferencias.' })
  async myRetention(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const member = await this.host.member(u.tenantId, u.sub);
    // Insignias de lo que ya hizo antes de que existieran (idempotente).
    await this.retention.evaluateBadges(u.tenantId, u.sub);
    const [settings, prefs, streak, earned, catalog, levelNumber] = await Promise.all([
      this.retention.getSettings(u.tenantId),
      this.retention.getPrefs(u.tenantId, u.sub),
      this.retention.streakOf(u.tenantId, u.sub, new Date(), member?.timeZone ?? 'UTC'),
      this.retention.earnedBadges(u.tenantId, [u.sub]),
      this.retention.listBadges(u.tenantId),
      this.retention.levelNumberOf(u.tenantId, u.sub),
    ]);
    return {
      settings: { streaksEnabled: settings.streaksEnabled, badgesEnabled: settings.badgesEnabled },
      prefs,
      streak: settings.streaksEnabled ? streak : null,
      levelNumber,
      badges: settings.badgesEnabled ? (earned.get(u.sub) ?? []) : [],
      catalog: settings.badgesEnabled ? catalog.filter((b) => b.enabled) : [],
    };
  }

  @Put('me/prefs')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'No salir en las celebraciones / no enseñar mi racha.' })
  async updatePrefs(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(prefsSchema)) body: z.infer<typeof prefsSchema>,
  ) {
    const u = this.requireUser(user);
    return this.retention.updatePrefs(u.tenantId, u.sub, body);
  }

  @Get('me/rewards')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Premios que he recibido y los que me quedan por conseguir.' })
  async myRewards(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    return this.retention.myRewards(u.tenantId, u.sub);
  }

  @Get('me/locks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Contenido que se desbloquea por nivel, visto por mí. No incluye lo que tengo por mi cuenta (compra, suscripción…).',
  })
  async myLocks(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const [states, enrollments] = await Promise.all([
      this.retention.lockStates(u.tenantId, u.sub),
      this.registry.getLearningService().listMyEnrollments(u.tenantId, u.sub),
    ]);
    // Misma regla que el gate de mod.learning: lo propio no se cierra por nivel.
    const own = new Set(
      enrollments
        .filter(
          (e) =>
            (e.status === 'ACTIVE' || e.status === 'COMPLETED') &&
            LearningService.LEVEL_EXEMPT_SOURCES.has(e.source),
        )
        .map((e) => e.courseId),
    );
    return {
      locks: states
        .filter((s) => !own.has(s.courseId))
        .map((s) => ({
          id: s.id,
          targetKind: s.targetKind,
          targetId: s.targetId,
          courseId: s.courseId,
          levelNumber: s.levelNumber,
          levelName: s.levelName,
          minPoints: s.minPoints,
          pointsMissing: s.pointsMissing,
          unlocked: s.unlocked,
        })),
    };
  }

  @Get('members/summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Nivel, insignias y racha de varios miembros (tarjetas).' })
  async membersSummary(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(idsSchema)) query: z.infer<typeof idsSchema>,
  ) {
    const u = this.requireUser(user);
    const ids = (query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => uuid.safeParse(s).success)
      .slice(0, 100);
    return { members: await this.summaries(u.tenantId, ids) };
  }

  @Get('members/:userId/summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Nivel, insignias y racha de un miembro (su perfil).' })
  async memberSummary(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('userId') userId: string,
  ) {
    const u = this.requireUser(user);
    const [summary] = await this.summaries(u.tenantId, [ensureUuid(userId)]);
    if (!summary)
      throw new NotFoundException({ message: 'No encontrado.', code: 'GAMIF_NOT_FOUND' });
    return summary;
  }

  // ── Creador ────────────────────────────────────────────────────────────────

  @Get('admin/retention/settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getSettings(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.retention.getSettings(u.tenantId);
  }

  @Put('admin/retention/settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateSettings(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.retention.updateSettings(u.tenantId, body);
  }

  @Get('admin/badges')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async listBadges(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return { badges: await this.retention.listBadges(u.tenantId) };
  }

  @Put('admin/badges/:key')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateBadge(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(badgeSchema)) body: z.infer<typeof badgeSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.retention.updateBadge(u.tenantId, key.slice(0, 64), body);
  }

  @Get('admin/lockable-content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cursos (y sus secciones) que se pueden cerrar por nivel.' })
  async lockableContent(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const coursesService = this.registry.getCoursesService();
    const courses = (await coursesService.listCourses(u.tenantId)).filter(
      (c) => c.status !== 'ARCHIVED',
    );
    const out = [];
    for (const c of courses.slice(0, 200)) {
      const detail = await coursesService.getCourseDetail(u.tenantId, c.id);
      out.push({
        id: c.id,
        title: c.title,
        status: c.status,
        paid:
          c.externalPurchaseUrl !== null || (await this.registry.isCourseSold(u.tenantId, c.id)),
        modules: detail.modules.map((m) => ({ id: m.id, title: m.title })),
      });
    }
    return { courses: out };
  }

  @Get('admin/locks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async listLocks(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return { locks: await this.retention.listLocks(u.tenantId) };
  }

  @Put('admin/locks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cierra un curso o una sección hasta un nivel (o cambia el nivel).' })
  async setLock(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(lockSchema)) body: z.infer<typeof lockSchema>,
  ) {
    const u = this.requireAdmin(user);
    // Que el contenido exista (y de qué curso es) lo dice mod.courses.
    let courseId: string | null = null;
    const coursesService = this.registry.getCoursesService();
    if (body.targetKind === 'COURSE') {
      courseId = (await this.host.course(u.tenantId, body.targetId))?.id ?? null;
    } else {
      const courses = await coursesService.listCourses(u.tenantId);
      for (const c of courses) {
        const detail = await coursesService.getCourseDetail(u.tenantId, c.id);
        if (detail.modules.some((m) => m.id === body.targetId)) {
          courseId = c.id;
          break;
        }
      }
    }
    if (!courseId) {
      throw new NotFoundException({ message: 'Ese contenido no existe.', code: 'GAMIF_NOT_FOUND' });
    }
    return this.retention.setLock(u.tenantId, { ...body, courseId });
  }

  @Delete('admin/locks/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  async removeLock(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.retention.removeLock(u.tenantId, ensureUuid(id));
  }

  @Get('admin/rewards')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async listRewards(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const [rewards, codesAllowed] = await Promise.all([
      this.retention.listRewards(u.tenantId),
      this.retention.codesAllowed(u.tenantId),
    ]);
    // `codesAllowed`: en el modo plataforma la interfaz no ofrece códigos.
    return { rewards, codesAllowed };
  }

  @Post('admin/rewards')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  async createReward(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(rewardSchema)) body: z.infer<typeof rewardSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.retention.createReward(u.tenantId, body);
  }

  @Put('admin/rewards/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async updateReward(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rewardPatchSchema)) body: z.infer<typeof rewardPatchSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.retention.updateReward(u.tenantId, ensureUuid(id), body);
  }

  @Delete('admin/rewards/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  async deleteReward(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.retention.deleteReward(u.tenantId, ensureUuid(id));
  }

  @Get('admin/reward-grants')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Registro de premios entregados.' })
  async listGrants(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const grants = await this.retention.listGrants(u.tenantId);
    const members = await this.host.members(
      u.tenantId,
      grants.map((g) => g.userId),
    );
    return {
      grants: grants.map((g) => ({
        ...g,
        displayName: members.get(g.userId)?.name ?? null,
      })),
    };
  }

  @Post('admin/celebrations/anniversaries/run')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publica ya los aniversarios de hoy de esta aula (lo hace solo cada mañana). Idempotente.',
  })
  async runAnniversaries(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.anniversaries.runFor(new Date(), u.tenantId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async summaries(tenantId: string, ids: string[]): Promise<MemberSummary[]> {
    if (ids.length === 0) return [];
    const members = await this.host.members(tenantId, ids);
    const present = ids.filter((id) => members.has(id));
    if (present.length === 0) return [];
    const [settings, badges, levels] = await Promise.all([
      this.retention.getSettings(tenantId),
      this.retention.earnedBadges(tenantId, present),
      this.registry.getGamificationService().listLevels(tenantId),
    ]);
    const now = new Date();
    const out: MemberSummary[] = [];
    for (const id of present) {
      const [prefs, levelNumber] = await Promise.all([
        this.retention.getPrefs(tenantId, id),
        this.retention.levelNumberOf(tenantId, id),
      ]);
      const streak =
        settings.streaksEnabled && prefs.showStreak
          ? await this.retention.streakOf(tenantId, id, now, members.get(id)!.timeZone)
          : null;
      out.push({
        userId: id,
        levelNumber,
        levelName: levelNumber > 0 ? (levels[levelNumber - 1]?.name ?? null) : null,
        badges: badges.get(id) ?? [],
        streak,
      });
    }
    return out;
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles?.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo un administrador puede tocar los premios y niveles.',
        code: 'GAMIF_ADMIN_REQUIRED',
      });
    }
    return u;
  }
}
