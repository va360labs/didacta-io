# Plan: Eliminación de datos falsos e implementación con datos reales

> Generado: 2026-06-22 | Metodología: SDD (SpecBox Engine v6.11.0)
> Spec importado: 4 US · 14 UC · 61 AC → `docs/plans/` (FreeForm tracking)

## Contexto

Durante el rediseño de la UI se introdujeron datos hardcodeados en múltiples páginas de producción
(arrays `POSTS`, `GROUPS`, `MEMBERS`, `EVENTOS`, etc. con personas y contenido inventados).
Esto viola la regla 3 del CLAUDE.md: **PROHIBIDO usar datos falsos o de cartón**.

Este plan elimina todos esos datos y conecta cada sección con la API real o muestra un empty state
honesto donde la API aún no existe.

---

## Estado de las APIs (inventario previo al plan)

| Sección | Endpoint disponible | Estado |
|---|---|---|
| `/comunidad` (feed de posts) | `GET /api/v1/modules/community/posts` | ✅ Existe |
| `/cursos` | `GET /api/v1/modules/courses` | ✅ Existe |
| `/inicio/mi-panel` (enrollments) | `GET /api/v1/modules/learning/me/enrollments` | ✅ Existe |
| `/miembros` (admin) | `GET /api/v1/admin/users` | ✅ Existe (admin-only) |
| `/miembros` (público) | `GET /api/v1/community/members` | ❌ Falta → UC-010 |
| Panel stats de comunidad | `GET /api/v1/community/stats` | ❌ Falta → UC-009 |
| `/grupos` | `GET /api/v1/modules/groups` | ❌ Módulo no existe → UC-011 |
| `/leaderboard` | `GET /api/v1/leaderboard` | ❌ Falta → UC-012 |
| `/eventos` y `/calendario` | `GET /api/v1/events` | ❌ Módulo no existe → UC-013 |

---

## US-01 — Limpieza de datos falsos del frontend

**Estimación: 8h** | Prioridad: CRÍTICA (bloquea todo lo demás)

### UC-001 · Redirect `/inicio` → `/comunidad` y limpiar fake feed
**2h** | Actor: Sistema

`/inicio/page.tsx` tiene array `POSTS` con 5 posts ficticios y tabs hardcodeados.
La página real es `/comunidad/page.tsx` que usa `communityApi.listPosts()`.

**Aceptación:**
- [ ] `/inicio` redirige automáticamente a `/comunidad`
- [ ] No existe ningún `const POSTS` ni datos hardcodeados en `/inicio/page.tsx`
- [ ] El sidebar item "Feed de la comunidad" apunta a `/comunidad`
- [ ] Test Playwright para `/inicio` valida la redirección, no contenido fake

### UC-002 · Reemplazar fake data de `/inicio/mi-panel` con enrollments reales
**3h** | Actor: Alumno autenticado

