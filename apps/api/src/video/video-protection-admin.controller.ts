/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { BUNNY_LIBRARY_ID_RE } from './bunny-embed';
import {
  VIDEO_LIMIT_BOUNDS,
  VideoProtectionConfigService,
  type SignatureCheckOutcome,
  type VideoProtectionStatus,
} from './video-protection-config.service';
import { checkBunnySignature } from './video-signature-check';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/** Token DI de la función que comprueba la firma contra Bunny (sustituible en tests). */
export const VIDEO_SIGNATURE_CHECKER = 'DIDACTA_VIDEO_SIGNATURE_CHECKER';

const tokenKeySchema = z.object({
  libraryId: z.string().regex(BUNNY_LIBRARY_ID_RE),
  tokenKey: z.string().trim().min(8).max(200),
});

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    watermark: z.boolean(),
    maxVideosPerHour: z
      .number()
      .int()
      .min(VIDEO_LIMIT_BOUNDS.perHour.min)
      .max(VIDEO_LIMIT_BOUNDS.perHour.max),
    maxVideosPerDay: z
      .number()
      .int()
      .min(VIDEO_LIMIT_BOUNDS.perDay.min)
      .max(VIDEO_LIMIT_BOUNDS.perDay.max),
  })
  .partial();

const checkSchema = z.object({ libraryId: z.string().regex(BUNNY_LIBRARY_ID_RE) });

/**
 * Resultado de «Comprobar». Además de lo que devuelve la petición real a Bunny
 * (`SignatureCheckOutcome`), hay dos motivos por los que ni se llega a pedir:
 * `no_key` (esa librería no tiene clave guardada) y `no_video` (el tenant no
 * tiene todavía ningún vídeo de esa librería con el que probar).
 */
export interface VideoSignatureCheckResponse {
  libraryId: string;
  outcome: SignatureCheckOutcome | 'no_key' | 'no_video';
  checkedAt: string;
  /** Código HTTP de Bunny a la URL firmada / sin firmar (null si no se pidió o no contestó). */
  signedStatus: number | null;
  unsignedStatus: number | null;
}

/**
 * Administración → Seguridad → Protección de vídeo. Estado, interruptor, tope,
 * marca de agua, clave de firma por librería y comprobación real contra Bunny.
 *
 * La clave entra por el `PUT` y no vuelve a salir en ninguna respuesta de este
 * controlador ni queda en la auditoría.
 */
@ApiTags('Admin · Protección de vídeo')
@ApiBearerAuth()
@Controller('admin/video-protection')
@UseGuards(JwtAuthGuard)
export class VideoProtectionAdminController {
  constructor(
    private readonly config: VideoProtectionConfigService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly tenantResolver: TenantResolverService,
    // Sin provider registrado se usa la comprobación real; el token existe para
    // que los tests pongan un Bunny de mentira sin tocar la red.
    @Optional()
    @Inject(VIDEO_SIGNATURE_CHECKER)
    private readonly runSignatureCheck: typeof checkBunnySignature = checkBunnySignature,
  ) {}

