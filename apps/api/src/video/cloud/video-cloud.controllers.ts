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
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminActor } from '../../admin/admin-tenants.controller';
import { auditActorId } from '../../auth/admin-actor';
import { AllowProvisioning, CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { JwtOrProvisioningGuard } from '../../auth/jwt-or-provisioning.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { isCourseEditor } from '../../modules/lesson-content-gate';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { verifyBunnyWebhookSignature } from './bunny-signing';
import {
  VIDEO_CLOUD_CONFIG,
  VIDEO_INACTIVITY_SERVICE,
  VIDEO_CLOUD_SERVICE,
} from './video-cloud.di';
import type { VideoCloudEnabled } from './video-cloud.config';
import {
  VideoCloudError,
  type TusUploadTicket,
  type VideoAssetView,
  type VideoCloudService,
  type VideoQuotaView,
} from './video-cloud.service';
import type { VideoInactivityService } from './video-inactivity.service';

export const createUploadSchema = z.object({
  lessonId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().max(100).default(''),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** La que lee el navegador del propio fichero antes de subirlo. */
  durationSeconds: z
    .number()
    .positive()
    .max(24 * 3600),
});
type CreateUploadDto = z.infer<typeof createUploadSchema>;

function toHttp(err: unknown): never {
  if (err instanceof VideoCloudError) {
    throw new HttpException({ message: err.message, code: err.code, ...err.details }, err.status);
  }
  throw err;
}

function requireEditor(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!isCourseEditor(user.roles)) {
    throw new ForbiddenException({
      message: 'Solo quien gestiona los cursos puede subir vídeos.',
      code: 'VIDEO_UPLOAD_FORBIDDEN',
    });
  }
  return user;
}

/**
 * Subida de vídeo del creador. Solo existe con `BUNNY_STREAM_API_KEY` (lo
 * registra `VideoCloudModule.register()`): sin ella estas rutas dan 404 y el
 * editor ofrece solo el enlace, como siempre.
 */
@ApiTags('Video · Subida')
@ApiBearerAuth()
@Controller('video/uploads')
@UseGuards(JwtAuthGuard)
export class VideoUploadsController {
  constructor(@Inject(VIDEO_CLOUD_SERVICE) private readonly cloud: VideoCloudService) {}

  @Get('quota')
  @ApiOperation({ summary: 'Horas de vídeo usadas y disponibles del aula, y sus límites.' })
  async quota(@CurrentUser() user: SessionClaims | undefined): Promise<VideoQuotaView> {
    const u = requireEditor(user);
    return this.cloud.quotaView(u.tenantId).catch(toHttp);
  }

