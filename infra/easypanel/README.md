# Easypanel — Deploy de Didacta

Deploy automático desde el repo. Cada merge a `main` dispara build + deploy del Dockerfile único en la raíz.

## Configuración del servicio en Easypanel

### Build

- **Source**: GitHub repo `va360labs/didacta`, branch `main`
- **Builder**: Dockerfile (raíz del repo)
- **Build context**: raíz del repo

### Runtime

- **Puertos expuestos**:
  - `4000` → API (NestJS) → reverse proxy a `https://api.didacta.<dominio>`
  - `3000` → Web (Next.js) → reverse proxy a `https://didacta.<dominio>`
- **Healthcheck**: ya configurado en el Dockerfile contra `/healthz`

### Variables de entorno requeridas

Crear desde el panel "Environment" del servicio. Ver `env.example` en la raíz del repo para la plantilla completa.

| Variable                                                                  | Valor (prod/staging)                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `NODE_ENV`                                                                | `production`                                                          |
| `DATABASE_URL`                                                            | `postgresql://USER:PASS@HOST:5432/DB` (Postgres del propio Easypanel) |
| `REDIS_URL`                                                               | `redis://HOST:6379`                                                   |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | MinIO o Hetzner Object Storage                                        |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`       | Brevo SMTP                                                            |
| `API_PORT`                                                                | `4000`                                                                |
| `WEB_PORT`                                                                | `3000`                                                                |
| `AUTH_SECRET`                                                             | string aleatorio largo (Auth.js v5)                                   |
| `AUTH_URL`                                                                | `https://didacta.<dominio>`                                           |
| `ANTHROPIC_API_KEY`                                                       | (Fase 1.C)                                                            |
| `ZOOM_*`                                                                  | (Fase 1.B)                                                            |

### Servicios dependientes en el mismo proyecto Easypanel

- **PostgreSQL 16** (con extensiones `uuid-ossp`, `pgcrypto`, `vector`)
- **Redis 7**
- **MinIO** (o Hetzner Object Storage como reemplazo en prod)
- **MailPit** solo en `staging` para capturar emails sin enviar

## Migraciones automáticas

El `entrypoint.sh` corre en cada arranque de contenedor:

1. `prisma migrate deploy` — aplica migraciones pendientes
2. `psql -f rls.sql` — reaplica políticas RLS

Si la conexión a BD falla, el contenedor crashea. Easypanel reintentará según su política de restart.

## Comandos útiles desde dentro del contenedor

Easypanel permite abrir shell en el contenedor:

```bash
# Ver estado de migraciones
pnpm --filter @didacta/database exec prisma migrate status

# Forzar reaplicación de RLS
pnpm --filter @didacta/database exec psql "$DATABASE_URL" -f packages/database/prisma/rls.sql

# Inspeccionar BD
psql "$DATABASE_URL"
```

## Triggers de deploy

- **`main`** se despliega automáticamente al recibir push (configurar webhook en Easypanel apuntando al repo).
- Tags `v*.*.*` pueden dispararse a un servicio `prod` separado cuando armemos release pipeline (Fase 2).

## Dominios

Pendiente de definir en T-F0-018 (decisiones operacionales).
