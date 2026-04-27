# Estado del proyecto — handoff completo

> **Nombre del producto**: **Didacta** (rebrand desde "LearnShip" en PR C0).
> **Última actualización**: 2026-04-27 (logo en certificados — follow-up HU-FOR-004)
> **Por**: Valentín Ayesa (`valen@va360labs.com`)
> **Objetivo**: que cualquier persona o IA pueda retomar exactamente donde quedó esta sesión, en otra máquina, sin contexto previo.

---

## 1. TL;DR

Didacta es un LMS multi-tenant modular construido por VA360 LABS S.L. La aplicación es **funcional end-to-end en producción** (Easypanel) y cubre el flujo completo del alumno y del formador.

### Lo que hace HOY

- **Alumno**: registrarse → matricularse (link directo o código de invitación) → consumir lecciones (VIDEO/HTML/PDF/TEXT/QUIZ) → realizar quizzes (4 tipos auto-corregidos + 2 con corrección manual) → completar curso → descargar certificado PDF → ver bandeja de notificaciones in-app → publicar en la comunidad y reaccionar.
- **Formador / tenant_admin**: dashboard con stats agregadas (`/formador`) → CRUD de cursos con módulos y lecciones → crear/editar/publicar quizzes con 6 tipos de pregunta → corregir manualmente las respuestas abiertas (`/formador/correcciones/[id]`) → reordenar lecciones (▲▼) → eliminar módulos.
- **Super_admin / tenant_admin**: verificar la integridad de la cadena de auditoría (`GET /audit/verify`), gestionar usuarios del tenant (`/admin/usuarios`: invitar, suspender, asignar/quitar rol), personalizar branding visual (`/admin/branding`: hue + saturación HSL → 10 escalones derivados, fuentes whitelist, custom CSS sanitizado).
- **Self-service**: olvido de contraseña con email vía SMTP per-tenant (`/forgot-password` + `/reset-password?token=...`). Token SHA-256 hasheado en DB, single-use, TTL 1h.
- **Auth**: signup/signin con JWT (jose + HS256), MFA TOTP obligatorio para roles administrativos, recovery codes.
- **Audit log**: cadena de hashes por tenant SHA-256, IP + user-agent reales, verificable end-to-end.
- **Eventos**: EventBus persistente con patrón Transactional Outbox, recovery worker que reprocesa pendientes cada 30s.
- **Notificaciones**: NotificationHub real con persistencia, canal IN_APP funcional, EMAIL real (PR #77 + reuso en password reset y user invite).
- **Storage**: S3StorageService (default en prod) o LocalDiskStorageService (dev fallback) según `STORAGE_DRIVER`.
- **Theming**: cada tenant override `--brand-h` y `--brand-s`; los 10 escalones brand-50..900 y los neutrales tintados se derivan automáticamente. SSR-ready via `TenantThemeProvider` con cache localStorage anti-FOUC.

### Stack final

| Capa | Tecnología | Notas |
|---|---|---|
| Runtime | Node.js 22 (`.nvmrc`) | |
| Package manager | pnpm 10.21.0 | corepack en local; en Easypanel `npm i -g pnpm@10.21.0` |
| Monorepo | Turborepo + pnpm workspaces | 21 tasks ejecutables (`pnpm typecheck` corre 21 paquetes) |
| Backend | NestJS 10 + Fastify | NestJS 10, no 11 hasta que `nestjs-pino` lo soporte sin pelea |
| ORM | Prisma 5.22 + Postgres 16 | Migraciones versionadas con `prisma migrate deploy` desde 2026-04-25 |
| Frontend | Next.js 15 (App Router) + React 19 + Tailwind 4 + shadcn/ui | |
| Auth | JWT con jose, MFA TOTP con otplib, argon2id para passwords | ADR-003 pendiente para Better-Auth o Auth.js v5 |
| Tests | Vitest + Playwright | 179 unit verdes en CI principal + 5 specs E2E en workflow separado |
| Observabilidad | Pino + nestjs-pino | OpenTelemetry diferido a Fase 2 |
| Hosting | Hetzner + Easypanel | `https://lab-learnship.3qntut.easypanel.host` (legacy hostname pre-rebrand — ver nota en docs/test.env.md) |

### Métricas de calidad (al cierre de los Bloques 0/A/B/C, sesión 2026-04-26 tarde)

- **~245 tests unitarios verdes** (189 api con +13 nuevos en password-reset + 45 mod.assessments + 17 mod.community + 16 mod.theming + 8 mod.learning + 8 mod.courses + 2 mod.certificates).
- **5 specs E2E Playwright**: golden path · quiz alumno · matrícula por código · corrección manual · MFA admin setup.
- **22 paquetes en typecheck** (subió de 21 con el nuevo `@didacta/mod-theming`).
- **22 rutas Next.js** compilando (subió de 17 con `/forgot-password`, `/reset-password`, `/admin/branding`, `/admin/usuarios`, `/admin/usuarios/[id]`, `/admin/usuarios/invitar`).
- **3 fallos pre-existentes en Windows**: `local-disk-storage.test.ts` falla por path separators. Reproduce en `main` — bug de test, no de prod.

---

## 2. Cómo retomar en otra máquina (checklist)

### 2.1 Pre-requisitos del host

- Node.js 22 (usar `nvm use` si tenés `.nvmrc` lectura habilitada)
- pnpm 10.21.0 (`corepack enable && corepack use pnpm@10.21.0` o `npm i -g pnpm@10.21.0`)
- Postgres 16 local (Docker o nativo) o conexión a una remota
- (Opcional) Docker para levantar Postgres: `docker run -d --name didacta-pg -e POSTGRES_USER=didacta -e POSTGRES_PASSWORD=didacta -e POSTGRES_DB=didacta -p 5432:5432 postgres:16`
- Git + acceso SSH/HTTPS al repo `va360labs/didacta`
- (Opcional para deploy/PRs) `gh` CLI autenticado

### 2.2 Setup de cero

```bash
# 1. Clonar y entrar
git clone https://github.com/va360labs/didacta.git
cd didacta

# 2. Activar Node 22 + pnpm
nvm use
corepack enable
corepack use pnpm@10.21.0   # o `npm i -g pnpm@10.21.0` si corepack falla

# 3. Variables de entorno
cp env.example .env
# Editar .env: DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, BOOTSTRAP_*, etc.
# Ver detalle de variables en sección 4 de este doc.

# 4. Instalar deps
pnpm install

# 5. Generar Prisma Client + aplicar migraciones + RLS + seed
pnpm --filter @didacta/database db:generate
pnpm --filter @didacta/database db:migrate:deploy
pnpm --filter @didacta/database db:rls:apply         # idempotente
BOOTSTRAP_PASSWORD='tu-password-min-12-chars' \
  pnpm --filter @didacta/database db:seed

# 6. Levantar dev
pnpm dev      # Turbo levanta web (3000) + api (4000) en watch

# 7. Verificar
pnpm typecheck       # 21 tasks; debe pasar todo
pnpm test            # 179 unit; 3 fallos esperables en Windows local-disk-storage
pnpm format:check    # prettier; en Windows puede salir lleno por CRLF (usar git config core.autocrlf false si querés evitarlo)

# 8. Abrir browser
# http://localhost:3000/signin
# tenant=va360, email=valen@va360labs.com (o tu BOOTSTRAP_EMAIL), password=tu-password
```

### 2.3 Setup en deploy (Easypanel)

Ver `docs/test.env.md` para el listado completo de variables que pide Easypanel. La DB de Easypanel **ya está creada** con el flujo previo de `prisma db push`. Antes del primer deploy con `migrate deploy`:

```bash
# Ejecutar UNA sola vez en el shell de Easypanel:
pnpm --filter @didacta/database exec prisma migrate resolve --applied 0_init
pnpm --filter @didacta/database exec prisma migrate resolve --applied 20260425000001_add_fill_in_blank
pnpm --filter @didacta/database exec prisma migrate resolve --applied 20260425000002_add_open_questions_and_grading
pnpm --filter @didacta/database exec prisma migrate resolve --applied 20260425000003_add_notifications
pnpm --filter @didacta/database exec prisma migrate resolve --applied 20260426000001_add_community
```

A partir de ahí, los deploys aplicarán solo migraciones nuevas posteriores. **CRÍTICO**: si el deploy intenta correr el SQL del baseline contra una DB que ya tiene esas tablas, falla. El `migrate resolve --applied` marca como aplicada sin ejecutar el SQL.

---

## 3. Arquitectura

### 3.1 Layout del monorepo

```
didacta/
├── apps/
│   ├── api/       # NestJS 10 + Fastify; punto de entrada del backend
│   ├── web/       # Next.js 15 App Router; UI alumno, formador, admin
│   └── e2e/       # Playwright; specs end-to-end
├── modules/       # Módulos de negocio (contrato DidactaModule)
│   ├── assessments/    # mod.assessments — quizzes (6 tipos + grading manual)
│   ├── certificates/   # mod.certificates — emisión de PDFs idempotente
│   ├── community/      # mod.community — posts, comments, reacciones (Fase 1.B)
│   ├── courses/        # mod.courses — CRUD cursos, módulos, lecciones
│   ├── hello-world/    # mod.hello-world — sample / contract test reference
│   └── learning/       # mod.learning — matriculación, progreso, invitaciones
└── packages/
    ├── core-kernel/    # Tipos del contrato (ModuleManifest, ModuleContext, EventBus, etc.)
    ├── core-registry/  # ModuleRegistry + DependencyResolver topológico
    └── database/       # PrismaClient + schema.prisma + migrations + seed + rls.sql
```

### 3.2 Módulos cargados al boot

```
mod.hello-world   (probe / contract test reference)
mod.courses       (estructura de cursos)
mod.learning      (matriculación + progreso)
mod.certificates  (PDF idempotente, escucha learning.course.completed)
mod.assessments   (quizzes, escucha nada, emite attempt events)
mod.community     (posts/comments/reactions)
```

Orden de registro = orden topológico resuelto por `core-registry` desde `dependencies` declaradas en cada manifest.

### 3.3 Servicios core (todos reales, sin stubs)

| Servicio | Implementación | Wiring |
|---|---|---|
| `EventBus` | `PersistentEventBus` + `OutboxQueueService` (BullMQ + Redis) — PR #75 | Outbox pattern persistente. Publish upserta en `outbox_event` y encola job a BullMQ. Worker (mismo proceso por ahora) ejecuta handlers con reintentos exponenciales (5 attempts, backoff 1s base, concurrencia 5). Si Redis cae al publish → fallback síncrono. `OutboxRecoveryWorker` failsafe cada 5 min reencola pendientes. Sin Redis → comportamiento legacy in-process (compat dev). |
| `AuditLogService` | `PrismaAuditLogService` | Cadena de hashes por tenant (SHA-256). Endpoint `GET /audit/verify` valida la cadena. |
| `EvidenceVaultService` | `PrismaEvidenceVaultService` | SHA-256 del contenido + storage backend. Idempotente por hash. |
| `StorageService` | `S3StorageService` (default en prod) o `LocalDiskStorageService` (dev fallback) — PR #79 | S3 con AWS SDK v3 + MinIO endpoint custom + forcePathStyle. Presigned URLs (TTL default 900s) — bucket privado, browser baja directo sin pasar por Node. Driver: `STORAGE_DRIVER=local\|s3` o autodetección por presencia de S3_*. |
| `NotificationHubService` | `PrismaNotificationHubService` | Persiste en `notification`. Canal IN_APP funcional. EMAIL loguea (listo para SMTP). WEBHOOK no implementado. |
| `HookRegistry` | `InMemoryHookRegistry` | Hooks dinámicos para extensión cross-module (ej. `courses.publish.validate`). |
| `I18nService` | Stub | Devuelve la key sin traducir. **Pendiente** wire real cuando llegue i18n. |
| `TenantConfigService` | `PrismaTenantConfigService` (PR #73) | Persistente en `tenant_setting` con encryption at-rest AES-256-GCM (`SecretCipherService`). Audit log en cada cambio. UI `/admin/configuracion`. Habilita SMTP/Zoom/etc per-tenant sin tocar env globales. |

Wired en `apps/api/src/modules/module-context.factory.ts` y consumido por todos los módulos vía `ModuleContext`.

### 3.4 Bridges cross-module (apps/api)

| Bridge | Escucha | Acción |
|---|---|---|
| `AssessmentsLearningBridge` | `assessments.attempt.passed` | Si el evento trae `enrollmentId`+`lessonId`, llama a `LearningService.trackProgress(completed: true)` para marcar la lección QUIZ como completada. Idempotente (trackProgress upsert). Rethrow si falla → outbox reintenta. |
| `NotificationsBridge` | 6 eventos: `learning.enrollment.created`, `learning.course.completed`, `certificates.issued`, `assessments.attempt.passed/failed/graded` | Resuelve template + variables y llama a `hub.send` con channel='in-app'. Centraliza la traducción evento → template. |

### 3.5 Flujo end-to-end del alumno (camino crítico)

```
[Alumno crea cuenta]
  └→ POST /auth/signup → AuthService.signup → JWT + audit (con IP+UA)

[Alumno se matricula en un curso]
  └→ POST /modules/learning/enrollments/me
      └→ LearningService.enrollSelf
          └→ ModLearningEnrollment created (status ACTIVE)
          └→ event learning.enrollment.created
              └→ NotificationsBridge → notification IN_APP "Te matriculaste en X"

[Alumno hace una lección VIDEO/HTML/PDF/TEXT]
  └→ POST /modules/learning/progress (cada 30s + manual "Marcar completada")
      └→ LearningService.trackProgress
          └→ ModLearningProgress upsert (completed=true)
          └→ Recalcula enrollment.progressPercent
          └→ Si progressPercent >= completionThreshold:
              └→ enrollment.status = COMPLETED
              └→ event learning.course.completed
                  └→ NotificationsBridge → notification IN_APP "Curso completado"
                  └→ mod.certificates handler → emite PDF → guarda en storage
                      └→ event certificates.issued
                          └→ NotificationsBridge → notification IN_APP "Tu certificado está listo"

[Alumno hace una lección QUIZ]
  └→ GET /modules/assessments/quizzes/:id/preview (vista sin isCorrect)
  └→ POST /modules/assessments/attempts (start)
  └→ POST /modules/assessments/attempts/:id/submit
      └→ AssessmentsService.submitAttempt
          └→ scoreAttempt (puro) → si needsReview=false:
              └→ ModAssessmentsAttempt status=SUBMITTED + scoreEarned + passed
              └→ event assessments.attempt.passed (o .failed)
                  └→ AssessmentsLearningBridge → LearningService.trackProgress(completed=true)
                      └→ (continúa el flujo como arriba: si completa el curso, certificado)
                  └→ NotificationsBridge → notification IN_APP del resultado
          └→ Si needsReview=true (hay SHORT/LONG_ANSWER):
              └→ status=PENDING_REVIEW, no emite passed/failed (espera al formador)

[Formador entra a /formador/correcciones]
  └→ Lista attempts PENDING_REVIEW del tenant
  └→ Click → /formador/correcciones/[id]
      └→ Muestra quiz + respuestas + input de score por respuesta abierta
      └→ POST /modules/assessments/attempts/:id/grade
          └→ AssessmentsService.gradeAttempt
              └→ Valida scoreEarned <= question.points
              └→ Recompura totales sumando todas las answers
              └→ Marca attempt status=GRADED + gradedAt + gradedById
              └→ event assessments.attempt.graded + .passed (o .failed)
                  └→ Bridges hacen lo mismo que para auto-corregido
```

---

## 4. Variables de entorno

### 4.1 Críticas (sin esto el api no arranca)

| Var | Para qué | Ejemplo / nota |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://didacta:didacta@localhost:5432/didacta?schema=public` |
| `JWT_SECRET` | HMAC key para access tokens | mín. 32 chars random |
| `JWT_REFRESH_SECRET` | HMAC key para refresh tokens | mín. 32 chars random, distinto del anterior |
| `STORAGE_ROOT` | Path local donde se guardan PDFs y blobs (cuando `STORAGE_DRIVER=local`) | ej. `./.local-storage`. Crear el dir antes de arrancar. |
| `TENANT_SETTINGS_ENC_KEY` | AES-256-GCM master key para cifrar settings per-tenant marcados con `is_secret`. Generar con `openssl rand -hex 32`. **Backup obligatorio.** En `NODE_ENV=production` boot falla si falta; en dev usa fallback determinístico. | 64 chars hex |

### 4.2 Bootstrap del seed

| Var | Para qué |
|---|---|
| `BOOTSTRAP_TENANT_SLUG` | Slug del tenant inicial (default `va360`) |
| `BOOTSTRAP_EMAIL` | Email del super_admin inicial |
| `BOOTSTRAP_PASSWORD` | Password del super_admin (mín. 12 chars) |

El seed es idempotente: si el usuario ya existe, no lo duplica.

### 4.3 Frontend

| Var | Para qué |
|---|---|
| `NEXT_PUBLIC_API_URL` | URL del api desde el browser. En dev `http://localhost:4000`. En prod la URL pública. |
| `API_INTERNAL_URL` | URL del api desde el server-side de Next (SSR / route handlers). En dev `http://localhost:4000`. En prod (mismo container) `http://localhost:4000`. |

### 4.4 E2E

| Var | Para qué |
|---|---|
| `E2E_BASE_URL` | URL del web (ej. `http://localhost:3000`) |
| `E2E_API_URL` | URL del api (ej. `http://localhost:3000` si el web hace proxy, o `http://localhost:4000` directo) |
| `E2E_TENANT_SLUG` | Tenant para los tests (default `va360`) |
| `E2E_ADMIN_EMAIL` | Mismo que BOOTSTRAP_EMAIL |
| `E2E_ADMIN_PASSWORD` | Mismo que BOOTSTRAP_PASSWORD |

### 4.5 Easypanel

Ver `docs/test.env.md` (debe estar al día con todo lo de arriba).

---

## 5. Mapa de código completo

### 5.1 `apps/api/src/`

```
auth/
  api-key.controller.ts     # POST /auth/api-keys (admin crea API keys)
  api-key.guard.ts          # JwtOrApiKeyGuard
  api-key.service.ts
  auth.controller.ts        # POST /auth/{signup,signin,refresh}
  auth.module.ts            # NestJS module + provee PrismaAuditLogService
  auth.service.ts           # signup/signin con audit IP+UA, refresh tokens
  client-context.ts         # extractClientContext(req) → {ip, userAgent} (XFF aware)
  decorators.ts             # @CurrentUser()
  jwt-auth.guard.ts         # Verifica JWT + cuelga claims en request
  mfa.controller.ts         # POST /auth/mfa/{setup,enable,verify} con audit IP+UA
  mfa.service.ts            # otplib + recovery codes
  password.service.ts       # argon2id
  token.service.ts          # JWT sign/verify con jose, SessionClaims
  zod-validation.pipe.ts    # Pipe para @Body con schemas Zod

health/
  health.controller.ts      # GET /healthz, /readyz

modules/
  assessments.controller.ts            # CRUD quiz + grade (formador only)
  assessments-attempts.controller.ts   # Flujo alumno (start, submit, list)
  assessments-error.filter.ts          # Maps AssessmentsError → HTTP
  assessments-learning.bridge.ts       # Listen attempt.passed → trackProgress
  audit.controller.ts                  # GET /audit/verify (admin only)
  certificates.controller.ts           # GET /me/certificates, /:id/download
  community.controller.ts              # 8 endpoints CRUD
  community-error.filter.ts
  courses.controller.ts                # CRUD cursos + module/lesson + publish/archive
  courses-error.filter.ts
  formador-stats.controller.ts         # GET /formador/stats agregadas
  learning.controller.ts               # Enrollment + progress + invitations
  learning-error.filter.ts
  local-disk-storage.service.ts        # StorageService impl
  module-context.factory.ts            # Construye ModuleContext con servicios reales
  module-registry.service.ts           # Registra módulos al boot, expone get*Service()
  modules.module.ts                    # NestJS module wiring
  notifications.bridge.ts              # 6 subs → hub.send
  notifications.controller.ts          # GET/POST /me/notifications
  outbox-recovery.worker.ts            # Reprocesa outbox cada 30s
  persistent-event-bus.ts              # EventBus impl (Outbox)
  prisma-audit-log.service.ts          # Cadena de hashes + verifyChain
  prisma-evidence-vault.service.ts     # SHA-256 idempotente
  prisma-notification-hub.service.ts   # NotificationHub real con templates inline

prisma/
  prisma.service.ts        # Inyectable PrismaClient

tenancy/
  tenant-context.service.ts  # Wrapper SET LOCAL para RLS (poco usado todavía)

main.ts                   # bootstrap NestJS + Fastify + Swagger en /docs
app.module.ts             # Top-level module
```

### 5.2 `apps/web/src/`

```
app/
  (app)/                                # Rutas autenticadas (layout con nav)
    layout.tsx                          # Header con NotificationsBell + nav
    comunidad/
      page.tsx                          # Lista posts + form crear
      [id]/page.tsx                     # Detalle + comments + reacciones
    cursos/
      page.tsx                          # Catálogo (cursos publicados)
      [slug]/page.tsx                   # Detalle alumno: matricularse, ver lecciones, certificado
    formador/
      page.tsx                          # Dashboard con 6 stats agregadas
      cursos/
        page.tsx                        # Mis cursos (formador)
        nuevo/page.tsx                  # Crear curso
        [id]/
          page.tsx                      # Editor del curso
          course-editor.tsx             # Componente principal (módulos + lecciones, ▲▼, eliminar)
          invitations-panel.tsx         # CRUD invitaciones
          lesson-content-editor.tsx     # Editor por tipo de lección (VIDEO/HTML/PDF/TEXT/QUIZ)
      correcciones/
        page.tsx                        # Lista PENDING_REVIEW
        [id]/page.tsx                   # Detalle + form de grading por respuesta abierta
      quizzes/
        [id]/
          page.tsx                      # Editor de quiz standalone
          quiz-editor.tsx               # Config + add/delete preguntas + publicar
    mis-certificados/
      page.tsx                          # Lista + descarga PDF
    notificaciones/
      page.tsx                          # Bandeja IN_APP

  (auth)/                               # Rutas no autenticadas
    layout.tsx
    mfa/
      setup/                            # MFA setup con QR
        page.tsx
        mfa-setup-flow.tsx
      verify/                           # MFA verify (login subsecuente)
        page.tsx
        mfa-verify-form.tsx
    signin/page.tsx
    signup/page.tsx

components/
  course-status-badge.tsx
  lesson-player.tsx                     # Player con tipo (VIDEO/HTML/PDF/TEXT/QUIZ)
  notifications-bell.tsx                # Badge en header con polling 60s
  quiz-player.tsx                       # State machine: loading/error/empty/idle/attempt/result
  ui/                                   # shadcn/ui primitives (button, card, input, etc.)

lib/
  api-client.ts                         # apiFetch + ApiHttpError
  assessments.ts                        # Cliente formador + alumno
  auth-storage.ts                       # tokens en sessionStorage + localStorage
  certificates.ts
  community.ts                          # posts/comments/reactions
  courses.ts                            # con moveLesson + deleteModule añadidos
  formador-stats.ts                     # GET /formador/stats
  learning.ts
  notifications.ts                      # listMine + markRead + markAllRead
  utils.ts                              # cn() y utilidades
```

### 5.3 `apps/e2e/`

```
helpers/
  api.ts                       # Bootstrap helpers + creador de courses/quizzes/invitations
  auth.ts                      # injectSession() en sessionStorage del browser

tests/
  enroll-by-code.spec.ts       # Matrícula con código de invitación
  golden-path.spec.ts          # Alumno completa curso TEXT → certificado
  manual-grading.spec.ts       # SHORT_ANSWER → admin califica → curso completado
  mfa-setup.spec.ts            # MFA setup + enable con TOTP
  quiz-flow.spec.ts            # Quiz auto-corregido con SINGLE_CHOICE
```

### 5.4 `modules/<nombre>/src/`

Cada módulo respeta el mismo layout:

```
manifest.ts            # parseModuleManifest({ name, version, eventsEmitted, ... })
<module>.service.ts    # Service class con (prisma, ctx) en constructor
dto.ts                 # Schemas Zod + tipos exportados
errors.ts              # Jerarquía CommunityError, AssessmentsError, etc.
index.ts               # Exporta el module + service + DTOs + errors
```

Algunos módulos extras:
- `mod.assessments/src/scoring.ts` — engine puro de corrección (sin dependencies de Prisma).
- `mod.certificates/src/pdf-renderer.ts` — pdfkit-based.

### 5.5 `packages/database/`

```
prisma/
  schema.prisma                                    # 1 archivo único, 600+ líneas
  rls.sql                                          # Políticas RLS + triggers append-only audit
  migrations/
    0_init/migration.sql                            # Baseline (716 líneas; capturado tras Fase 1.A)
    20260425000001_add_fill_in_blank/              # FILL_IN_BLANK + acceptedAnswers + textAnswer
    20260425000002_add_open_questions_and_grading/ # SHORT/LONG_ANSWER + PENDING_REVIEW + grading fields
    20260425000003_add_notifications/              # Notification table
    20260426000001_add_community/                  # Posts, comments, reactions
    migration_lock.toml                            # provider = postgresql

src/
  client.ts                # PrismaClient factory
  index.ts                 # Re-export de types + client
  seed.ts                  # tsx; crea tenant, super_admin con MFA disabled, role base
  tenant-context.ts        # withTenantContext(prisma, tenantId, cb) → SET LOCAL app.current_tenant_id
```

### 5.6 `packages/core-kernel/`

```
src/
  module/
    module.ts            # Tipos del contrato: ModuleManifest, ModuleContext, EventBus, NotificationHubService, etc.
    parser.ts            # parseModuleManifest() valida con Zod
  index.ts
```

### 5.7 `packages/core-registry/`

```
src/
  module-registry.ts        # Registro + DependencyResolver topológico
  dependency-resolver.ts
  index.ts

tests/
  module-registry.test.ts
  dependency-resolver.test.ts
```

---

## 6. Schema de DB y migraciones

### 6.1 Modelos por categoría

**Multi-tenancy + módulos:**
- `Tenant`, `Module`, `TenantModule`

**IAM:**
- `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Session`, `ApiKey`

**Cross-cutting del core:**
- `AuditLog` (append-only via trigger en `rls.sql`, hash chain por tenant)
- `EvidenceVaultEntry`
- `OutboxEvent` (event bus persistente)
- `Webhook`
- `NotificationTemplate` (tabla histórica, no usada en v0.1; los templates están inline en el service)
- `Notification` (bandeja IN_APP del alumno)

**mod.courses:**
- `ModCoursesCourse`, `ModCoursesModule`, `ModCoursesLesson`

**mod.learning:**
- `ModLearningEnrollment`, `ModLearningProgress`, `ModLearningInvitation`

**mod.certificates:**
- `ModCertificatesTemplate`, `ModCertificatesIssued`

**mod.assessments:**
- `ModAssessmentsQuiz`, `ModAssessmentsQuestion`, `ModAssessmentsOption`
- `ModAssessmentsAttempt`, `ModAssessmentsAnswer`

**mod.community:**
- `ModCommunityPost`, `ModCommunityComment`, `ModCommunityReaction`

### 6.2 Lista de migraciones (en orden)

| # | Migración | Contenido |
|---|---|---|
| 1 | `0_init` | Baseline completo: 716 líneas. Captura todo el schema hasta el cierre de Fase 1.A (incluido `mod_assessments_*` v0.1). |
| 2 | `20260425000001_add_fill_in_blank` | Añade `FILL_IN_BLANK` al enum + `accepted_answers` (Question) + `text_answer` (Answer). |
| 3 | `20260425000002_add_open_questions_and_grading` | Añade `SHORT_ANSWER`/`LONG_ANSWER` al enum, `PENDING_REVIEW`/`GRADED` al status enum, `graded_at`/`graded_by_id` (Attempt) y `graded_feedback` (Answer). |
| 4 | `20260425000003_add_notifications` | Tabla `notification` con índices. |
| 5 | `20260426000001_add_community` | Tablas `mod_community_post/comment/reaction` con FKs intra-módulo. |
| 6 | `20260426000002_add_tenant_settings` | Tabla `tenant_setting` (tenant_id, module_name, key, is_secret, value_json \| value_cipher/iv/tag). Habilita config per-tenant cifrada. |

### 6.3 Comandos útiles de DB

```bash
# Aplicar migraciones pendientes (CI / nueva máquina / Easypanel)
pnpm --filter @didacta/database db:migrate:deploy

# Crear nueva migración tras editar schema.prisma (la aplica al instante en local)
pnpm --filter @didacta/database db:migrate:dev --name <descripción-corta>

# Reset full (BORRA todo y reaplica desde 0_init)
pnpm --filter @didacta/database exec prisma migrate reset

# Re-generar Prisma client tras cambios en schema.prisma
pnpm --filter @didacta/database db:generate

# Aplicar políticas RLS (idempotente; correr tras migraciones)
pnpm --filter @didacta/database db:rls:apply

# Re-seed (idempotente)
BOOTSTRAP_PASSWORD='...' pnpm --filter @didacta/database db:seed

# Studio
pnpm --filter @didacta/database exec prisma studio
```

### 6.4 Marcar baseline como aplicada (Easypanel post-PR #51)

Ver sección 2.3.

---

## 7. Decisiones clave de arquitectura (no repetirlas)

### 7.1 Stack
- **NestJS 10** y NO 11 — `nestjs-pino` no soporta 11 todavía sin pelea.
- **CommonJS en TODO el monorepo** — NestJS necesita CJS por decoradores. Cualquier `"type": "module"` en un workspace package rompe el build de api con error críptico.
- **Fastify** sobre Express — más rápido, mejor con TS.
- **`prisma migrate deploy/dev`** versionado en `packages/database/prisma/migrations/` desde 2026-04-25. Antes era `prisma db push`. Para una nueva máquina: `pnpm --filter @didacta/database db:migrate:deploy`. Para Easypanel: ver sección 2.3.
- **JWT con jose + HS256** — ADR pendiente para pasar a RS256 cuando haya rotación de keys.
- **argon2id** para passwords (no bcrypt, por memory cost).

### 7.2 Arquitectura
- **Sin pgvector hasta Fase 1.C** — Easypanel pg17 no lo trae. Cuando active mod.ai-tutor, cambiar imagen a `pgvector/pgvector:pg16` y agregar `vector` a extensions del datasource.
- **Sin Redis hasta que Easypanel lo provea** — patrón Outbox persistente in-process es el reemplazo intermedio.
- **Sin BullMQ todavía** por la misma razón.
- **`STORAGE_ROOT` env** para mover el storage local a un volumen de Easypanel sin cambiar código.
- **MFA solo para `super_admin` y `tenant_admin`** (NO `formador` ni `alumno`) — definición en `auth.service.ts:ADMIN_ROLES`.
- **Hash chain del audit log es por tenant**, no global — evita contención entre tenants. Concurrencia intra-tenant tiene riesgo de mismo `prev_hash` hasta Fase 2 (`pg_advisory_xact_lock(tenantId)`).
- **Snapshot inmutable en `certificate.snapshot`** — si renombras el curso o el alumno, el certificado conserva la versión original.
- **Sin FKs cross-module** — los módulos referencian otros vía UUID lógico (`courseId`, `userId`, `lessonId`) sin `@relation`. Esto preserva la independencia operativa: cada módulo se puede testear / desinstalar sin colaterales.
- **Snapshot del `displayName` del autor en `mod.community`** — denormalizado para listados rápidos sin join cross-module a IAM.

### 7.3 Anti-patrones encontrados (gotchas)

- `@UsePipes(...)` a nivel handler valida TODOS los args (incluido `@CurrentUser()`) — usar `@Body(new ZodValidationPipe(...))` en su lugar.
- Workspace package con `main: dist/index.js` necesita build previo. Sin build de `mod-X`, `apps/api` da `TS2307`. CI lo hace solo (turbo `dependsOn: ['^build']` en typecheck/test). En local, antes del primer typecheck del api, hay que correr `pnpm --filter @didacta/mod-X build` para cada mod nuevo.
- Para descargar PDFs con bearer auth, NO usar `<a href>` (no soporta cabeceras). Hay que hacer fetch → blob → URL.createObjectURL → click programático.
- pdfkit no requiere fonts externas (Helvetica embebido) ni native deps → ideal Docker.
- corepack falla con EACCES en Easypanel. Solución: `npm install -g pnpm@10.21.0`.
- En Windows, los tests de `local-disk-storage` fallan por separators de path (`\` interpretado como escape). Es bug del test, no del código. Pre-existente en `main` antes de cualquier PR de esta sesión.
- En Windows, `pnpm format:check` puede salir lleno por CRLF vs LF. Solución 1: `git config core.autocrlf false` antes de clonar. Solución 2: ignorar localmente — git normaliza al commit (verificar con `git ls-files --eol`).
- Para inferencia circular de TypeScript con `Prisma.JsonValue`, agregar anotación explícita de tipo (ej. `const expected: string = ...`).
- Si te encontrás con `TS2742: cannot be named without a reference to ...`, anotá el tipo de retorno de la función pública (ej. `Promise<unknown[]>`).

---

## 8. Convenciones de trabajo

### 8.1 Idioma

- **Español** para commits, comentarios, documentación, copy de UI.
- **Inglés** para identificadores técnicos (nombres de funciones, variables, tipos, endpoints).

### 8.2 Commits

- **Conventional Commits** obligatorios: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `test(scope): ...`, `docs(scope): ...`.
- **Nunca** añadir `Co-Authored-By` ni atribuciones a IA.
- Mensaje en español, descriptivo, multi-paragraph cuando hay contexto que justifica (un `feat` complejo merece un párrafo explicando el "por qué" además del "qué").

### 8.3 Branches y PRs

- Una rama por feature: `feat/<descripción-corta>`, `fix/<descripción>`, `chore/<descripción>`, `docs/<descripción>`, `test/<descripción>`.
- Un PR por feature. Squash-merge siempre. Auto-delete branch después de mergear.
- Descripción del PR en español: resumen + cambios + plan de test.
- Esperar CI verde antes de mergear (`gh pr checks <n> --watch`).

### 8.4 Tests

- **Lógica de negocio en services y handlers**: coverage mínimo 70%.
- **Scoring engines puros** (sin DB): tests exhaustivos en su propio archivo.
- **Tests de service**: usar fake Prisma (patrón en `audit-log.test.ts`, `assessments-service.*.test.ts`, `community.service.test.ts`).
- **Tests de filter de errores**: verificar mapping a HTTP status (patrón en `assessments-error.filter.test.ts`).
- **E2E**: solo flujos críticos. Cada spec self-contained con bootstrap helpers.

### 8.5 Reglas que NO se negocian

- Verificar antes de afirmar; si dudás, decir "dejame verificar" y leer el código.
- No usar `cat`/`grep`/`find`/`sed`/`ls` en bash — usar las tools dedicadas.
- No commit a `main` directamente (siempre branch + PR + squash).
- No `git push --force` sin `--force-with-lease`.

---

## 9. Workflows de CI

### 9.1 `ci.yml` — corre en cada push y PR

Job `Lint · Typecheck · Test · Build`:
1. Setup pnpm + Node 22
2. `pnpm install --frozen-lockfile`
3. `pnpm --filter @didacta/database db:generate`
4. `pnpm format:check`
5. `pnpm lint`
6. `pnpm typecheck`
7. `pnpm test`
8. `pnpm build`

Ver `.github/workflows/ci.yml`.

### 9.2 `e2e.yml` — corre en push a main + workflow_dispatch

Levanta Postgres 16 como service container, aplica migraciones (`db:migrate:deploy`), seedea, levanta api+web, instala browsers de Playwright, corre `pnpm --filter @didacta/e2e test:e2e`. Sube reporte HTML como artifact.

Ver `.github/workflows/e2e.yml`.

---

## 10. Roadmap pendiente

### 10.0 Sesión 2026-04-26 tarde — Foundations visuales + P0 admin (Bloques 0/A/B/C)

Tras el rebrand a Didacta (PR C0), el usuario pidió:

1. Crear `mod.theming` (personalización visual per-tenant) — del brief `docs/diseño/PANTALLAS-DOGFOODING.md` §10.
2. Cubrir P0 backend faltantes — del mismo brief §2.4-2.5 y §6.2-6.4.
3. Rediseño visual de las pantallas P0 con principios pixel-perfect.

**Estrategia ejecutada**: stacked PRs lineales en cadena `A → B1 → B2 → B3` y `A → C1 → C2`. Cada PR es chiquito y reviewable. Mergear en orden, los demás se rebasan automático.

| PR | Branch | Bloque | Estado | Resumen |
|---|---|---|---|---|
| #85 | `feat/design-tokens-foundation` | A | abierto | Foundation de design tokens (Tailwind 4 `@theme`) + skill global `pixel-perfect-ui`. Refactor componentes shadcn (button con variants primary/secondary/success/destructive/ghost/link, card interactive, input/textarea/select con border-strong y focus shadow, badge con tinted bg + ring-inset, label semibold). Sora + Inter via next/font/google. |
| #86 | `feat/mod-theming-scaffold` | B1 | abierto | Schema `ModThemingTenantTheme` + migración `20260426000003_add_theming` + módulo `modules/theming/` (manifest, service, DTOs, errors, sanitización CSS, 16 tests). Whitelists de fuentes (8 display + 8 body). |
| #87 | `feat/mod-theming-api` | B2 | abierto | Endpoints `GET/PUT /modules/theming/me` + `POST .../reset` con role-check. Cliente web `lib/theming.ts` + `TenantThemeProvider` con cache localStorage anti-FOUC. |
| #88 | `feat/admin-branding-ui` | B3 | abierto | UI `/admin/branding` con preview live: slider HSL gradient, preview de los 10 escalones derivados, selectores de fuente, custom CSS con counter de bytes, footer HTML, panel sticky con tarjeta+botón+badge derivando colores en tiempo real. |
| #89 | `feat/forgot-reset-password` | C1 | abierto | Tabla `password_reset_token` + migración. Servicio `PasswordResetService` (token raw 32B random hex, DB persiste SHA-256, TTL 1h, single-use, anti user-enumeration). Endpoints `POST /auth/forgot-password` y `POST /auth/reset-password`. UI `/forgot-password` y `/reset-password` (Suspense para Next 15 prerendering). 13 tests nuevos. |
| #90 | `feat/admin-usuarios-crud-v2` | C2 | abierto | Módulo Nest `admin/` con `AdminUsersService` (list, getDetail, invite con email del C1, setStatus con invalidación de sessions, assignRole/removeRole con whitelist de roles asignables, resendInvite). 7 endpoints REST. UI `/admin/usuarios` (tabla con badges + filtros), `/admin/usuarios/invitar` (form con descripciones contextuales por rol), `/admin/usuarios/[id]` (acceso + roles + sesiones recientes). |

**Skill creada**: `~/.claude/skills/pixel-perfect-ui/SKILL.md` codifica principios Refactoring UI + tipografía exquisita + color HSL + microinteracciones + a11y + UX para no-técnicos + stack-aware (Tailwind 4 + shadcn + Next 15). Auto-loads en cualquier trabajo de UI futuro.

**Pendiente en esta sesión** (en cola):
- C3: UI `/admin/auditoria` consumiendo `GET /audit/verify` ya existente.
- D1-D8: rediseño visual aplicando tokens a todas las pantallas P0 del brief.

### 10.1 Plan A — Infra externa habilitada el 2026-04-26 (Redis y MinIO ya provistos en Easypanel)

| PR | Item | Estado | Notas |
|---|---|---|---|
| **A0** | `feat(core): TenantSettings persistente con encryption at-rest` | ✅ **MERGED #73** | Reemplaza el stub. Habilita SMTP/Zoom/etc per-tenant. AES-256-GCM, audit log, UI `/admin/configuracion`. |
| **A1** | `feat(events): BullMQ outbox dispatcher con Redis` | ✅ **MERGED #75** | Queue + Worker BullMQ. Reintentos exponenciales nativos. /readyz chequea DB y Redis. enableShutdownHooks para SIGTERM limpio. |
| **A2** | `feat(notifications): adapter SMTP per-tenant con nodemailer` | ✅ **MERGED #77** | Canal EMAIL real. Lee `notifications.smtp` cifrado per-tenant. Endpoint POST `/tenant-settings/notifications/smtp/test`. UI con botón "Probar envío". |
| **A3** | `feat(storage): MinIO/S3 backend con presigned URLs` | ✅ **MERGED #79** | `S3StorageService` con AWS SDK v3, forcePathStyle, presigned URLs TTL configurable (default 900s). Driver selector `STORAGE_DRIVER`. /readyz chequea S3. |

### 10.2 Plan B — Mods grandes con dependencia de A0 (TenantSettings)

| PR | Item | Notas |
|---|---|---|
| B1 | `feat(mod.zoom-live): scaffold + Zoom OAuth Server-to-Server` | Lee `zoom.{accountId,clientId,clientSecret}` cifrados del TenantSettings. CRUD live sessions, link de assist, embed Zoom Web SDK. |
| B2 | `feat(mod.fundae): cumplimiento RD 694/2017` | Investigar requisitos SEPE primero (acción formativa, grupo, participante, asistencia, export XML). |

### 10.3 Polish posible sin bloqueo (priorizar bajo demanda)

- **Polish de `mod.community`**: moderación (flag + admin panel), nested replies, menciones (`@usuario`), notificaciones IN_APP cuando alguien responde a tu post.
- **Per-tenant notification templates**: UX para tenant_admin que customiza copy de cada plantilla.
- **Drag & drop visual de lecciones** en el editor del formador (las flechas ▲▼ funcionan).
- **Webhook adapter en NotificationHub** (defer hasta caso de uso concreto).
- **Más specs E2E**: invitación con maxUses agotada, certificate download con bearer (golden cubre solo path positivo), edit de course por formador completo.
- **Tests de service de community endpoints** (el service tiene 17 tests, los handlers HTTP no).
- **OpenAPI doc completa** — ya hay decoradores `@ApiOperation` pero no se publica el JSON estructurado.

---

## 11. Tabla de PRs cerrados (histórico completo)

### Pre-sesión actual

| PR | Título | Estado |
|---|---|---|
| #1–#34 | Bootstrap + Fase 0 + Fase 1.A inicial | merged |
| #35 | feat(courses): editor de contenido por tipo de lección | merged |
| #36 | feat(certificates): mod.certificates con emisión automática y descarga PDF | merged |
| #37 | feat(events): EventBus persistente con patrón Transactional Outbox | merged |
| #38 | feat(core): AuditLog, EvidenceVault y Storage funcionales | merged |
| #39 | test(e2e): tests Playwright del golden path del alumno | merged |
| #40 | feat(audit): registrar eventos clave en audit_log y evidence_vault | merged |
| #41 | docs: estado del proyecto (punto de retomada al 2026-04-25) | merged |

### Sesión actual (28 PRs consecutivos, #42–#71)

| PR | Título | Estado |
|---|---|---|
| #42 | feat(audit): endpoint /audit/verify para validar la cadena de hashes | merged |
| #43 | docs(estado): cierre de PR #42 (audit verify) y nuevo Trabajo en curso vacío | merged |
| #44 | feat(assessments): scaffold mod.assessments + scoring engine | merged |
| #45 | feat(assessments): endpoints HTTP del formador | merged |
| #46 | feat(assessments): endpoints del alumno (start/submit attempt) | merged |
| #47 | feat(assessments): bridge mod.assessments → mod.learning | merged |
| #48 | feat(assessments): UI formador del editor de quiz | merged |
| #49 | feat(assessments): UI alumno del player de quiz | merged |
| #50 | docs(estado): cierre de mod.assessments v0.1 + nuevo Trabajo en curso vacío | merged |
| #51 | chore(db): baseline `0_init` + switch a prisma migrate deploy | merged |
| #52 | feat(audit): IP + user-agent reales en signup/signin/MFA | merged |
| #53 | test(e2e): specs Playwright (quiz alumno + matrícula por código) | merged |
| #54 | feat(assessments): tipo FILL_IN_BLANK con auto-corrección (v0.2) | merged |
| #55 | feat(assessments): SHORT/LONG_ANSWER + corrección manual (v0.3) | merged |
| #56 | feat(assessments): UI detalle de corrección manual + endpoint formador | merged |
| #57 | docs(estado): cierre de mod.assessments + corrección manual | merged |
| #58 | test(e2e): spec del flujo end-to-end de corrección manual (SHORT_ANSWER) | merged |
| #59 | test(e2e): spec del flujo MFA admin (setup + enable con TOTP) | merged |
| #60 | feat(courses): polish del editor (reordenar lecciones + eliminar módulo) | merged |
| #61 | feat(core): NotificationHub real con persistencia + bandeja in-app | merged |
| #62 | feat(web): bell de notificaciones con badge de no leídas en el header | merged |
| #63 | docs(estado): cierre completo de sesión (19 PRs #44–62) | merged |
| #64 | test: cobertura unitaria de NotificationHub (service + bridge) | merged |
| #65 | test(assessments): cobertura de gradeAttempt (corrección manual) | merged |
| #66 | feat(formador): dashboard con stats agregadas del tenant | merged |
| #67 | docs(estado): cierre final de sesión (23 PRs #44–66) | merged |
| #68 | feat(community): scaffold mod.community + service + 17 tests (PR A) | merged |
| #69 | feat(community): endpoints HTTP del módulo community (PR B) | merged |
| #70 | feat(community): UI alumno (lista + detalle + reacciones) (PR C) | merged |
| #71 | docs(estado): cierre de mod.community v0.1 (Fase 1.B arrancada) | merged |

### Sesión 2026-04-26 (Plan A — fundación per-tenant config)

| PR | Título | Estado |
|---|---|---|
| #73 | feat(core): TenantSettings persistente con encryption at-rest (PR A0) | merged |
| #75 | feat(events): BullMQ outbox dispatcher con Redis (PR A1) | merged |
| #77 | feat(notifications): adapter SMTP per-tenant con nodemailer (PR A2) | merged |
| #79 | feat(storage): MinIO/S3 backend con presigned URLs (PR A3) | merged |
| #81 | chore(rebrand): renombrar producto a Didacta (PR C0) | merged |
| #82 | fix(database): tipar explícitamente tx en withTenantContext | merged |
| #83 | fix(ci): actualizar filter @learnship/database → @didacta/database | merged |

### Sesión 2026-04-27 — Logo en certificados (follow-up de HU-FOR-004)

- **Renderer** acepta `logoData?: Buffer` (no URL) y embebe el logo
  centrado en cabecera del PDF (alto fijo 60px, ancho proporcional auto).
  Si `pdfkit` rechaza el buffer (formato no soportado), se ignora sin
  romper la emisión.
- **Service** descarga el logo de `template.logoUrl` con `globalThis.fetch`
  + `AbortController` (timeout 5s, max 2 MiB). Si falla por cualquier
  motivo (404, timeout, archivo grande), loguea warn y emite el
  certificado sin logo. La emisión NO debe fallar por un asset de
  branding caído.
- **Separación de concerns**: el renderer es puro (recibe buffer); el
  service es el único que hace I/O HTTP.
- 2 tests nuevos del renderer: PNG 1x1 válido se embebe + buffer corrupto
  no rompe.

### Sesión 2026-04-27 — Module access guard (follow-up de HU-TA-002)

Cierre del follow-up que quedaba documentado en HU-TA-002: el guard runtime
que bloquea endpoints de módulos desactivados.

- **`ModuleAccessInterceptor`** (NestJS interceptor global): lee la URL del
  request, extrae el segment del path `/modules/<segment>/...`, lo mapea al
  nombre del módulo via `manifest.apiNamespace`, y consulta el estado en
  `tenant_module`. Si el módulo está desactivado para el tenant actual,
  responde 403 con mensaje claro.
- **Implementación como interceptor (no guard)**: los APP_GUARD globales
  corren antes que los `@UseGuards(JwtAuthGuard)` de cada controller, así
  que un guard global no tendría `request.user.tenantId`. Los interceptors
  corren después, con el request ya enriquecido. Throw desde
  `intercept()` rechaza el request igual que un guard.
- **Cache in-memory** por (tenantId, moduleName) → boolean con TTL 30s.
  Evita golpear DB en cada request. `TenantModulesService` invalida la
  cache tras enable/disable (incluida la cascada) para evitar ventana de
  inconsistencia.
- **Paths fuera de `/modules/<segment>` no se ven afectados**: admin, auth,
  me, healthz, audit, formador-stats, etc. siguen funcionando aunque el
  módulo correspondiente esté desactivado.
- **Ruta sin user (pre-auth)**: deja pasar — JwtAuthGuard ya rechazaría si
  el endpoint requería auth.
- **Default conservador**: si el módulo no tiene fila en `module` (caso
  raro durante boot) → permite. Si no hay fila en `tenant_module` → usa
  `enabledByDefault` (true para los 7 módulos sembrados al boot).

**Tests**: 8 nuevos del interceptor (paths no-modules, segment desconocido,
sin user, enabledByDefault sin row, fila disabled → 403, cache 30s,
invalidate específico, mapeo correcto via apiNamespace). El test del
service se actualizó para inyectar el cache mock.

Con esto, el ciclo completo de "modularidad visible al cliente" queda
operativo: el toggle persiste, audita, emite evento, y bloquea endpoints
en runtime.

### Sesión 2026-04-27 — HU-TA-003 (dashboard tenant_admin con métricas)

Historia Notion **HU-TA-003 / LMS-73** (P2, Fase 1.A) cerrada. Limpia el "En
curso" residual que quedaba sin PR asociado.

- **Endpoint** `GET /admin/stats?range=all|7d|30d` con guard
  tenant_admin/super_admin. Devuelve activeUsers, coursesPublished,
  totalEnrollments, certificatesIssued, completionRate.
- **Página `/admin`** con cards + selector de rango (Histórico / 30d / 7d).
  Atajos a usuarios / configuración / branding / auditoría.
- **Comportamiento del rango**: solo aplica a métricas temporales
  (matriculaciones nuevas, certificados emitidos). Usuarios activos y
  cursos publicados son siempre snapshot actual.
- **`completionRate`** = completed / total \* 100, redondeado. Si
  `total === 0` devuelve 0 (evita división por cero).
- **5 unit tests** del service: range=all sin filter, range=30d gte ~30d
  atrás (con tolerance), completionRate calc, división por cero, payload
  shape.

### Sesión 2026-04-27 — HU-FOR-004 (plantillas custom de certificado)

Historia Notion **HU-FOR-004 / LMS-68** (P1, Fase 1.A) cerrada. El formador ya
puede personalizar plantillas de certificado por tenant y asignarlas curso a
curso desde el editor.

Cambios funcionales:

- **`/formador/certificados/templates`**: nueva página con CRUD completo de
  plantillas (nombre, body con `{{alumno}}/{{curso}}/{{fecha}}/{{numero}}`,
  primaryColor hex, logoUrl opcional, signerName + signerTitle, isDefault).
  La default se marca con badge y se desmarca automáticamente cuando se
  asigna otra (transacción atómica).
- **Editor del curso**: card "Plantilla de certificado" con dropdown que
  lista las del tenant + opción "Por defecto del tenant". El cambio se
  persiste vía `PUT /modules/courses/:id` con `certificateTemplateId`.
- **`getEffectiveTemplate(tenantId, courseTemplateId)`** del service:
  resuelve la jerarquía curso → default tenant → null. Llamado al emitir.

Backend:

- Migración `20260427000002_add_course_certificate_template`: añade
  `certificate_template_id UUID NULL` a `mod_courses_course` (sin FK
  cross-module — es UUID lógico).
- `CertificatesService` extendido: `listTemplates`, `getTemplate`,
  `createTemplate`, `updateTemplate`, `setDefaultTemplate`, `deleteTemplate`,
  `getEffectiveTemplate`. Errores tipados nuevos:
  `TEMPLATE_NOT_FOUND`, `TEMPLATE_NAME_TAKEN`, `TEMPLATE_IN_USE`,
  `TEMPLATE_IS_DEFAULT`.
- Endpoints HTTP: `GET /modules/certificates/templates`,
  `POST/PATCH/DELETE /:id`, `POST /:id/set-default`. Guard formador o
  tenant_admin.
- `CertificatesErrorFilter` mapea los nuevos códigos a HTTP (404/409).
- `mod.courses.updateCourse` valida que el `certificateTemplateId` pertenezca
  al tenant antes de persistir.

**Tests**: 15 unit del CRUD + dependencias en `mod-certificates`
(create/update con isDefault atomic, delete bloqueado por default o por
curso en uso, getEffectiveTemplate con jerarquía, name-taken,
not-found).

**Pendiente para PR posterior**:

- Embed real del logo en el PDF (descarga URL → buffer → image en pdfkit
  con timeout). Hoy `logoUrl` se persiste pero el renderer aún no lo
  consume.
- Uploader de logo al storage del tenant (en lugar de URL pública).
- Vista previa del PDF en la página de templates antes de guardar.

### Sesión 2026-04-27 — HU-TA-002 (toggle de módulos por tenant)

Historia Notion **HU-TA-002 / LMS-64** (P0, Fase 1.A) cerrada. El `tenant_admin`
ahora puede activar/desactivar módulos del producto desde
`/admin/configuracion` → tab "Módulos".

Cambios funcionales:

- **Persistencia real**: `ModuleRegistryService` siembra la tabla `module` con
  los manifests de los 7 módulos cargados al boot (idempotente, upsert por
  nombre con version + displayName + description + manifest JSON).
- **`TenantModulesService`**: list (estado efectivo = fila en `tenant_module`
  o `enabledByDefault`), enable (registry + upsert + audit + evento
  `tenant.module.enabled`), disable con validación de dependientes activos
  (chequea `manifest.dependencies.modules`, no las opcionales).
- **Cascada con confirmación**: si tratás de desactivar un módulo del que
  dependen otros activos, la API responde 409 con
  `code: MODULE_HAS_ACTIVE_DEPENDENTS` + `details.dependents`. La UI muestra
  un panel de confirmación; al confirmar manda `?force=true` y se desactivan
  todos en cascada.
- **Endpoints HTTP** `tenant_admin` o `super_admin`:
  `GET /admin/modules`, `POST /admin/modules/:name/enable`,
  `POST /admin/modules/:name/disable[?force=true]`.
- **UI**: nueva tab "Módulos" en `/admin/configuracion` con cards (nombre,
  versión, descripción, estado, deps, dependents) + toggle.
- **Audit log + eventos** en cada toggle (`admin.module.enabled` /
  `admin.module.disabled`).

**Tests**: 13 unit del `TenantModulesService` con prisma fake (list, enable
idempotente, disable con/sin force, dependents detectados, cascade audit
con metadata, optionalModules ignoradas).

**Pendiente para PR posterior** (deliberadamente fuera de scope):

- **Guard runtime que bloquee endpoints de módulos desactivados**. Hoy el
  estado se persiste pero no se chequea en cada request. El Gherkin del
  escenario 1 dice "endpoints `/api/v1/modules/community/*` responden 200
  cuando se activa" — implica que cuando NO está activado deberían responder
  403/404. Implementarlo ahora rompería los tenants existentes (todos los
  módulos arrancan con `enabledByDefault: true` para preservar
  funcionalidad). El guard requiere: (a) hook en cada controller, (b)
  cache para no consultar DB en cada request, (c) decisión sobre el código
  HTTP de respuesta (404 "no existe" vs 403 "no activo"). Issue separado.
- **Per-tenant default override desde `/admin/configuracion` Module catalog**
  (super_admin ve catálogo completo, tenant_admin solo los suyos).

### Sesión 2026-04-26 noche — Sprint 1 inmediato (Notion-as-bible)

Tras descubrir que el roadmap real vive en Notion (database "LMS Ship — Work Items"),
no en el brief de dogfooding, hicimos gap analysis y arrancamos el Sprint 1 con
las historias P0/P1 más críticas pendientes.

| PR | Historia Notion | Tipo | Prioridad |
|---|---|---|---|
| #111 | HU-SA-001 + LMS-110 (tenant transparente + super_admin tenants) | Historia + Tarea | P0 |
| #112 | HU-USR-001 (perfil + seguridad del usuario) — creada en Notion | Historia | P1 |
| #113 | HU-FORM-002 (listado alumnos por curso) — creada en Notion | Historia | P1 |

Workflow establecido: **Notion como única fuente de verdad** de las historias.
Antes de cada PR se lee la historia, se actualiza estado a "En curso", al
mergear se marca "Hecho". Las historias que faltan en Notion se crean con
criterios Gherkin completos antes de implementar.

Cambios funcionales clave:

- **Tenant transparente**: el alumno ya NO escribe el slug en signin/signup.
  El sistema resuelve por Host header (tabla `tenant_domain`) o por email
  único entre tenants. Si email matchea múltiples → selector de candidatos.
- **Super_admin CRUD de tenants**: `/admin/tenants` con crear (alta + admin
  + dominio + email de bienvenida), suspender (invalida sessions de TODO
  el tenant), añadir/quitar dominios.
- **Perfil del usuario**: `/cuenta` (avatar URL, nombre, idioma,
  timezone IANA) + `/cuenta/seguridad` (cambiar password con verificación
  de actual + invalidación de sessions, listado de sessions activas con
  revocación selectiva o total, link a MFA setup).
- **Listado de alumnos por curso**: `/formador/cursos/[id]/alumnos` con
  tabla sortable por nombre/progreso/fecha, filtros por status, stats
  agregadas, export CSV.

Schemas nuevos:
- `tenant_domain` (HU-SA-001/LMS-110) con índice parcial UNIQUE para 1
  primary por tenant.
- `user.timezone` + `user.avatar_url` (HU-USR-001).

Despliegue post-merge:
1. `pnpm --filter @didacta/database db:migrate:deploy` aplica migraciones
   `20260426000005_add_tenant_domain` y `20260427000001_add_user_profile_fields`.
2. Re-correr seed con `BOOTSTRAP_DOMAINS='localhost,lab-learnship.3qntut.easypanel.host'`
   para sembrar los hosts del tenant del bootstrap.
3. Smoke: signin sin tenant slug → debería identificar tenant por host.

### Sesión 2026-04-26 tarde (Bloques 0/A/B/C/D) — TODOS MERGEADOS

| PR | Título | Estado |
|---|---|---|
| #85 | feat(web): foundation de design tokens + skill pixel-perfect-ui (PR A) | merged |
| #86 | feat(theming): scaffold mod.theming v0.1 + schema + tests (PR B1) | merged |
| #92 | feat(theming): API endpoints + SSR-ready theme injection (PR B2) | merged |
| #93 | feat(web): UI /admin/branding con preview live (PR B3) | merged |
| #94 | feat(auth): forgot-password + reset-password con SMTP per-tenant (PR C1) | merged |
| #95 | feat(admin): CRUD de usuarios del tenant + UI completa (PR C2) | merged |
| #96 | feat(admin): UI /admin/auditoria con verificación de cadena + filtros + export CSV (PR C3) | merged |
| #91 | docs(estado): cierre de Bloques 0/A/B/C | merged |
| #97 | feat(web): rediseño visual de signin / signup / auth layout (PR D1) | merged |
| #98 | feat(web): rediseño catálogo + detalle de curso (PR D2) | merged |
| #99 | feat(web): rediseño player de lección — REDISEÑO MAYOR (PR D3) | merged |
| #100 | feat(web): rediseño quiz player con resultado hero + estados visuales (PR D4) | merged |
| #101 | feat(web): rediseño certificados + notificaciones (PR D5) | merged |
| #102 | feat(web): rediseño formador + admin con tokens y tabs (PR D6+D7+D8) | merged |

**14 PRs cerrados en una corrida**. La main ahora tiene:
- Sistema de design tokens HSL escalables consumido por todos los componentes shadcn.
- mod.theming v0.1 funcional end-to-end con UI `/admin/branding`.
- Self-service de forgot/reset password con SMTP per-tenant.
- CRUD completo de usuarios admin (`/admin/usuarios`) + audit log UI (`/admin/auditoria`).
- Rediseño visual aplicando skill `pixel-perfect-ui` a todas las pantallas P0 del brief de dogfooding.

**Pendiente** (follow-ups, no entró en esta sesión):
- D7-bis: editor del curso (`/formador/cursos/[id]`) y editor de quiz (`/formador/quizzes/[id]`) — drag/drop reordenable que merece PR dedicado.
- D7-ter: detalle de corrección manual (`/formador/correcciones/[id]`) — form de grading por respuesta abierta.
- MFA setup/verify rediseño (D1.5) — flow largo con QR + recovery codes.
- Mobile testing real device + E2E specs nuevos para los flujos rediseñados.

---

## 12. Comandos útiles que olvido

```bash
# Levantar el stack en dev (turbo levanta web 3000 + api 4000 en watch)
pnpm dev

# Solo el web
pnpm --filter @didacta/web dev

# Solo el api
pnpm --filter @didacta/api dev

# Re-build de un módulo (necesario tras cambiar mod-X y antes del typecheck del api)
pnpm --filter @didacta/mod-certificates build

# Typecheck/test del monorepo entero (turbo orquesta)
pnpm typecheck
pnpm test

# Typecheck/test de un solo paquete
pnpm --filter @didacta/api typecheck
pnpm --filter @didacta/mod-assessments test

# Format check (CRLF en Windows puede ensuciar la salida — ver gotchas)
pnpm format:check

# Format auto-fix
pnpm format

# Re-generar Prisma tras cambios en schema.prisma
pnpm --filter @didacta/database db:generate

# Crear nueva migration
pnpm --filter @didacta/database db:migrate:dev --name <descripción>

# Aplicar migrations pendientes
pnpm --filter @didacta/database db:migrate:deploy

# Re-seed (idempotente)
BOOTSTRAP_PASSWORD='...' pnpm --filter @didacta/database db:seed

# Inspeccionar la BD desde CLI
pnpm --filter @didacta/database exec prisma studio

# Correr E2E local (con dev levantado en otra terminal)
E2E_ADMIN_EMAIL=valen@va360labs.com \
E2E_ADMIN_PASSWORD='...' \
pnpm --filter @didacta/e2e test:e2e

# Ver el reporte HTML de Playwright tras un fail
pnpm --filter @didacta/e2e exec playwright show-report

# Crear un PR rápido con gh
gh pr create --title "..." --body "..."

# Esperar que pase CI y mergear
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

---

## 13. Referencias rápidas

| Necesito... | Mirar en... |
|---|---|
| Variables de entorno para deploy | `docs/test.env.md` |
| Plan completo de fases del PRD | `docs/PLAN-FASES.md` |
| Contrato de módulo (cómo se construye un mod.X nuevo) | `docs/ARQUITECTURA-MODULAR.md` |
| PRD completo | `docs/PRD.md` |
| Convenciones de commits / branches | `CLAUDE.md` global del usuario + sección 8 de este doc |
| Cómo correr E2E en local | sección 12 de este doc + `apps/e2e/README.md` |
| ADRs (cuando existan) | `docs/adrs/` |
| Notion (planificación viva) | https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4 |
| Repo GitHub | https://github.com/va360labs/didacta |
| App productiva | https://lab-learnship.3qntut.easypanel.host (legacy URL pre-rebrand) |

---

## 14. Para el próximo asistente / próximo PC

1. **Leer este doc completo antes de tocar código**. Especialmente la sección 7 (decisiones) y la sección 10 (roadmap pendiente).
2. **No empezar features grandes sin sign-off**. La sesión 2026-04-26 cerró 28 PRs en una corrida, agotando todo lo accionable sin guidance. Lo que queda son: (a) items bloqueados por infra externa, (b) módulos grandes de Fase 1.B que necesitan planning con stakeholder, (c) polish que se prioriza bajo demanda.
3. **Antes de cualquier comando que toque la DB de Easypanel**, leer la sección 2.3 (procedimiento de baseline migration). Si la DB ya tiene `0_init` aplicado pero el `_prisma_migrations` table no lo refleja, el deploy fallará con "table already exists".
4. **No tocar el contrato de módulo** (`packages/core-kernel/src/module/module.ts`) sin ADR aprobada — es SemVer estricto y rompe todos los módulos.
5. **Antes de hacer un `git push --force`**, usar `--force-with-lease` para no sobrescribir cambios remotos accidentalmente.
6. **El audit log de un tenant**: una vez escrito, no se modifica. Si necesitás "limpiar" para tests, hacer `prisma migrate reset` (borra DB completa) o `DELETE FROM audit_log WHERE tenant_id = '...'` desde Studio (rompe la cadena, hay que regenerarla).
7. **Reglas que NO se negocian** — ver sección 8.5.

---

**FIN ESTADO.md** — Para dudas o handoff verbal: `valen@va360labs.com`.
