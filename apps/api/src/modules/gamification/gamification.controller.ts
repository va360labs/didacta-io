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
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';
import { GamificationBackfillService } from './gamification-backfill.service';

/** Quien gestiona el catálogo y revisa las entregas. */
const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);
const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const rangeSchema = z.object({
  range: z.enum(['week', 'month', 'all']).optional(),
});

const updateRuleSchema = z.object({
  points: z.number().int().min(0).max(100_000).optional(),
  dailyCap: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
});

const levelBodySchema = z.object({
  key: z.string().trim().min(2).max(64),
  name: z.string().trim().min(2).max(80),
  minPoints: z.number().int().min(0).max(100_000),
  benefitText: z.string().trim().max(2000).optional(),
  benefitKind: z.enum(['NONE', 'ACCESS_GROUP']).optional(),
  accessGroupId: z.string().uuid().optional(),
});

const updateLevelSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  minPoints: z.number().int().min(0).max(100_000).optional(),
  benefitText: z.string().trim().max(2000).nullable().optional(),
  benefitKind: z.enum(['NONE', 'ACCESS_GROUP']).optional(),
  accessGroupId: z.string().uuid().nullable().optional(),
});

/**
 * Las fechas llegan como ISO y se convierten en el handler, no en el esquema:
 * `ZodValidationPipe` exige que entrada y salida sean del mismo tipo, así que
 * un `.transform()` de string a Date no encaja en el pipe.
 */
const isoDate = z.string().datetime({ offset: true });

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

const challengeBodySchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
  points: z.number().int().min(1).max(100_000),
  proofRequired: z.boolean().optional(),
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED']).optional(),
  startsAt: isoDate.nullable().optional(),
  endsAt: isoDate.nullable().optional(),
});

const updateChallengeSchema = challengeBodySchema.partial();

const submitSchema = z.object({
  proofUrl: z.string().trim().max(2000).optional(),
  proofName: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});

const reviewSchema = z.object({
  approve: z.boolean(),
  reviewNote: z.string().trim().max(1000).optional(),
});

const submissionFilterSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  challengeId: z.string().uuid().optional(),
});

const uuidSchema = z.string().uuid();

/** Un id malformado daría P2023 (columna Uuid) → 500. Mismo criterio que resources. */
function ensureUuid(id: string): string {
  if (!uuidSchema.safeParse(id).success) throw new NotFoundException('No encontrado.');
  return id;
}

