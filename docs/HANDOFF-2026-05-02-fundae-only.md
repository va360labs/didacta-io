# HANDOFF — Didacta Community (2026-05-02, sesión fundae self-contained)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-02-marketplace.md` (queda como referencia del cierre alpha.32 + rollout marketplace).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repo "principal" del orchestrator**: `D:\Test\learnship` (NO MODIFICAR sin permiso explícito).
- **Branch activo**: `main` sincronizado con `origin/main`. Último push: `728d5ff`.
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español **neutro** (NO voseo) en commits, comentarios, docs y UI. Identificadores técnicos en inglés.
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`). GitHub Issues NO se usa como tracker.

---

## 2. Qué se hizo en esta sesión

### 2.1 Imagen Docker publicada

- **Registry primario**: Docker Hub, namespace `didactaio`.
  - `docker.io/didactaio/community:0.0.1-alpha.33` — sha256:`91dbf6caefb254cb2e5ce59b4f6de4d9cadaee5b74e5587a5922847dcb169803` (NUEVA esta sesión).
  - `docker.io/didactaio/community:alpha` (rolling, mismo digest).
  - `docker.io/didactaio/community:5ba5d63` (commit short SHA).
- **Tamaño**: ~1.3 GB (alpine + monorepo prunado).
- **GHCR**: sigue bloqueado por billing suspendido en `va360labs`. NO BLOQUEANTE.

### 2.2 Refactor único: `mod.fundae` self-contained (ADR-011)

| PR | Commit | Descripción |
|---|---|---|
| #57 | `728d5ff` (squash) | refactor(fundae): migrar mod.fundae a self-contained (ADR-011) |

Tercer módulo en el patrón self-contained, tras `zoom-live` (alpha.17) y `notifications` (alpha.21). Aplicación mecánica del patrón validado:

**Backend** — 6 archivos movidos con `git mv` a `apps/api/src/modules/fundae/`:
- `fundae.controller.ts`, `fundae-companies.controller.ts`, `fundae-groups.controller.ts`, `fundae-group-participants.controller.ts`, `fundae-rlpt.controller.ts`, `fundae-error.filter.ts`.
- Nuevo `fundae.module.ts` con `imports: [AuthModule, forwardRef(() => ModulesModule)]` + `controllers` + `providers: [{ provide: APP_FILTER, useClass: FundaeErrorFilter }]`.
- `ModulesModule` deja de listar los controllers/filter sueltos y añade `forwardRef(() => FundaeModule)` a `imports`.
- 4 tests de controller con paths actualizados.

**Frontend** — 3 clientes HTTP movidos con `git mv` a `apps/web/src/modules/fundae/`:
- `lib/fundae.ts` → `modules/fundae/actions-client.ts`.
- `lib/fundae-companies.ts` → `modules/fundae/companies-client.ts`.
- `lib/fundae-groups.ts` → `modules/fundae/groups-client.ts`.
- Imports relativos cambiados de `'./api-client'` a `'@/lib/api-client'` (gotcha del move).
- Nuevo `index.ts` declara `fundaeExtension: ModuleWebExtension` con sidebar item `/admin/fundae` (grupo Integraciones, `requiresRole: 'tenant_admin'`).
- El item DESAPARECE de `apps/web/src/app/(app)/layout.tsx`: ahora el catálogo `apps/web/src/modules/index.ts` lo agrega y `filterByActiveModulesOptional` decide visibilidad por `activeModules`.
- Las 5 páginas Next bajo `(app)/admin/fundae/*` importan ahora de `@/modules/fundae` como wrappers thin (lógica UI intacta).

### 2.3 Validación

| Paso | Resultado |
|---|---|
| `tsc apps/api` | ✅ 0 errores nuevos en fundae (los 23 errores marketplace son pre-existentes). |
| `tsc apps/web` | ✅ clean. |
| `vitest run` controllers fundae (4 archivos) | ✅ 42/42. |
| `vitest run` paquete `@didacta/mod-fundae` | ✅ 104/104. |
| `docker build` alpha.33 | ✅ exit 0. |
| Smoke `docker run` con grep DI (regla §3.3) | ✅ cero líneas `Nest can|Cannot resolve|ERROR`. |
| Push 3 tags a Docker Hub | ✅ digest `91dbf6cae...`. |

### 2.4 APP_VERSION

`0.0.1-alpha.32` → `0.0.1-alpha.33`. Footer del sidebar y banner version-check siguen funcionando.

---

## 3. Decisiones arquitectónicas (sin novedad)

Esta sesión NO introdujo decisiones nuevas: aplicó las ya tomadas (ADR-011 self-contained + forward-ref obligatorio + smoke `docker run` antes del push).

Aprendizaje operativo confirmado: **el pre-commit hook funciona en este Windows en commits "limpios"** (sólo refactor, sin lockfile o package.json). El workaround `--no-verify` de la memoria sigue siendo necesario solo cuando hay que arreglar prettier en cambios de dependencies.

---

## 4. Estado del rollout self-contained (ADR-011)

| Módulo | Backend | Frontend | Esfuerzo |
|---|---|---|---|
| `mod.zoom-live` | ✅ alpha.17 | ✅ admin tab + sidebar | DONE |
| `mod.notifications` | ✅ alpha.21 (parcial) | ⚠️ tab Plantillas DONE, SMTP queda en core | DONE con excepción |
| `mod.fundae` | ✅ **alpha.33** | ✅ **alpha.33** (sidebar + clients) | **DONE** |
| `mod.billing` | pendiente | `/admin/billing/products` + checkout | L |
| `mod.community` | pendiente | digestor metrics + UI | M |
| `mod.certificates` | pendiente | templates + mis-certificados | M |
| `mod.assessments` | pendiente | quiz editor + attempts | L |
| `mod.ai-tutor` | pendiente | `lib/ai-tutor.ts` | M |
| `mod.ai-grader` | pendiente | tab IA + clientes | M |
| `mod.ai-content` | pendiente | clientes | M |

---

## 5. Backlog priorizado para próxima sesión

### Opción A — Continuar con self-contained (siguiente módulo)

Candidatos lógicos: `mod.billing` (L, alta visibilidad — checkout) o `mod.assessments` (L, también alta visibilidad — quiz editor). Ambos siguen el patrón ya validado tres veces.

### Opción B — Smoke real ART-002 con `stripe listen` (deuda preexistente)

**Tiempo**: ~1h. **Riesgo**: bajo. Doc: `docs/SMOKE-STRIPE-ART-002.md`. Bloqueado solo por acción manual del usuario (stripe login interactivo + crear Product/Price test).

### Opción C — Issues GitHub abiertos (deuda preexistente)

- **#24** — Configurar `DIDACTA_SKILLS_PAT` para reactivar `module-contract.yml`.
- **#25** — Permisos `GITHUB_TOKEN` en `cloud-shadow-build.yml`.
- **#26** — 22 errores `module-doctor` (theming/zoom-live: apiNamespace, tablePrefix `mod_zoom_` requiere migración DB, coreVersionRequired, READMEs).

### Opción D — Marketplace Prisma client desfasado

Los 23 errores tsc actuales en `apps/api` son del marketplace (`InstalledModule`, `installedModule` no existen en el client generado). Probable: falta `pnpm prisma generate` o el schema cambió post-migración. Investigar y arreglar — mientras esté roto, `pnpm typecheck` no es útil como guard.

### Opción E — RLS strict (Fase 2+)

Plan completo en `docs/RLS-STRICT-PLAN.md`. Activar antes de `0.0.1-beta.1`.

---

## 6. Comandos clave

```bash
# Estado del repo
cd /d/Test/didacta-community
git status
git log --oneline -5

# Smoke local del alpha actual (alpha.33)
DIDACTA_IMAGE_TAG=0.0.1-alpha.33 docker compose -f docker-compose.alpha.yml --env-file=.env up -d
until curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do sleep 2; done
curl -s http://localhost:4000/api/v1/setup/status

# Smoke `docker run` para verificar DI graph antes de push (regla §3.3)
docker run --rm --entrypoint sh \
  -e AUTH_SECRET=$(node -e "console.log('a'.repeat(32))") \
  -e DATABASE_URL="postgresql://x:x@localhost:5432/x?schema=public" \
  didactaio/community:<tag> -c \
  'cd /repo/apps/api && timeout 6 node dist/main.js 2>&1 | grep -E "ERROR|Nest can|Cannot resolve" | head -5'
# Si devuelve líneas → NO push.
# Si devuelve nada (cae en prisma.connect() por BD ausente) → DI OK.

# Build + tag + push (patrón usado en esta sesión)
docker build -t didactaio/community:0.0.1-alpha.X-build -f Dockerfile .
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:0.0.1-alpha.X
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:alpha
SHA=$(git rev-parse --short HEAD)
docker tag didactaio/community:0.0.1-alpha.X-build didactaio/community:$SHA
docker push didactaio/community:0.0.1-alpha.X
docker push didactaio/community:alpha
docker push didactaio/community:$SHA
```

---

## 7. Files de referencia

| Archivo | Por qué importa |
|---|---|
| `apps/api/src/modules/fundae/fundae.module.ts` | Sub-module NestJS (NUEVO #57) — patrón ADR-011 con forwardRef. |
| `apps/api/src/modules/zoom-live/zoom-live.module.ts` | Referencia idéntica del patrón (alpha.17/19). |
| `apps/web/src/modules/fundae/index.ts` | `fundaeExtension: ModuleWebExtension` (NUEVO #57). |
| `apps/web/src/modules/zoom-live/index.ts` | Referencia idéntica frontend. |
| `apps/web/src/modules/index.ts` | Catálogo agregado de extensions. |
| `apps/web/src/lib/module-registry.ts` | Contrato `ModuleWebExtension` + `filterByActiveModulesOptional`. |
| `apps/web/src/app/(app)/layout.tsx` | Shell core — items SIN módulo en sidebar (todo lo del módulo viaja por catálogo). |
| `apps/web/src/lib/version.ts` | `APP_VERSION = '0.0.1-alpha.33'`. |
| `docs/adrs/ADR-011-modulo-self-contained.md` | Decisión arquitectónica. |
| `docs/HANDOFF-2026-05-02-marketplace.md` | HANDOFF previo (alpha.11 → alpha.32). |

---

## 8. Memorias persistentes (cargadas automáticamente)

Ver `~/.claude/projects/D--Test-learnship/memory/MEMORY.md`. Las relevantes para esta sesión:

- `project_didacta_arch_rule_modules.md` — regla arquitectónica de módulos.
- `project_didacta_ui_ee_gating_pattern.md` — convención UI · gating Enterprise estilo n8n.
- `project_didacta_nestjs_authmodule_rule.md` — módulos con JwtAuthGuard importan AuthModule.
- `project_docker_alpine_pruner_pattern.md` — patrón runner-desde-alpine-limpio.
- `project_didacta_session_state_2026_05_04_v9.md` — estado consolidado anterior (a sustituir).
- `project_didacta_handoff_pointer.md` — pointer al HANDOFF activo (actualizar a este archivo).

---

## 9. Siguiente paso recomendado

**Opción A — Continuar self-contained con `mod.billing`** (L, alta visibilidad).

Justificación:
- El patrón está validado tres veces (zoom-live, notifications, fundae). Cada migración refuerza la convención.
- `mod.billing` es de los más visibles del producto (admin Stripe + checkout cursos).
- Pre-requisitos cero: solo aplicar el mismo patrón mecánico.

Si Valen prefiere salir del rollout self-contained, segundo plato: **Opción D** (arreglar errores Prisma del marketplace, devuelve `tsc` como guard).

---

## 10. Cómo arrancar la próxima sesión

1. Lee este archivo entero.
2. Verifica `git log --oneline -5` y `docker images didactaio/community --format "{{.Tag}}\t{{.Size}}"`.
3. Pregunta al usuario qué opción del backlog (A / B / C / D / E). NO asumas.
4. Si arrancás con **Opción A** (siguiente módulo self-contained), aplicá el mismo patrón mecánico:
   1. `git checkout -b feat/mod-<name>-self-contained`.
   2. `git mv` los controllers + filter a `apps/api/src/modules/<name>/`.
   3. Crear `<Name>Module` con `forwardRef(() => ModulesModule)`.
   4. Editar `ModulesModule` (quitar refs sueltas + añadir forwardRef).
   5. Ajustar paths relativos (`../auth/*` → `../../auth/*`, `./module-registry.service` → `../module-registry.service`).
   6. Ajustar tests `apps/api/tests/<name>-*.test.ts`.
   7. `git mv` clients HTTP a `apps/web/src/modules/<name>/`. Cuidado con paths internos del client (`./api-client` → `@/lib/api-client`).
   8. Crear `index.ts` con `<name>Extension`.
   9. Editar `apps/web/src/modules/index.ts`.
   10. Quitar item del `app/(app)/layout.tsx`.
   11. Actualizar imports en páginas Next (`@/lib/<name>` → `@/modules/<name>`).
   12. Bump `APP_VERSION` + commit + smoke + push imagen + PR.
5. Modo ahorro de tokens, sub-agentes NO se usan, tests `vitest run` + tsc local sin CI.
6. Al cerrar sesión: actualizar este archivo Y crear/actualizar la memoria de session state (formato `project_didacta_session_state_<fecha>_v<n>.md`).
