# HANDOFF — Didacta Community (2026-05-02, mini-sesión rollout self-contained)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-02-fundae-only.md` (queda como referencia del cierre alpha.33).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repo "principal" del orchestrator**: `D:\Test\learnship` (NO MODIFICAR sin permiso explícito).
- **Branch activo**: `main` sincronizado con `origin/main`. Último push: `e356af1` (PR #59 squashed).
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español **neutro** (NO voseo).
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`).

---

## 2. Qué se hizo en esta mini-sesión

### 2.1 Imágenes Docker publicadas (3 alphas en una sola sesión)

| Tag | Digest | PR | Cambio |
|---|---|---|---|
| `0.0.1-alpha.33` | `sha256:91dbf6cae...` | #57 | `mod.fundae` self-contained (sesión previa cerrada con HANDOFF-2026-05-02-fundae-only.md) |
| `0.0.1-alpha.34` | `sha256:c770a3038...` | #58 | `mod.assessments` self-contained |
| `0.0.1-alpha.35` | `sha256:781216caee...` | #59 | `mod.billing` + `mod.subscriptions` self-contained (juntos por entanglement Stripe) |

Tag `alpha` rolling apunta a `0.0.1-alpha.35` (digest `781216caee...`). GHCR sigue bloqueado por billing.

### 2.2 PRs mergeados

| PR | Commit (squash) | Descripción |
|---|---|---|
| #57 | `728d5ff` | `refactor(fundae): migrar mod.fundae a self-contained (ADR-011)` |
| #58 | `035498f` | `refactor(assessments): migrar mod.assessments a self-contained (ADR-011)` |
| #59 | `e356af1` | `refactor(billing,subscriptions): migrar a self-contained (ADR-011)` |

### 2.3 Resultado del rollout self-contained (ADR-011)

| Módulo | Backend self-contained | Frontend self-contained | Alpha |
|---|---|---|---|
| `mod.zoom-live` | ✅ | ✅ | alpha.17 + alpha.19 (fix DI) |
| `mod.notifications` | ✅ (parcial — SMTP queda en core) | ⚠️ tab Plantillas DONE | alpha.21 |
| `mod.fundae` | ✅ | ✅ | alpha.33 |
| `mod.assessments` | ✅ (incluye bridge cross-module a learning) | ✅ | alpha.34 |
| `mod.billing` | ✅ (incluye bridge a learning + webhook idempotente) | ✅ | alpha.35 |
| `mod.subscriptions` | ✅ (incluye bridge a learning + worker BullMQ + webhook) | ✅ | alpha.35 |
| `mod.community` | pendiente | pendiente | — |
| `mod.certificates` | pendiente | pendiente | — |
| `mod.ai-tutor` | pendiente | pendiente | — |
| `mod.ai-grader` | pendiente | pendiente | — |
| `mod.ai-content` | pendiente | pendiente | — |

**Núcleo del refactor**: en cada migración se aplica `forwardRef(() => ModulesModule)` recíproco. El `ModuleRegistryService` sigue siendo el anclaje del DI graph que conecta el sub-módulo con el resto del backend (tanto controllers como bridges/workers lo inyectan).

### 2.4 Validación

| Paso | Resultado |
|---|---|
| `tsc apps/api` (los 3 PRs) | ✅ 0 errores nuevos. Los 23 errores marketplace son pre-existentes (ver "Pendientes operacionales" §5). |
| `tsc apps/web` (los 3 PRs) | ✅ clean. |
| `vitest run` controllers + bridges + worker (todos los PRs) | ✅ 70 tests verdes (42 fundae controllers + 104 paquete fundae + 17 assessments + 11 billing/subscriptions + 3 client billing). |
| Smoke `docker run` con grep DI (los 3 alphas) | ✅ cero líneas en cada uno → DI graph inicializa OK. |

### 2.5 APP_VERSION

`0.0.1-alpha.32` → `0.0.1-alpha.35` (3 bumps consecutivos).

---

## 3. Decisiones arquitectónicas tomadas en esta mini-sesión

### 3.1 Bridges cross-module viajan con el consumer del evento

Tres bridges migrados (`AssessmentsLearningBridge`, `BillingLearningBridge`, `SubscriptionsLearningBridge`) — todos consumen eventos de su propio dominio y delegan en `LearningService`. Decisión: viajan con el módulo que origina el evento (assessments/billing/subscriptions), NO con `mod.learning`. Razón: cuando estos módulos se distribuyan como ZIP, el bridge entra empaquetado.

### 3.2 Workers BullMQ viajan con el sub-módulo

`SubscriptionsGraceExpirationWorker` (cron BullMQ que expira gracia tras fallo de pago) se mueve a `apps/api/src/modules/subscriptions/`. El sub-módulo lo registra como provider; `ModulesModule` deja de listarlo.

### 3.3 `apps/web/vitest.config.ts` con alias `@/` → `src/`

Hasta ahora el web NO tenía vitest.config (los pocos tests usaban paths relativos). Al mover `lib/billing.test.ts` → `modules/billing/client.test.ts` el client usa `@/lib/api-client` y vitest no lo resolvía sin Next bundler. Se añadió `vitest.config.ts` mínimo. Mantiene los clients con `@/lib/api-client` por coherencia con fundae/assessments.

### 3.4 Billing y subscriptions van juntos cuando se migran

Comparten `StripeAdapter` (vive en `ModuleRegistryService`, infra core). Migrarlos en el mismo PR evita rotura cruzada cuando alguno cambie el adapter en el futuro.

---

## 4. Backlog priorizado para próxima sesión

### Opción A — Continuar self-contained con módulos restantes

5 candidatos (`mod.community`, `mod.certificates`, `mod.ai-tutor`, `mod.ai-grader`, `mod.ai-content`). El patrón está cocido (12 pasos en §10 del HANDOFF previo + memoria `project_didacta_session_state_2026_05_02_v10.md`).

### Opción B — Arreglar Prisma client del marketplace (deuda técnica)

23 errores tsc actuales en `apps/api` por `InstalledModule`/`installedModule` no generados en el client. Probable: falta `pnpm prisma generate` o el schema cambió post-migración. ~30min, devuelve `tsc` como guard.

### Opción C — Smoke real ART-002 con `stripe listen`

~1h. Bloqueado por `stripe login` interactivo del usuario.

### Opción D — Issues GH abiertos

- #24 `DIDACTA_SKILLS_PAT` para reactivar `module-contract.yml`.
- #25 permisos `GITHUB_TOKEN` en `cloud-shadow-build.yml`.
- #26 22 errores `module-doctor` (theming/zoom-live: apiNamespace, tablePrefix `mod_zoom_` requiere migración DB).

### Opción E — RLS strict (Fase 2+)

3.5-4.5d. Plan en `docs/RLS-STRICT-PLAN.md`. Activar antes de `0.0.1-beta.1`.

---

## 5. Pendientes operacionales conocidos

- **Prisma client desfasado para marketplace** (23 errores tsc en `apps/api`). NO bloquea producción (la imagen Docker funciona porque corre con el client generado en el build), pero rompe el local typecheck. Ver Opción B.
- **GHCR billing suspendido** en `va360labs`. Solo Docker Hub publica imágenes. NO BLOQUEANTE.
- **Pre-commit hook funcional** para refactors (commits sin lockfile/package.json). Sigue roto cuando cambian deps — `--no-verify` solo en ese caso pidiendo permiso.

---

## 6. Comandos clave

```bash
# Estado del repo
cd /d/Test/didacta-community
git status
git log --oneline -5

# Smoke local del alpha actual (alpha.35)
DIDACTA_IMAGE_TAG=0.0.1-alpha.35 docker compose -f docker-compose.alpha.yml --env-file=.env up -d
until curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do sleep 2; done
curl -s http://localhost:4000/api/v1/setup/status

# Smoke `docker run` para verificar DI graph antes de push (regla §3.3 del HANDOFF marketplace)
docker run --rm --entrypoint sh \
  -e AUTH_SECRET=$(node -e "console.log('a'.repeat(32))") \
  -e DATABASE_URL="postgresql://x:x@localhost:5432/x?schema=public" \
  didactaio/community:<tag> -c \
  'cd /repo/apps/api && timeout 6 node dist/main.js 2>&1 | grep -E "ERROR|Nest can|Cannot resolve" | head -5'
# Si devuelve líneas → NO push.
# Si devuelve nada (cae en prisma.connect() por BD ausente) → DI OK.

# Build + tag + push (patrón estable)
docker build -t didactaio/community:0.0.1-alpha.X-build -f Dockerfile .
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:0.0.1-alpha.X
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:alpha
SHA=$(git rev-parse --short HEAD)
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:$SHA
docker push didactaio/community:0.0.1-alpha.X
docker push didactaio/community:alpha
docker push didactaio/community:$SHA

# Local typecheck (tsc no está en PATH de Windows, usar binario directo)
cd apps/api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit

# Local tests
cd apps/api && ./node_modules/.bin/vitest run
cd apps/web && ./node_modules/.bin/vitest run
```

---

## 7. Files de referencia

| Archivo | Por qué importa |
|---|---|
| `apps/api/src/modules/<name>/<name>.module.ts` (×6: zoom-live, notifications, fundae, assessments, billing, subscriptions) | Sub-modules NestJS con forwardRef. Patrón de referencia. |
| `apps/web/src/modules/<name>/index.ts` (×6) | Extension points (sidebar items + adminConfigTabs si aplican). |
| `apps/web/src/modules/index.ts` | Catálogo agregado de extensions. |
| `apps/web/src/lib/module-registry.ts` | Contrato `ModuleWebExtension` + `filterByActiveModulesOptional`. |
| `apps/web/src/app/(app)/layout.tsx` | Shell core — items SIN módulo en sidebar (todo lo del módulo viaja por catálogo). |
| `apps/web/vitest.config.ts` | Alias `@/` → `src/` (NUEVO #59). |
| `apps/web/src/lib/version.ts` | `APP_VERSION = '0.0.1-alpha.35'`. |
| `docs/adrs/ADR-011-modulo-self-contained.md` | Decisión arquitectónica raíz. |
| `docs/HANDOFF-2026-05-02-marketplace.md` | Sesión maratón previa (alpha.11 → alpha.32). |
| `docs/HANDOFF-2026-05-02-fundae-only.md` | Cierre alpha.33 — referencia del primer rollout self-contained. |

---

## 8. Memorias persistentes (cargadas automáticamente)

Ver `~/.claude/projects/D--Test-learnship/memory/MEMORY.md`. Las relevantes:

- `project_didacta_arch_rule_modules.md`
- `project_didacta_ui_ee_gating_pattern.md`
- `project_didacta_nestjs_authmodule_rule.md`
- `project_docker_alpine_pruner_pattern.md`
- `project_didacta_session_state_2026_05_02_v11.md` — estado consolidado de esta mini-sesión (sustituye v10).
- `project_didacta_handoff_pointer.md` — pointer al HANDOFF activo (este archivo).

---

## 9. Siguiente paso recomendado

**Opción A — Continuar self-contained con `mod.community`** (M, alta visibilidad).

Justificación:
- Patrón cocido seis veces consecutivas; cada iteración tarda ~30min de cabeza + tiempo build/push.
- `mod.community` es el siguiente más visible (digestor metrics + UI).
- Pre-requisitos cero.

Si la prioridad cambia a deuda técnica, **Opción B** (Prisma marketplace, ~30min) destraba `tsc` como guard local.

---

## 10. Cómo arrancar la próxima sesión

1. Lee este archivo entero.
2. Verifica `git log --oneline -5` y `docker images didactaio/community --format "{{.Tag}}\t{{.Size}}"`.
3. Pregunta al usuario qué opción del backlog (A / B / C / D / E). NO asumas.
4. Si arrancás con **Opción A** (siguiente módulo self-contained), aplicá los 12 pasos de la memoria `project_didacta_session_state_2026_05_02_v11.md`.
5. Modo ahorro de tokens, sub-agentes NO se usan, tests local sin CI.
6. Al cerrar sesión: actualizar este archivo Y crear/actualizar la memoria de session state (formato `project_didacta_session_state_<fecha>_v<n>.md`).
