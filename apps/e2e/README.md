# @didacta/e2e

Tests end-to-end con Playwright. Cubren el **golden path** del alumno: signup → catálogo → matrícula → completar lecciones → certificado.

## Pre-requisitos

- API y web corriendo (locales o stack de Easypanel).
- Base de datos con seed inicial (al menos un usuario admin).

## Variables de entorno

| Variable             | Default                 | Descripción                                              |
| -------------------- | ----------------------- | -------------------------------------------------------- |
| `E2E_BASE_URL`       | `http://localhost:3000` | URL del frontend (Playwright navega aquí)                |
| `E2E_API_URL`        | `http://localhost:3000` | URL de la API (los helpers la usan para bootstrap)       |
| `E2E_TENANT_SLUG`    | `va360`                 | Tenant donde se crean cursos y se registran alumnos      |
| `E2E_ADMIN_EMAIL`    | —                       | **obligatorio** — email del super_admin con MFA-required |
| `E2E_ADMIN_PASSWORD` | —                       | **obligatorio** — password del super_admin               |

El admin debe existir previamente (lo crea `pnpm --filter @didacta/database db:seed`). El alumno se crea fresh por test con timestamp único.

## Correr local

```bash
# 1. Levantar el stack
pnpm dev

# 2. (Una vez) Instalar browsers de Playwright
pnpm --filter @didacta/e2e install-browsers

# 3. Correr los tests
E2E_ADMIN_EMAIL=valen@va360labs.com \
E2E_ADMIN_PASSWORD='tu-password' \
pnpm --filter @didacta/e2e test
```

Para depurar visualmente: `pnpm --filter @didacta/e2e test:headed` o `pnpm --filter @didacta/e2e test:ui`.

## Estructura

- `tests/` — specs `.spec.ts` (un test por flujo)
- `helpers/api.ts` — clientes HTTP para bootstrap de datos
- `helpers/auth.ts` — inyección de sesión en localStorage del browser
- `playwright.config.ts` — base URL, retries, browsers

## CI

El workflow `.github/workflows/e2e.yml` se dispara manualmente (`workflow_dispatch`) y en push a `main`. NO bloquea PRs todavía: se valida en post-merge contra el deploy de staging.
