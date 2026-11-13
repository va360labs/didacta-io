/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { CourseNotFoundError, CourseSlugAlreadyExistsError } from '@didacta/mod-courses';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRateLimiter } from '../src/agent/agent-rate-limiter';
import { AGENT_SCOPES, PANEL_AGENT_SCOPES } from '../src/agent/agent-scopes';
import { AGENT_TOOLS, AGENT_UI_NAMES, localizeAgentText } from '../src/agent/agent-tools';
import { AgentService, slugFromTitle } from '../src/agent/agent.service';
import { ALLOWED_API_KEY_SCOPES, grantableApiKeyScopes } from '../src/auth/api-key-scopes';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Cada herramienta de la puerta de agentes, con los servicios de los módulos
 * falsos: qué servicio llama, con qué aula y con qué datos, y qué rechaza.
 * El aislamiento REAL entre aulas (RLS con `didacta_app`) está en
 * `tests/integration/agent-mcp-rls.integration.test.ts`.
 */

const TENANT = 'tenant-A';
const OWNER = 'owner-a';
const COURSE = '11111111-1111-4111-8111-111111111111';
const LESSON = '22222222-2222-4222-8222-222222222222';

function user(roles: string[] = [...PANEL_AGENT_SCOPES]): SessionClaims {
  return { sub: OWNER, tenantId: TENANT, roles, mfaVerified: true };
}

const ownerRow = {
  id: OWNER,
  email: 'hello@aula-a.example.com',
  name: 'Aula A',
  locale: 'en-US',
  status: 'ACTIVE',
  roles: [{ role: { name: 'tenant_admin' } }],
};

let courses: Record<string, ReturnType<typeof vi.fn>>;
let zoom: Record<string, ReturnType<typeof vi.fn>>;
let community: Record<string, ReturnType<typeof vi.fn>>;
let prisma: {
  user: { findFirst: ReturnType<typeof vi.fn> };
  tenant: { findFirst: ReturnType<typeof vi.fn> };
  modCoursesLesson: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};
let enabled: Set<string>;
let audit: { record: ReturnType<typeof vi.fn> };
let restrictions: { activeRestrictions: ReturnType<typeof vi.fn> };
let limiter: AgentRateLimiter;
let service: AgentService;

beforeEach(() => {
  courses = {
    listCourses: vi.fn(async () => [
      { id: COURSE, title: 'Espresso at Home', status: 'DRAFT' },
      { id: 'c2', title: 'Latte Art', status: 'PUBLISHED' },
    ]),
    getCourseDetail: vi.fn(async () => ({
      id: COURSE,
      title: 'Espresso at Home',
      description: null,
      status: 'DRAFT',
      modules: [
        {
          id: 'm1',
          lessons: [
            { id: 'l1', title: 'Beans', type: 'TEXT', content: { text: 'hola' } },
            { id: 'l2', title: 'Grind', type: 'VIDEO', content: {} },
          ],
        },
      ],
    })),
    createCourse: vi.fn(async (_t: string, _a: string, dto: { title: string; slug: string }) => ({
      id: 'nuevo',
      title: dto.title,
      slug: dto.slug,
      status: 'DRAFT',
    })),
    updateCourse: vi.fn(async () => ({ id: COURSE, title: 'Nuevo', status: 'DRAFT' })),
    createModule: vi.fn(async () => ({ id: 'm-nuevo' })),
    createLesson: vi.fn(async (_t: string, _a: string, _m: string, dto: { title: string }) => ({
      id: 'lec-nueva',
      title: dto.title,
    })),
    updateLesson: vi.fn(async () => ({
      id: LESSON,
      title: 'T',
      type: 'TEXT',
      content: { text: 'x' },
    })),
  };
  zoom = {
    list: vi.fn(async () => [
      { id: 's2', topic: 'B', startTime: '2026-12-02T18:00:00Z', status: 'SCHEDULED' },
      { id: 's1', topic: 'A', startTime: '2026-12-01T18:00:00Z', status: 'SCHEDULED' },
      { id: 's0', topic: 'X', startTime: '2026-11-30T18:00:00Z', status: 'CANCELLED' },
    ]),
    create: vi.fn(async (_t: string, _a: string, dto: { topic: string; startTime: string }) => ({
      id: 'ses',
      topic: dto.topic,
      startTime: dto.startTime,
      timezone: 'Europe/Madrid',
      durationMinutes: 60,
    })),
  };
  community = {
    listSpaces: vi.fn(async () => [
      { slug: 'general', title: 'General' },
      { slug: 'anuncios', title: 'Anuncios' },
    ]),
    createPost: vi.fn(async (_t: string, _a: unknown, dto: { title: string }) => ({
      id: 'post',
      title: dto.title,
    })),
  };
  prisma = {
    user: { findFirst: vi.fn(async () => ownerRow) },
    tenant: { findFirst: vi.fn(async () => ({ name: 'Aula A' })) },
    modCoursesLesson: {
      findMany: vi.fn(async () => [
        { module: { courseId: COURSE } },
        { module: { courseId: COURSE } },
      ]),
      findFirst: vi.fn(async () => ({
        id: LESSON,
        type: 'TEXT',
        content: { text: 'viejo', extra: 1 },
      })),
    },
  };
  enabled = new Set(['mod.courses', 'mod.zoom-live', 'mod.community']);
  audit = { record: vi.fn(async () => undefined) };
  restrictions = { activeRestrictions: vi.fn(async () => []) };
  limiter = new AgentRateLimiter(null);
  const registry = {
    getCoursesService: () => courses,
    getZoomLiveService: () => zoom,
    getCommunityService: () => community,
  };
  service = new AgentService(
    prisma as never,
    registry as never,
    { isEnabled: async (_t: string, m: string) => enabled.has(m) } as never,
    audit as never,
    restrictions as never,
    limiter,
  );
});

