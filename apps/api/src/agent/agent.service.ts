/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { CourseSlugAlreadyExistsError, CoursesError } from '@didacta/mod-courses';
import { createSessionSchema, ZoomLiveError } from '@didacta/mod-zoom-live';
import { ZodError, type z } from 'zod';
import type { SessionClaims } from '../auth/token.service';
import { blockedBy } from '../moderation/restriction-scopes';
import { RestrictionService } from '../moderation/restriction.service';
import { ModuleAccessInterceptor } from '../modules/module-access.interceptor';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  academyLocale,
  type AcademyDefaultsPrisma,
  type AcademyLocale,
} from '../common/academy-defaults';
import { isAgentScope } from './agent-scopes';
import {
  AGENT_TOOLS,
  type AgentTool,
  type AgentToolName,
  type createCommunityPostInput,
  type createCourseInput,
  type createLessonInput,
  findAgentTool,
  type getCourseInput,
  type listCoursesInput,
  type scheduleLiveClassInput,
  type updateCourseInput,
  type updateLessonInput,
} from './agent-tools';
import { AgentRateLimiter } from './agent-rate-limiter';

/**
 * Error que el agente PUEDE leer: el servidor MCP lo devuelve como resultado
 * de herramienta con `isError: true` (no como error de protocolo), para que
 * el agente se lo cuente a la persona o corrija la llamada.
 */
export class AgentToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

const ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin', 'tenant_admin']);

interface Owner {
  id: string;
  email: string;
  name: string | null;
  locale: string;
}

/** Enlace del curso a partir del título: misma regla que el «Nuevo curso» del modo sencillo. */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'curso';
}

/** ¿Tiene contenido la lección? Misma regla que el editor sencillo y «Empieza aquí». */
function lessonHasContent(type: string, content: unknown): boolean {
  const c = (content ?? {}) as Record<string, unknown>;
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (type === 'VIDEO') return has(c['videoUrl']);
  if (type === 'TEXT') return has(c['text']) || has(c['html']);
  if (type === 'PDF') return has(c['pdfUrl']);
  return Object.keys(c).length > 0;
}

