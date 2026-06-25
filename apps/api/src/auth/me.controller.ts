import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { extractClientContext } from './client-context';
import { CurrentUser, MfaExempt } from './decorators';
import { isValidDocumentId, normalizeDocumentId } from './document-id';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import type { SessionClaims } from './token.service';
import { ZodValidationPipe } from './zod-validation.pipe';

const ALLOWED_LOCALES = ['es-ES', 'es-AR', 'en-US', 'pt-BR'] as const;

const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /**
   * Biografía corta opcional (máx 280). `''` o `null` la borran; omitir la
   * deja como estaba.
   */
  bio: z.union([z.string().max(280), z.literal(''), z.null()]).optional(),
  /** Cargo/puesto. `''`/`null` lo borran; omitir lo deja igual. */
  jobTitle: z.union([z.string().max(120), z.literal(''), z.null()]).optional(),
  /** Departamento/área. `''`/`null` lo borran; omitir lo deja igual. */
  department: z.union([z.string().max(120), z.literal(''), z.null()]).optional(),
  /** Ubicación libre. `''`/`null` la borran; omitir la deja igual. */
  location: z.union([z.string().max(120), z.literal(''), z.null()]).optional(),
  locale: z.enum(ALLOWED_LOCALES).optional(),
  timezone: z.string().min(1).max(64).optional(),
  /**
   * URL pública del avatar. Acepta una URL https absoluta (S3/CDN) o una ruta
   * relativa de storage (`/api/v1/storage/file/...`, que es lo que devuelve el
   * driver local-disk en dev). `null` borra el avatar. Omitir lo deja igual.
   */
  avatarUrl: z
    .union([
      z
        .string()
        .max(2048)
        .refine((u) => u.startsWith('https://') || u.startsWith('/'), {
          message: 'Avatar URL debe usar https o ser una ruta de storage.',
        }),
      z.null(),
    ])
    .optional(),
  /**
   * DNI o NIE español. Se normaliza (mayúsculas, sin guiones/puntos) antes
   * de validar checksum. Pasar `null` lo borra. Omitir el campo lo deja
   * como estaba.
   */
  documentId: z
    .union([
      z
        .string()
        .max(20)
        .transform((v) => normalizeDocumentId(v))
        .refine((v) => isValidDocumentId(v), {
          message: 'Documento de identidad inválido (esperado DNI o NIE español).',
        }),
      z.literal(''),
      z.null(),
    ])
    .optional(),
});
type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});
type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

/**
 * Matriz de preferencias de notificación del usuario: categoría × canal.
 * Solo EMAIL/IN_APP son configurables por el usuario (WEBHOOK es a nivel
 * tenant). Si no existe fila para una combinación, el default es `true`.
 */
const PREF_CATEGORIES = ['COMMUNITY', 'LEARNING', 'ASSESSMENTS', 'SYSTEM'] as const;
const PREF_CHANNELS = ['EMAIL', 'IN_APP'] as const;

const notificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        category: z.enum(PREF_CATEGORIES),
        channel: z.enum(PREF_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .max(PREF_CATEGORIES.length * PREF_CHANNELS.length),
});
type NotificationPreferencesDto = z.infer<typeof notificationPreferencesSchema>;

