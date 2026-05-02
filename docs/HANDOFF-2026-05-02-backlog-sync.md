# HANDOFF — Didacta Community (2026-05-02, cierre + sincronización backlog Notion)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-02-rollout-complete-part1.md` (queda como referencia del cierre 11/11 self-contained).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repo "principal" del orchestrator**: `D:\Test\learnship` (NO MODIFICAR sin permiso explícito).
- **Branch activo**: `main` sincronizado con `origin/main`. Último commit: `b345cb8`.
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español **neutro**. Identificadores técnicos en inglés.
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`). Vista activa: <https://www.notion.so/aa00fff5f15f42948ddd864047e5a4ac?v=34cb609a124c81e984b5000c5793f793>.

---

## 2. Qué se hizo en esta sesión

### 2.1 Cierre rollout self-contained ADR-011 (parte 1, primera mitad de la sesión)

11/11 módulos en self-contained. 5 PRs en cadena (#60→#64) cerraron community/certificates/ai-tutor/ai-grader/ai-content. Imágenes alpha.36→alpha.40 publicadas. Detalle completo en `HANDOFF-2026-05-02-rollout-complete-part1.md`.

### 2.2 Diagnóstico Prisma marketplace (no commitable)

23 errores tsc residuales en `apps/api` por Prisma client local desfasado. Resuelto local con `cd packages/database && ./node_modules/.bin/prisma generate`. El `Dockerfile:75` ya hace `RUN pnpm --filter @didacta/database db:generate`, así que la imagen production siempre se construye con el client correcto. Intenté añadir `postinstall: "prisma generate"` para automatizar pero rompe en Windows (cmd.exe no resuelve binary). Documentado en memoria `project_didacta_prisma_regenerate_after_clone.md`.

### 2.3 Sincronización del backlog Notion (segunda mitad)

Auditoría de items con estado activo (Backlog / Todo / En curso / Bloqueado / Bloqueado-Valen) contra el código real en `main`. **6 items movidos a "Hecho"**:

| ID | Code | Título | Por qué cerrado |
|---|---|---|---|
| LMS-108 | `T-1A-001` | Core IAM: User/Role/Permission + auth | `apps/api/src/auth/` (26 archivos) + 7 modelos Prisma; tests integración verde |
| LMS-111 | `T-1A-004` | Module Registry UI + activación por tenant | `/admin/configuracion` + `TenantModulesService` (enable/disable + onEnable/onDisable + eventos `didacta:modules-changed`) |
| LMS-112 | `T-1A-005` | Core audit log + API + export CSV/JSON | `audit.controller.ts` + `audit-export/` + modelo `AuditLog` |
| LMS-113 | `T-1A-006` | Core evidence vault + S3 + paquete export | `prisma-evidence-vault.service.ts` + tests (131 líneas) + integrado en fundae RLPT y audit-zip |
| LMS-114 | `T-1A-007` | Core notification hub multicanal | `mod.notifications` self-contained alpha.21 (templates + SMTP + in-app + bridge) |
| LMS-120 | `T-1A-013` | mod.learning SCORM 1.2/2004 | `modules/learning/src/scorm-parser.ts` + `scorm.service.ts` + tests + `ScormLearningBridge` |

Cada item tiene un bloque "Cierre — sincronización 2026-05-02" en su contenido Notion con la lista de archivos / decisiones que justifican el cierre.

---

## 3. Estado actual del backlog (post-sync)

### 3.1 Backlog "vivo" pero NO ejecutable por mí solo (bloqueantes humanos)

| Code | Título | Bloqueo |
|---|---|---|
| `HU-SA-002` | Auditoría externa antes de prod (F1.C, P0) | Auditor jurídico/técnico externo |
| `E-1C-005` | Épica Hardening F1.C (P0): RGPD/pentest/WCAG/perf | Pentest externo + auditor RGPD |
| `T-1A-019` | Dogfooding 1 curso real VA360 (P0) | Valen selecciona curso + 10 alumnos reales |
| `ART-005` | Migrator Moodle MVP (.mbz → Didacta) | Bloqueado-Valen |
| `LMS-265` | Smoke test manual /admin/webhooks (P1) | Necesita webhook.site + verificación visual en navegador |
| `HU-MKT-001` | Push install marketplace web (P2) | Web pública didacta.io no construida |
| `ADR-010` | Pairing instancia ↔ cuenta didacta.io | Propuesto; requiere decisión arquitectónica + ADR firmada |
| `MIG-045` | Crear canal Discord/Slack #didacta-alpha | Bloqueado-Valen |
| `ART-026` | Armonizar landing didacta.io (fair-code) | Bloqueado por equipo web |

### 3.2 Backlog Fase 2+ ejecutable pero grande (sin prioridad establecida)

Módulos nuevos: `xAPI / Tin Can LRS` (ART-009), `IFAPA Andalucía` (ART-016), `Compliance FR/DE/IT` (ART-024), `Streaming nativo LiveKit`, `Cupones/Affiliates` (ART-017), `Gamification full`, `Helm chart K8s`, `App móvil iOS/Android`, `Itinerarios formativos`, `Direct messages 1-a-1`, `Pizarra colaborativa` (ART-022), `Marketplace third-party Stripe Connect`.

Cada uno es un módulo de tamaño M-XL sin DoD detallado. Requiere alineación previa con Valen sobre cuál atacar.

---

## 4. Decisiones operativas confirmadas en esta sesión

### 4.1 Cuándo NO automatizar `prisma generate`

El postinstall directo (`prisma generate`) rompe en Windows con cmd.exe. Soluciones portables (node directo, pnpm exec) tampoco son robustas. **Decisión**: dejar manual. El Dockerfile ya lo hace en CI/build. Devs en Windows deben ejecutar `cd packages/database && ./node_modules/.bin/prisma generate` tras clone o tras cambios al schema. Documentado en memoria + nota en HANDOFF.

### 4.2 Sincronización de backlog: un cierre por sesión

El backlog Notion se desfasa porque el código avanza más rápido que las propiedades. **Convención**: al cierre de cada sesión grande (≥3 PRs), pasar 10-15 min auditando items en estados activos cuyo código ya está en main, y moverlos a "Hecho" con un bloque "Cierre — sincronización <fecha>" en el contenido. Esto evita que el backlog se vuelva mentira.

---

## 5. Backlog priorizado para próxima sesión

### Opción A — Escribir ADR-010 (pairing instancia ↔ cuenta web) [recomendada]

**Tiempo**: ~30-45min. **Riesgo**: bajo. **Bloqueo**: cero.

Es documento técnico, no código. Destrabaría la cadena `HU-MKT-001` + endpoints pairing + UI `/admin/integrations/marketplace` (todos Backlog hoy). El proceso pairing OAuth-like + push HMAC+Ed25519 ya está en `docs/MARKETPLACE-WEB-SPEC.md` v1 según memoria `project_didacta_marketplace_web_spec.md`. Sólo falta condensar a formato ADR firmable.

### Opción B — Atacar un módulo Fase 2+ concreto

Requiere alineación previa con Valen sobre cuál priorizar. Candidatos con valor B2B inmediato:
- `IFAPA Andalucía` — abre mercado regional acotado.
- `xAPI / Tin Can LRS` — checkbox compliance corporate.
- `Cupones / Affiliates` — monetización.
- `App móvil iOS/Android` (XL) — diferenciador vs Moodle.

### Opción C — Continuar audit de backlog

Quedan items que aún no validé contra código (e.g. otros T-1B, T-1C, FR-MOD-* dispersos). 15-20min más cerraría más items obsoletos.

### Opción D — Smoke real ART-002 (`stripe listen`)

~1h. Cierra ART-002 al 100%. Bloqueado por `stripe login` interactivo del usuario.

---

## 6. Comandos clave

```bash
# Estado del repo
cd /d/Test/didacta-community
git log --oneline -5
docker images didactaio/community --format "{{.Tag}}\t{{.Size}}" | head -5

