# Estado del proyecto — punto de retomada

> **Última actualización**: 2026-04-25 (post `mod.assessments`)
> **Por**: Valentín Ayesa (`valen@va360labs.com`)
> **Objetivo de este doc**: que cualquier sesión nueva (otro equipo, otra IA) pueda retomar exactamente donde quedó la anterior.

---

## TL;DR

- **Fase 1.A cerrada + `mod.assessments` v0.1 cerrado** (PRs #44–49). El alumno puede ahora hacer quizzes con auto-corrección de tipos objetivos (SINGLE_CHOICE / MULTIPLE_CHOICE / TRUE_FALSE) y, si aprueba, la lección QUIZ se marca completada automáticamente vía evento.
- Aplicación funcional end-to-end en Easypanel: `https://lab-learnship.3qntut.easypanel.host`.
- El alumno puede registrarse, matricularse, **realizar quizzes**, completar un curso y descargar su certificado PDF.
- Todos los servicios core (EventBus, AuditLog, EvidenceVault, Storage) son **reales** — ya no quedan stubs en `module-context.factory`.
- 68 tests unitarios en `apps/api` + 48 tests en módulos = **116 tests verdes** en CI principal. E2E con Playwright (1 spec) corre en workflow separado, no bloquea PRs.
- Módulos cargados al boot: `mod.hello-world`, `mod.courses`, `mod.learning`, `mod.certificates`, `mod.assessments`.
- Próximo item del roadmap: **versionar migraciones con `prisma migrate dev`** (item #2).

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

# 4. Instalar + generar Prisma + sembrar DB
pnpm install
pnpm --filter @learnship/database db:generate
pnpm --filter @learnship/database exec prisma db push --skip-generate
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

Ninguno. **`mod.assessments` v0.1 cerrado** (PRs #44–49). Lo siguiente es elegir un item del "Roadmap inmediato".

---

## Roadmap inmediato (en orden de prioridad)

| # | Item | Por qué | Esfuerzo |
|---|---|---|---|
| 1 | **Versionar migraciones con `prisma migrate dev`** | Hoy se usa `prisma db push` (no genera migraciones). Con 5 modelos nuevos del módulo de assessments, ya conviene estabilizar y migrar a migrate-style antes de que el schema crezca más. | 1 sesión |
| 2 | **Llamadas explícitas a `auditLog.record()` con IP + UA** | Hoy las metadata no llevan IP ni user-agent. Hay que pasar el `request` desde controllers. | < 1 sesión |
| 3 | **mod.outbox real con BullMQ + Redis** | Ya hay outbox persistente, pero el dispatch sigue siendo in-process. Cuando Easypanel tenga Redis, se reemplaza el processor. | 1 sesión + infra |
| 4 | **MinIO/S3 storage para producción** | Hoy se usa LocalDiskStorageService. Para prod hace falta storage compartido entre instancias. | 1 sesión |
| 5 | **Más specs E2E** | Solo hay golden path. Faltan: invitación por código, MFA admin, **flujo completo de quiz alumno**, edición por formador. | 1-2 sesiones |
| 6 | **Notificaciones reales (NotificationHub)** | Sigue siendo stub. El alumno no recibe email al matricularse, al obtener certificado ni al aprobar/no aprobar un quiz. | 1-2 sesiones + SMTP |
| 7 | **mod.assessments tipos avanzados** | v0.1 solo cubre tipos objetivos. Faltan FILL_IN_BLANK, SHORT_ANSWER, LONG_ANSWER y la pipeline de corrección manual. | 2 sesiones |

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
- **prisma db push** (no migrate dev) hasta que el schema estabilice
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

# Aplicar cambios de schema sin migration files
pnpm --filter @learnship/database exec prisma db push --skip-generate --accept-data-loss

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