/**
 * La PUERTA DE AGENTES: lo que un agente de IA puede hacer en un aula.
 *
 * No hay lógica de negocio propia: cada herramienta llama al MISMO servicio
 * público del módulo que usa el panel (cursos, directos, comunidad), con la
 * misma validación y el mismo saneado, y con el dueño de la clave como autor.
 * Es el patrón de `SimpleModeService`: infraestructura del host que orquesta
 * servicios de módulos a través de `ModuleRegistryService`.
 *
 * Por qué no `ctx.didacta` (la API de módulos del marketplace) como en la
 * puerta de VA360: aquella direcciona todo por `externalRef` y, a propósito,
 * no toca entidades que no creó ese mismo origen. Aquí el caso principal es el
 * contrario: «añade 5 lecciones al curso que acabo de crear a mano».
 *
 * El aula es SIEMPRE `user.tenantId`, que el `AgentKeyGuard` saca de la fila
 * de la clave. Ningún argumento de herramienta lleva tenant: un `courseId` de
 * otra aula simplemente no existe para esta (filtro explícito + RLS).
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly moduleAccess: ModuleAccessInterceptor,
    private readonly auditLog: PrismaAuditLogService,
    private readonly restrictions: RestrictionService,
    private readonly limiter: AgentRateLimiter,
  ) {}

  /** Herramientas que esta clave ve: las de sus scopes, de módulos activos en el aula. */
  async visibleTools(user: SessionClaims): Promise<AgentTool[]> {
    const scopes = new Set(user.roles.filter(isAgentScope));
    const out: AgentTool[] = [];
    for (const tool of AGENT_TOOLS) {
      if (!scopes.has(tool.scope)) continue;
      if (!(await this.moduleAccess.isEnabled(user.tenantId, tool.module))) continue;
      out.push(tool);
    }
    return out;
  }

  /** Nombre del aula, para el saludo del servidor MCP. */
  async academyName(tenantId: string): Promise<string | null> {
    const t = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { name: true },
    });
    return t?.name ?? null;
  }

  /**
   * Idioma del aula (es/en), para los textos que el servidor pone por su
   * cuenta, como el nombre por defecto de la clave del panel.
   */
  async academyLocale(tenantId: string): Promise<AcademyLocale> {
    return academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId);
  }

  async call(
    user: SessionClaims,
    apiKeyId: string,
    name: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const tool = findAgentTool(name);
    if (!tool) throw new AgentToolError('AGENT_TOOL_UNKNOWN', `Unknown tool: ${name}`);

    if (!user.roles.includes(tool.scope)) {
      throw new AgentToolError(
        'AGENT_SCOPE_MISSING',
        `This key does not have the "${tool.scope}" permission needed for ${name}. Create a new key from the "Do it faster with your AI agent" panel.`,
      );
    }
    if (!(await this.moduleAccess.isEnabled(user.tenantId, tool.module))) {
      throw new AgentToolError(
        'AGENT_MODULE_OFF',
        `This academy has ${tool.module} turned off, so ${name} is not available.`,
      );
    }

    const rate = await this.limiter.hit(apiKeyId);
    if (!rate.allowed) {
      throw new AgentToolError(
        'AGENT_RATE_LIMITED',
        `Too many calls with this key (limit ${rate.limit} per ${rate.window}). Wait ${rate.retryAfterSeconds} seconds and try again.`,
      );
    }

    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
        .join('; ');
      throw new AgentToolError(
        'AGENT_INVALID_ARGUMENTS',
        `Invalid arguments for ${name}: ${detail}`,
      );
    }

    // El dueño tiene que SEGUIR siendo administrador del aula: una clave de
    // alguien a quien le quitaron el rol deja de servir en ese momento.
    const owner = await this.requireOwner(user);

    try {
      const result = await this.dispatch(tool.name, user.tenantId, owner, parsed.data);
      if (tool.writes) await this.audit(user.tenantId, owner.id, apiKeyId, tool.name, result);
      return result;
    } catch (err) {
      throw this.toToolError(err);
    }
  }

  // ── Despacho ───────────────────────────────────────────────────────────────

  private dispatch(name: AgentToolName, tenantId: string, owner: Owner, args: unknown) {
    switch (name) {
      case 'list_courses':
        return this.listCourses(tenantId, args as z.infer<typeof listCoursesInput>);
      case 'get_course':
        return this.getCourse(tenantId, (args as z.infer<typeof getCourseInput>).courseId);
      case 'create_course':
        return this.createCourse(tenantId, owner, args as z.infer<typeof createCourseInput>);
      case 'update_course':
        return this.updateCourse(tenantId, owner, args as z.infer<typeof updateCourseInput>);
      case 'create_lesson':
        return this.createLesson(tenantId, owner, args as z.infer<typeof createLessonInput>);
      case 'update_lesson':
        return this.updateLesson(tenantId, owner, args as z.infer<typeof updateLessonInput>);
      case 'list_live_classes':
        return this.listLiveClasses(tenantId, owner);
      case 'schedule_live_class':
        return this.scheduleLiveClass(
          tenantId,
          owner,
          args as z.infer<typeof scheduleLiveClassInput>,
        );
      case 'list_community_spaces':
        return this.listSpaces(tenantId);
      case 'create_community_post':
        return this.createPost(tenantId, owner, args as z.infer<typeof createCommunityPostInput>);
    }
  }

  // ── Cursos y lecciones ─────────────────────────────────────────────────────

  private async listCourses(tenantId: string, args: z.infer<typeof listCoursesInput>) {
    const courses = (
      await this.registry.getCoursesService().listCourses(tenantId, { status: args.status })
    ).slice(0, 100);
    const lessons = courses.length
      ? await this.prisma.modCoursesLesson.findMany({
          where: {
            tenantId,
            deletedAt: null,
            module: { courseId: { in: courses.map((c) => c.id) }, deletedAt: null },
          },
          select: { module: { select: { courseId: true } } },
        })
      : [];
    const count = new Map<string, number>();
    for (const l of lessons) count.set(l.module.courseId, (count.get(l.module.courseId) ?? 0) + 1);
    return {
      courses: courses.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        lessons: count.get(c.id) ?? 0,
        editPath: `/studio/courses/${c.id}`,
      })),
    };
  }

  private async getCourse(tenantId: string, courseId: string) {
    const course = await this.registry.getCoursesService().getCourseDetail(tenantId, courseId);
    const lessons = course.modules.flatMap((m) => m.lessons);
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      status: course.status,
      editPath: `/studio/courses/${course.id}`,
      lessons: lessons.map((l, i) => ({
        id: l.id,
        number: i + 1,
        title: l.title,
        type: l.type,
        hasContent: lessonHasContent(l.type, l.content),
      })),
    };
  }

  private async createCourse(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof createCourseInput>,
  ) {
    const courses = this.registry.getCoursesService();
    const base = slugFromTitle(args.title);
    // Mismo criterio que el «Nuevo curso» del modo sencillo: si el enlace ya
    // existe, se prueba con -2, -3… El creador nunca ve el slug.
    for (let i = 1; i <= 20; i++) {
      try {
        const course = await courses.createCourse(tenantId, owner.id, {
          title: args.title,
          slug: i === 1 ? base : `${base}-${i}`,
          description: args.description || undefined,
          language: owner.locale.startsWith('en') ? 'en-US' : 'es-ES',
        });
        return {
          id: course.id,
          title: course.title,
          status: course.status,
          editPath: `/studio/courses/${course.id}`,
          note: 'Created as a draft. The owner publishes it with its price from "Start here".',
        };
      } catch (err) {
        if (!(err instanceof CourseSlugAlreadyExistsError)) throw err;
      }
    }
    throw new AgentToolError('AGENT_COURSE_SLUG', 'Could not find a free web address for it.');
  }

  private async updateCourse(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof updateCourseInput>,
  ) {
    const updated = await this.registry
      .getCoursesService()
      .updateCourse(tenantId, owner.id, args.courseId, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description || null } : {}),
      });
    return { id: updated.id, title: updated.title, status: updated.status };
  }

  private async createLesson(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof createLessonInput>,
  ) {
    const courses = this.registry.getCoursesService();
    const course = await courses.getCourseDetail(tenantId, args.courseId);
    // Al final del curso: en la última sección. En el modo sencillo hay una
    // sola (la crea el editor la primera vez, igual que aquí).
    let section = course.modules[course.modules.length - 1];
    if (!section) {
      section = {
        ...(await courses.createModule(tenantId, owner.id, course.id, {
          title: owner.locale.startsWith('en') ? 'Lessons' : 'Lecciones',
        })),
        lessons: [],
      };
    }
    const type = args.type === 'video' ? 'VIDEO' : 'TEXT';
    const content =
      args.type === 'video'
        ? args.videoUrl
          ? { videoUrl: args.videoUrl }
          : {}
        : args.text
          ? { text: args.text }
          : {};
    const lesson = await courses.createLesson(tenantId, owner.id, section.id, {
      type,
      title: args.title,
      content,
    });
    const number = course.modules.reduce((n, m) => n + m.lessons.length, 0) + 1;
    return {
      id: lesson.id,
      courseId: course.id,
      number,
      title: lesson.title,
      type,
      hasContent: lessonHasContent(type, content),
      editPath: `/studio/courses/${course.id}`,
    };
  }

  private async updateLesson(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof updateLessonInput>,
  ) {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: args.lessonId, deletedAt: null },
      select: { id: true, type: true, content: true },
    });
    if (!lesson) throw new AgentToolError('AGENT_NOT_FOUND', `Lesson not found: ${args.lessonId}`);
    if (args.text !== undefined && lesson.type !== 'TEXT') {
      throw new AgentToolError(
        'AGENT_WRONG_TYPE',
        `This is a ${lesson.type} lesson: it has no text.`,
      );
    }
    if (args.videoUrl !== undefined && lesson.type !== 'VIDEO') {
      throw new AgentToolError(
        'AGENT_WRONG_TYPE',
        `This is a ${lesson.type} lesson: it has no video link.`,
      );
    }
    const current = (lesson.content ?? {}) as Record<string, unknown>;
    const content =
      args.text !== undefined
        ? { ...current, text: args.text }
        : args.videoUrl !== undefined
          ? { ...current, videoUrl: args.videoUrl }
          : undefined;
    const updated = await this.registry
      .getCoursesService()
      .updateLesson(tenantId, owner.id, lesson.id, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(content ? { content } : {}),
      });
    return {
      id: updated.id,
      title: updated.title,
      type: updated.type,
      hasContent: lessonHasContent(updated.type, updated.content),
    };
  }

  // ── Directos ───────────────────────────────────────────────────────────────

  private async listLiveClasses(tenantId: string, owner: Owner) {
    const sessions = await this.registry
      .getZoomLiveService()
      .list(tenantId, { from: new Date() }, { userId: owner.id, isStaff: true });
    return {
      liveClasses: sessions
        .filter((s) => s.status !== 'CANCELLED')
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
        .slice(0, 20)
        .map((s) => ({
          id: s.id,
          title: s.topic,
          startTime: s.startTime,
          timezone: s.timezone,
          durationMinutes: s.durationMinutes,
          status: s.status,
          path: `/live/${s.id}`,
        })),
    };
  }

  private async scheduleLiveClass(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof scheduleLiveClassInput>,
  ) {
    // El mismo contrato que valida el panel (createSessionSchema del módulo):
    // aquí solo con enlace propio, así nunca se habla con la API de Zoom.
    const dto = createSessionSchema.parse({
      topic: args.title,
      startTime: args.startTime,
      durationMinutes: args.durationMinutes,
      timezone: args.timezone,
      hostEmail: owner.email,
      externalJoinUrl: args.joinUrl,
      ...(args.description ? { description: args.description } : {}),
      ...(args.courseId ? { courseId: args.courseId } : {}),
      announce: args.announce ?? false,
    });
    const s = await this.registry.getZoomLiveService().create(tenantId, owner.id, dto);
    return {
      id: s.id,
      title: s.topic,
      startTime: s.startTime,
      timezone: s.timezone,
      durationMinutes: s.durationMinutes,
      announced: args.announce ?? false,
      path: `/live/${s.id}`,
    };
  }

  // ── Comunidad ──────────────────────────────────────────────────────────────

  private async listSpaces(tenantId: string) {
    const spaces = await this.registry.getCommunityService().listSpaces(tenantId);
    return { spaces: spaces.map((s) => ({ slug: s.slug, title: s.title })) };
  }

  private async createPost(
    tenantId: string,
    owner: Owner,
    args: z.infer<typeof createCommunityPostInput>,
  ) {
    // Una sanción de comunidad al dueño de la clave también frena a su agente:
    // misma regla que la ruta `/community-api/posts` en el interceptor global.
    const active = await this.restrictions.activeRestrictions(tenantId, owner.id);
    for (const r of active) {
      const area = blockedBy(r.scopes, 'POST', '/community-api/posts');
      if (area) {
        throw new AgentToolError(
          'AGENT_OWNER_RESTRICTED',
          `The owner of this key cannot post in the community right now (${area}).`,
        );
      }
    }

    const svc = this.registry.getCommunityService();
    const spaces = await svc.listSpaces(tenantId);
    let space: string | null;
    if (args.space) {
      const match = spaces.find((s) => s.slug === args.space);
      if (!match) {
        throw new AgentToolError(
          'AGENT_SPACE_UNKNOWN',
          `Space "${args.space}" does not exist. Valid spaces: ${spaces.map((s) => s.slug).join(', ') || '(none)'}.`,
        );
      }
      space = match.slug;
    } else {
      space = spaces.find((s) => s.slug === 'general')?.slug ?? null;
    }
    const post = await svc.createPost(
      tenantId,
      { id: owner.id, displayName: owner.name ?? owner.email },
      {
        title: args.title,
        body: args.body,
        tags: space ? [space] : [],
        notifyAll: false,
        important: false,
      },
      'api',
    );
    return { id: post.id, title: post.title, space, path: `/community/${post.id}` };
  }

  // ── Apoyo ──────────────────────────────────────────────────────────────────

  private async requireOwner(user: SessionClaims): Promise<Owner> {
    const owner = await this.prisma.user.findFirst({
      where: { id: user.sub, tenantId: user.tenantId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        locale: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!owner || owner.status !== 'ACTIVE') {
      throw new AgentToolError(
        'AGENT_OWNER_GONE',
        'The person who created this key no longer has access.',
      );
    }
    if (!owner.roles.some((r) => ADMIN_ROLES.has(r.role.name))) {
      throw new AgentToolError(
        'AGENT_OWNER_NOT_ADMIN',
        'The person who created this key is no longer an administrator of the academy.',
      );
    }
    return { id: owner.id, email: owner.email, name: owner.name, locale: owner.locale };
  }

  private async audit(
    tenantId: string,
    actorId: string,
    apiKeyId: string,
    tool: AgentToolName,
    result: unknown,
  ): Promise<void> {
    const id = (result as { id?: unknown } | null)?.id;
    await this.auditLog.record({
      tenantId,
      actorId,
      action: `agent.${tool}`,
      resourceType: tool.includes('lesson')
        ? 'lesson'
        : tool.includes('course')
          ? 'course'
          : tool.includes('live')
            ? 'zoom_session'
            : 'community_post',
      resourceId: typeof id === 'string' ? id : 'unknown',
      metadata: { apiKeyId, via: 'mcp' },
    });
  }

  private toToolError(err: unknown): AgentToolError {
    if (err instanceof AgentToolError) return err;
    if (err instanceof CoursesError || err instanceof ZoomLiveError) {
      return new AgentToolError(err.code, err.message);
    }
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
        .join('; ');
      return new AgentToolError('AGENT_INVALID_ARGUMENTS', detail);
    }
    // Lo inesperado no se filtra al agente con detalles internos.
    return new AgentToolError('AGENT_INTERNAL', 'Unexpected error. Try again in a moment.');
  }
}