describe('catálogo', () => {
  it('cada herramienta tiene un scope de agente y el JSON Schema pide lo mismo que zod', () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_SCOPES).toContain(tool.scope);
      const required = (tool.inputSchema['required'] as string[] | undefined) ?? [];
      const props = Object.keys(tool.inputSchema['properties'] as object);
      // Lo requerido existe como propiedad, y sin ello zod rechaza.
      for (const r of required) {
        expect(props).toContain(r);
      }
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  it('ninguna herramienta borra, cobra, pone precio, publica ni invita', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.name).not.toMatch(/delete|remove|price|publish|invite|enroll|refund|charge/);
    }
  });

  it('los scopes de agente están en el catálogo y el guard los conserva', () => {
    for (const s of AGENT_SCOPES) expect(ALLOWED_API_KEY_SCOPES).toContain(s);
    expect(grantableApiKeyScopes([...AGENT_SCOPES, 'tenant_admin'])).toEqual([...AGENT_SCOPES]);
  });

  it('slug a partir del título, como el «Nuevo curso» del modo sencillo', () => {
    expect(slugFromTitle('Café en Casa: ¡Básico!')).toBe('cafe-en-casa-basico');
    expect(slugFromTitle('¿¿??')).toBe('curso');
  });
});

describe('puertas comunes a todas las herramientas', () => {
  it('herramienta desconocida', async () => {
    await expect(service.call(user(), 'k', 'drop_database', {})).rejects.toMatchObject({
      code: 'AGENT_TOOL_UNKNOWN',
    });
  });

  it('sin el scope de la herramienta: se niega y no llama al servicio', async () => {
    await expect(
      service.call(user(['agent:courses:read']), 'k', 'create_course', { title: 'X' }),
    ).rejects.toMatchObject({ code: 'AGENT_SCOPE_MISSING' });
    expect(courses.createCourse).not.toHaveBeenCalled();
  });

  it('los nombres de pantalla de las herramientas salen en el idioma del aula', async () => {
    const descripcion = async () =>
      (await service.visibleTools(user())).find((t) => t.name === 'create_course')!.description;
    // Sin ajuste ni perfil legible: español.
    expect(await descripcion()).toContain('from "Empieza aquí"');
    Object.assign(prisma, {
      tenantSetting: {
        findUnique: vi.fn(
          async (q: { where: { tenantId_moduleName_key: { moduleName: string; key: string } } }) =>
            q.where.tenantId_moduleName_key.moduleName === 'academy' ? { valueJson: 'en' } : null,
        ),
      },
    });
    const en = await descripcion();
    expect(en).toContain('from "Start here"');
    for (const tool of await service.visibleTools(user())) {
      expect(tool.description, tool.name).not.toContain('{{ui:');
    }
    // El catálogo de origen no se toca: cada aula localiza su copia.
    expect(AGENT_TOOLS.find((t) => t.name === 'create_course')!.description).toContain(
      '{{ui:startHere}}',
    );
  });

  it('localizeAgentText: los dos idiomas, y una marca desconocida se deja tal cual', () => {
    expect(localizeAgentText('from "{{ui:startHere}}"', 'es')).toBe('from "Empieza aquí"');
    expect(localizeAgentText('the "{{ui:agentPanel}}" panel', 'en')).toBe(
      `the "${AGENT_UI_NAMES.agentPanel.en}" panel`,
    );
    expect(localizeAgentText('{{ui:nope}}', 'es')).toBe('{{ui:nope}}');
  });

  it('módulo apagado en el aula: ni se ve ni se usa', async () => {
    enabled.delete('mod.zoom-live');
    const visible = (await service.visibleTools(user())).map((t) => t.name);
    expect(visible).not.toContain('schedule_live_class');
    await expect(service.call(user(), 'k', 'list_live_classes', {})).rejects.toMatchObject({
      code: 'AGENT_MODULE_OFF',
    });
  });

  it('argumentos inválidos o con campos de más (p. ej. tenantId): se rechaza', async () => {
    await expect(
      service.call(user(), 'k', 'create_course', { title: 'X', tenantId: 'tenant-B' }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
    await expect(
      service.call(user(), 'k', 'get_course', { courseId: 'no-uuid' }),
    ).rejects.toMatchObject({
      code: 'AGENT_INVALID_ARGUMENTS',
    });
    expect(courses.createCourse).not.toHaveBeenCalled();
  });

  it('el dueño de la clave ya no es admin, o ya no está: se niega', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({
      ...ownerRow,
      roles: [{ role: { name: 'alumno' } }],
    });
    await expect(service.call(user(), 'k', 'list_courses', {})).rejects.toMatchObject({
      code: 'AGENT_OWNER_NOT_ADMIN',
    });
    prisma.user.findFirst.mockResolvedValueOnce({ ...ownerRow, status: 'SUSPENDED' });
    await expect(service.call(user(), 'k', 'list_courses', {})).rejects.toMatchObject({
      code: 'AGENT_OWNER_GONE',
    });
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(service.call(user(), 'k', 'list_courses', {})).rejects.toMatchObject({
      code: 'AGENT_OWNER_GONE',
    });
    // Siempre se busca al dueño EN el aula de la clave.
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OWNER, tenantId: TENANT, deletedAt: null } }),
    );
  });

  it('límite por clave: la llamada 61 del minuto se niega; otra clave sigue', async () => {
    for (let i = 0; i < 60; i++) await service.call(user(), 'k1', 'list_courses', {});
    await expect(service.call(user(), 'k1', 'list_courses', {})).rejects.toMatchObject({
      code: 'AGENT_RATE_LIMITED',
    });
    await expect(service.call(user(), 'k2', 'list_courses', {})).resolves.toBeDefined();
  });

  it('un error inesperado no filtra detalles internos', async () => {
    courses.listCourses!.mockRejectedValueOnce(new Error('password=hunter2 en la conexión'));
    await expect(service.call(user(), 'k', 'list_courses', {})).rejects.toMatchObject({
      code: 'AGENT_INTERNAL',
      message: expect.not.stringContaining('hunter2'),
    });
  });
});