/// Backend HTTP de `mod.gamification` (bloque 1 — puntos, niveles y retos).
/// El ranking y los retos son de todos los miembros; el catálogo (reglas,
/// niveles, retos) y la revisión de entregas son del staff.
@ApiTags('Gamificación')
@Controller('modules/gamification')
export class GamificationController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly backfill: GamificationBackfillService,
  ) {}

  // ── Miembro ────────────────────────────────────────────────────────────────

  @Get('leaderboard')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ranking del tenant por puntos del ledger.' })
  async leaderboard(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(rangeSchema)) query: z.infer<typeof rangeSchema>,
  ) {
    const u = this.requireUser(user);
    const board = await this.registry
      .getGamificationService()
      .leaderboard(u.tenantId, query.range ?? 'all');

    const names = await this.resolveDisplayNames(
      u.tenantId,
      board.rows.map((r) => r.userId),
    );
    return {
      total: board.total,
      entries: board.rows
        .filter((r) => names.has(r.userId))
        .map((r) => ({
          userId: r.userId,
          rank: r.rank,
          points: r.points,
          displayName: names.get(r.userId)!,
        })),
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Puntos, nivel y puesto del miembro que consulta.' })
  async myStanding(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(rangeSchema)) query: z.infer<typeof rangeSchema>,
  ) {
    const u = this.requireUser(user);
    return this.registry.getGamificationService().standing(u.tenantId, u.sub, query.range ?? 'all');
  }

  @Get('me/history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Últimos asientos del miembro, para explicar sus puntos.' })
  async myHistory(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const entries = await this.registry.getGamificationService().myHistory(u.tenantId, u.sub);
    return { entries };
  }

  @Get('levels')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Niveles definidos por el operador (visible para todos).' })
  async listLevels(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const levels = await this.registry.getGamificationService().listLevels(u.tenantId);
    return { levels };
  }

  @Get('challenges')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retos abiertos y el estado de mi entrega en cada uno.' })
  async listChallenges(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    const challenges = await this.registry
      .getGamificationService()
      .listOpenChallenges(u.tenantId, u.sub);
    return { challenges };
  }

  @Post('challenges/:id/submit')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Entrega un reto con su prueba (una por reto y persona).' })
  async submit(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitSchema)) dto: z.infer<typeof submitSchema>,
  ) {
    const u = this.requireUser(user);
    return this.registry.getGamificationService().submitChallenge({
      tenantId: u.tenantId,
      userId: u.sub,
      challengeId: ensureUuid(id),
      ...dto,
    });
  }

  // ── Catálogo (staff) ───────────────────────────────────────────────────────

  @Get('admin/rules')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reglas de puntuación (siembra las de por defecto).' })
  async listRules(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const rules = await this.registry.getGamificationService().listRules(u.tenantId);
    return { rules };
  }

  @Put('admin/rules/:key')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambia puntos, techo diario o activación de una regla.' })
  async updateRule(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(updateRuleSchema)) dto: z.infer<typeof updateRuleSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getGamificationService().updateRule(u.tenantId, key, dto);
  }

  @Post('admin/levels')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un nivel con su beneficio.' })
  async createLevel(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(levelBodySchema)) dto: z.infer<typeof levelBodySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getGamificationService().createLevel({ tenantId: u.tenantId, ...dto });
  }

  @Put('admin/levels/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edita un nivel y reasigna a quien corresponda.' })
  async updateLevel(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLevelSchema)) dto: z.infer<typeof updateLevelSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getGamificationService().updateLevel(u.tenantId, ensureUuid(id), dto);
  }

  @Delete('admin/levels/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Borra un nivel y recoloca a los perfiles afectados.' })
  async deleteLevel(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getGamificationService().deleteLevel(u.tenantId, ensureUuid(id));
  }

  @Get('admin/challenges')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Todos los retos con su número de entregas.' })
  async listAdminChallenges(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireStaff(user);
    const challenges = await this.registry
      .getGamificationService()
      .listChallengesForAdmin(u.tenantId);
    return { challenges };
  }

  @Post('admin/challenges')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un reto (nace en borrador salvo que se indique).' })
  async createChallenge(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(challengeBodySchema)) dto: z.infer<typeof challengeBodySchema>,
  ) {
    const u = this.requireStaff(user);
    return this.registry.getGamificationService().createChallenge({
      tenantId: u.tenantId,
      createdById: u.sub,
      ...dto,
      startsAt: toDate(dto.startsAt),
      endsAt: toDate(dto.endsAt),
    });
  }

  @Put('admin/challenges/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Edita un reto (abrirlo, cerrarlo, cambiar puntos o fechas).' })
  async updateChallenge(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateChallengeSchema)) dto: z.infer<typeof updateChallengeSchema>,
  ) {
    const u = this.requireStaff(user);
    await this.registry.getGamificationService().updateChallenge(u.tenantId, ensureUuid(id), {
      ...dto,
      startsAt: toDate(dto.startsAt),
      endsAt: toDate(dto.endsAt),
    });
  }

  @Delete('admin/challenges/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Borra un reto. Los puntos ya concedidos NO se retiran.' })
  async deleteChallenge(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireStaff(user);
    await this.registry.getGamificationService().deleteChallenge(u.tenantId, ensureUuid(id));
  }

  // ── Entregas (staff) ───────────────────────────────────────────────────────

  @Get('admin/submissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Entregas para revisar, con el nombre de quien entrega.' })
  async listSubmissions(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(submissionFilterSchema))
    query: z.infer<typeof submissionFilterSchema>,
  ) {
    const u = this.requireStaff(user);
    const submissions = await this.registry
      .getGamificationService()
      .listSubmissions(u.tenantId, query);
    const names = await this.resolveDisplayNames(
      u.tenantId,
      submissions.map((s) => s.userId),
    );
    return {
      submissions: submissions.map((s) => ({
        ...s,
        displayName: names.get(s.userId) ?? s.userId.slice(0, 8),
      })),
    };
  }

  @Post('admin/submissions/:id/review')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Aprueba o rechaza una entrega; aprobar acredita los puntos.' })
  async review(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewSchema)) dto: z.infer<typeof reviewSchema>,
  ) {
    const u = this.requireStaff(user);
    return this.registry.getGamificationService().reviewSubmission({
      tenantId: u.tenantId,
      submissionId: ensureUuid(id),
      reviewerId: u.sub,
      ...dto,
    });
  }

  // ── Relleno del histórico ──────────────────────────────────────────────────

  @Post('admin/backfill')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rellena el ledger con la actividad ya publicada. Idempotente: repetirlo no duplica puntos.',
  })
  async runBackfill(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.backfill.run(u.tenantId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * El módulo no lee la tabla `user` (no es suya): los nombres los resuelve el
   * host, igual que hace mod.community con el autor de un post.
   */
  private async resolveDisplayNames(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] }, tenantId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id.slice(0, 8)]));
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireStaff(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles?.some((r) => STAFF_ROLES.has(r))) {
      throw new ForbiddenException('Solo el equipo puede gestionar los retos.');
    }
    return u;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles?.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Solo un administrador puede tocar el catálogo de puntos.');
    }
    return u;
  }
}
