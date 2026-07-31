/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
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
import {
  createSessionSchema,
  listWebhookEventsQuerySchema,
  sessionStatusSchema,
  setManualAttendanceSchema,
  updateSessionSchema,
  type CreateSessionDto,
  type ListWebhookEventsQuery,
  type SetManualAttendanceDto,
  type UpdateSessionDto,
} from '@didacta/mod-zoom-live';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';
import { ZoomReminderWorker } from './zoom-reminder.worker';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const listQuerySchema = z.object({
  courseId: z.string().uuid().optional(),
  lessonId: z.string().uuid().optional(),
  status: sessionStatusSchema.optional(),
  /** Rango por startTime (lo usa el calendario para pedir un mes). */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

function viewerOf(user: SessionClaims): { userId: string; isStaff: boolean } {
  return { userId: user.sub, isStaff: user.roles.some((r) => ADMIN_ROLES.has(r)) };
}

const uuidSchema = z.string().uuid();

/**
 * `/clase/<id>` es una URL compartible públicamente: un id malformado debe
 * responder 404 (la web muestra "Clase no encontrada"), no un 500 de Prisma
 * (P2023) al comparar contra una columna @db.Uuid.
 */
function ensureSessionId(id: string): void {
  if (!uuidSchema.safeParse(id).success) {
    throw new NotFoundException('Sesión no encontrada.');
  }
}

@ApiTags('Modules · Zoom Live')
@ApiBearerAuth()
@Controller('modules/zoom-live')
@UseGuards(JwtAuthGuard)
export class ZoomLiveController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly reminderWorker: ZoomReminderWorker,
  ) {}

  /** Gating de staff (formador/admin) con el motivo en el mensaje. */
  private ensureStaff(user: SessionClaims, action: string): void {
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException(`Solo formadores y admins pueden ${action}.`);
    }
  }

  @Get('sessions')
  @ApiOperation({
    summary:
      'Listar sesiones síncronas del tenant (lectura: cualquier rol). `joinUrl`/`recordingUrl` solo se sirven si el viewer está inscrito o es staff (ADR-017).',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    const { from, to, ...rest } = q;
    return this.registry.getZoomLiveService().list(
      user.tenantId,
      {
        ...rest,
        ...(from ? { from: new Date(from) } : {}),
        ...(to ? { to: new Date(to) } : {}),
      },
      viewerOf(user),
    );
  }

  @Get('sessions/:id')
  @ApiOperation({
    summary:
      'Detalle de una sesión. Host/admin ven `startUrl` y siempre `joinUrl`; los demás solo ven `joinUrl`/`recordingUrl` si están inscritos (ADR-017).',
  })
  async get(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    ensureSessionId(id);
    const viewer = viewerOf(user);
    return viewer.isStaff
      ? this.registry.getZoomLiveService().getForHost(user.tenantId, id, viewer)
      : this.registry.getZoomLiveService().get(user.tenantId, id, viewer);
  }

  @Post('sessions/:id/register')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Inscribirse a una sesión (cualquier usuario autenticado del tenant). Idempotente. Devuelve la vista con `joinUrl` ya visible. 409 si la sesión está ENDED/CANCELLED.',
  })
  async register(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    ensureSessionId(id);
    const viewer = viewerOf(user);
    const view = await this.registry.getZoomLiveService().register(user.tenantId, user.sub, id);
    // El staff que se inscribe no debe perder `startUrl` en la respuesta
    // (la página /clase reemplaza su estado con este payload).
    return viewer.isStaff
      ? this.registry.getZoomLiveService().getForHost(user.tenantId, id, viewer)
      : view;
  }

  @Post('sessions/:id/unregister')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar la inscripción propia a una sesión. Idempotente.' })
  async unregister(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    ensureSessionId(id);
    return this.registry.getZoomLiveService().unregister(user.tenantId, user.sub, id);
  }

  @Get('sessions/:id/registrations')
  @ApiOperation({
    summary: 'Roster de miembros inscritos con nombre/email/avatar (solo formador o admin).',
  })
  async listRegistrations(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden ver los inscritos.');
    }
    ensureSessionId(id);
    return this.registry.getZoomLiveService().listRegistrations(user.tenantId, id);
  }

  @Post('sessions/:id/join')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sella la entrada del usuario a la clase y devuelve el `joinUrl` (ADR-018). Es el proxy de asistencia: pasa por aquí antes de abrir Zoom. 403 si no está inscrito.',
  })
  async join(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    ensureSessionId(id);
    const viewer = viewerOf(user);
    return this.registry
      .getZoomLiveService()
      .markJoinClick(user.tenantId, user.sub, id, viewer.isStaff);
  }

  @Get('sessions/:id/attendance')
  @ApiOperation({
    summary:
      'Informe de asistencia real: inscritos que asistieron, ausentes y participantes de Zoom sin casar (solo formador o admin).',
  })
  async getAttendance(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    this.ensureStaff(user, 'ver la asistencia');
    ensureSessionId(id);
    return this.registry.getZoomLiveService().getAttendance(user.tenantId, id);
  }

  @Post('sessions/:id/attendance/sync')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fuerza la reconciliación de asistencia contra la API de Zoom. Devuelve el informe; si Zoom falla, el motivo viaja en `syncError` en vez de un 502 opaco.',
  })
  async syncAttendance(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    this.ensureStaff(user, 'sincronizar la asistencia');
    ensureSessionId(id);
    return this.registry.getZoomLiveService().syncAttendance(user.tenantId, id);
  }

  @Put('sessions/:id/attendance/:userId')
  @ApiOperation({
    summary:
      'Marca a mano si un miembro asistió (`present: true|false`) o quita el override (`present: null`). No destruye la evidencia automática.',
  })
  async setManualAttendance(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(setManualAttendanceSchema)) dto: SetManualAttendanceDto,
  ) {
    if (!user) throw new UnauthorizedException();
    this.ensureStaff(user, 'marcar la asistencia');
    ensureSessionId(id);
    if (!uuidSchema.safeParse(userId).success) {
      throw new NotFoundException('Miembro no encontrado.');
    }
    return this.registry
      .getZoomLiveService()
      .setManualAttendance(user.tenantId, id, userId, dto.present);
  }

  @Post('sessions')
  @ApiOperation({
    summary:
      'Crear una sesión Zoom (formador o admin). El stub de Zoom API genera un meetingId determinístico.',
  })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSessionSchema)) dto: CreateSessionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden crear sesiones.');
    }
    return this.registry.getZoomLiveService().create(user.tenantId, user.sub, dto);
  }

  @Put('sessions/:id')
  @ApiOperation({ summary: 'Actualizar una sesión SCHEDULED.' })
  async update(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSessionSchema)) dto: UpdateSessionDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden modificar sesiones.');
    }
    ensureSessionId(id);
    return this.registry.getZoomLiveService().update(user.tenantId, user.sub, id, dto);
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar una sesión (soft: status = CANCELLED).' })
  async cancel(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException('Solo formadores y admins pueden cancelar sesiones.');
    }
    ensureSessionId(id);
    await this.registry.getZoomLiveService().cancel(user.tenantId, user.sub, id);
    return { cancelled: true };
  }

  @Post('test-credentials')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Smoke test de las credenciales Zoom S2S del tenant: hace el OAuth handshake (sin crear meetings). Devuelve `kind: "real" | "stub"` y el `accountId` echo. Errores de Zoom se traducen a 400.',
  })
  async testCredentials(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const allowed = new Set(['super_admin', 'tenant_admin']);
    if (!user.roles.some((r) => allowed.has(r))) {
      throw new UnauthorizedException(
        'Solo administradores pueden probar las credenciales de Zoom.',
      );
    }
    return this.registry.getZoomLiveService().testCredentials(user.tenantId);
  }

  @Post('admin/reminders/run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fuerza el barrido de recordatorios de clase sin esperar al cron (clases que empiezan dentro de la ventana y aún sin aviso). Solo formador/admin.',
  })
  async runReminders(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    this.ensureStaff(user, 'lanzar los recordatorios');
    // Acotado al tenant del que llama: el cron barre todos, un admin no.
    return this.reminderWorker.runSweep(new Date(), user.tenantId);
  }

  @Get('webhook-events')
  @ApiOperation({
    summary:
      'Lista paginada de eventos webhook recibidos de Zoom (solo super_admin / tenant_admin). Sirve para QA y debugging cuando un meeting no transiciona como se espera.',
  })
  async listWebhookEvents(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listWebhookEventsQuerySchema)) q: ListWebhookEventsQuery,
  ) {
    if (!user) throw new UnauthorizedException();
    // Solo admins ven eventos crudos: incluyen meetingId y errorMessage
    // que no queremos exponer a formadores genéricos.
    const allowed = new Set(['super_admin', 'tenant_admin']);
    if (!user.roles.some((r) => allowed.has(r))) {
      throw new UnauthorizedException('Solo administradores pueden consultar eventos de webhook.');
    }
    return this.registry.getZoomLiveService().listWebhookEvents(user.tenantId, q);
  }
}
