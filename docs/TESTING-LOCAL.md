# Ejecutar los tests en local

Los tests de Didacta se ejecutan **en local** con `scripts/test-local.sh`, que
es el runner autorizado antes de mergear. La CI de GitHub Actions valida
typecheck, lint, ee-fence, gitleaks y license-check; las suites unit e
integración corren aquí.

## Requisitos

- Docker Desktop (o un daemon Docker) corriendo.
- `pnpm` en PATH con la versión del campo `packageManager` del `package.json` raíz.
- Puertos **5433** y **6380** libres (Postgres y Redis efímeros de test).

## Comandos

```bash
bash scripts/test-local.sh          # full: pre-flight + build + unit + integración
bash scripts/test-local.sh unit     # solo pre-flight + unit
bash scripts/test-local.sh integ    # solo pre-flight + build + integración
```

También disponibles como scripts pnpm: `pnpm test:local`,
`pnpm test:local:unit`, `pnpm test:local:integ`. En Windows, usa Git Bash
(o `scripts\test-local.cmd`, que delega en él).

## Qué hace el runner

1. **Pre-flight**: comprueba Docker, puertos libres y que no queden
   contenedores `didacta-*-test` de runs anteriores.
2. Genera el cliente Prisma y compila los packages internos que los tests
   importan (`@didacta/database`, `@didacta/core-kernel`,
   `@didacta/core-registry`, `@didacta/license-sdk`).
3. Corre la suite **unit** (`pnpm test`, vitest vía turbo).
4. Levanta `docker-compose.test.yml` (postgres-test en 5433, redis-test en
   6380 — DB en tmpfs, Redis sin persistencia), corre la suite de
   **integración** y baja el compose siempre, incluso si vitest falla.

## Suites rápidas sin Docker

- `pnpm typecheck` — typecheck de todo el monorepo.
- `pnpm test` — solo los tests unit (no necesitan infraestructura).

## E2E (Playwright)

Los E2E de `apps/e2e` necesitan la API y la web corriendo (locales con
`pnpm dev`, o el stack de `docker-compose.alpha.yml`). Ver `apps/e2e/README.md`.
