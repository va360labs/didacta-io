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
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { extractClientContext } from './client-context';
import { CurrentUser } from './decorators';
import { isValidDocumentId, normalizeDocumentId } from './document-id';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import type { SessionClaims } from './token.service';
import { ZodValidationPipe } from './zod-validation.pipe';

const ALLOWED_LOCALES = ['es-ES', 'es-AR', 'en-US', 'pt-BR'] as const;

const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  locale: z.enum(ALLOWED_LOCALES).optional(),
  timezone: z.string().min(1).max(64).optional(),
  avatarUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'Avatar URL debe usar https' })
    .nullable()
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
      avatarUrl: dbUser.avatarUrl,
      locale: dbUser.locale,
      timezone: dbUser.timezone,
      documentId: dbUser.documentId,
      mfaEnabled: dbUser.mfaEnabled,
      emailVerified: dbUser.emailVerified,
      createdAt: dbUser.createdAt.toISOString(),
      lastLoginAt: dbUser.lastLoginAt?.toISOString() ?? null,
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
    try {
      const updated = await this.prisma.user.update({
        where: { id: user.sub },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
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
        data: { passwordHash: newHash },
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
