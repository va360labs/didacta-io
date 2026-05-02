# HANDOFF — Didacta Community (2026-05-02, rollout self-contained ADR-011 COMPLETO)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-02-modules-rollout-part1.md` (queda como referencia del cierre alpha.36 + 7 módulos).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repo "principal" del orchestrator**: `D:\Test\learnship` (NO MODIFICAR sin permiso explícito).
- **Branch activo**: `main` sincronizado con `origin/main`. Último commit: `352ec4b`.
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español **neutro** (NO voseo).
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`).

---

## 2. Logro principal: rollout self-contained 11/11 módulos COMPLETO

### 2.1 Imágenes Docker publicadas en esta mini-sesión

| Tag | Digest | PR | Cambio |
|---|---|---|---|
| `0.0.1-alpha.36` | `sha256:5cabb45149...` | #60 | `mod.community` self-contained (worker BullMQ + métricas Prometheus) |
| `0.0.1-alpha.37` | `sha256:b8ad561...` | #61 | `mod.certificates` self-contained |
| `0.0.1-alpha.38` | `sha256:50212e6...` | #62 | `mod.ai-tutor` self-contained (incluye bridge cross-module + indexer) |
| `0.0.1-alpha.39` | `sha256:d68506a...` | #63 | `mod.ai-grader` self-contained |
| `0.0.1-alpha.40` | `sha256:6a62fcfee2949387016c869a87affe7e119874141b07508e3174174d9eb6f62a` | #64 | `mod.ai-content` self-contained (cierra rollout) |

Tag `alpha` rolling apunta a `0.0.1-alpha.40`. GHCR sigue bloqueado por billing.

### 2.2 PRs mergeados (5 en cadena)

| PR | Commit (squash) | Módulo |
|---|---|---|
| #60 | `468f7a1` | community |
| #61 | `69b3d32` | certificates |
| #62 | `50212e6` | ai-tutor |
| #63 | `d68506a` | ai-grader |
| #64 | `352ec4b` | ai-content |

### 2.3 Estado FINAL del rollout self-contained (ADR-011)

| Módulo | Estado |
|---|---|
| `mod.zoom-live` | ✅ DONE (alpha.17 + alpha.19 fix DI) |
| `mod.notifications` | ✅ DONE parcial (SMTP queda en core como infra compartida) (alpha.21) |
| `mod.fundae` | ✅ DONE (alpha.33) |
| `mod.assessments` | ✅ DONE (alpha.34) |
| `mod.billing` | ✅ DONE (alpha.35) |
| `mod.subscriptions` | ✅ DONE (alpha.35) |
| `mod.community` | ✅ DONE (alpha.36) |
| `mod.certificates` | ✅ DONE (alpha.37) |
| `mod.ai-tutor` | ✅ DONE (alpha.38) |
| `mod.ai-grader` | ✅ DONE (alpha.39) |
| `mod.ai-content` | ✅ DONE (alpha.40) |

**11/11 módulos en self-contained.** Todo el código de cada módulo (back + front) vive bajo `apps/<api|web>/src/modules/<name>/`. El día que un módulo se publique como `*.zip` distribuible, su carpeta entera se empaqueta y `ModuleRegistryService` lo carga dinámicamente.

### 2.4 Validación común a todos los PRs

- `tsc apps/api`: cero errores nuevos (los errores del marketplace por Prisma client desfasado siguen pre-existentes).
- `tsc apps/web`: clean.
- `vitest run` para tests específicos: todos verdes (controllers + filters + bridges + workers + clients web).
- Smoke `docker run` con grep DI clean en cada alpha (regla §3.3).

---

## 3. Decisiones arquitectónicas tomadas en esta mini-sesión

### 3.1 Bridges cross-module viajan con el consumer del evento

Tres bridges migrados (`AssessmentsLearningBridge`, `BillingLearningBridge`, `SubscriptionsLearningBridge`, `AiTutorBridge`) — todos consumen eventos y delegan en el módulo destino. Decisión: viajan con el módulo del que originan los eventos / hacen la suscripción, NO con `mod.learning`. Cuando estos módulos se distribuyan como ZIP, el bridge entra empaquetado.

### 3.2 Workers BullMQ viajan con el sub-módulo

`SubscriptionsGraceExpirationWorker` y `CommunityDigestWorker` viven en sus respectivos sub-módulos. `CommunityDigestMetrics` + `communityDigestMetricsProviders` también van con el sub-módulo (encapsulación completa).

### 3.3 Módulos sin client HTTP web declaran extension vacía

`mod.ai-content` no tiene client HTTP en web (la generación se dispara desde el editor de cursos del formador con `apiFetch` directo). Su `index.ts` declara `aiContentExtension: ModuleWebExtension` SIN sidebar items y SIN exports de client. Se mantiene en el catálogo para que `filterByActiveModulesOptional` reconozca el módulo y permita gating sidebar futuro.

### 3.4 `apps/web/vitest.config.ts` con alias `@/`

Añadido en PR #59 (billing). Permite que tests de clients web (`modules/<name>/client.test.ts`) resuelvan `@/lib/api-client` sin Next bundler. Mantiene los clients con paths absolutos `@/lib/*` por coherencia.

### 3.5 Stacked PRs por entanglement

`billing` + `subscriptions` mergearon juntos (PR #59) por compartir `StripeAdapter` en `ModuleRegistryService`. Razón: migrarlos en el mismo commit evita rotura cruzada cuando el adapter cambie.

---

## 4. Backlog priorizado para próxima sesión

### Opción A — Arreglar Prisma client del marketplace [recomendada]

**Tiempo**: ~30min. **Riesgo**: bajo. Los 23 errores tsc actuales en `apps/api` son por `InstalledModule`/`installedModule` no generados en el client de Prisma. Probable: falta `pnpm prisma generate` o el schema cambió post-migración. Devuelve `tsc` como guard local, **muy útil** ahora que el rollout self-contained terminó y `tsc` debería ser 100% clean.

### Opción B — Smoke real ART-002 con `stripe listen`

**Tiempo**: ~1h. **Bloqueo**: `stripe login` interactivo del usuario. Cierra ART-002 100%.

### Opción C — Issues GH abiertos

- #24 `DIDACTA_SKILLS_PAT` para reactivar `module-contract.yml`.
- #25 permisos `GITHUB_TOKEN` en `cloud-shadow-build.yml`.
- #26 22 errores `module-doctor` (theming/zoom-live: apiNamespace, tablePrefix `mod_zoom_` requiere migración DB).

### Opción D — RLS strict (Fase 2+)

3.5-4.5d. Plan en `docs/RLS-STRICT-PLAN.md`. Activar antes de `0.0.1-beta.1`.

### Opción E — `module-doctor` aprovechando el rollout self-contained

Ahora que TODOS los módulos están self-contained, `module-doctor` debería poder validar cada uno contra las 14 reglas del contrato (10 auto-detectables). Buena oportunidad para ejecutarlo y limpiar deuda residual (READMEs faltantes, manifest version, etc.).

---

## 5. Files de referencia

| Archivo | Por qué importa |
|---|---|
| `apps/api/src/modules/<name>/<name>.module.ts` (×11) | Sub-modules NestJS con forwardRef. Patrón mecánico cocido 11 veces. |
| `apps/web/src/modules/<name>/index.ts` (×11) | Extension points (sidebar items + tabs si aplican + re-exports de clients). |
| `apps/web/src/modules/index.ts` | Catálogo agregado de extensions (11 imports). |
| `apps/web/src/lib/module-registry.ts` | Contrato `ModuleWebExtension` + `filterByActiveModulesOptional`. |
| `apps/web/src/app/(app)/layout.tsx` | Shell core — items de módulo declarados POR los módulos, no por el layout. |
| `apps/web/vitest.config.ts` | Alias `@/` → `src/`. |
| `apps/web/src/lib/version.ts` | `APP_VERSION = '0.0.1-alpha.40'`. |
| `docs/adrs/ADR-011-modulo-self-contained.md` | Decisión arquitectónica raíz. |
| `docs/HANDOFF-2026-05-02-modules-rollout-part1.md` | Cierre previo (alpha.33 → alpha.36 con 4 módulos). |
| `docs/HANDOFF-2026-05-02-marketplace.md` | Sesión maratón (alpha.11 → alpha.32). |

---

## 6. Comandos clave (sin cambios)

```bash
# Estado del repo
cd /d/Test/didacta-community
git status
git log --oneline -5

# Smoke local del alpha actual (alpha.40)
DIDACTA_IMAGE_TAG=0.0.1-alpha.40 docker compose -f docker-compose.alpha.yml --env-file=.env up -d

# Smoke `docker run` para verificar DI graph antes de push (regla §3.3)
docker run --rm --entrypoint sh \
  -e AUTH_SECRET=$(node -e "console.log('a'.repeat(32))") \
  -e DATABASE_URL="postgresql://x:x@localhost:5432/x?schema=public" \
  didactaio/community:<tag> -c \
  'cd /repo/apps/api && timeout 6 node dist/main.js 2>&1 | grep -E "ERROR|Nest can|Cannot resolve" | head -5'
```

---

## 7. Memorias persistentes (cargadas automáticamente)

Ver `~/.claude/projects/D--Test-learnship/memory/MEMORY.md`. Las relevantes:

- `project_didacta_arch_rule_modules.md`
- `project_didacta_ui_ee_gating_pattern.md`
- `project_didacta_nestjs_authmodule_rule.md`
- `project_docker_alpine_pruner_pattern.md`
- `project_didacta_session_state_2026_05_02_v12.md` — estado consolidado de esta mini-sesión (sustituye v11).
- `project_didacta_handoff_pointer.md` — pointer al HANDOFF activo (este archivo).

---

## 8. Siguiente paso recomendado

**Opción A — Arreglar Prisma client del marketplace** (~30min).

Justificación:
- Ahora que el rollout self-contained terminó, `tsc` debería ser 100% clean. Los 23 errores residuales del marketplace se solucionan probablemente con un `pnpm prisma generate` (o investigar si el schema desfasó).
- Sin esto, no podemos volver a usar `tsc --noEmit` como guard de PRs futuros.
- Pre-requisito mental para cualquier nueva feature: no tener errores tsc preexistentes.

Si deseas otra dirección, **Opción E** (`module-doctor` post-rollout) es interesante para limpiar deuda residual de cada módulo recién migrado.

---

## 9. Cómo arrancar la próxima sesión

1. Lee este archivo entero.
2. Verifica `git log --oneline -5` y `docker images didactaio/community --format "{{.Tag}}\t{{.Size}}"`.
3. Pregunta al usuario qué opción del backlog (A / B / C / D / E). NO asumas.
4. Si arrancás con **Opción A** (Prisma marketplace):
   1. `pnpm prisma generate` desde la raíz para regenerar el client.
   2. Verificar `tsc apps/api`. Si los 23 errores desaparecen, fix simple.
   3. Si NO desaparecen, mirar `packages/database/prisma/schema.prisma` para ver si `installedModule` está definido. Si no, el modelo se eliminó por error o no se commiteó la migración correspondiente.
5. Modo ahorro de tokens, sub-agentes NO se usan, tests local sin CI.
6. Al cerrar sesión: actualizar este archivo Y crear/actualizar la memoria de session state.