# Si tsc apps/api da 23 errores marketplace InstalledModule:
cd packages/database && ./node_modules/.bin/prisma generate

# Smoke local del alpha actual
DIDACTA_IMAGE_TAG=0.0.1-alpha.40 docker compose -f docker-compose.alpha.yml --env-file=.env up -d

# Tests local
cd apps/api && ./node_modules/.bin/vitest run
cd apps/web && ./node_modules/.bin/vitest run
```

---

## 7. Files de referencia

| Archivo | Por qué importa |
|---|---|
| `apps/api/src/modules/<name>/<name>.module.ts` (×11) | Sub-modules NestJS self-contained (rollout completo). |
| `apps/web/src/modules/<name>/index.ts` (×11) | Extension points por módulo. |
| `apps/web/vitest.config.ts` | Alias `@/` → `src/`. |
| `apps/web/src/lib/version.ts` | `APP_VERSION = '0.0.1-alpha.40'`. |
| `Dockerfile:75` | `RUN pnpm --filter @didacta/database db:generate` (CI ya lo hace). |
| `docs/MARKETPLACE-WEB-SPEC.md` | Spec v1 para ADR-010 + HU-MKT-001. |
| `docs/RLS-STRICT-PLAN.md` | Plan 5 fases RLS strict (pre-req beta.1). |
| `docs/HANDOFF-2026-05-02-rollout-complete-part1.md` | HANDOFF previo (rollout self-contained). |

---

## 8. Memorias persistentes (cargadas automáticamente)

Ver `~/.claude/projects/D--Test-learnship/memory/MEMORY.md`. Las relevantes:

- `project_didacta_handoff_pointer.md` — pointer al HANDOFF activo.
- `project_didacta_session_state_2026_05_02_v13.md` — estado consolidado de esta sesión (sustituye v12).
- `project_didacta_arch_rule_modules.md`, `project_didacta_ui_ee_gating_pattern.md`, `project_didacta_nestjs_authmodule_rule.md`.
- `project_docker_alpine_pruner_pattern.md`, `project_didacta_setup_wizard_pruner_trap.md`.
- `project_didacta_prisma_regenerate_after_clone.md` — gotcha Prisma client local.

---

## 9. Siguiente paso recomendado

**Opción A — Escribir ADR-010 (pairing)** (~30-45min).

Justificación:
- Sin bloqueos humanos.
- Destrabaría la cadena marketplace web (4 items Backlog).
- La spec técnica ya existe en `docs/MARKETPLACE-WEB-SPEC.md` — solo hay que destilar a formato ADR.
- Prepara el terreno para HU-MKT-001 cuando didacta.io esté pública.

Si Valen prefiere atacar producto, **Opción B** (módulo Fase 2+) — pero necesita decidir cuál.

---

## 10. Cómo arrancar la próxima sesión

1. Lee este archivo entero.
2. Verifica `git log --oneline -5` y `docker images didactaio/community --format "{{.Tag}}\t{{.Size}}"`.
3. Si haces `tsc apps/api` y ves 23 errores marketplace: ejecutar `cd packages/database && ./node_modules/.bin/prisma generate`.
4. Pregunta al usuario qué opción del backlog (A / B / C / D). NO asumas.
5. Si arrancás con **Opción A** (ADR-010): leer `docs/MARKETPLACE-WEB-SPEC.md` y `docs/adrs/ADR-009-module-marketplace.md` como referencia. Crear `docs/adrs/ADR-010-pairing-instancia-cuenta-web.md`. Status = Propuesto inicialmente.
6. Modo ahorro de tokens, sub-agentes NO se usan, tests local sin CI.
7. Al cerrar sesión: actualizar este archivo Y crear/actualizar la memoria de session state.
