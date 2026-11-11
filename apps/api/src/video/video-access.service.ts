/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import {
  isCourseEditor,
  lessonContentAllowed,
  resolveLessonContentGate,
} from '../modules/lesson-content-gate';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { BUNNY_GUID_RE } from './bunny-embed';

export interface VideoViewer {
  tenantId: string;
  userId: string;
  roles: string[];
}

/**
 * Solo se cachea el «sí», 5 min (los saltos de capítulo vuelven a pedir URL).
 * El «no» no se cachea: quien acaba de matricularse (o de recibir la clase por
 * el drip) debe poder ver el vídeo al instante, no un minuto después.
 */
const ALLOW_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 5_000;

/**
 * ¿Puede este usuario reproducir este vídeo de Bunny? Un vídeo es visible si
 * el usuario puede ver ALGÚN sitio de SU tenant donde aparece:
 *
 *  - el vídeo destacado de un curso publicado: es el escaparate del curso, lo
 *    ve cualquier usuario del aula (también quien aún no se ha matriculado);
 *  - una lección de un curso publicado cuyo contenido recibe: misma regla que
 *    enmascara el `content` en `GET /modules/courses/:id` (matrícula viva,
 *    drip, fecha de publicación y periodo de prueba). No se replica: se le
 *    pregunta a `lesson-content-gate`.
 *
 * Si no aparece en ningún sitio, no se sirve: conocer el GUID no basta. Y como
 * toda la búsqueda va filtrada por `tenant_id` (y por RLS debajo), que el vídeo
 * esté en una lección de OTRA academia del mismo servidor tampoco da acceso.
 *
 * Lecturas de tablas de mod.courses filtradas por tenant y sin escribir nada.
 */
@Injectable()
export class VideoAccessService {
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async canPlay(viewer: VideoViewer, guid: string): Promise<boolean> {
    // El GUID acaba dentro de un LIKE: fuera de su forma no se busca nada.
    if (!BUNNY_GUID_RE.test(guid)) return false;
    if (isCourseEditor(viewer.roles)) return true;

    const cacheKey = `${viewer.tenantId}:${viewer.userId}:${guid.toLowerCase()}`;
    const now = Date.now();
    const allowedUntil = this.cache.get(cacheKey);
    if (allowedUntil !== undefined && allowedUntil > now) return true;

    const allowed = await this.resolve(viewer, guid);
    if (!allowed) return false;
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.pruneCache(now);
    this.cache.set(cacheKey, now + ALLOW_TTL_MS);
    return true;
  }

  private async resolve(viewer: VideoViewer, guid: string): Promise<boolean> {
    const featured = await this.prisma.modCoursesCourse.findFirst({
      where: {
        tenantId: viewer.tenantId,
        deletedAt: null,
        status: 'PUBLISHED',
        featuredVideoUrl: { contains: guid, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (featured) return true;

    return this.canSeeInLessons(viewer, guid);
  }

  private async canSeeInLessons(viewer: VideoViewer, guid: string): Promise<boolean> {
    const { tenantId, userId } = viewer;
    // `content` es jsonb libre (`videoUrl`, `html` con iframes…): se busca el
    // GUID en el texto. Prisma 5 no filtra jsonb por subcadena sin distinguir
    // mayúsculas, de ahí la consulta cruda.
    //
    // Va en un `$transaction` por lotes y no suelta: la extensión de RLS solo
    // envuelve operaciones de MODELO; una consulta cruda suelta correría sin
    // `app.current_tenant_id` y, con RLS forzada, no vería ni una fila (todos
    // los alumnos recibirían un 403).
    const [matches] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ lessonId: string; courseId: string }>>`
        SELECT l.id AS "lessonId", m.course_id AS "courseId"
          FROM mod_courses_lesson l
          JOIN mod_courses_module m ON m.id = l.module_id
         WHERE l.tenant_id = ${tenantId}::uuid
           AND m.tenant_id = ${tenantId}::uuid
           AND l.deleted_at IS NULL
           AND m.deleted_at IS NULL
           AND l.content::text ILIKE ${`%${guid}%`}
         LIMIT 50`,
    ]);
    if (matches.length === 0) return false;

    const lessonsByCourse = new Map<string, string[]>();
    for (const m of matches) {
      lessonsByCourse.set(m.courseId, [...(lessonsByCourse.get(m.courseId) ?? []), m.lessonId]);
    }

    const learning = this.registry.getLearningService();
    for (const [courseId, lessonIds] of lessonsByCourse) {
      // Un alumno no ve cursos en borrador ni archivados, tampoco sus vídeos.
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: courseId, tenantId, deletedAt: null, status: 'PUBLISHED' },
        select: { id: true },
      });
      if (!course) continue;
      const gate = await resolveLessonContentGate(learning, tenantId, userId, courseId);
      if (lessonIds.some((lessonId) => lessonContentAllowed(gate, lessonId))) return true;
    }
    return false;
  }

  private pruneCache(now: number): void {
    for (const [k, until] of this.cache) if (until <= now) this.cache.delete(k);
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
  }
}
