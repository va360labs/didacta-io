/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente mod.zoom-live → mod.community (composición en el host: el emisor no
 * importa al receptor, mismo patrón que SurveysZoomBridge).
 *
 * Al crear o editar una clase marcando «Anunciar en la comunidad», publica un
 * post en el feed con un marcador invisible que el front convierte en una
 * tarjeta rica con inscripción en línea (`lib/clase-embed.ts`). Escucha también
 * las ediciones para que un anuncio ya publicado nunca quede desfasado.
 *
 * Cuatro cosas importantes:
 *
 *  1. OPT-IN para publicar. Solo se crea el post si el evento trae
 *     `announce: true`. Las clases de prueba (y las creadas por integraciones)
 *     no ensucian el feed, y editar una clase deliberadamente no anunciada
 *     tampoco la publica por la espalda.
 *  2. SINCRONIZACIÓN incondicional. Si el anuncio YA existe, cada edición
 *     actualiza título y cuerpo aunque no se pida anunciar: cambiar la hora no
 *     puede dejar un post mintiendo.
 *  3. GATING POR TENANT. Un tenant sin mod.community activo no recibe post.
 *  4. IDEMPOTENCIA. La entrega es AL MENOS UNA VEZ: el marcador de la sesión es
 *     lo que evita publicar dos veces la misma clase.
 *
 * Todo es best-effort: un fallo aquí JAMÁS rompe la clase ni su edición.
 */

const COMMUNITY_MODULE = 'mod.community';

/** Payload común de `zoom.session.created` y `zoom.session.updated`. */
interface SessionEventPayload {
  sessionId: string;
  announce?: boolean;
}

/**
 * Marcador que el front reconoce para pintar la tarjeta de la clase.
 * ⚠️ Debe coincidir EXACTAMENTE con `CLASE_MARKER` de
 * `apps/web/src/lib/clase-embed.ts` — los dos lados evolucionan juntos.
 */
function claseMarker(sessionId: string): string {
  return `<!--didacta-clase:${sessionId}-->`;
}

function formatWhen(startTime: Date, timezone: string): string {
  try {
    return startTime.toLocaleString('es-ES', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    // Timezone IANA inválida: no rompemos el anuncio.
    return startTime.toLocaleString('es-ES');
  }
}

@Injectable()
export class ZoomLiveCommunityBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const bus = this.factory.getEventBus();

    for (const eventName of ['zoom.session.created', 'zoom.session.updated'] as const) {
      bus.subscribe<SessionEventPayload>(
        eventName,
        async (event: DomainEvent<SessionEventPayload>) => {
          const tenantId = event.metadata.tenantId;
          // Sin actor no hay autor real para el post: se descarta en vez de
          // inventarse uno (regla del proyecto: cero datos de cartón).
          const actorId = event.metadata.userId;
          if (!tenantId || !actorId) return;
          try {
            await this.sync(tenantId, actorId, event.data.sessionId, event.data.announce ?? false);
          } catch (err) {
            this.logger.warn(
              {
                tenantId,
                eventName,
                sessionId: event.data.sessionId,
                err: err instanceof Error ? err.message : String(err),
              },
              'mod.community: fallo publicando/actualizando el anuncio de la clase (la clase NO se ve afectada)',
            );
          }
        },
      );
    }

    this.logger.log(
      {},
      'ZoomLiveCommunityBridge: subscribed to zoom.session.created + zoom.session.updated',
    );
  }

  /**
   * Deja el feed coherente con la clase.
   *
   *  - Si YA hay anuncio, se re-sincroniza título y cuerpo aunque `announce`
   *    venga a false: cambiar la hora de una clase anunciada no puede dejar un
   *    post mintiendo. (La tarjeta rica lee la sesión en vivo, pero el texto
   *    del post es una copia.)
   *  - Si NO hay anuncio, solo se publica cuando el formador lo pidió. Así
   *    editar una clase que decidió no anunciar no la publica por la espalda.
   */
  private async sync(
    tenantId: string,
    actorId: string,
    sessionId: string,
    announce: boolean,
  ): Promise<void> {
    if (!(await this.registry.isModuleEnabledForTenant(tenantId, COMMUNITY_MODULE))) return;

    const prisma = this.factory.getPrisma();
    // Lectura acotada de mod_zoom_session (ADR-016: core first-party, filtrada
    // por tenant, sin escribir en tablas ajenas).
    const session = await prisma.modZoomSession.findFirst({
      where: { id: sessionId, tenantId },
      select: {
        topic: true,
        description: true,
        startTime: true,
        timezone: true,
        durationMinutes: true,
      },
    });
    if (!session) return;

    const marker = claseMarker(sessionId);
    const existing = await prisma.modCommunityPost.findFirst({
      where: { tenantId, body: { contains: marker }, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!existing && !announce) return;

    const cuerpo = [
      `Clase en directo: **${session.topic}**.`,
      `🗓️ ${formatWhen(session.startTime, session.timezone)} · ${session.durationMinutes} min.`,
      session.description?.trim() ? `\n${session.description.trim()}` : '',
      '\nInscríbete desde aquí para recibir el enlace de Zoom.',
      `\n${marker}`,
    ]
      .filter(Boolean)
      .join('\n');

    if (existing) {
      // Editar como el AUTOR original: `updatePost` autoriza al dueño o a un
      // moderador, y así el post no cambia de firma porque lo edite otro.
      await this.registry
        .getCommunityService()
        .updatePost(tenantId, { id: existing.authorId, canModerate: true }, existing.id, {
          title: session.topic,
          body: cuerpo,
        });
      this.logger.log(
        { tenantId, sessionId, postId: existing.id },
        'mod.community: anuncio de la clase actualizado',
      );
      return;
    }

    // El autor es quien pidió anunciarla. Si ya no está en el tenant, no se
    // publica: un post sin autor real rompería el feed y el perfil enlazado.
    const user = await prisma.user.findFirst({
      where: { id: actorId, tenantId },
      select: { id: true, name: true },
    });
    if (!user) return;

    const post = await this.registry.getCommunityService().createPost(
      tenantId,
      { id: user.id, displayName: user.name },
      {
        title: session.topic,
        body: cuerpo,
        tags: ['Clases en directo'],
        // El anuncio se queda en el feed: no dispara el broadcast por email a
        // todo el tenant. Eso lo decide un admin publicando a mano.
        notifyAll: false,
        important: false,
      },
      'web',
    );

    this.logger.log(
      { tenantId, sessionId, postId: post.id },
      'mod.community: clase en directo anunciada en el feed',
    );
  }
}
