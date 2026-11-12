/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isCourseEditor } from '../modules/lesson-content-gate';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { bunnyEmbedBaseUrl, signBunnyEmbedUrl } from './bunny-embed';
import { VIDEO_CLOUD_LIBRARY, type CloudVideoLibrary } from './cloud/video-cloud.tokens';
import { VideoAccessService, type VideoViewer } from './video-access.service';
import { VideoPlayLimiter, type VideoPlayWindow } from './video-play-limiter';
import { VideoProtectionConfigService } from './video-protection-config.service';

export class VideoForbiddenError extends Error {
  constructor() {
    super('No tienes acceso a este vídeo.');
    this.name = 'VideoForbiddenError';
  }
}

export class VideoRateLimitedError extends Error {
  constructor(
    readonly window: VideoPlayWindow,
    readonly retryAfterSeconds: number,
  ) {
    // Una sola frase para las dos ventanas: el `code` tiene que poder
    // traducirse con UNA key por idioma. Cuál de las dos ventanas se ha
    // llenado viaja aparte, en `window`.
    super('Has abierto demasiados vídeos distintos en poco tiempo. Vuelve a intentarlo más tarde.');
    this.name = 'VideoRateLimitedError';
  }
}

/** La academia ha llegado al tope de horas vistas del mes (vídeo subido a Cloud). */
export class VideoWatchQuotaError extends Error {
  constructor() {
    super('Esta academia ha llegado a su límite de horas de vídeo de este mes.');
    this.name = 'VideoWatchQuotaError';
  }
}

export interface PlayUrl {
  /** URL de embed lista para el iframe. */
  url: string;
  /** ISO de caducidad de la firma, o null si la URL no va firmada. */
  expiresAt: string | null;
  /**
   * La librería de este vídeo está protegida en el tenant: la URL va firmada y
   * ha pasado la comprobación de acceso y el tope por cuenta.
   */
  protected: boolean;
  /** El reproductor debe pintar la marca de agua con la identidad del alumno. */
  watermark: boolean;
}

/** Entradas del antirrebote de auditoría antes de purgar. */
const AUDIT_DEBOUNCE_MAX = 10_000;

/**
 * Entrega la URL de reproducción de un vídeo de Bunny.
 *
 * - Librería SIN protección en el tenant (no hay clave guardada, o el admin la
 *   ha apagado): devuelve la URL de siempre, sin firmar y sin más
 *   comprobaciones. Es exactamente lo que el aula incrustaba antes de que
 *   existiera esta función, así que actualizar no cambia nada para quien no la
 *   ha configurado. No se filtra nada: esa URL se construye con los dos datos
 *   que ya trae quien pregunta.
 * - Librería protegida: comprueba que el usuario puede ver ESE vídeo, aplica el
 *   tope de vídeos distintos por cuenta (salvo a quien gestiona cursos) y firma
 *   con la clave del tenant para que la URL caduque.
 */
@Injectable()
export class VideoPlaybackService {
  private readonly logger = new Logger(VideoPlaybackService.name);
  /** Un registro de auditoría por cuenta y ventana de tope, no uno por intento. */
  private readonly auditedUntil = new Map<string, number>();

  constructor(
    private readonly access: VideoAccessService,
    private readonly config: VideoProtectionConfigService,
    private readonly limiter: VideoPlayLimiter,
    private readonly auditLog: PrismaAuditLogService,
    /** Solo con la subida de vídeo de Didacta Cloud encendida (`VideoCloudModule`). */
    @Optional() @Inject(VIDEO_CLOUD_LIBRARY) private readonly cloud?: CloudVideoLibrary,
  ) {}