describe('cursos y lecciones', () => {
  it('list_courses: del aula de la clave, con nº de lecciones', async () => {
    const r = (await service.call(user(), 'k', 'list_courses', { status: 'DRAFT' })) as {
      courses: Array<{ id: string; lessons: number }>;
    };
    expect(courses.listCourses).toHaveBeenCalledWith(TENANT, { status: 'DRAFT' });
    expect(r.courses.find((c) => c.id === COURSE)?.lessons).toBe(2);
    expect(r.courses.find((c) => c.id === 'c2')?.lessons).toBe(0);
  });

  it('get_course: lecciones numeradas y si tienen contenido', async () => {
    const r = (await service.call(user(), 'k', 'get_course', { courseId: COURSE })) as {
      lessons: Array<{ number: number; hasContent: boolean }>;
    };
    expect(courses.getCourseDetail).toHaveBeenCalledWith(TENANT, COURSE);
    expect(r.lessons).toEqual([
      expect.objectContaining({ number: 1, hasContent: true }),
      expect.objectContaining({ number: 2, hasContent: false }),
    ]);
  });

  it('create_course: borrador, slug del título y -2 si ya existe; idioma del dueño; auditado', async () => {
    courses.createCourse!.mockRejectedValueOnce(
      new CourseSlugAlreadyExistsError('espresso-at-home'),
    );
    const r = (await service.call(user(), 'key-1', 'create_course', {
      title: 'Espresso at Home',
      description: 'From bean to cup',
    })) as { id: string; status: string; note: string };
    // La nota cita la pantalla con el nombre del aula (aquí, sin ajuste: español).
    expect(r.note).toBe(
      'Created as a draft. The owner publishes it with its price from "Empieza aquí".',
    );
    expect(courses.createCourse).toHaveBeenLastCalledWith(TENANT, OWNER, {
      title: 'Espresso at Home',
      slug: 'espresso-at-home-2',
      description: 'From bean to cup',
      language: 'en-US',
    });
    expect(r.status).toBe('DRAFT');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: OWNER,
        action: 'agent.create_course',
        resourceId: 'nuevo',
        metadata: { apiKeyId: 'key-1', via: 'mcp' },
      }),
    );
  });

  it('update_course: solo título y descripción (nunca estado ni precio)', async () => {
    await service.call(user(), 'k', 'update_course', { courseId: COURSE, title: 'Nuevo' });
    expect(courses.updateCourse).toHaveBeenCalledWith(TENANT, OWNER, COURSE, { title: 'Nuevo' });
    await expect(
      service.call(user(), 'k', 'update_course', { courseId: COURSE, status: 'PUBLISHED' }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
  });

  it('create_lesson: al final del curso; texto como {text} y vídeo como {videoUrl}', async () => {
    const r = (await service.call(user(), 'k', 'create_lesson', {
      courseId: COURSE,
      title: 'Tamping',
      type: 'text',
      text: 'Press evenly.',
    })) as { number: number };
    expect(courses.createLesson).toHaveBeenCalledWith(TENANT, OWNER, 'm1', {
      type: 'TEXT',
      title: 'Tamping',
      content: { text: 'Press evenly.' },
    });
    expect(r.number).toBe(3);

    await service.call(user(), 'k', 'create_lesson', {
      courseId: COURSE,
      title: 'Demo',
      type: 'video',
      videoUrl: 'https://vimeo.com/123',
    });
    expect(courses.createLesson).toHaveBeenLastCalledWith(TENANT, OWNER, 'm1', {
      type: 'VIDEO',
      title: 'Demo',
      content: { videoUrl: 'https://vimeo.com/123' },
    });
  });

  it('create_lesson: sin secciones, crea «Lessons» (idioma del dueño) como el editor sencillo', async () => {
    courses.getCourseDetail!.mockResolvedValueOnce({ id: COURSE, modules: [] });
    await service.call(user(), 'k', 'create_lesson', {
      courseId: COURSE,
      title: 'A',
      type: 'text',
    });
    expect(courses.createModule).toHaveBeenCalledWith(TENANT, OWNER, COURSE, { title: 'Lessons' });
    expect(courses.createLesson).toHaveBeenCalledWith(TENANT, OWNER, 'm-nuevo', expect.anything());
  });

  it('create_lesson: vídeo sin https o texto en una de vídeo → inválido', async () => {
    await expect(
      service.call(user(), 'k', 'create_lesson', {
        courseId: COURSE,
        title: 'A',
        type: 'video',
        videoUrl: 'http://inseguro.example.com/v',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
    await expect(
      service.call(user(), 'k', 'create_lesson', {
        courseId: COURSE,
        title: 'A',
        type: 'video',
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
  });

  it('un curso de otra aula «no existe» (el servicio lo busca con el aula de la clave)', async () => {
    courses.getCourseDetail!.mockRejectedValueOnce(new CourseNotFoundError(COURSE));
    await expect(
      service.call(user(), 'k', 'create_lesson', { courseId: COURSE, title: 'A', type: 'text' }),
    ).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });
    expect(courses.getCourseDetail).toHaveBeenCalledWith(TENANT, COURSE);
    expect(courses.createLesson).not.toHaveBeenCalled();
  });

  it('update_lesson: conserva el resto del contenido y no mezcla tipos', async () => {
    await service.call(user(), 'k', 'update_lesson', { lessonId: LESSON, text: 'nuevo' });
    expect(prisma.modCoursesLesson.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, id: LESSON, deletedAt: null } }),
    );
    expect(courses.updateLesson).toHaveBeenCalledWith(TENANT, OWNER, LESSON, {
      content: { text: 'nuevo', extra: 1 },
    });
    await expect(
      service.call(user(), 'k', 'update_lesson', {
        lessonId: LESSON,
        videoUrl: 'https://x.example.com',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_WRONG_TYPE' });
    prisma.modCoursesLesson.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.call(user(), 'k', 'update_lesson', { lessonId: LESSON, title: 'x' }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });
});

describe('directos', () => {
  it('list_live_classes: próximas, en orden y sin canceladas', async () => {
    const r = (await service.call(user(), 'k', 'list_live_classes', {})) as {
      liveClasses: Array<{ id: string }>;
    };
    expect(r.liveClasses.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(zoom.list).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ from: expect.any(Date) }),
      {
        userId: OWNER,
        isStaff: true,
      },
    );
  });

  it('schedule_live_class: con el enlace propio (nunca la API de Zoom) y el dueño como anfitrión', async () => {
    await service.call(user(), 'k', 'schedule_live_class', {
      title: 'Q&A',
      startTime: '2026-11-24T19:00:00+01:00',
      durationMinutes: 60,
      timezone: 'Europe/Madrid',
      joinUrl: 'https://meet.example.com/abc',
    });
    expect(zoom.create).toHaveBeenCalledWith(
      TENANT,
      OWNER,
      expect.objectContaining({
        topic: 'Q&A',
        hostEmail: 'hello@aula-a.example.com',
        externalJoinUrl: 'https://meet.example.com/abc',
        announce: false,
      }),
    );
  });

  it('schedule_live_class: zona horaria inventada o enlace no https → inválido', async () => {
    const base = {
      title: 'Q&A',
      startTime: '2026-11-24T19:00:00+01:00',
      durationMinutes: 60,
      joinUrl: 'https://meet.example.com/abc',
    };
    await expect(
      service.call(user(), 'k', 'schedule_live_class', { ...base, timezone: 'Marte/Olympus' }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
    await expect(
      service.call(user(), 'k', 'schedule_live_class', {
        ...base,
        timezone: 'Europe/Madrid',
        joinUrl: 'http://meet.example.com/abc',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INVALID_ARGUMENTS' });
    expect(zoom.create).not.toHaveBeenCalled();
  });
});

describe('comunidad', () => {
  it('create_community_post: espacio como primer tag, origen api y sin aviso por correo', async () => {
    await service.call(user(), 'k', 'create_community_post', {
      title: 'Welcome!',
      body: 'Hi all',
      space: 'anuncios',
    });
    expect(community.createPost).toHaveBeenCalledWith(
      TENANT,
      { id: OWNER, displayName: 'Aula A' },
      { title: 'Welcome!', body: 'Hi all', tags: ['anuncios'], notifyAll: false, important: false },
      'api',
    );
  });

  it('sin espacio va a «general»; un espacio que no existe se dice con los válidos', async () => {
    await service.call(user(), 'k', 'create_community_post', { title: 'Welcome!', body: 'Hi' });
    expect(community.createPost).toHaveBeenLastCalledWith(
      TENANT,
      expect.anything(),
      expect.objectContaining({ tags: ['general'] }),
      'api',
    );
    await expect(
      service.call(user(), 'k', 'create_community_post', {
        title: 'Hey!',
        body: 'x',
        space: 'nope',
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_SPACE_UNKNOWN',
      message: expect.stringContaining('general'),
    });
  });

  it('dueño sancionado en comunidad: su agente tampoco publica', async () => {
    restrictions.activeRestrictions.mockResolvedValueOnce([
      { id: 'r', scopes: ['community'], reason: 'spam', expiresAt: null },
    ]);
    await expect(
      service.call(user(), 'k', 'create_community_post', { title: 'Welcome!', body: 'Hi' }),
    ).rejects.toMatchObject({ code: 'AGENT_OWNER_RESTRICTED' });
    expect(community.createPost).not.toHaveBeenCalled();
  });
});

describe('AgentRateLimiter', () => {
  it('con Redis cuenta en Redis (compartido entre réplicas)', async () => {
    const counts = new Map<string, number>();
    const redis = {
      incr: vi.fn(async (k: string) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      }),
      expire: vi.fn(async () => 1),
    };
    const l = new AgentRateLimiter(redis);
    const now = Date.UTC(2026, 10, 13, 10, 0, 30);
    for (let i = 0; i < l.perMinute; i++) expect((await l.hit('k', now)).allowed).toBe(true);
    const no = await l.hit('k', now);
    expect(no).toMatchObject({ allowed: false, window: 'minute', retryAfterSeconds: 30 });
    expect(redis.expire).toHaveBeenCalled();
  });

  it('con Redis caído no abre la puerta: cuenta en memoria', async () => {
    const redis = {
      incr: vi.fn(async () => {
        throw new Error('down');
      }),
      expire: vi.fn(),
    };
    const l = new AgentRateLimiter(redis);
    const now = Date.UTC(2026, 10, 13, 10, 0, 0);
    for (let i = 0; i < l.perMinute; i++) await l.hit('k', now);
    expect((await l.hit('k', now)).allowed).toBe(false);
  });
});
