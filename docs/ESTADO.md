# Estado del proyecto — punto de retomada

> **Última actualización**: 2026-04-26 (sesión maratón: 27 PRs)
> **Por**: Valentín Ayesa (`valen@va360labs.com`)
> **Objetivo de este doc**: que cualquier sesión nueva (otro equipo, otra IA) pueda retomar exactamente donde quedó la anterior.

---

## TL;DR

- **27 PRs consecutivos cerrados esta sesión** (#44–#70).
- **`mod.assessments` cerrado en v0.3**: 6 tipos de pregunta (4 auto-corregidos + 2 con corrección manual), bridge a `mod.learning`, UI completa formador y alumno.
- **`mod.community` cerrado en v0.1** (Fase 1.B arrancada): posts + comments + reacciones por emoji con UI alumno en `/comunidad`. Sin nested replies ni moderación todavía.
- **NotificationHub real**: persistencia + bandeja IN_APP en `/notificaciones` con bell badge en el header. EMAIL stub listo para SMTP.
- **Dashboard del formador**: `/formador` con stats agregadas (cursos, matriculaciones, % progreso, correcciones pendientes).
- **Editor de cursos pulido**: reordenar lecciones (▲ ▼), eliminar módulo con cascade lógico.
- **Migraciones versionadas** (`prisma migrate deploy`) + **audit log con IP+UA**.
- Aplicación funcional end-to-end en Easypanel: `https://lab-learnship.3qntut.easypanel.host`.
- **173 tests verdes** en CI principal (101 unitarios api + 72 en módulos). **5 specs E2E** Playwright.
- Módulos cargados al boot: `mod.hello-world`, `mod.courses`, `mod.learning`, `mod.certificates`, `mod.assessments`, **`mod.community`**.
- **Items pendientes del roadmap**: 3 bloqueados por infra externa (Redis, S3, SMTP) + 2 módulos grandes de Fase 1.B (`mod.zoom-live` necesita credenciales Zoom; `mod.fundae` necesita planning con stakeholder).

---

## Cómo retomar en otra máquina (checklist)

```bash
# 1. Clonar
git clone https://github.com/va360labs/learnship.git
cd learnship

# 2. Node 22 (.nvmrc) + pnpm 10.21.0 + Postgres 16 local o remota
nvm use
corepack enable
corepack use pnpm@10.21.0  # o `npm install -g pnpm@10.21.0` si corepack falla

# 3. Variables de entorno
cp env.example .env
# Editar .env: DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, BOOTSTRAP_*, etc.
# Para deploy hay docs/test.env.md con todo lo que pide Easypanel.

# 4. Instalar + generar Prisma + aplicar migraciones + sembrar DB
pnpm install
pnpm --filter @learnship/database db:generate
pnpm --filter @learnship/database db:migrate:deploy   # aplica migrations versionadas
BOOTSTRAP_PASSWORD='tu-password-12chars' pnpm --filter @learnship/database db:seed

# 5. Levantar dev
pnpm dev   # Turbo levanta web (3000) + api (4000)

# 6. Verificar tests
pnpm typecheck && pnpm test && pnpm format:check

# 7. Login en el browser
# http://localhost:3000/signin
# tenant=va360, email=valen@va360labs.com (o lo que pusiste en BOOTSTRAP_EMAIL), password=tu-password
```

Para el deploy en Easypanel: ver `docs/test.env.md`.

---

## Trabajo en curso

Ninguno. Todo lo iniciado en esta sesión quedó cerrado y mergeado a main (PRs #44–70, 27 PRs).

---

## Roadmap inmediato — todos bloqueados por infra

| # | Item | Por qué | Esfuerzo | Bloqueo |
|---|---|---|---|---|
| 1 | **mod.outbox real con BullMQ + Redis** | Ya hay outbox persistente, pero el dispatch sigue siendo in-process. | 1 sesión + infra | **Redis en Easypanel** |
| 2 | **MinIO/S3 storage para producción** | Hoy se usa LocalDiskStorageService. Para prod hace falta storage compartido entre instancias. | 1 sesión | **S3 / MinIO** |
| 3 | **Adapter SMTP real** (NotificationHub) | El branch EMAIL en `prisma-notification-hub.service.ts` ya está listo para que se sustituya por SMTP/Resend/SES sin tocar el contrato. | < 1 sesión | **SMTP** |

> Ningún item del roadmap conocido es accionable sin estos 3 desbloqueos.

## Próximo paso recomendado

Restantes de Fase 1.B + polish:

- **`mod.zoom-live`** — aula virtual con Zoom API + SDK Web. **Bloqueado por credenciales Zoom**.
- **`mod.fundae`** — cumplimiento sectorial Fundae (RD 694/2017). **Bloqueado por planning con stakeholder** (cómo funciona Fundae a fondo).
- **Polish de `mod.community`** — moderación (flagging + admin panel), nested replies, menciones (`@usuario`), notificaciones via NotificationHub cuando alguien responde a tu post.
- **Per-tenant notification templates** — UX para tenant_admin que customiza el copy de cada plantilla.
- **Drag & drop visual de lecciones** en el editor (las flechas ▲▼ funcionan, pero un DnD sería más natural).
- **Webhook adapter en NotificationHub** — defer hasta caso de uso concreto.

## Items aún bloqueados por infra externa

| # | Item | Bloqueo |
|---|---|---|
| 1 | `mod.outbox` real con BullMQ + Redis | **Redis en Easypanel** |
| 2 | MinIO/S3 storage para producción | **S3 / MinIO** |
| 3 | Adapter SMTP real (NotificationHub) | **SMTP** |

Detalle completo en `docs/PLAN-FASES.md`.

---

## Mapa del código (resumen)

```
apps/
  api/                    # NestJS 10 + Fastify
    src/
      auth/               # JWT con jose, MFA TOTP con otplib, argon2
        auth.module.ts    # Importa PrismaAuditLogService
        auth.service.ts   # Audita signup/signin
        mfa.controller.ts # Audita MFA enable/verify
      modules/
        module-context.factory.ts   # Wirea TODOS los servicios (sin stubs)
        module-registry.service.ts  # Registra módulos + expone services
        persistent-event-bus.ts     # Outbox pattern (PR 37)
        outbox-recovery.worker.ts   # Reprocesa pendientes cada 30s
        prisma-audit-log.service.ts # Hash chain por tenant (PR 38, 41 en curso)
        prisma-evidence-vault.service.ts # SHA-256 + idempotente (PR 38)
        local-disk-storage.service.ts    # STORAGE_ROOT (PR 38)
        certificates.controller.ts  # GET /me, /:id, /:id/download (PR 36)
        courses.controller.ts       # CRUD cursos
        learning.controller.ts      # Matrícula + progreso
        audit.controller.ts         # GET /audit/verify, super_admin/tenant_admin only (PR 42)
        assessments.controller.ts   # CRUD quizzes (formador role) (PR 45)
        assessments-attempts.controller.ts # Flujo alumno (PR 46)
        assessments-error.filter.ts # Mapping AssessmentsError → HTTP (PR 45)
        assessments-learning.bridge.ts # Subscribe a assessments.attempt.passed → trackProgress (PR 47)
        modules.module.ts           # Registra TODOS los controllers + providers
      prisma/             # PrismaService inyectable
      ...
    tests/                # 68 tests unitarios (vitest)

  web/                    # Next.js 15 (App Router) + React 19 + Tailwind 4
    src/
      app/
        (app)/cursos/[slug]/page.tsx   # Detalle del curso (con cert si COMPLETED)
        (app)/cursos/page.tsx          # Catálogo
        (app)/mis-certificados/page.tsx # Listado certificados (PR 36)
        (app)/formador/cursos/...      # Editor del formador (PR 35)
        (auth)/{signin,signup,mfa}/    # Flujo auth
      lib/
        api-client.ts     # apiFetch + ApiHttpError
        auth-storage.ts   # Tokens en sessionStorage + localStorage
        certificates.ts   # Cliente para /modules/certificates (PR 36)
        courses.ts        # Cliente cursos
        learning.ts       # Cliente learning

  e2e/                    # Playwright (PR 39)
    helpers/api.ts        # bootstrapScenario crea admin + curso + alumno
    helpers/auth.ts       # injectSession en localStorage del browser
    tests/golden-path.spec.ts # Spec único: alumno completa curso, descarga cert

modules/                  # Módulos de negocio (contrato LearnShipModule)
  hello-world/            # Módulo de prueba
  courses/                # mod.courses (estructura, lecciones, publish)
  learning/               # mod.learning (matrícula, progreso, invitaciones)
  certificates/           # mod.certificates (PDF, idempotente, EvidenceVault)
  assessments/            # mod.assessments (quizzes + scoring engine puro + 25 tests)

packages/
  core-kernel/            # Tipos del contrato de módulo (ModuleContext, EventBus, etc.)
  core-registry/          # ModuleRegistry + DependencyResolver
  database/               # PrismaClient + seed + schema.prisma
```

---

## Decisiones clave (para no repetirlas)

### Stack
- **NestJS 10** (no migrar a 11 hasta que `nestjs-pino` lo soporte sin pelea)
- **CommonJS en TODO el monorepo** (NestJS necesita CJS por decoradores; cualquier `"type": "module"` en un workspace package rompe el build de api)
- **Fastify** sobre Express (más rápido, mejor con TS)
- **`prisma migrate deploy/dev`** versionado en `packages/database/prisma/migrations/` (baseline `0_init` capturado tras cerrar `mod.assessments`). Para una nueva máquina: `pnpm --filter @learnship/database db:migrate:deploy`. Para cambios de schema: editar `schema.prisma` y `pnpm --filter @learnship/database db:migrate:dev --name <descripción>`.
- **JWT con jose + HS256** (ADR pendiente para pasar a RS256 cuando haya rotación de keys)
- **argon2id** para passwords (no bcrypt, por memory cost)

### Arquitectura
- **Sin pgvector hasta Fase 1.C** (Easypanel pg17 no lo trae; cuando active mod.ai-tutor cambiar imagen a pgvector/pgvector:pg16)
- **Sin Redis hasta que Easypanel lo provea** — patrón Outbox persistente in-process es el reemplazo intermedio (PR 37)
- **Sin BullMQ todavía** por la misma razón
- **`STORAGE_ROOT` env** para mover el storage local a un volumen de Easypanel sin cambiar código
- **MFA solo para `super_admin` y `tenant_admin`** (NO `formador` ni `alumno`) — definición en `auth.service.ts:ADMIN_ROLES`
- **Hash chain del audit log es por tenant**, no global — evita contención entre tenants. Concurrencia intra-tenant queda con riesgo de mismo prev_hash hasta Fase 2 (`pg_advisory_xact_lock(tenantId)`)
- **Snapshot inmutable en certificate.snapshot**: si renombras el curso o el alumno, el certificado conserva la versión original

### Anti-patrones que ya encontramos
- `@UsePipes(...)` a nivel handler valida TODOS los args (incluido `@CurrentUser()`) — usar `@Body(new ZodValidationPipe(...))` en su lugar.
- Workspace package con `main: dist/index.js` necesita build previo. Sin build de mod-X, apps/api da `TS2307`. CI lo hace solo, en local hay que correr `pnpm --filter @learnship/mod-X build` antes del typecheck.
- Para descargar PDFs con bearer auth, NO usar `<a href>` (no soporta cabeceras). Hay que hacer fetch → blob → URL.createObjectURL → click programático.
- pdfkit no requiere fonts externas (Helvetica embebido) ni native deps → ideal Docker.
- corepack falla con EACCES en Easypanel. Solución: `npm install -g pnpm@10.21.0`.

---

## Referencias rápidas

| Necesito... | Mirar en... |
|---|---|
| Variables de entorno para deploy | `docs/test.env.md` |
| Plan completo de fases | `docs/PLAN-FASES.md` |
| Contrato de módulo | `docs/ARQUITECTURA-MODULAR.md` |
| PRD completo | `docs/PRD.md` |
| Convenciones de commits / branches | `CLAUDE.md` y `CONTRIBUTING.md` |
| Cómo correr E2E | `apps/e2e/README.md` |
| ADRs (cuando existan) | `docs/adrs/` |

---

## Estado de PRs en GitHub

| PR | Título | Estado |
|---|---|---|
| #1-#34 | Bootstrap + Fase 0 + Fase 1.A inicial | merged |
| #35 | feat(courses): editor de contenido por tipo de lección | merged |
| #36 | feat(certificates): mod.certificates con emisión automática y descarga PDF | merged |
| #37 | feat(events): EventBus persistente con patrón Transactional Outbox | merged |
| #38 | feat(core): AuditLog, EvidenceVault y Storage funcionales | merged |
| #39 | test(e2e): tests Playwright del golden path del alumno | merged |
| #40 | feat(audit): registrar eventos clave en audit_log y evidence_vault | merged |
| #42 | feat(audit): endpoint /audit/verify para validar la cadena de hashes | merged |
| #44 | feat(assessments): scaffold mod.assessments + scoring engine | merged |
| #45 | feat(assessments): endpoints HTTP del formador | merged |
| #46 | feat(assessments): endpoints del alumno (start/submit attempt) | merged |
| #47 | feat(assessments): bridge mod.assessments → mod.learning | merged |
| #48 | feat(assessments): UI formador del editor de quiz | merged |
| #49 | feat(assessments): UI alumno del player de quiz | merged |
| #51 | chore(db): baseline `0_init` + switch a prisma migrate deploy | merged |
| #52 | feat(audit): IP + user-agent reales | merged |
| #53 | test(e2e): specs Playwright (quiz alumno + matrícula por código) | merged |
| #54 | feat(assessments): tipo FILL_IN_BLANK con auto-corrección (v0.2) | merged |
| #55 | feat(assessments): SHORT/LONG_ANSWER + corrección manual (v0.3) | merged |
| #56 | feat(assessments): UI detalle de corrección manual + endpoint formador | merged |
| #58 | test(e2e): spec del flujo end-to-end de corrección manual (SHORT_ANSWER) | merged |
| #59 | test(e2e): spec del flujo MFA admin (setup + enable con TOTP) | merged |
| #60 | feat(courses): polish del editor del formador (reordenar lecciones + eliminar módulo) | merged |
| #61 | feat(core): NotificationHub real con persistencia + bandeja in-app del alumno | merged |
| #62 | feat(web): bell de notificaciones con badge de no leídas en el header | merged |
| #64 | test: cobertura unitaria de NotificationHub (service + bridge) | merged |
| #65 | test(assessments): cobertura de gradeAttempt (corrección manual) | merged |
| #66 | feat(formador): dashboard con stats agregadas del tenant | merged |
| #68 | feat(community): scaffold mod.community + service + 17 tests (PR A) | merged |
| #69 | feat(community): endpoints HTTP del módulo community (PR B) | merged |
| #70 | feat(community): UI alumno (lista + detalle + reacciones) (PR C) | merged |

---

## Comandos útiles que olvido

```bash
# Levantar el stack en dev
pnpm dev

# Solo el web
pnpm --filter @learnship/web dev

# Solo el api
pnpm --filter @learnship/api dev

# Re-build de un módulo (necesario tras cambiar mod-X)
pnpm --filter @learnship/mod-certificates build

# Re-generar Prisma tras cambios en schema.prisma
pnpm --filter @learnship/database db:generate

# Crear nueva migración tras editar schema.prisma (la aplica al instante en local)
pnpm --filter @learnship/database db:migrate:dev --name <descripción-corta>

# Aplicar todas las migraciones pendientes (CI / nueva máquina / Easypanel)
pnpm --filter @learnship/database db:migrate:deploy

# Re-seed (idempotente)
BOOTSTRAP_PASSWORD='...' pnpm --filter @learnship/database db:seed

# Correr E2E local
E2E_ADMIN_EMAIL=valen@va360labs.com \
E2E_ADMIN_PASSWORD='...' \
pnpm --filter @learnship/e2e test:e2e

# Ver el reporte HTML de Playwright tras un fail
pnpm --filter @learnship/e2e exec playwright show-report

# Inspeccionar la BD desde CLI
pnpm --filter @learnship/database exec prisma studio
```

---

## Para el próximo asistente / próximo PC

1. Leer este doc completo. **No empezar a tocar código sin entender el "Trabajo en curso".**
2. No hay rama abierta. Mirar la tabla "Roadmap inmediato" y proponer el siguiente item al usuario antes de tocar.
3. **Reglas que NO se negocian** (ver `CLAUDE.md` global):
   - Commits en español, conventional commits, SIN `Co-Authored-By` ni referencias a IA
   - 1 PR por feature, ramas por feature, squash-merge
   - Verificar antes de afirmar; si el user dice algo técnicamente raro, decir "dejame verificar"
   - No usar `cat`/`grep`/`find`/`sed`/`ls` — usar `bat`/`rg`/`fd`/`sd`/`eza`