  @Post()
  @ApiOperation({
    summary:
      'Prepara la subida de un vídeo a una lección: comprueba los límites, crea el vídeo en Bunny y devuelve la firma TUS para subirlo desde el navegador.',
  })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createUploadSchema)) dto: CreateUploadDto,
  ): Promise<{ asset: VideoAssetView; upload: TusUploadTicket }> {
    const u = requireEditor(user);
    return (
      this.cloud
        // El aula y el usuario salen SIEMPRE de la sesión, nunca del cuerpo.
        .createUpload({ ...dto, tenantId: u.tenantId, userId: u.sub })
        .catch(toHttp)
    );
  }

  @Get()
  @ApiOperation({ summary: 'Vídeos subidos a una lección (los vivos, el último primero).' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<VideoAssetView[]> {
    const u = requireEditor(user);
    return this.cloud.listForLesson(u.tenantId, lessonId).catch(toHttp);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado de un vídeo subido (subiendo, procesando, listo, fallido).' })
  async get(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<VideoAssetView> {
    const u = requireEditor(user);
    return this.cloud.getAsset(u.tenantId, id).catch(toHttp);
  }

  @Post(':id/signature')
  @ApiOperation({ summary: 'Firma nueva para reanudar una subida a medias.' })
  async resign(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TusUploadTicket> {
    const u = requireEditor(user);
    return this.cloud.resign(u.tenantId, id).catch(toHttp);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Cancela una subida o borra un vídeo que ninguna lección usa. Un vídeo en uso da 409: primero se quita de la lección.',
  })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const u = requireEditor(user);
    await this.cloud.deleteAsset(u.tenantId, u.sub, id).catch(toHttp);
  }
}

const webhookSchema = z.object({
  VideoLibraryId: z.number().int(),
  VideoGuid: z.string(),
  Status: z.number().int(),
  IsLiveStreamWebhook: z.boolean().optional(),
});

/**
 * Webhook de Bunny Stream. Firmado (HMAC-SHA256 con la clave de solo lectura
 * de la biblioteca); sin firma válida, 401 y Bunny no reintenta. El aviso solo
 * dispara una lectura del vídeo en la API de Bunny: lo que cambia el estado es
 * lo que diga Bunny, no el cuerpo del aviso.
 */
@ApiTags('Webhooks · Vídeo')
@Controller('video/bunny')
export class VideoBunnyWebhookController {
  private readonly logger = new Logger(VideoBunnyWebhookController.name);

  constructor(
    @Inject(VIDEO_CLOUD_SERVICE) private readonly cloud: VideoCloudService,
    @Inject(VIDEO_CLOUD_CONFIG) private readonly config: VideoCloudEnabled,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Avisos de Bunny Stream sobre el estado de un vídeo.' })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ result: string }> {
    const raw = req.rawBody;
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (
      !raw ||
      !verifyBunnyWebhookSignature({
        rawBody: raw,
        signature: header('x-bunnystream-signature'),
        version: header('x-bunnystream-signature-version'),
        algorithm: header('x-bunnystream-signature-algorithm'),
        secret: this.config.webhookSecret,
      })
    ) {
      throw new UnauthorizedException({
        message: 'Firma del webhook no válida.',
        code: 'VIDEO_WEBHOOK_SIGNATURE_INVALID',
      });
    }
    let parsed: z.infer<typeof webhookSchema>;
    try {
      parsed = webhookSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      return { result: 'ignored' };
    }
    if (parsed.IsLiveStreamWebhook) return { result: 'ignored' };
    try {
      const result = await this.cloud.handleWebhook({
        libraryId: parsed.VideoLibraryId,
        guid: parsed.VideoGuid,
      });
      return { result };
    } catch (err) {
      // 503: Bunny reintenta (30 s, 2 min, 10 min…), y el barrido horario
      // lo recoge igualmente.
      this.logger.warn(`webhook de vídeo ${parsed.VideoGuid}: ${(err as Error).message}`);
      throw new HttpException(
        { message: 'No se pudo procesar ahora.', code: 'VIDEO_WEBHOOK_RETRY' },
        503,
      );
    }
  }
}

/** Estado del vídeo de un aula para el operador. */
export interface TenantVideoStatus {
  tenantId: string;
  collectionName: string | null;
  quota: VideoQuotaView;
  lastActivityAt: string | null;
  lastActivitySource: string | null;
  warned10At: string | null;
  warned20At: string | null;
  purgedAt: string | null;
  purgeBlockedReason: string | null;
  backups: { live: number; bytes: number };
}

/**
 * Operador (super_admin o credencial del plano de control): estado del vídeo
 * de un aula y supresión de sus copias en Drive (RGPD).
 */
@ApiTags('Admin · Tenants · Vídeo')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(JwtOrProvisioningGuard)
export class AdminTenantsVideoController {
  constructor(
    @Inject(VIDEO_CLOUD_SERVICE) private readonly cloud: VideoCloudService,
    @Inject(VIDEO_INACTIVITY_SERVICE) private readonly inactivity: VideoInactivityService,
    private readonly prisma: PrismaService,
  ) {}

  private async requireTenant(id: string): Promise<void> {
    const t = await this.prisma.tenant.findFirst({ where: { id }, select: { id: true } });
    if (!t) {
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });
    }
  }

  @Get(':id/video')
  @AllowProvisioning()
  @ApiOperation({ summary: 'Cuota, actividad e inactividad del vídeo subido de un aula.' })
  async status(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TenantVideoStatus> {
    requireAdminActor(user, req);
    await this.requireTenant(id);
    const [quota, state, backups] = await Promise.all([
      this.cloud.quotaView(id),
      runAsTenant(id, () => this.prisma.videoTenantState.findUnique({ where: { tenantId: id } })),
      runAsTenant(id, () =>
        this.prisma.videoAsset.aggregate({
          where: { tenantId: id, backupDriveFileId: { not: null }, backupDeletedAt: null },
          _count: { _all: true },
          _sum: { backupBytes: true },
        }),
      ),
    ]);
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    return {
      tenantId: id,
      collectionName: state?.collectionName ?? null,
      quota,
      lastActivityAt: iso(state?.lastActivityAt),
      lastActivitySource: state?.lastActivitySource ?? null,
      warned10At: iso(state?.warned10At),
      warned20At: iso(state?.warned20At),
      purgedAt: iso(state?.purgedAt),
      purgeBlockedReason: state?.purgeBlockedReason ?? null,
      backups: { live: backups._count._all, bytes: Number(backups._sum.backupBytes ?? 0n) },
    };
  }

  @Post(':id/video-backups/purge')
  @AllowProvisioning()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Supresión (RGPD): borra YA, de forma definitiva, todas las copias en Google Drive de los vídeos del aula. Idempotente.',
  })
  async purgeBackups(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: number; failed: number }> {
    const actor = requireAdminActor(user, req);
    await this.requireTenant(id);
    try {
      return await this.inactivity.deleteBackups(id, {
        onlyExpired: false,
        reason: 'erasure_request',
        actorId: auditActorId(actor),
      });
    } catch (err) {
      throw new HttpException(
        { message: (err as Error).message, code: 'VIDEO_BACKUP_PURGE_UNAVAILABLE' },
        503,
      );
    }
  }
}
