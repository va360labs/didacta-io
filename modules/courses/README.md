# mod.courses

Módulo de gestión de cursos (catálogo, módulos, lecciones).

## Estado

Fase 1.A — backend listo (CRUD, publicación con hook abierto). Falta wiring en `apps/api` (controller HTTP) y UI en `apps/web` para el formador.

## Modelos (Prisma `mod_courses_*`)

- `mod_courses_course` — curso con `slug`, `title`, `status` (DRAFT/PUBLISHED/ARCHIVED)
- `mod_courses_module` — agrupación dentro de un curso, posición ordenada
- `mod_courses_lesson` — `type` (VIDEO/HTML/PDF/TEXT/QUIZ), `content` JSONB

## Hook expuesto: `courses.publish.validate`

Permite a otros módulos (típicamente `mod.fundae`) bloquear la publicación añadiendo razones al array `reasons` recibido por contexto:

```ts
ctx.hookRegistry.register<{ courseId: string; reasons: string[] }>(
  'courses.publish.validate',
  async ({ input }) => {
    if (!hasObjective(input.courseId)) input.reasons.push('Falta objetivo Fundae');
  },
);
```

Si al final del hook hay razones, `CoursesService.publishCourse` lanza `PublishValidationError`.

## Eventos emitidos

- `courses.course.created`
- `courses.course.updated`
- `courses.course.published`
- `courses.course.archived`
- `courses.module.created`
- `courses.lesson.created`

Todos con metadata estándar (`tenantId`, `traceId`, `idempotencyKey`).

## Próximos PRs

- Controller HTTP en `apps/api` consumiendo este service
- UI editor del formador en `apps/web`
- Wiring del módulo en el ModuleRegistry de la app