La página tiene stats ficticias (4 cursos, 62% progreso, #3 leaderboard) y 3 grupos hardcodeados.
Existe `GET /api/v1/modules/learning/me/enrollments` para obtener matriculaciones reales.

**Aceptación:**
- [ ] Cursos en marcha → `GET /api/v1/modules/learning/me/enrollments`
- [ ] Progreso medio calculado desde datos reales de enrollments
- [ ] Sin array con datos ficticios de cursos o grupos
- [ ] Empty state "Aún no estás matriculado en ningún curso" si no hay enrollments
- [ ] Sección grupos → "Los grupos estarán disponibles próximamente"

### UC-003 · Eliminar grupos hardcodeados del sidebar
**1h** | Actor: Sistema

`buildGroups()` en `apps/web/src/app/(app)/layout.tsx` tiene 3 grupos ficticios
(Cohorte Mar 25, Mentoría avanzada, Proyecto final) con avatares de colores inventados.

**Aceptación:**
- [ ] No existen items hardcodeados de grupos en `buildGroups()`
- [ ] El grupo "Grupos" en el sidebar muestra un único link a `/grupos`
- [ ] Sin avatares con colores hardcodeados para grupos inexistentes

---

## US-02 — Empty states honestos para secciones sin API

**Estimación: 10h** | Prioridad: ALTA

### UC-004 · Empty state en `/grupos` y `/grupos/[id]`
**2h** | Bloqueado por: UC-011 (módulo grupos backend)

**Aceptación:**
- [ ] Sin arrays `GROUPS` ni `GROUP_META` hardcodeados
- [ ] `/grupos` muestra heading "Grupos" + tabs "Mis grupos" / "Explorar" + empty state
- [ ] `/grupos/[id]` muestra "Grupo no encontrado" para slugs inexistentes
- [ ] Tests Playwright actualizados (no buscan "Cohorte · Marzo 2025" ni fake content)

### UC-005 · Empty state en `/leaderboard`
**1h** | Bloqueado por: UC-012 (endpoint leaderboard backend)

**Aceptación:**
- [ ] Sin array `ENTRIES` con puntos ficticios
- [ ] Página muestra heading "Leaderboard" + empty state informativo
- [ ] Test Playwright actualizado

### UC-006 · Empty state en `/eventos` y `/calendario` sin fake data
**2h** | Bloqueado por: UC-013 (módulo eventos backend)

**Aceptación:**
- [ ] Sin arrays `EVENTOS` ni `EVENTS` hardcodeados
- [ ] `/calendario` muestra el mes actual dinámico (no hardcodeado a marzo 2025)
- [ ] `/eventos` muestra heading + empty state
- [ ] Tests Playwright verifican solo estructura del grid, no eventos específicos

### UC-007 · Directorio `/miembros`: datos reales para admin, empty state para alumno
**2h** | Parcialmente desbloqueado (admin API existe)

**Aceptación:**
- [ ] Sin array `MEMBERS` con 12 personas ficticias
- [ ] Rol admin: llama a `GET /api/v1/admin/users` y lista usuarios reales
- [ ] Rol alumno: empty state hasta que exista UC-010
- [ ] Tests Playwright verifican heading y estructura, no nombres ficticios

### UC-008 · Verificar y limpiar `/mensajes` y `/espacios/[space]`
**3h** | Actor: Alumno autenticado

**Aceptación:**
- [ ] Sin mensajes ficticios hardcodeados en `/mensajes`
- [ ] Sin posts ficticios hardcodeados en `/espacios/[space]`
- [ ] `/espacios/[space]` usa `communityApi.listPosts()` con filtro, o empty state
- [ ] Tests Playwright actualizados para ambas páginas

---

## US-03 — APIs faltantes en el backend NestJS

**Estimación: 23h** | Prioridad: MEDIA (desbloqueante para US-02)
**⚠️ Requiere aprobación antes de implementar cada UC**

### UC-009 · `GET /api/v1/community/stats` — estadísticas públicas del tenant
**3h**

```
GET /api/v1/community/stats
Authorization: Bearer <jwt-cualquier-rol>
→ { members: number, activeCourses: number, activeGroups: number }
```

### UC-010 · `GET /api/v1/community/members` — directorio público paginado
**4h**

```
GET /api/v1/community/members?page=1&limit=20&search=
Authorization: Bearer <jwt-cualquier-rol>
→ { members: [{ id, displayName, roles, avatarUrl? }], total: number }
```
No exponer: email, passwordHash ni datos sensibles.

### UC-011 · Módulo de grupos básico — CRUD y membresía
**8h** — Módulo completo desde cero

```
GET  /api/v1/modules/groups          → lista grupos del tenant (paginada)
GET  /api/v1/modules/groups/:id      → detalle del grupo
GET  /api/v1/modules/groups/me       → grupos del usuario autenticado
POST /api/v1/modules/groups/:id/join → unirse a un grupo
```

Tablas nuevas en BD:
- `groups`: id, tenantId, name, slug, description, memberCount, createdAt
- `group_members`: groupId, userId, joinedAt, role

### UC-012 · `GET /api/v1/leaderboard` — ranking de usuarios
**4h**

```
GET /api/v1/leaderboard?range=week|month|all
Authorization: Bearer <jwt-cualquier-rol>
→ [{ userId, displayName, points, rank, streak? }]
```
Puntos calculados desde: posts creados, comentarios, lecciones completadas.

### UC-013 · Módulo de eventos básico — listado, detalle e inscripción
**8h** — Módulo completo desde cero

```
GET  /api/v1/events?from=&to=      → lista eventos en rango de fechas
GET  /api/v1/events/:id            → detalle del evento
POST /api/v1/events/:id/register   → inscribirse a un evento
```

Tablas nuevas en BD:
- `events`: id, tenantId, title, startAt, endAt, capacity, description
- `event_registrations`: eventId, userId, registeredAt

---

## US-04 — Tests E2E actualizados a datos reales

**Estimación: 4h** | Ejecutar tras completar US-01 + US-02

### UC-014 · Reescribir `redesign-smoke.spec.ts` sin referencias a datos fake
**4h** | Actor: QA

Referencias a eliminar: "Marta Ruiz", "Diego Salas", "Carla Núñez", "¡Gracias Diego!",
"Plantilla caso práctico SBI", posts ficticios específicos, etc.

**Aceptación:**
- [ ] Ningún test busca nombres de personas inventadas
- [ ] Ningún test busca texto de posts ficticios
- [ ] `/comunidad`: heading visible, compositor visible, filtros de tag
- [ ] `/grupos`: heading visible, tabs "Mis grupos"/"Explorar", empty state correcto
- [ ] `/calendario`: grid del mes actual, navegación entre meses funciona
- [ ] `/miembros`: heading visible, buscador visible
- [ ] 10/10 tests pasan con el servidor en marcha

---

## Orden de ejecución recomendado

```
Fase 1 (inmediata — no necesita backend nuevo):
  UC-001 → UC-002 → UC-003   [limpiar fake data, redirigir, sidebar]
  UC-004 → UC-005 → UC-006 → UC-007 → UC-008   [empty states]
  UC-014   [actualizar tests Playwright]

Fase 2 (requiere aprobación del usuario):
  UC-009   [stats públicas — 3h, impacto bajo, añadir endpoint al módulo community]
  UC-010   [directorio miembros — 4h, añadir endpoint al módulo community]
  UC-012   [leaderboard — 4h, endpoint nuevo en core]

Fase 3 (módulos nuevos — mayor impacto):
  UC-011   [módulo grupos — 8h, BD + API + migraciones]
  UC-013   [módulo eventos — 8h, BD + API + migraciones]
```

La Fase 1 se puede ejecutar inmediatamente. Las Fases 2 y 3 requieren que el usuario
apruebe la creación de nuevas tablas/migraciones en la BD.

---

## Archivos afectados (Fase 1)

| Archivo | UC | Cambio |
|---|---|---|
| `apps/web/src/app/(app)/inicio/page.tsx` | UC-001 | Reemplazar por redirect a `/comunidad` |
| `apps/web/src/app/(app)/inicio/mi-panel/page.tsx` | UC-002 | Usar real enrollments API |
| `apps/web/src/app/(app)/layout.tsx` | UC-003 | Eliminar 3 grupos hardcodeados de `buildGroups()` |
| `apps/web/src/app/(app)/grupos/page.tsx` | UC-004 | Eliminar array `GROUPS`, empty state |
| `apps/web/src/app/(app)/grupos/[id]/page.tsx` | UC-004 | Eliminar `GROUP_META`, "Grupo no encontrado" |
| `apps/web/src/app/(app)/leaderboard/page.tsx` | UC-005 | Eliminar array `ENTRIES`, empty state |
| `apps/web/src/app/(app)/eventos/page.tsx` | UC-006 | Eliminar array `EVENTOS`, empty state |
| `apps/web/src/app/(app)/calendario/page.tsx` | UC-006 | Eliminar `EVENTS`, mes dinámico |
| `apps/web/src/app/(app)/miembros/page.tsx` | UC-007 | Eliminar array `MEMBERS`, usar admin API |
| `apps/web/src/app/(app)/mensajes/page.tsx` | UC-008 | Verificar y limpiar |
| `apps/web/src/app/(app)/espacios/[space]/page.tsx` | UC-008 | Usar `communityApi.listPosts()` |
| `apps/e2e/tests/redesign-smoke.spec.ts` | UC-014 | Reescribir sin referencias a fake data |
