# mod.access-groups

Grupos de acceso configurables: el entitlement de "qué cursos puede ver un miembro" como pieza componible. Un grupo otorga un SET de cursos (todos, uno o varios) y el acceso se materializa como matrículas del core con provenance y refcount para revocación segura.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Estable. El vertical existía en el host desde la Fase 2 de grupos; formalizado como módulo en la fase F6 de captación (2026-08), que además introdujo el origen `MEMBERSHIP` para las membresías concedidas por la membresía de pago. El host NestJS (controller, service Prisma y bridges de eventos) vive en `apps/api/src/modules/access-groups/` (módulo first-party built-in, ADR-011/015/016).

## Resumen funcional

- El admin define grupos con tres `kind`: **ALL_COURSES** (membresía = todos los cursos publicados, con `autoGrantNewCourses` para matricular en cada curso nuevo), **COURSE** y **MULTI_COURSE** (set explícito).
- El acceso se **materializa** como enrollments del core (`source = GROUP`) vía `mod.learning` — nunca Prisma directo a tablas de otro módulo. `mod_access_groups_grant` lleva el provenance/refcount: un curso solo se desmatricula cuando ningún grupo vivo lo otorga, y jamás se tocan matrículas de PURCHASE/SUBSCRIPTION/API.
- Los miembros entran por tres vías, cada una dueña de lo suyo (`source`):
  - **MANUAL** — alta del admin o aprobación de inscripción (grupo `isDefaultForApproval`). Sticky: los bridges nunca la degradan ni la retiran.
  - **TIER** — reconciliada por el vínculo `linkedTierName` con los tiers de `mod.payment-connections`.
  - **MEMBERSHIP** — concedida al activarse la membresía de pago (`mod.subscriptions`); se retira al cancelarse o agotar el impago, sin tocar MANUAL ni TIER.

## API pública

Prefijo global `/api/v1`. Todos los endpoints exigen rol `super_admin` / `tenant_admin` (es una pantalla de administración; hasta las lecturas exponen el roster):

- `GET /modules/access-groups` — lista paginada de grupos del tenant.
- `GET /modules/access-groups/:id` — detalle (cursos + miembros con su `source`).
- `POST /modules/access-groups` · `PATCH /modules/access-groups/:id` · `DELETE /modules/access-groups/:id` — CRUD (el borrado revoca membresías y limpia drips huérfanos).
- `PUT /modules/access-groups/:id/courses` — reemplaza el set de cursos (reconcilia matrículas de los miembros).
- `POST /modules/access-groups/:id/members` · `DELETE /modules/access-groups/:id/members/:userId` — asignar / revocar miembros.
- `GET /modules/access-groups/catalog/courses` · `catalog/users` — catálogos para la UI.

## Modelo de datos

- `mod_access_groups_group` — el grupo (`kind`, `isDefaultForApproval`, `autoGrantNewCourses`, `linkedTierName`, `memberCount`; soft-delete).
- `mod_access_groups_group_course` — cursos del grupo (IDs lógicos, sin FK cross-module).
- `mod_access_groups_group_member` — membresía por usuario (`status` ACTIVE/REVOKED, `source` MANUAL/TIER/MEMBERSHIP).
- `mod_access_groups_grant` — provenance/refcount por (grupo, usuario, curso) para revocación segura.

Todas con `tenant_id` + RLS (autodescubierta por `rls.sql`).

## Configuración

Sin settings propios de tenant ni ENV del host. Dos puntos de configuración viven en sus módulos dueños: el grupo por defecto de aprobación se marca en el propio grupo (`isDefaultForApproval`), y el grupo que concede la membresía de pago se elige en la config de membresía (`mod.subscriptions`, campo `accessGroupId`).

## Dependencias

- `mod.courses` ^1.0.0 — catálogo de cursos publicados (resolución de ALL_COURSES y selector de la UI).
- `mod.learning` ^1.0.0 — materialización del acceso como enrollments (`enrollFromGroup` / `unenrollFromGroup`).
- `mod.payment-connections` ^1.0.0 (opcional) — vínculo tier→grupo (miembros TIER).
- `mod.subscriptions` ^1.0.0 (opcional) — grupo de la membresía de pago (miembros MEMBERSHIP).

## Eventos

**Emite**: ninguno.

**Consume** (bridges en el host):

- `courses.course.published` — matricula el curso nuevo a miembros de grupos ALL_COURSES con `autoGrantNewCourses`.
- `payment_connections.user_tier.changed` — reconcilia membresías TIER según el tier efectivo.
- `subscriptions.membership.activated` / `subscriptions.subscription.activated` — concede el grupo configurado de la membresía (miembro MEMBERSHIP).
- `subscriptions.subscription.canceled` (inmediata) / `subscriptions.subscription.unpaid` — revoca SOLO membresías MEMBERSHIP.
