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
import {
  allKnownTemplateKeys,
  buildEmailTemplateCatalog,
  type EmailTemplateCatalogEntry,
} from './email-template-catalog';

// Forma serializable del modelo Prisma. Lo declaramos explícito para
// evitar que el typecheck infiera un tipo que referencia paths internos
// del paquete generado de Prisma (no portable).
interface NotificationTemplateRow {
  id: string;
  tenantId: string;
  key: string;
  channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK';
  locale: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const upsertTemplateSchema = z.object({
  channel: z.enum(['EMAIL', 'IN_APP', 'WEBHOOK']),
  locale: z.string().min(2).max(10),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(10_000),
});

const listQuerySchema = z.object({
  key: z.string().optional(),
});

@ApiTags('Admin · Notification templates')
@ApiBearerAuth()
@Controller('admin/notifications/templates')
@UseGuards(JwtAuthGuard)
export class NotificationTemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Sólo super_admin / tenant_admin pueden gestionar templates.',
        code: 'NOTIF_TEMPLATES_ADMIN_REQUIRED',
      });
    }
    return user;
  }

  @Get('keys')
  @ApiOperation({ summary: 'Lista de templates conocidos del producto.' })
  listKeys(@CurrentUser() user: SessionClaims | undefined) {
    this.requireAdmin(user);
    return allKnownTemplateKeys();
  }

  @Get('catalog')
  @ApiOperation({
    summary:
      'Catálogo completo de emails/notificaciones del producto: nombre, trigger, default, variables y nota estructural. Para la UI /admin/emails.',
  })
  catalog(@CurrentUser() user: SessionClaims | undefined): EmailTemplateCatalogEntry[] {
    this.requireAdmin(user);
    return buildEmailTemplateCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'Lista los overrides del tenant. Filtra por key opcionalmente.' })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<NotificationTemplateRow[]> {
    const u = this.requireAdmin(user);
    return this.prisma.notificationTemplate.findMany({
      where: {
        tenantId: u.tenantId,
        ...(query.key ? { key: query.key } : {}),
      },
      orderBy: [{ key: 'asc' }, { locale: 'asc' }, { channel: 'asc' }],
    });
  }

  @Put(':key')
  @ApiOperation({
    summary:
      'Crea o actualiza un override del template `:key` para un (channel, locale) del tenant.',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(upsertTemplateSchema)) dto: z.infer<typeof upsertTemplateSchema>,
  ): Promise<NotificationTemplateRow> {
    const u = this.requireAdmin(user);
    return this.prisma.notificationTemplate.upsert({
      where: {
        tenantId_key_channel_locale: {
          tenantId: u.tenantId,
          key,
          channel: dto.channel,
          locale: dto.locale,
        },
      },
      create: {
        tenantId: u.tenantId,
        key,
        channel: dto.channel,
        locale: dto.locale,
        subject: dto.subject ?? null,
        body: dto.body,
      },
      update: {
        subject: dto.subject ?? null,
        body: dto.body,
      },
    });
  }

  @Delete(':key')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Elimina el override del template `:key` para (channel, locale). El producto vuelve a usar el default hardcoded.',
  })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Query('channel') channel?: string,
    @Query('locale') locale?: string,
  ) {
    const u = this.requireAdmin(user);
    if (!channel || !locale) {
      // Si no se pasan channel y locale, borramos todos los overrides
      // del key para el tenant (limpieza global de un template).
      await this.prisma.notificationTemplate.deleteMany({
        where: { tenantId: u.tenantId, key },
      });
      return { deleted: true };
    }
    if (!['EMAIL', 'IN_APP', 'WEBHOOK'].includes(channel)) {
      throw new ForbiddenException({ message: 'channel inválido', code: 'NOTIF_CHANNEL_INVALID' });
    }
    await this.prisma.notificationTemplate.deleteMany({
      where: {
        tenantId: u.tenantId,
        key,
        channel: channel as 'EMAIL' | 'IN_APP' | 'WEBHOOK',
        locale,
      },
    });
    return { deleted: true };
  }
}
