# HANDOFF — Didacta Community (2026-05-02, tras ART-002 + ART-010)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-01.md` (que queda como referencia histórica del setup wizard ART-011 + bug del pruner).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repo "principal" del orchestrator**: `D:\Test\learnship` (NO MODIFICAR sin permiso explícito).
- **Branch activo**: `main` sincronizado con `origin/main`. Último push: `9d978a2`.
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español para commits/comentarios, inglés solo para identificadores técnicos.
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`). GitHub Issues NO se usa como tracker.

## 2. Estado actual — qué está hecho

### 2.1 Imágenes Docker publicadas

- **Registry primario**: Docker Hub, namespace `didactaio` (login `hola@didacta.io`).
  - `docker.io/didactaio/community:0.0.1-alpha.5` — sha256:93e40ebd70b168e45e83ad0350b0e0326d0a015aff2b077918dc8f9adb2e91c0
  - `docker.io/didactaio/community:alpha` (rolling, mismo digest)
  - `docker.io/didactaio/community:9d978a2` (tag por commit)
- **Tamaño**: ~1.32 GB (alpine).
- **Registry secundario (GHCR)**: bloqueado por billing suspendido de `va360labs`. NO BLOQUEANTE.

### 2.2 Últimos commits en main

- `9d978a2` feat(license-sdk): 11º piloto · feat:multi_tenant.real (ART-010)
- `f8bfd05` feat(billing): admin UI /admin/billing/products + tests bridge enroll (ART-002)
- `1e2bcf3` docs(handoff): cerrar sesión 2026-05-01 con ART-011 publicado
- `c0cd424` fix(setup): wizard renderable en imagen alpine + matcher acotado
- `44d150c` feat(setup): wizard de primer arranque para self-host alpha

### 2.3 Smoke test del alpha.5 (verificado local antes del push)

DB persistida del smoke previo (`initialized:true`). Resultado:

| Endpoint | Esperado | Estado |
|---|---|---|
| `GET /healthz` | 200 ok | ✅ |
| `GET /api/v1/setup/status` | `{"initialized":true}` | ✅ |
| `GET /signin` | 200 (DB ya inicializada) | ✅ |
| `GET /admin/billing/products` (web) | 200 (renderiza en cliente, redirige sin sesión) | ✅ |
| `GET /admin/tenants` (web) | 200 (renderiza en cliente) | ✅ |
| `GET /api/v1/admin/tenants/capacity` | 401 sin auth (JwtAuthGuard) | ✅ |
| `GET /api/v1/modules/billing/products` | 401 sin auth (JwtAuthGuard) | ✅ |

### 2.4 Tickets Notion actualizados esta sesión

- **ART-002** Stripe checkout MVP → contenido apend. con cierre real (Estado ya estaba Hecho preasignado).
- **ART-010** 11º piloto License SDK `feat:multi_tenant.real` → estado **Todo → Hecho**, cierra capabilities EE al 100%.

### 2.5 Capabilities EE pilotadas: 11/11 ✅

100% del modelo open-core completado. Cada capability tiene su gate end-to-end:

1. `feat:audit.long_retention`
2. `feat:reports.advanced_signed`
3. `feat:mfa.enforcement`
4. `feat:custom_domains`
5. `feat:white_label`
6. `feat:api.rate_limit.elevated`
7. `feat:scim`
8. `feat:sso.oidc`
9. `feat:sso.saml`
10. `feat:api.webhooks.high_throughput`
11. `feat:multi_tenant.real`  ← cerrado esta sesión

## 3. Decisiones arquitectónicas tomadas en esta sesión

### 3.1 mod.billing es CE puro — sin EeGate

Confirmado: monetización B2C es parte del core abierto. No hay upsell card en `/admin/billing/products` ni gate. Diferencia con n8n / Outline / similares que sí gatean el módulo de pago.

Razonamiento: una community sin pagos no es viable para self-host comercial (formadores autónomos, escuelas pequeñas). El revenue-share VA360 entra por Enterprise Cloud + módulos exclusivos, no por bloquear el módulo de checkout.

### 3.2 Bridge cross-module sólo por eventos — confirmado en ART-002

`mod.billing.handleWebhookEvent` emite `billing.order.completed`; `BillingLearningBridge` (en `apps/api/src/modules/billing-learning.bridge.ts`) lo consume y llama a `mod.learning.enrollFromPurchase`. Cero FKs cross-module.

`AlreadyEnrolledError` se captura como no-op en el bridge (caso webhook duplicado). Cualquier otro error se rethrow para que el outbox dispatcher reintente.

### 3.3 Multi-tenant gate — gate de capacidad, no gate de panel

Para `feat:multi_tenant.real` evalué tres opciones:

- **A**: bloquear el panel `/admin/tenants` entero sin licencia → desplaza al super_admin que necesita gestionar SU UNICO tenant.
- **B**: gate de capacidad — count >= 1 sin licencia → 402. count == 0 (setup wizard) o EE → ilimitado.
- **C**: hard cap incluso para super_admin sin opción de upsell → no escalable.

Elegida **B**. Patrón:
- `AdminTenantsService.getCapacityInfo()` retorna `{ tenantCount, limit, capabilityActive, capability, canCreate }`.
- `create()` pre-chequea: si `currentCount >= COMMUNITY_TENANT_LIMIT (=1)`, llama a `license.requireCapability(MULTI_TENANT_REAL)` que lanza `CapabilityRequiredError` → 402 vía `LicenseExceptionFilter` global.
- Frontend `/admin/tenants` pinta banner contextual (CE 0/1 / CE 1/1 upsell / EE ilimitado) y desactiva el botón "Crear" cuando `canCreate=false`.

**Out of scope (follow-up multi_tenant.real)**: RLS strict cross-tenant policies, encripción AES-256-GCM per-row, listings cross-tenant `super/users`. Documentado en el ticket Notion.

## 4. Backlog priorizado para próxima sesión

Backlog completo: Notion → LMS Ship → Work Items.

### Opción A — Smoke real `/admin/webhooks` (queda del Sprint 2) [recomendada]

**Tiempo**: ~30 min. **Riesgo**: bajo. Ticket Notion: <https://app.notion.com/p/353b609a124c8154bfafce4782d6610b>. Tarea pendiente desde el cierre del Sprint 2.

### Opción B — Smoke real ART-002 con `stripe listen`

**Tiempo**: ~1h. **Riesgo**: bajo. Pendiente del cierre real de ART-002 (queda como acción manual del operador).

Pasos:
1. `stripe login` (CLI).
2. Crear Product + Price en modo test del dashboard Stripe.
3. Lanzar stack: `DIDACTA_IMAGE_TAG=alpha docker compose -f docker-compose.alpha.yml --env-file=.env up -d`.
4. Login como tenant_admin → `/admin/billing/products` → vincular curso ↔ price_xxx.
5. `stripe listen --forward-to http://localhost:4000/api/v1/modules/billing/webhook`.
6. Login como alumno → `/cursos/[slug]` → "Comprar curso" → tarjeta test `4242 4242 4242 4242`.
7. Verificar: order COMPLETED, evento `billing.order.completed` emitido, alumno enrolled vía bridge.