  async getPlayUrl(viewer: VideoViewer, libraryId: string, guid: string): Promise<PlayUrl> {
    if (this.cloud && libraryId === this.cloud.libraryId) {
      return this.getCloudPlayUrl(viewer, libraryId, guid, this.cloud);
    }
    const protection = await this.config.resolveLibrary(viewer.tenantId, libraryId);
    if (!protection.active) {
      return {
        url: bunnyEmbedBaseUrl(libraryId, guid),
        expiresAt: null,
        protected: false,
        watermark: false,
      };
    }

    if (!(await this.access.canPlay(viewer, guid))) throw new VideoForbiddenError();

    if (!isCourseEditor(viewer.roles)) {
      const decision = await this.limiter.check(viewer.tenantId, viewer.userId, guid, {
        perHour: protection.settings.maxVideosPerHour,
        perDay: protection.settings.maxVideosPerDay,
      });
      if (!decision.allowed) {
        await this.onRateLimited(viewer, guid, decision);
        throw new VideoRateLimitedError(decision.window, decision.retryAfterSeconds);
      }
    }

    const signed = signBunnyEmbedUrl({ libraryId, guid, tokenKey: protection.tokenKey });
    return { ...signed, protected: true, watermark: protection.settings.watermark };
  }

  /**
   * Vídeo de la biblioteca de Didacta Cloud (compartida por todas las aulas):
   * SIEMPRE firmado, y solo si el vídeo es de un aula de ESTE tenant —pegar en
   * una lección la URL de un vídeo de otra academia no da acceso—. El
   * interruptor de protección del aula no aplica (la biblioteca exige firma);
   * el tope por cuenta y la marca de agua, sí.
   */
  private async getCloudPlayUrl(
    viewer: VideoViewer,
    libraryId: string,
    guid: string,
    cloud: CloudVideoLibrary,
  ): Promise<PlayUrl> {
    const editor = isCourseEditor(viewer.roles);
    const decision = await cloud.resolvePlay({ tenantId: viewer.tenantId, guid, isEditor: editor });
    if (decision.kind === 'not_ours') throw new VideoForbiddenError();
    if (decision.kind === 'watch_quota_exceeded') throw new VideoWatchQuotaError();
    if (!(await this.access.canPlay(viewer, guid))) throw new VideoForbiddenError();

    const settings = await this.config.getSettings(viewer.tenantId);
    if (!editor) {
      const limit = await this.limiter.check(viewer.tenantId, viewer.userId, guid, {
        perHour: settings.maxVideosPerHour,
        perDay: settings.maxVideosPerDay,
      });
      if (!limit.allowed) {
        await this.onRateLimited(viewer, guid, limit);
        throw new VideoRateLimitedError(limit.window, limit.retryAfterSeconds);
      }
    }
    const signed = signBunnyEmbedUrl({ libraryId, guid, tokenKey: decision.tokenKey });
    return { ...signed, protected: true, watermark: settings.watermark };
  }

  private async onRateLimited(
    viewer: VideoViewer,
    guid: string,
    decision: { window: VideoPlayWindow; limit: number; retryAfterSeconds: number },
  ): Promise<void> {
    const { window, limit, retryAfterSeconds } = decision;
    this.logger.warn(
      `Tope de vídeos superado: tenant=${viewer.tenantId} user=${viewer.userId} ventana=${window} límite=${limit} guid=${guid}`,
    );

    const key = `${viewer.tenantId}:${viewer.userId}:${window}`;
    const now = Date.now();
    if ((this.auditedUntil.get(key) ?? 0) > now) return;
    if (this.auditedUntil.size >= AUDIT_DEBOUNCE_MAX) {
      for (const [k, until] of this.auditedUntil) if (until <= now) this.auditedUntil.delete(k);
      if (this.auditedUntil.size >= AUDIT_DEBOUNCE_MAX) this.auditedUntil.clear();
    }
    this.auditedUntil.set(key, now + retryAfterSeconds * 1000);

    try {
      await this.auditLog.record({
        tenantId: viewer.tenantId,
        actorId: viewer.userId,
        action: 'video.play_url.rate_limited',
        resourceType: 'user',
        resourceId: viewer.userId,
        metadata: { window, limit, guid, retryAfterSeconds },
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo auditar el tope de vídeos: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
