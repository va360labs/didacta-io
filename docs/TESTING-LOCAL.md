# Testing local — política y manual

> **Política activa desde 2026-05-01.** Las pruebas (unit, integración, E2E) **NO** se ejecutan en GitHub Actions. Se corren en local sobre Docker Desktop antes de mergear. La responsabilidad de ejecutar la suite verde antes de mergear es **100% del desarrollador que abre el PR**.

## Por qué

Didacta es un producto serio con licencias EE comerciales en producción. Las pruebas son críticas y exigen:

- Postgres real (no mock — los pilotos License SDK validan flujos cifrados con Prisma + RLS).
- Redis real para flujos de rate-limit y pronto el state store de OIDC.
- Control absoluto de la versión exacta de Docker, Postgres, Redis, Node, pnpm.

GitHub Actions con la org va360labs ha tenido históricamente:

- Bloqueos por billing (PRs #18, #20 con CI roja sin culpa del código).
- Mismatches de versión pnpm/Node entre runners y dev local.
- Costes de minutos de runner en disparos automáticos en cada push.
- Suites flaky por timing de containers en runners compartidos.

Decisión: el contrato es **CI = checks estáticos** (lint, typecheck, format, build, ee-fence, gitleaks, license-check). El **runtime se valida en local** con un runner único, repetible y observable.

## Qué corre en CI (todavía)

| Workflow | Hace |
|---|---|
| `ci.yml` | Format check + lint + typecheck + build (sin tests) |
| `ee-fence.yml` | Valida convención open-core `.ee` |
| `gitleaks.yml` | Escanea secretos en repo + history |
| `license-check.yml` | Verifica compatibilidad de licencias OSS |
| `module-contract.yml` | Valida contrato de módulos |
| `module-doctor.yml` | Health check estático de módulos |

## Qué NO corre en CI (movido a local)

| Workflow | Estado | Cómo lanzarlo |
|---|---|---|
| `integration.yml` | `workflow_dispatch` only | `bash scripts/test-local.sh integ` |
| `e2e.yml` | `workflow_dispatch` only | TBD (Playwright local — fuera de scope hoy) |
| `cloud-shadow-build.yml` | Sigue activo en PRs sobre core, pero el step `pnpm test` está retirado. Solo typecheck contra cloud. | — |

## El runner local

Una sola entrada: `scripts/test-local.sh` (con wrapper `scripts/test-local.cmd` para Windows cmd). Hace, en orden:

1. **Pre-flight** estricto:
   - Docker Desktop responde a `docker info`.
   - `pnpm` en PATH.
   - Puertos `5433` (postgres-test) y `6380` (redis-test) libres.
   - Limpia contenedores `didacta-postgres-test` / `didacta-redis-test` huérfanos de runs anteriores.
   - Verifica que existe `docker-compose.test.yml`.

2. **Genera cliente Prisma** (`pnpm --filter @didacta/database db:generate`).

3. **Compila packages internos** que los tests importan como deps de workspace:
   - `@didacta/database`
   - `@didacta/core-kernel`
   - `@didacta/core-registry`
   - `@didacta/license-sdk`

   Este paso es la **causa raíz** del fallo del workflow `integration.yml` antiguo: vite no resuelve `@didacta/database` sin `dist/` compilado.

4. **Suite unit** (`pnpm test` = `turbo run test`).

5. **Suite integración**:
   - `docker compose -f docker-compose.test.yml up -d`.
   - Espera `healthy` en `didacta-postgres-test` (timeout 60s).
   - Corre `pnpm --filter @didacta/api test:integration:license:run`.
   - **`trap EXIT`** garantiza `down -v` aunque vitest crashee o el dev haga Ctrl-C.

6. **Resumen tabular** con OK / FAIL / skipped por etapa.

### Modos

```bash
bash scripts/test-local.sh           # full: pre-flight + build + unit + integ
bash scripts/test-local.sh unit      # solo pre-flight + prisma + unit
bash scripts/test-local.sh integ     # solo pre-flight + prisma + build + integ
```

En Windows desde `cmd.exe`:

```cmd
scripts\test-local.cmd
scripts\test-local.cmd unit
scripts\test-local.cmd integ
```

### Garantías de seguridad del runner

- **DB efímera**: `tmpfs` en postgres-test → cada run parte de DB virgen, sin volúmenes persistentes.
- **Puertos distintos del dev**: `5433` / `6380`, no `5432` / `6379`. Imposible que un test tire la DB de desarrollo local.
- **Cleanup garantizado**: `trap EXIT INT TERM` baja el compose en cualquier path de salida (éxito, fallo, Ctrl-C, kill).
- **Container names fijos**: `didacta-postgres-test` / `didacta-redis-test`. El pre-flight detecta y elimina huérfanos antes de levantar nuevos.
- **Sin `--frozen-lockfile=false` ni atajos**: el script asume que `pnpm install` ya se hizo. Si el lockfile no está al día, el comando falla explícitamente.

### Qué hacer si falla

| Síntoma | Causa probable | Fix |
|---|---|---|
| `Docker no responde a 'docker info'` | Docker Desktop no está arrancado | Abre Docker Desktop, espera al icono verde, reintenta |
| `Puerto 5433 en uso` | Run anterior dejó algo, o tienes otro pg en 5433 | `docker ps -a \| grep didacta` y `docker rm -f`. Si es otro proceso, identifícalo y mátalo |
| `postgres-test no quedó healthy en 60s` | Imagen pesada en primera descarga, o Docker con poca RAM | Reintenta. Si persiste, sube RAM a Docker Desktop a ≥ 4GB |
| `Failed to resolve entry for package "@didacta/database"` | Olvidaste el step de build | El runner ya lo hace; si lo saltas con un comando custom, recuerda compilar antes |

## Política de PR y merge

1. Antes de marcar un PR como ready-for-review: **el dev DEBE haber visto `[test-local] TODO VERDE`** en su máquina.
2. La descripción del PR debe incluir la línea **"Pruebas locales: ✅ verde"** o equivalente, con al menos un test count si tocaste lógica.
3. Si el PR toca **solo** docs/`.github/`/configs sin afectar runtime, se permite saltar el runner pero hay que indicarlo en la descripción.
4. CI verde NO es prueba de que el código funciona — sólo de que compila y está bien formateado. Mergear sin haber corrido el runner local es violación de política.

## Si en algún momento queremos volver a CI

El workflow `integration.yml` está como `workflow_dispatch` — se puede lanzar manualmente desde la UI de Actions. Si en el futuro decidimos reactivar tests automáticos:

1. Recuperar el bloque `pull_request` / `push` original (commit anterior tiene la versión).
2. Añadir step de build de packages internos (lo que faltaba antes).
3. Verificar billing va360labs antes de mergear el cambio.

## Próximos pasos (deuda registrada)

- [ ] Añadir Playwright al runner local (`bash scripts/test-local.sh e2e`).
- [ ] Hook `pre-push` opcional que corra `unit` automáticamente (todavía no — frenaría push de docs).
- [ ] Snapshot de tiempos por etapa para detectar regresión de duración.