### Opción C — RLS strict + listings super_admin (follow-up multi_tenant.real)

**Tiempo**: ~2-3d. **Riesgo**: medio (migración cuidadosa de policies, performance). Convierte el piloto ART-010 en feature lista para holdings reales con varias filiales.

### Opción D — ART-005 Migrator Moodle MVP

Bloqueado-Valen (decisión de scope — está en el board).

## 5. Bloqueado-Valen

- **ART-005 Migrator Moodle MVP**.
- **Armonizar landing didacta.io** con realidad legal del repo (fair-code SUL+EE, NO GPL v3).

## 6. Comandos clave

```bash
# Estado del repo
cd /d/Test/didacta-community
git status
git log --oneline -5

# Smoke local del alpha actual
DIDACTA_IMAGE_TAG=alpha docker compose -f docker-compose.alpha.yml --env-file=.env up -d
until curl -fsS http://localhost:4000/healthz >/dev/null 2>&1; do sleep 2; done
curl -s http://localhost:4000/api/v1/setup/status
curl -sI http://localhost:3000/admin/billing/products  # 200, ART-002
curl -sI http://localhost:3000/admin/tenants          # 200, ART-010
docker compose -f docker-compose.alpha.yml down

# Build local de la imagen
docker build -t didacta-community:0.0.1-alpha.X-build -f Dockerfile .

# Re-tag y push tras cambios verificados
docker tag didacta-community:0.0.1-alpha.X-build didactaio/community:0.0.1-alpha.X
docker tag didacta-community:0.0.1-alpha.X-build didactaio/community:alpha
docker push didactaio/community:0.0.1-alpha.X
docker push didactaio/community:alpha
```

