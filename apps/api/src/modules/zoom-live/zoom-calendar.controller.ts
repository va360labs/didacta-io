/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  buildGoogleCalendarUrl,
  buildIcsEvent,
  buildOutlookCalendarUrl,
  icsFileName,
  type CalendarEventInput,
  type CalendarLocale,
} from '@didacta/mod-zoom-live';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  academyLocale,
  toAcademyLocale,
  type AcademyDefaultsPrisma,
} from '../../common/academy-defaults';
import { readRequestLocale } from '../../common/checkout-locale';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { classUrl } from './class-links';

const uuidSchema = z.string().uuid();

/**
 * Endpoints de "añadir al calendario" de una clase en directo.
 *
 * **Públicos a propósito** (sin `JwtAuthGuard`): a estos enlaces se llega
 * desde el email de confirmación y desde el recordatorio de 2h antes, y un
 * cliente de correo no manda bearer token. La credencial es el UUID de la
 * sesión — el mismo modelo del enlace compartible `/live/<id>` (ADR-017).
 *
 * Qué se expone: título, hora y duración, que es exactamente lo que ya ve
 * cualquiera que abra ese enlace. Qué NO: el `joinUrl` de Zoom, la
 * descripción interna y el roster de inscritos. Un `.ics` se reenvía y se
 * sincroniza a móviles; meter ahí el joinUrl sería regalar el acceso.
 *
 * Una clase cancelada responde 404: el evento ya no existe.
 *
 * Idioma del texto que escribimos (descripción y nombre del fichero): el de
 * quien lo abre, que es la cookie de idioma de la web (`didacta_locale`: la
 * manda el navegador al pedir el enlace desde el aula o desde el correo, que
 * apunta al mismo dominio); si no la hay, el del aula dueña de la clase. Aquí
 * no hay sesión (un cliente de correo no manda token), así que no hay perfil
 * que leer.
 */
@ApiTags('Modules · Zoom Live')
@Controller('modules/zoom-live')
export class ZoomCalendarController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('sessions/:id/calendar.ics')
  @ApiOperation({
    summary:
      'Evento iCalendar (RFC 5545) de la clase, para Apple Calendar, Outlook de escritorio y cualquier cliente estándar. Público: se abre desde el email.',
  })
  async ics(
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    const event = await this.resolve(id, req);
    const ics = buildIcsEvent({ ...event, reminderMinutesBefore: 30 });
    void reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${icsFileName(id, event.locale)}"`)
      // Sin caché: la clase puede reprogramarse y el fichero cambia con ella.
      .header('Cache-Control', 'no-store')
      .send(ics);
  }

  @Get('sessions/:id/calendar/google')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Google Calendar. Público.' })
  async google(
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    redirect(reply, buildGoogleCalendarUrl(await this.resolve(id, req)));
  }

  @Get('sessions/:id/calendar/outlook')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Outlook.com (personal). Público.' })
  async outlook(
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    redirect(reply, buildOutlookCalendarUrl(await this.resolve(id, req), 'personal'));
  }

  @Get('sessions/:id/calendar/office365')
  @ApiOperation({ summary: 'Redirige al "añadir evento" de Outlook de Microsoft 365. Público.' })
  async office365(
    @Param('id') id: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    redirect(reply, buildOutlookCalendarUrl(await this.resolve(id, req), 'work'));
  }

  /**
   * Idioma del evento: la cookie de idioma de quien lo abre y, si no la manda
   * (o trae un idioma sin texto propio), el del aula. `academyLocale` es de
   * mejor esfuerzo: si no puede leer nada, español.
   */
  private async locale(tenantId: string, req?: FastifyRequest): Promise<CalendarLocale> {
    const fromCookie = toAcademyLocale(req ? readRequestLocale(req.headers) : undefined);
    if (fromCookie) return fromCookie;
    // RLS forzada: `tenant_setting` y `user` solo se leen dentro del aula.
    return runAsTenant(
      tenantId,
      () => academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId),
      { traceLabel: 'zoom-calendar-locale' },
    );
  }

  /** Carga la sesión y la traduce al evento, o 404 si no procede. */
  private async resolve(id: string, req?: FastifyRequest): Promise<CalendarEventInput> {
    if (!uuidSchema.safeParse(id).success)
      throw new NotFoundException({
        message: 'Clase no encontrada.',
        code: 'ZOOM_LIVE_CLASS_NOT_FOUND',
      });
    // Lookup cross-tenant DELIBERADO por UUID compartible (ADR-017): el id es la
    // credencial y el service resuelve internamente sesión + nombre del tenant,
    // sin más queries después (los builders de ICS/URL son puros). Inventario
    // F3: post-flip esta resolución irá vía `didacta_super`.
    const info = await runSanctionedGlobalAccess(() =>
      this.registry.getZoomLiveService().getCalendarInfo(id),
    );
    if (!info || info.status === 'CANCELLED') {
      throw new NotFoundException({
        message: 'Clase no encontrada.',
        code: 'ZOOM_LIVE_CLASS_NOT_FOUND',
      });
    }
    return {
      sessionId: info.id,
      topic: info.topic,
      startTime: info.startTime,
      durationMinutes: info.durationMinutes,
      // El enlace que queda guardado en el calendario del alumno es el de SU
      // aula: se resuelve por el tenant dueño de la clase, no por
      // `WEB_PUBLIC_URL` (una sola para toda la instalación).
      classUrl: classUrl(
        await this.tenantResolver.resolveTenantWebBaseUrlForBackground(info.tenantId),
        info.id,
      ),
      organizerName: info.organizerName,
      locale: await this.locale(info.tenantId, req),
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
