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
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RETENTION_TRIGGERS, type RetentionTriggerName } from '@didacta/mod-retention';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const triggerSchema = z.enum(
  RETENTION_TRIGGERS as [RetentionTriggerName, ...RetentionTriggerName[]],
);

// Forma y tipos; los rangos (días, longitud del texto, variables) los valida
// el servicio del módulo, que es quien sabe qué vale para cada disparador.
const automationSchema = z.object({
  trigger: triggerSchema,
  name: z.string().max(200).nullish(),
  days: z.number().int().nullish(),
  resendAfterDays: z.number().int().nullish(),
  body: z.string().max(8000),
  emailEnabled: z.boolean().optional(),
  emailSubject: z.string().max(400).nullish(),
  enabled: z.boolean().optional(),
});

const patchSchema = automationSchema.omit({ trigger: true }).partial();

const settingsSchema = z.object({
  senderUserId: z.string().uuid().nullish(),
  manualCooldownHours: z.number().int().optional(),
  sendWindowStartHour: z.number().int().optional(),
  sendWindowEndHour: z.number().int().optional(),
});

const previewSchema = z.object({
  trigger: triggerSchema,
  body: z.string().max(8000),
  subject: z.string().max(400).nullish(),
  userId: z.string().uuid().nullish(),
});

const atRiskQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  reason: z.enum(['inactive', 'paid_not_started', 'stalled']).optional(),
  search: z.string().max(120).optional(),
});

/**
 * Backend HTTP de mod.retention. Capa fina: cada endpoint valida la forma,
 * comprueba que quien llama administra el aula y delega en el servicio del
 * módulo. Todo bajo `/modules/retention/`, así que si el aula apaga el módulo
 * el interceptor de módulos responde 403 sin llegar aquí.
 */
@ApiTags('Modules · Retention')
@ApiBearerAuth()
@Controller('modules/retention')
@UseGuards(JwtAuthGuard)
export class RetentionController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private get service() {
    return this.registry.getRetentionService();
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo quien administra el aula puede gestionar los mensajes automáticos.',
        code: 'RETENTION_ADMIN_REQUIRED',
      });
    }
    return user;
  }

  @Get('admin/settings')
  @ApiOperation({ summary: 'Quién firma los mensajes y las reglas anti-spam del aula.' })
  async getSettings(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.service.getSettings(u.tenantId);
  }

  @Put('admin/settings')
  @ApiOperation({ summary: 'Cambia quién firma y las reglas anti-spam.' })
  async putSettings(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(settingsSchema)) dto: z.infer<typeof settingsSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.service.updateSettings(u.tenantId, u.sub, dto);
  }

  @Get('admin/templates')
  @ApiOperation({ summary: 'Plantillas listas, en el idioma del aula.' })
  async templates(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return { templates: await this.service.listTemplates(u.tenantId) };
  }

  @Post('admin/templates/:key/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activa una plantilla con un clic (o la reenciende si ya existe).' })
  async activateTemplate(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('key') key: string,
  ) {
    const u = this.requireAdmin(user);
    return { automation: await this.service.activateTemplate(u.tenantId, u.sub, key) };
  }

  @Get('admin/automations')
  @ApiOperation({ summary: 'Mensajes automáticos del aula con sus métricas.' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return { automations: await this.service.listAutomations(u.tenantId) };
  }

  @Post('admin/automations')
  @HttpCode(201)
  @ApiOperation({ summary: 'Crea un mensaje automático.' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(automationSchema)) dto: z.infer<typeof automationSchema>,
  ) {
    const u = this.requireAdmin(user);
    return { automation: await this.service.createAutomation(u.tenantId, u.sub, dto) };
  }

  @Patch('admin/automations/:id')
  @ApiOperation({ summary: 'Edita, enciende o apaga un mensaje automático.' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(patchSchema)) dto: z.infer<typeof patchSchema>,
  ) {
    const u = this.requireAdmin(user);
    return { automation: await this.service.updateAutomation(u.tenantId, u.sub, id, dto) };
  }

  @Delete('admin/automations/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Borra un mensaje automático (se conservan sus métricas).' })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const u = this.requireAdmin(user);
    await this.service.deleteAutomation(u.tenantId, id);
  }

  @Post('admin/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Vista previa con los datos reales de una persona (o de quien mira).' })
  async preview(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(previewSchema)) dto: z.infer<typeof previewSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.service.preview(u.tenantId, u.sub, dto);
  }

  @Post('admin/run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Pasa el barrido de ESTA aula ahora, sin esperar a los 5 minutos (mismas reglas anti-spam).',
  })
  async runNow(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.service.runTenant(u.tenantId);
  }

  @Get('admin/at-risk')
  @ApiOperation({ summary: 'Miembros en riesgo: sin entrar, pagaron y no empezaron, a medias.' })
  async atRisk(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(atRiskQuerySchema)) q: z.infer<typeof atRiskQuerySchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.service.atRisk(u.tenantId, q);
  }

  @Post('admin/at-risk/:userId/recovery')
  @HttpCode(200)
  @ApiOperation({ summary: 'Añade a la persona al mensaje de recuperación del aula.' })
  async addToRecovery(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    const u = this.requireAdmin(user);
    return this.service.addToRecovery(u.tenantId, userId);
  }
}