## 7. Files de referencia

| Archivo | Por qué importa |
|---|---|
| `apps/api/src/modules/billing-learning.bridge.ts` | Bridge `billing.order.completed` → `mod.learning.enrollFromPurchase`. AlreadyEnrolledError = no-op |
| `apps/api/tests/billing-learning.bridge.test.ts` | 6 tests del bridge ART-002 |
| `apps/web/src/app/(app)/admin/billing/products/page.tsx` | UI admin ART-002, sin EeGate (CE) |
| `apps/web/src/lib/billing.ts` | Cliente HTTP unificado `startCheckout` (alumno) + `*Product` (admin) + `formatPrice` |
| `apps/api/src/admin/admin-tenants.service.ts` | `getCapacityInfo()` + gate `multi_tenant.real` en `create()` |
| `apps/api/tests/admin-tenants-multi-tenant-gate.test.ts` | 6 tests del gate ART-010 |
| `apps/web/src/app/(app)/admin/tenants/page.tsx` | Banner capacidad + `MultiTenantUpsellCard` |
| `Dockerfile` | Pruner con `-prune` de `.next` y `node_modules`. NO QUITAR (ART-011) |
| `apps/web/src/middleware.ts` | First-run gate. Matcher EXPLÍCITO (ART-011) |
| `packages/database/src/seed.ts` | Script CLI alternativo; aún funciona vía `docker exec ... seed` |

## 8. Memorias persistentes (cargadas automáticamente)

Ver `~/.claude/projects/D--Test-learnship/memory/MEMORY.md`. Las relevantes para esta sesión:

- `project_didacta_session_state_2026_05_02_v7.md` — estado consolidado fin de esta sesión (sustituye v6).
- `project_didacta_setup_wizard_pruner_trap.md` — la trampa del pruner + Next middleware.
- `project_didacta_arch_rule_modules.md` — regla arquitectónica de módulos.
- `project_didacta_ui_ee_gating_pattern.md` — convención UI · gating Enterprise estilo n8n.
- `project_didacta_nestjs_authmodule_rule.md` — módulos con JwtAuthGuard importan AuthModule.
- `project_docker_alpine_pruner_pattern.md` — patrón runner-desde-alpine-limpio.

## 9. Cómo arrancar la próxima sesión

1. Lee este archivo entero.
2. Verifica `git log --oneline -5` y `docker images didactaio/community --format "{{.Tag}}\t{{.Size}}"`.
3. Pregunta al usuario qué opción del backlog (A / B / C / D). NO asumas.
4. Si arrancás con Opción B (smoke real Stripe), pedí al usuario que tenga `stripe login` hecho y un Product+Price en modo test.
5. Al cerrar sesión: actualizar este archivo Y crear/actualizar la memoria de session state.
