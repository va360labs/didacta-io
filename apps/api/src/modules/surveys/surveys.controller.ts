/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';
import { SurveysReminderWorker } from './surveys-reminder.worker';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const submitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        valueInt: z.number().int().optional(),
        valueText: z.string().max(4000).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/// Backend HTTP de `mod.surveys` (bloque 2 — feedback/NPS). Las respuestas son
/// anónimas: el userId del token solo se usa para el HMAC de dedupe y NUNCA se
/// persiste junto a la respuesta.
@ApiTags('Encuestas')
@Controller('modules/surveys')
export class SurveysController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly reminderWorker: SurveysReminderWorker,
  ) {}

  @Get('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Encuesta de una clase en directo (si existe) + si ya respondiste.' })
  async getForSession(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('sessionId') sessionId: string,
  ) {
    const u = this.requireUser(user);
    const survey = await this.registry
      .getSurveysService()
      .getForZoomSession(u.tenantId, sessionId, u.sub);
    return { survey };
  }

  @Post(':id/responses')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Envía la respuesta anónima del usuario actual (una por encuesta).' })
  async submit(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') surveyId: string,
    @Body(new ZodValidationPipe(submitSchema)) dto: z.infer<typeof submitSchema>,
  ) {
    const u = this.requireUser(user);
    await this.registry.getSurveysService().submitResponse({
      tenantId: u.tenantId,
      surveyId,
      userId: u.sub,
      answers: dto.answers,
    });
    return { ok: true };
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Listado de encuestas del tenant con nº de respuestas (admin).' })
  async adminList(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const surveys = await this.registry.getSurveysService().listSurveys(u.tenantId);
    return { surveys };
  }

  @Get('admin/:id/results')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resultados agregados (NPS, medias, textos) de una encuesta (admin).' })
  async adminResults(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    return this.registry.getSurveysService().getResults(u.tenantId, id);
  }

  @Post('admin/sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Crea (idempotente) la encuesta post-clase de una sesión sin esperar al webhook de Zoom (admin).',
  })
  async adminCreateForSession(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('sessionId') sessionId: string,
  ) {
    const u = this.requireAdmin(user);
    // Lectura acotada de mod_zoom_live_session (título) — composición en el host.
    const session = await this.factory.getPrisma().modZoomSession.findFirst({
      where: { id: sessionId, tenantId: u.tenantId },
      select: { topic: true },
    });
    if (!session) throw new NotFoundException('Clase no encontrada.');
    const result = await this.registry.getSurveysService().createForZoomSession({
      tenantId: u.tenantId,
      sessionId,
      topic: session.topic,
    });
    return result;
  }

  @Post('admin/reminders/run')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fuerza el barrido de recordatorios sin esperar al cron (encuestas abiertas ≥24h sin recordatorio).',
  })
  async adminRunReminders(@CurrentUser() user: SessionClaims | undefined) {
    this.requireAdmin(user);
    return this.reminderWorker.runSweep();
  }

  @Post('admin/:id/close')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cierra una encuesta: deja de aceptar respuestas (admin).' })
  async adminClose(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getSurveysService().closeSurvey(u.tenantId, id);
    return { ok: true };
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Sólo super_admin / tenant_admin pueden gestionar encuestas.');
    }
    return u;
  }
}
