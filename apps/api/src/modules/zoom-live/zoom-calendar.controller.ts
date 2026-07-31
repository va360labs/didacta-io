/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  buildGoogleCalendarUrl,
  buildIcsEvent,
  buildOutlookCalendarUrl,
  type CalendarEventInput,
} from '@didacta/mod-zoom-live';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ModuleRegistryService } from '../module-registry.service';
import { classUrl } from './class-links';

const uuidSchema = z.string().uuid();

/**
 * Endpoints de "añadir al calendario" de una clase en directo.
 *
 * **Públicos a propósito** (sin `JwtAuthGuard`): a estos enlaces se llega
 * desde el email de confirmación y desde el recordatorio de 2h antes, y un
 * cliente de correo no manda bearer token. La credencial es el UUID de la
 * sesión — el mismo modelo del enlace compartible `/clase/<id>` (ADR-017).
 *
 * Qué se expone: título, hora y duración, que es exactamente lo que ya ve
 * cualquiera que abra ese enlace. Qué NO: el `joinUrl` de Zoom, la
 * descripción interna y el roster de inscritos. Un `.ics` se reenvía y se
 * sincroniza a móviles; meter ahí el joinUrl sería regalar el acceso.
 *
 * Una clase cancelada responde 404: el evento ya no existe.
 */
@ApiTags('Modules · Zoom Live')
@Controller('modules/zoom-live')
export class ZoomCalendarController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('sessions/:id/calendar.ics')
  @ApiOperation({
    summary:
      'Evento iCalendar (RFC 5545) de la clase, para Apple Calendar, Outlook de escritorio y cualquier cliente estándar. Público: se abre desde el email.',
  })
  async ics(@Param('id') id: string, @Res({ passthrough: false }) reply: FastifyReply) {
    const event = await this.resolve(id);
    const ics = buildIcsEvent({ ...event, reminderMinutesBefore: 30 });
    void reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="clase-${id}.ics"`)
      // Sin caché: la clase puede reprogramarse y el fichero cambia con ella.
      .header('Cache-Control', 'no-store')
      .send(ics);
  }

  @Get('sessions/:id/calendar/google')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Google Calendar. Público.' })
  async google(@Param('id') id: string, @Res({ passthrough: false }) reply: FastifyReply) {
    redirect(reply, buildGoogleCalendarUrl(await this.resolve(id)));
  }

  @Get('sessions/:id/calendar/outlook')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Outlook.com (personal). Público.' })
  async outlook(@Param('id') id: string, @Res({ passthrough: false }) reply: FastifyReply) {
    redirect(reply, buildOutlookCalendarUrl(await this.resolve(id), 'personal'));
  }

  @Get('sessions/:id/calendar/office365')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Outlook de Microsoft 365. Público.' })
  async office365(@Param('id') id: string, @Res({ passthrough: false }) reply: FastifyReply) {
    redirect(reply, buildOutlookCalendarUrl(await this.resolve(id), 'work'));
  }

  /** Carga la sesión y la traduce al evento, o 404 si no procede. */
  private async resolve(id: string): Promise<CalendarEventInput> {
    if (!uuidSchema.safeParse(id).success) throw new NotFoundException('Clase no encontrada.');
    const info = await this.registry.getZoomLiveService().getCalendarInfo(id);
    if (!info || info.status === 'CANCELLED') {
      throw new NotFoundException('Clase no encontrada.');
    }
    return {
      sessionId: info.id,
      topic: info.topic,
      startTime: info.startTime,
      durationMinutes: info.durationMinutes,
      classUrl: classUrl(info.id),
      organizerName: info.organizerName,
    };
  }
}

/**
 * 302 al proveedor. Header + código explícitos en vez de `reply.redirect()`
 * porque Fastify le dio la vuelta a los argumentos entre v4 (`code, dest`) y
 * v5 (`dest, code`): así el destino no depende de la versión instalada.
 */
function redirect(reply: FastifyReply, url: string): void {
  void reply.header('Location', url).code(302).send();
}