  /** La biblioteca de Didacta Cloud la firma el servidor: no admite clave del aula. */
  private rejectPlatformLibrary(libraryId: string): void {
    if (this.config.isPlatformLibrary(libraryId)) {
      throw new BadRequestException({
        message: 'Los vídeos subidos a la academia ya van protegidos: no hace falta ninguna clave.',
        code: 'ADMIN_VIDEO_PROTECTION_PLATFORM_LIBRARY',
      });
    }
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo super_admin o tenant_admin pueden gestionar la protección de vídeo.',
        code: 'ADMIN_VIDEO_PROTECTION_FORBIDDEN',
      });
    }
    return user;
  }

  @Get()
  @ApiOperation({
    summary:
      'Estado de la protección de vídeo del tenant: interruptor, tope por cuenta, marca de agua y librerías de Bunny (si tienen clave y qué dijo la última comprobación). Nunca devuelve una clave.',
  })
  async status(@CurrentUser() user: SessionClaims | undefined): Promise<VideoProtectionStatus> {
    const u = this.requireAdmin(user);
    return this.config.status(u.tenantId);
  }

  @Put('settings')
  @ApiOperation({
    summary:
      'Activa o desactiva la protección y ajusta el tope de vídeos distintos por cuenta y la marca de agua. Los campos omitidos conservan su valor.',
  })
  async putSettings(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(settingsSchema)) dto: z.infer<typeof settingsSchema>,
  ): Promise<VideoProtectionStatus> {
    const u = this.requireAdmin(user);
    const current = await this.config.getSettings(u.tenantId);
    const perHour = dto.maxVideosPerHour ?? current.maxVideosPerHour;
    const perDay = dto.maxVideosPerDay ?? current.maxVideosPerDay;
    if (perDay < perHour) {
      throw new BadRequestException({
        message: 'El tope diario no puede ser menor que el tope por hora.',
        code: 'ADMIN_VIDEO_PROTECTION_LIMITS_INVALID',
      });
    }
    const next = await this.config.updateSettings(u.tenantId, u.sub, dto);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'video_protection.settings_updated',
      resourceType: 'video_protection',
      resourceId: u.tenantId,
      metadata: { ...next },
    });
    return this.config.status(u.tenantId);
  }

  @Put('token-key')
  @ApiOperation({
    summary:
      'Guarda (cifrada) la «Token authentication key» de una librería de Bunny Stream. Con ella, y con la protección activa, las URL de vídeo de esa librería salen firmadas y caducan.',
  })
  async putTokenKey(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(tokenKeySchema)) dto: z.infer<typeof tokenKeySchema>,
  ): Promise<VideoProtectionStatus> {
    const u = this.requireAdmin(user);
    this.rejectPlatformLibrary(dto.libraryId);
    await this.config.setTokenKey(u.tenantId, u.sub, dto.libraryId, dto.tokenKey);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'video_protection.token_key_updated',
      resourceType: 'video_library',
      resourceId: dto.libraryId,
      metadata: { libraryId: dto.libraryId },
    });
    return this.config.status(u.tenantId);
  }

  @Post('check')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Comprobación real de la firma contra Bunny con un vídeo del propio tenant: pide el reproductor firmado y sin firmar. Siempre 200 con `outcome` (ok, not_enforced, rejected, video_unavailable, unreachable, no_key, no_video): el motivo es el dato, no una excepción.',
  })
  async check(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(checkSchema)) dto: z.infer<typeof checkSchema>,
    @Req() req: FastifyRequest,
  ): Promise<VideoSignatureCheckResponse> {
    const u = this.requireAdmin(user);
    this.rejectPlatformLibrary(dto.libraryId);
    const checkedAt = new Date().toISOString();
    const skipped = (outcome: 'no_key' | 'no_video'): VideoSignatureCheckResponse => ({
      libraryId: dto.libraryId,
      outcome,
      checkedAt,
      signedStatus: null,
      unsignedStatus: null,
    });

    const tokenKey = await this.config.getTokenKey(u.tenantId, dto.libraryId);
    if (!tokenKey) return skipped('no_key');
    const guid = await this.config.findSampleVideo(u.tenantId, dto.libraryId);
    if (!guid) return skipped('no_video');

    const referer = await this.tenantResolver.resolveTenantWebBaseUrl(u.tenantId, req);
    const result = await this.runSignatureCheck({
      libraryId: dto.libraryId,
      guid,
      tokenKey,
      referer: `${referer.replace(/\/$/, '')}/`,
    });
    await this.config.recordCheck(u.tenantId, u.sub, dto.libraryId, {
      outcome: result.outcome,
      checkedAt,
    });
    return {
      libraryId: dto.libraryId,
      outcome: result.outcome,
      checkedAt,
      signedStatus: result.signed.status,
      unsignedStatus: result.unsigned.status,
    };
  }
}
