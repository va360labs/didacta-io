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
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createRlptNoticeSchema, type CreateRlptNoticeDto } from '@didacta/mod-fundae';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB — los acuses escaneados son grandes
const MAX_BASE64_BYTES = Math.ceil(MAX_BYTES * 1.4);

const uploadRlptSchema = createRlptNoticeSchema.extend({
  /** Documento codificado en base64 (PDF firmado o escaneo del acuse). */
  data: z.string().min(1).max(MAX_BASE64_BYTES),
  contentType: z
    .enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
    .default('application/pdf'),
  filename: z.string().trim().min(1).max(200).optional(),
});
type UploadRlptDto = z.infer<typeof uploadRlptSchema>;

/**
 * Endpoints de notificaciones RLPT (LMS-80) anidados bajo la empresa.
 * Comparten guard MFA admin con el resto de `/admin/...`.
 */
@ApiTags('Admin · Fundae · RLPT')
@ApiBearerAuth()
@Controller('admin/fundae/companies/:companyId/rlpt-notices')
@UseGuards(JwtAuthGuard)
export class FundaeRlptController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo super_admin y tenant_admin pueden gestionar notificaciones RLPT.',
        code: 'FUNDAE_RLPT_ADMIN_REQUIRED',
      });
    }
    return user;
  }

  @Get()
  @ApiOperation({ summary: 'Listar notificaciones RLPT de una empresa, ordenadas por fecha desc.' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('companyId') companyId: string,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getFundaeRlptService().listByCompany(u.tenantId, companyId);
  }

  @Post()
  @ApiOperation({
    summary:
      'Subir notificación a la RLPT (PDF/imagen base64). El blob se persiste en Evidence Vault con hash SHA-256.',
  })
  async upload(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('companyId') companyId: string,
    @Body(new ZodValidationPipe(uploadRlptSchema)) dto: UploadRlptDto,
  ) {
    const u = this.requireAdmin(user);
    if (!ALLOWED_MIME.has(dto.contentType)) {
      throw new ForbiddenException({
        message: 'Tipo MIME no permitido para notificación RLPT.',
        code: 'FUNDAE_RLPT_MIME_NOT_ALLOWED',
      });
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(dto.data, 'base64');
    } catch {
      throw new ForbiddenException({
        message: 'Base64 inválido.',
        code: 'FUNDAE_RLPT_BASE64_INVALID',
      });
    }
    if (blob.length === 0 || blob.length > MAX_BYTES) {
      throw new ForbiddenException({
        message: `El documento debe pesar entre 1 byte y ${MAX_BYTES} bytes.`,
        code: 'FUNDAE_RLPT_SIZE_INVALID',
        // String, no número: ICU formatearía un `number` con separador de
        // miles por idioma y el español dejaría de salir byte a byte igual.
        detail: String(MAX_BYTES),
      });
    }

    const dtoToService: CreateRlptNoticeDto = {
      tipo: dto.tipo,
      fechaNotificacionAt: dto.fechaNotificacionAt,
      plazoVencimientoAt: dto.plazoVencimientoAt,
      observaciones: dto.observaciones,
    };
    return this.registry.getFundaeRlptService().upload({
      tenantId: u.tenantId,
      companyId,
      actorId: u.sub,
      dto: dtoToService,
      blob,
      contentType: dto.contentType,
    });
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Soft-delete de una notificación RLPT. El blob queda en Evidence Vault (no se borra) por trazabilidad.',
  })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('companyId') _companyId: string,
    @Param('id') id: string,
  ) {
    const u = this.requireAdmin(user);
    await this.registry.getFundaeRlptService().softDelete(u.tenantId, u.sub, id);
    return { deleted: true };
  }
}
