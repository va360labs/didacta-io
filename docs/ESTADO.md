# Estado del proyecto — punto de retomada

> **Última actualización**: 2026-04-25
> **Por**: Valentín Ayesa (`valen@va360labs.com`)
> **Objetivo de este doc**: que cualquier sesión nueva (otro equipo, otra IA) pueda retomar exactamente donde quedó la anterior.

---

## TL;DR

- **Fase 1.A** del plan está al ~90 %. Falta solo el **endpoint público de verificación de la cadena de auditoría** (PR 41, en curso, ver "Trabajo en curso" más abajo).
- Aplicación funcional end-to-end en Easypanel: `https://lab-learnship.3qntut.easypanel.host`.
- El alumno puede registrarse, matricularse, completar un curso y descargar su certificado PDF.
- Todos los servicios core (EventBus, AuditLog, EvidenceVault, Storage) son **reales** — ya no quedan stubs en `module-context.factory`.
- 49 tests unitarios en `apps/api` + 23 tests en módulos = **72 tests verdes** en CI principal. E2E con Playwright (1 spec) corre en workflow separado, no bloquea PRs.

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

## Trabajo en curso (PR 41 — `feat/T-1A-018-audit-verify`)

**Rama**: `feat/T-1A-018-audit-verify` — pusheada al remoto con un commit `wip(audit): verifyChain + AuditController (sin registrar en módulo, sin tests)`.

Lo que falta para cerrar PR 41:

1. **Registrar `AuditController`** en `apps/api/src/modules/modules.module.ts` (añadir a `controllers: [...]`).
2. **Tests del `verifyChain`** en `apps/api/tests/audit-log.test.ts` (caso válido + caso corrupto: editar la fila intermedia y comprobar que `firstBrokenId` apunta a esa fila o la siguiente).
3. **Format + commit final** (squash el `wip`), abrir PR, esperar CI verde, mergear con `--squash --delete-branch`.

Snippet sugerido para el test:

```ts
it('detecta tampering: si se modifica el metadata de una fila vieja, la cadena se rompe', async () => {
  const prisma = makeFakePrisma();
  const svc = new PrismaAuditLogService(prisma as never);
  await svc.record({ tenantId: 't1', actorId: 'u1', action: 'a', resourceType: 'r', resourceId: 'r1' });
  await svc.record({ tenantId: 't1', actorId: 'u1', action: 'b', resourceType: 'r', resourceId: 'r2' });
  await svc.record({ tenantId: 't1', actorId: 'u1', action: 'c', resourceType: 'r', resourceId: 'r3' });

  // Tampering: alguien modifica metadata de la 2ª fila sin recalcular el hash
  prisma._rows[1].metadata = { mutado: true };

  const result = await svc.verifyChain('t1');
  expect(result.valid).toBe(false);
  expect(result.firstBrokenId).toBe('2');
});
```

Recordatorio: el endpoint solo permite `super_admin` y `tenant_admin`, y siempre verifica la cadena del **tenant del usuario** (no acepta tenantId arbitrario en el path por seguridad).

---

## Roadmap inmediato (en orden de prioridad)

| # | Item | Por qué | Esfuerzo |
|---|---|---|---|
| 1 | **PR 41 — audit verify** (en curso, ver arriba) | Cierra el ciclo del audit log: ahora es verificable, no solo registrable. | < 1 sesión |
| 2 | **mod.assessments** (quizzes) | Sin quizzes, los cursos no validan aprendizaje. Era el item original diferido en Fase 1.A. | 1-2 sesiones |
| 3 | **Versionar migraciones con `prisma migrate dev`** | Hoy se usa `prisma db push` (no genera migraciones). Al estabilizar schema, hay que migrar a migrate-style. | 1 sesión |
| 4 | **Llamadas explícitas a `auditLog.record()` con IP + UA** | Hoy las metadata no llevan IP ni user-agent. Hay que pasar el `request` desde controllers. | < 1 sesión |
| 5 | **mod.outbox real con BullMQ + Redis** | Ya hay outbox persistente, pero el dispatch sigue siendo in-process. Cuando Easypanel tenga Redis, se reemplaza el processor. | 1 sesión + infra |
| 6 | **MinIO/S3 storage para producción** | Hoy se usa LocalDiskStorageService. Para prod hace falta storage compartido entre instancias. | 1 sesión |
| 7 | **Más specs E2E** | Solo hay golden path. Faltan: invitación por código, MFA admin, edición por formador. | 1-2 sesiones |
| 8 | **Notificaciones reales (NotificationHub)** | Sigue siendo stub. El alumno no recibe email al matricularse ni al obtener certificado. | 1-2 sesiones + SMTP |

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
        audit.controller.ts         # GET /verify (PR 41 WIP — falta registrar)
        modules.module.ts           # Registra TODOS los controllers + providers
      prisma/             # PrismaService inyectable
      ...
    tests/                # 49 tests unitarios (vitest)

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
| **WIP** | feat(audit): endpoint /audit/verify para validar cadena de hashes | rama `feat/T-1A-018-audit-verify` pusheada, sin PR todavía |

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
2. Si vas a continuar PR 41, hacer `git checkout feat/T-1A-018-audit-verify` y seguir desde el commit `wip(audit): verifyChain + AuditController (sin registrar en módulo, sin tests)`.
3. Si vas a empezar algo nuevo, mirar la tabla "Roadmap inmediato" y proponer el siguiente item al usuario antes de tocar.
4. **Reglas que NO se negocian** (ver `CLAUDE.md` global):
   - Commits en español, conventional commits, SIN `Co-Authored-By` ni referencias a IA
   - 1 PR por feature, ramas por feature, squash-merge
   - Verificar antes de afirmar; si el user dice algo técnicamente raro, decir "dejame verificar"
   - No usar `cat`/`grep`/`find`/`sed`/`ls` — usar `bat`/`rg`/`fd`/`sd`/`eza`