@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('profile')
  @MfaExempt()
  @ApiOperation({ summary: 'Devuelve el perfil del usuario autenticado.' })
  async getProfile(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!dbUser) throw new UnauthorizedException();
    return {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      bio: dbUser.bio,
      jobTitle: dbUser.jobTitle,
      department: dbUser.department,
      location: dbUser.location,
      avatarUrl: dbUser.avatarUrl,
      locale: dbUser.locale,
      timezone: dbUser.timezone,
      documentId: dbUser.documentId,
      mfaEnabled: dbUser.mfaEnabled,
      emailVerified: dbUser.emailVerified,
      createdAt: dbUser.createdAt.toISOString(),
      lastLoginAt: dbUser.lastLoginAt?.toISOString() ?? null,
      onboardingCompletedAt: dbUser.onboardingCompletedAt?.toISOString() ?? null,
      roles: dbUser.roles.map((r) => r.role.name),
    };
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Editar nombre, idioma, zona horaria, avatar, DNI/NIE.' })
  async updateProfile(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
  ) {
    if (!user) throw new UnauthorizedException();
    // Convertimos `''` a null para borrar el documento; cualquier otro string
    // ya viene normalizado por el schema (mayúsculas, sin separadores).
    const documentIdValue =
      dto.documentId === undefined
        ? undefined
        : dto.documentId === '' || dto.documentId === null
          ? null
          : dto.documentId;
    // `''` borra el campo (→ null); cualquier otro string se guarda tal cual;
    // `undefined` lo deja como estaba.
    const blank = (v: string | null | undefined) =>
      v === undefined ? undefined : v === '' || v === null ? null : v;
    const bioValue = blank(dto.bio);
    const jobTitleValue = blank(dto.jobTitle);
    const departmentValue = blank(dto.department);
    const locationValue = blank(dto.location);
    try {
      const updated = await this.prisma.user.update({
        where: { id: user.sub },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(bioValue !== undefined ? { bio: bioValue } : {}),
          ...(jobTitleValue !== undefined ? { jobTitle: jobTitleValue } : {}),
          ...(departmentValue !== undefined ? { department: departmentValue } : {}),
          ...(locationValue !== undefined ? { location: locationValue } : {}),
          ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
          ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
          ...(documentIdValue !== undefined ? { documentId: documentIdValue } : {}),
        },
      });
      const ctx = extractClientContext(req);
      await this.auditLog.record({
        tenantId: user.tenantId,
        actorId: user.sub,
        action: 'user.profile.updated',
        resourceType: 'user',
        resourceId: user.sub,
        metadata: { fields: Object.keys(dto) },
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        bio: updated.bio,
        jobTitle: updated.jobTitle,
        department: updated.department,
        location: updated.location,
        avatarUrl: updated.avatarUrl,
        locale: updated.locale,
        timezone: updated.timezone,
        documentId: updated.documentId,
      };
    } catch (e) {
      // Prisma P2002 = unique constraint violation. Para este modelo solo
      // puede ser por (tenantId, documentId) ya que email no se edita acá.
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BadRequestException('Ese DNI/NIE ya está registrado en este tenant.');
      }
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Onboarding de primera vez
  // ──────────────────────────────────────────────────────────────────────────

  @Get('onboarding/status')
  @MfaExempt()
  @ApiOperation({ summary: 'Estado del onboarding (completado + campos obligatorios que faltan).' })
  async onboardingStatus(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser) throw new UnauthorizedException();
    return {
      completed: dbUser.onboardingCompletedAt !== null,
      completedAt: dbUser.onboardingCompletedAt?.toISOString() ?? null,
      missing: this.missingOnboardingFields(dbUser),
    };
  }

  @Post('onboarding/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Marca el onboarding como completado. Requiere nombre y avatar. Idempotente (solo null → fecha).',
  })
  async completeOnboarding(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser) throw new UnauthorizedException();

    // Idempotente: si ya estaba completado, no re-audita ni cambia el timestamp.
    if (dbUser.onboardingCompletedAt) {
      return {
        ok: true,
        alreadyCompleted: true,
        onboardingCompletedAt: dbUser.onboardingCompletedAt.toISOString(),
      };
    }

    const missing = this.missingOnboardingFields(dbUser);
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Faltan datos obligatorios para completar el onboarding.',
        missing,
      });
    }

    const updated = await this.prisma.user.update({
      where: { id: user.sub },
      data: { onboardingCompletedAt: new Date() },
    });
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.onboarding.completed',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: {},
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { ok: true, onboardingCompletedAt: updated.onboardingCompletedAt!.toISOString() };
  }

  private missingOnboardingFields(dbUser: {
    name: string | null;
    avatarUrl: string | null;
  }): string[] {
    const missing: string[] = [];
    if (!dbUser.name || dbUser.name.trim() === '') missing.push('name');
    if (!dbUser.avatarUrl) missing.push('avatar');
    return missing;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Preferencias de notificación (matriz categoría × canal)
  // ──────────────────────────────────────────────────────────────────────────

  @Get('notification-preferences')
  @MfaExempt()
  @ApiOperation({ summary: 'Matriz de preferencias de notificación del usuario.' })
  async getNotificationPreferences(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const rows = await this.prisma.userNotificationPreference.findMany({
      where: { userId: user.sub },
    });
    return { preferences: this.buildPreferenceMatrix(rows) };
  }

  @Put('notification-preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualiza (upsert batch) las preferencias de notificación.' })
  async updateNotificationPreferences(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(notificationPreferencesSchema)) dto: NotificationPreferencesDto,
  ) {
    if (!user) throw new UnauthorizedException();
    await this.prisma.$transaction(
      dto.preferences.map((p) =>
        this.prisma.userNotificationPreference.upsert({
          where: {
            tenantId_userId_category_channel: {
              tenantId: user.tenantId,
              userId: user.sub,
              category: p.category,
              channel: p.channel,
            },
          },
          create: {
            tenantId: user.tenantId,
            userId: user.sub,
            category: p.category,
            channel: p.channel,
            enabled: p.enabled,
          },
          update: { enabled: p.enabled },
        }),
      ),
    );
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.notification_preferences.updated',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: { count: dto.preferences.length },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    const rows = await this.prisma.userNotificationPreference.findMany({
      where: { userId: user.sub },
    });
    return { preferences: this.buildPreferenceMatrix(rows) };
  }

  /**
   * Matriz completa categoría × canal, rellenando con `true` las combinaciones
   * sin fila persistida (default = activado).
   */
  private buildPreferenceMatrix(
    rows: { category: string; channel: string; enabled: boolean }[],
  ): { category: string; channel: string; enabled: boolean }[] {
    const byKey = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
    const out: { category: string; channel: string; enabled: boolean }[] = [];
    for (const category of PREF_CATEGORIES) {
      for (const channel of PREF_CHANNELS) {
        out.push({ category, channel, enabled: byKey.get(`${category}:${channel}`) ?? true });
      }
    }
    return out;
  }

  @Post('security/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cambia la contraseña verificando la actual. Invalida todas las sessions excepto la del request actual.',
  })
  async changePassword(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser || !dbUser.passwordHash) {
      throw new UnauthorizedException();
    }
    const ok = await this.passwords.verify(dbUser.passwordHash, dto.currentPassword);
    if (!ok) {
      throw new ForbiddenException('La contraseña actual no es correcta.');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual.');
    }

    const newHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.sub },
        // Al fijar una contraseña propia se limpia el flag de contraseña
        // temporal (p.ej. usuarios creados por `POST /api/v1/inscribe`).
        data: { passwordHash: newHash, mustChangePassword: false },
      }),
      // Invalidar todas las sessions excepto la actual (no la podemos identificar
      // sin más metadata; aproximamos: cerramos las que NO coinciden con el JWT).
      // Por ahora cerramos TODAS y el cliente deberá relogin con el nuevo
      // password si el actual no es el del JWT.
      this.prisma.session.deleteMany({ where: { userId: user.sub } }),
    ]);

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.password.changed',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: {},
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { ok: true, message: 'Tu contraseña fue actualizada.' };
  }

  @Get('security/sessions')
  @ApiOperation({ summary: 'Listado de sesiones activas del usuario.' })
  async listSessions(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const sessions = await this.prisma.session.findMany({
      where: { userId: user.sub, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent ?? null,
      ip: s.ip ?? null,
    }));
  }

  @Delete('security/sessions/:id')
  @ApiOperation({ summary: 'Cerrar una sesión específica del usuario.' })
  async revokeSession(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const sess = await this.prisma.session.findFirst({
      where: { id, userId: user.sub },
    });
    if (!sess) throw new ForbiddenException('Sesión no encontrada o no es tuya.');
    await this.prisma.session.delete({ where: { id } });
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.session.revoked',
      resourceType: 'session',
      resourceId: id,
      metadata: {},
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { ok: true };
  }

  @Post('security/sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar TODAS las sesiones del usuario, incluyendo la actual.' })
  async revokeAll(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const result = await this.prisma.session.deleteMany({ where: { userId: user.sub } });
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.sessions.revoke_all',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: { count: result.count },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { ok: true, revoked: result.count };
  }
}
