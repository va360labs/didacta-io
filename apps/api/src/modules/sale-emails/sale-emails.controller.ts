/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
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
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { EmailLang } from '../../common/branded-email';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { SALE_EMAIL_LIMITS, isSaleEmailKey, type SaleEmailKey } from './sale-email-templates';
import { SaleEmailsService } from './sale-emails.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);
const LANGS = new Set<EmailLang>(['es', 'en', 'pt']);

const saveSchema = z.object({
  subject: z.string().trim().min(1).max(SALE_EMAIL_LIMITS.subject),
  body: z.string().trim().min(1).max(SALE_EMAIL_LIMITS.body),
});

const draftSchema = z
  .object({
    subject: z.string().max(SALE_EMAIL_LIMITS.subject).nullable().optional(),
    body: z.string().max(SALE_EMAIL_LIMITS.body).nullable().optional(),
  })
  .optional();

const testSchema = z
  .object({
    subject: z.string().max(SALE_EMAIL_LIMITS.subject).nullable().optional(),
    body: z.string().max(SALE_EMAIL_LIMITS.body).nullable().optional(),
    /** Sin él, a quien pulsa «Enviarme una prueba». */
    toEmail: z.string().trim().email().max(320).optional(),
  })
  .optional();

const settingsSchema = z.object({
  refundPolicyUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), {
      message: 'Tiene que ser un enlace que empiece por http:// o https://',
    })
    .nullable(),
});

/**
 * Correos de VENTA y ACCESO que el creador puede personalizar (asunto y
 * mensaje; el recibo y el botón no se tocan): los usa la sección «Correos» de
 * Ajustes en el modo sencillo y `/admin/emails` en el completo. Mismo
 * almacenamiento que el resto de plantillas (`notification_template`).
 */
@ApiTags('Admin · Correos de venta')
@ApiBearerAuth()
@Controller('admin/sale-emails')
@UseGuards(JwtAuthGuard)
export class SaleEmailsController {
  constructor(
    private readonly emails: SaleEmailsService,
    private readonly prisma: PrismaService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  private admin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo quien administra el aula puede cambiar sus correos.',
        code: 'SALE_EMAILS_ADMIN_REQUIRED',
      });
    }
    return user;
  }

  private target(key: string, lang: string): { key: SaleEmailKey; lang: EmailLang } {
    if (!isSaleEmailKey(key) || !LANGS.has(lang as EmailLang)) {
      throw new NotFoundException({
        message: 'Ese correo no existe.',
        code: 'SALE_EMAIL_NOT_FOUND',
      });
    }
    return { key, lang: lang as EmailLang };
  }

  @Get()
  @ApiOperation({
    summary:
      'Correos de venta y acceso editables: texto original por idioma, lo que el aula cambió, variables y ajustes.',
  })
  list(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.admin(user);
    return this.emails.adminList(u.tenantId);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Enlace a la política de devoluciones que va en cada recibo.' })
  settings(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
  ) {
    const u = this.admin(user);
    return this.emails.saveSettings(
      u.tenantId,
      { refundPolicyUrl: body.refundPolicyUrl?.trim() || null },
      u.sub,
    );
  }

  @Put(':key/:lang')
  @ApiOperation({ summary: 'Guarda el asunto y el mensaje de un correo en un idioma.' })
  save(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Param('lang') lang: string,
    @Body(new ZodValidationPipe(saveSchema)) body: z.infer<typeof saveSchema>,
  ) {
    const u = this.admin(user);
    const t = this.target(key, lang);
    return this.emails.saveTemplate(u.tenantId, t.key, t.lang, body);
  }

  @Delete(':key/:lang')
  @HttpCode(200)
  @ApiOperation({ summary: '«Volver al original»: borra el texto propio de ese idioma.' })
  async reset(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Param('lang') lang: string,
  ) {
    const u = this.admin(user);
    const t = this.target(key, lang);
    await this.emails.resetTemplate(u.tenantId, t.key, t.lang);
    return { reset: true };
  }

  @Post(':key/:lang/preview')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'El correo tal como saldría (con el borrador si se manda), con datos de ejemplo del comprador.',
  })
  async preview(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Param('lang') lang: string,
    @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>,
    @Req() req: FastifyRequest,
  ) {
    const u = this.admin(user);
    const t = this.target(key, lang);
    // Las imágenes y enlaces de la vista previa, con el dominio desde el que
    // se mira (el logo se ve también donde el aula aún no tiene HTTPS).
    const viewBase = await this.tenantResolver
      .resolveTenantWebBaseUrl(u.tenantId, req)
      .catch(() => null);
    return this.emails.preview(u.tenantId, t.key, t.lang, body ?? null, viewBase);
  }

  @Post(':key/:lang/test')
  @HttpCode(200)
  @ApiOperation({ summary: '«Enviarme una prueba»: el correo real a quien lo pide.' })
  async test(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
    @Param('lang') lang: string,
    @Body(new ZodValidationPipe(testSchema)) body: z.infer<typeof testSchema>,
  ) {
    const u = this.admin(user);
    const t = this.target(key, lang);
    let to = body?.toEmail;
    if (!to) {
      const me = await runAsTenant(u.tenantId, () =>
        this.prisma.user.findFirst({
          where: { id: u.sub, tenantId: u.tenantId },
          select: { email: true },
        }),
      );
      to = me?.email;
    }
    if (!to) {
      throw new BadRequestException({
        message: 'No sabemos a qué correo enviarte la prueba.',
        code: 'SALE_EMAIL_TEST_NO_ADDRESS',
      });
    }
    const result = await this.emails.sendTest(
      u.tenantId,
      t.key,
      t.lang,
      body ? { subject: body.subject ?? null, body: body.body ?? null } : null,
      to,
    );
    if (!result.ok) {
      throw new BadRequestException(
        result.reason === 'no_smtp'
          ? {
              message: 'Tu aula todavía no puede enviar correos.',
              code: 'SALE_EMAIL_TEST_NO_SMTP',
            }
          : {
              message: 'El servidor de correo no aceptó la prueba.',
              code: 'SALE_EMAIL_TEST_FAILED',
              ...(result.detail ? { detail: result.detail } : {}),
            },
      );
    }
    return result;
  }
}
