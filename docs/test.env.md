# Variables de entorno — entorno de test en Easypanel

> **URL del entorno**: https://lab-learnship.3qntut.easypanel.host/
> **Branch deploy**: `main`
> **Última actualización**: 2026-04-26

Pegá este bloque tal cual en el panel "Environment" del servicio en Easypanel. Las marcadas con `# CAMBIAR` necesitan que rellenes vos según tus servicios internos.

## Cambios respecto a la versión anterior (2026-04-25)

- **`DATABASE_URL`** ya viene con el host real (`lab_pgprueba`) y password.
- **`REDIS_URL`** ya viene con creds reales — habilita BullMQ + outbox dispatcher (PR A1).
- **`TENANT_SETTINGS_ENC_KEY`** nueva — clave maestra AES-256-GCM para cifrar credenciales que cada admin de tenant pone en su panel (SMTP, Zoom, etc.). **Si la perdés, los settings cifrados son ilegibles.**
- **`STORAGE_DRIVER` + `S3_*`** apuntan a MinIO interno con presigned URLs (privado por defecto).
- **`SMTP_*` eliminadas del entorno global**: ahora SMTP se configura por tenant desde el panel `/admin/configuracion`. Si un tenant no lo configura, las notificaciones EMAIL se loguean y no se envían (no rompe).
- **`ZOOM_*` eliminadas del entorno global**: idem, per-tenant en `mod.zoom-live` (PR B1).
- **`ANTHROPIC_API_KEY` eliminada del entorno global**: idem, per-tenant en `mod.ai-tutor`/`ai-grader` (Fase 1.C).

## Bloque listo para copiar

```bash
# ============================================================================
# ENTORNO
# ============================================================================
NODE_ENV=production
API_PORT=4000
WEB_PORT=3000

# Easypanel sirve un solo dominio https://lab-learnship.3qntut.easypanel.host/
# Configurar el dominio público para que apunte al puerto :3000 (Next.js).
# Next.js reescribe internamente /api/*, /healthz, /readyz, /api/docs al :4000
# (la API NestJS dentro del mismo contenedor).
WEB_URL=https://lab-learnship.3qntut.easypanel.host
API_URL=https://lab-learnship.3qntut.easypanel.host
# URL interna por loopback que usa Next.js para llamar a la API en SSR
API_INTERNAL_URL=http://localhost:4000

# ============================================================================
# AUTH (ADR-003 → JWT firmado con jose, MFA TOTP obligatorio para admins)
# ============================================================================
# Secret generado con: openssl rand -hex 32
AUTH_SECRET=ae508afa4eb2e2be2faea735df7bfdadff76d5266847d8a6968a6333f4d06c7c
AUTH_URL=https://lab-learnship.3qntut.easypanel.host

# ============================================================================
# TENANT SETTINGS — encryption at-rest de las credenciales per-tenant
# ============================================================================
# AES-256-GCM. Generada con: openssl rand -hex 32
# Cada tenant guarda en TenantSettings cosas como SMTP, Zoom, Anthropic key, etc.
# Esa tabla cifra el `value` con esta key. Si rotás la key sin re-cifrar, todos
# los settings cifrados quedan ilegibles. Backup obligatorio.
TENANT_SETTINGS_ENC_KEY=35dd608d52485e803848893bf26b923a2be02dcc5cc2a13bfa512d8e5e853073

# ============================================================================
# POSTGRES — servicio Postgres interno del proyecto Easypanel
# ============================================================================
# Imagen recomendada: pgvector/pgvector:pg16 (incluye uuid-ossp, pgcrypto, vector).
DATABASE_URL=postgresql://postgres:aa85de758878c03a5966@lab_pgprueba:5432/learnship?schema=public

# ============================================================================
# REDIS — servicio Redis interno del proyecto Easypanel
# Habilita BullMQ + outbox dispatcher con reintentos exponenciales
# ============================================================================
REDIS_URL=redis://default:7227132a9ea83f62d90e@lab_learnshipredis:6379

# ============================================================================
# OBJECT STORAGE — MinIO interno de Easypanel (privado, presigned URLs)
# ============================================================================
# Driver: 'local' usa disco (dev), 's3' usa MinIO/S3 (prod).
STORAGE_DRIVER=s3

# Endpoint público (TLS). Si querés latencia menor + sin TLS overhead, cambiá a
# la URL interna del proyecto (ej. http://lab_learnshipminio:9000) cuando la
# tengas confirmada en la pestaña del servicio MinIO en Easypanel.
S3_ENDPOINT=https://lab-minio.3qntut.easypanel.host
S3_REGION=us-east-1
S3_BUCKET=learnship
# MinIO requiere path-style addressing (no virtual-hosted-style).
S3_FORCE_PATH_STYLE=true

# !!! IMPORTANTE — ROTAR A SERVICE ACCOUNT
# Estas creds son las del root admin de MinIO. Para producción real, en la
# consola de MinIO (https://console-lab-minio.3qntut.easypanel.host) creá un
# Access Key dedicado con policy scoped al bucket `learnship` (s3:GetObject,
# s3:PutObject, s3:DeleteObject, s3:ListBucket sobre arn:aws:s3:::learnship/*)
# y reemplazá estas dos vars por ese service account. NO uses root admin en la app.
S3_ACCESS_KEY=admin
S3_SECRET_KEY=MasKil0s123!!!

# Tiempo de vida de las presigned URLs (segundos). 900 = 15 min.
S3_PRESIGNED_TTL_SECONDS=900

# Fallback dev local (ignorado si STORAGE_DRIVER=s3)
STORAGE_ROOT=./.local-storage

# ============================================================================
# SMTP — eliminado del entorno global
# ============================================================================
# A partir de PR A2 cada admin de tenant configura su SMTP desde
# /admin/configuracion → Notificaciones. Las creds se guardan cifradas en
# TenantSettings con TENANT_SETTINGS_ENC_KEY. Si un tenant no configura SMTP,
# las notificaciones de canal EMAIL se loguean (no rompen el flujo).

# ============================================================================
# ZOOM — eliminado del entorno global
# ============================================================================
# A partir de PR B1 cada admin de tenant configura sus credenciales Zoom
# (Server-to-Server OAuth: account_id, client_id, client_secret) desde
# /admin/configuracion → Aula virtual. Cifradas en TenantSettings.

# ============================================================================
# ANTHROPIC — eliminado del entorno global
# ============================================================================
# Idem cuando arranque mod.ai-tutor / ai-grader / ai-content / ai-analytics
# (Fase 1.C). Cada tenant trae su propia API key.

# ============================================================================
# BOOTSTRAP — necesarias SOLO para el primer arranque (correr db:seed una vez).
# Después podés borrarlas del entorno o dejarlas; el seed es idempotente.
# ============================================================================
BOOTSTRAP_TENANT_SLUG=va360
BOOTSTRAP_TENANT_NAME=VA360 LABS
BOOTSTRAP_EMAIL=valen@va360labs.com
BOOTSTRAP_NAME=Valentín Ayesa
# Generada con: openssl rand -base64 24
# Cambiala si querés otra cosa, mínimo 12 caracteres.
BOOTSTRAP_PASSWORD=1SWsTvJ/oy/xbaN6Q3lWDGTQHX8IOZJg
```

## Configuración crítica del dominio en Easypanel

En el panel del servicio LearnShip → **Domains** o **Proxy** del dominio principal:

| Campo | Valor |
| --- | --- |
| **Target port** | `3000` |
| **Path** | `/` |

**¿Por qué `:3000` y no `:4000`?**

El contenedor expone los dos puertos: `:4000` (API NestJS) y `:3000` (Web Next.js). Easypanel solo proxea uno al dominio público. Apuntá al `:3000` (frontend); Next.js reescribe internamente todo lo que sea `/api/*`, `/healthz`, `/readyz` y `/api/docs` al `:4000` por loopback (`localhost:4000`).

Resultado: el browser hace todo a `https://lab-learnship.3qntut.easypanel.host/...` con same-origin. Sin CORS, sin variables públicas que filtrar.

## Pasos para arrancar

### 1. Servicios dependientes en el mismo proyecto Easypanel

Antes de configurar la app, asegurate de tener corriendo en el proyecto `lab-learnship`:

| Servicio | Imagen recomendada | Notas |
|---|---|---|
| Postgres | `pgvector/pgvector:pg16` | Trae `pgvector` preinstalado. Crear DB `learnship` y usuario `postgres`. |
| Redis | `redis:7-alpine` | Con auth (la `REDIS_URL` lleva la password). |
| MinIO | `minio/minio:latest` | Bucket `learnship` precreado. Service account dedicado scoped al bucket. |

Anotá los hostnames internos (Easypanel los muestra en la pestaña del servicio). Los del entorno actual son `lab_pgprueba`, `lab_learnshipredis` y `lab-minio.3qntut.easypanel.host` (ver consola MinIO en `https://console-lab-minio.3qntut.easypanel.host`).

### 2. Configurar el servicio de la app LearnShip

- **Source**: GitHub `va360labs/learnship`, branch `main`
- **Builder**: Dockerfile (raíz del repo)
- **Puerto interno expuesto**: `3000` (Web). El `:4000` (API) se accede por loopback desde Next.js.
- **Variables**: pegar el bloque de arriba con tus secretos
- **Healthcheck**: ya viene en el Dockerfile contra `/healthz`, no hay que tocar nada

### 3. Primer deploy

Easypanel hace pull + build + run automáticamente. El `entrypoint.sh` corre:

1. `prisma migrate deploy` (aplica migraciones pendientes)
2. `psql -f rls.sql` (políticas Row-Level Security)
3. Levanta API y Web en paralelo

Ver logs: deberías ver `LearnShip API escuchando en http://localhost:4000` y `Module registry inicializado`.

### 4. Bootstrap (una sola vez)

En Easypanel → Console del servicio LearnShip:

```bash
pnpm --filter @learnship/database db:seed
```

Output esperado:

```
[seed] Tenant va360 (<uuid>) listo
[seed] 6 roles del sistema garantizados
[seed] Usuario valen@va360labs.com (<uuid>) con rol super_admin
[seed] OK. Login en: tenantSlug=va360 email=valen@va360labs.com
```

### 5. Login y prueba end-to-end

Abrí https://lab-learnship.3qntut.easypanel.host/ y deberías caer en `/signin`:

- **Tenant**: `va360`
- **Email**: `valen@va360labs.com`
- **Contraseña**: `1SWsTvJ/oy/xbaN6Q3lWDGTQHX8IOZJg` (la del bootstrap)

Como sos `super_admin`, MFA es obligatorio. Te llevará a `/mfa/setup`:

1. Escaneá el QR con Google Authenticator / 1Password / Authy / Bitwarden
2. **Guardá los 10 recovery codes** que aparecen en el cuadro amarillo (uso único, te salvan si perdés la app TOTP)
3. Confirmá con el código de 6 dígitos de la app

### 6. Configurar SMTP / Zoom / etc. del tenant (post-PR A2)

Una vez deployado el PR A2 (SMTP per-tenant), entrá como `super_admin` o `tenant_admin` a:

`https://lab-learnship.3qntut.easypanel.host/admin/configuracion`

Pestañas previstas:
- **Notificaciones**: SMTP host, port, user, pass, from. Botón "Probar envío".
- **Aula virtual** (post-PR B1): Zoom account_id, client_id, client_secret.
- **Storage** (opcional, override del default): bucket per-tenant si se quiere aislar evidence vault por tenant.

Las creds se guardan cifradas con `TENANT_SETTINGS_ENC_KEY`. Solo `super_admin` y `tenant_admin` pueden leerlas/escribirlas.

## Verificación rápida sin login

Estas URLs deberían responder sin auth:

| URL | Esperado |
|---|---|
| `https://lab-learnship.3qntut.easypanel.host/healthz` | `200 {"status":"ok",...}` |
| `https://lab-learnship.3qntut.easypanel.host/readyz` | `200 {"status":"ok","redis":"ok","db":"ok","s3":"ok",...}` |
| `https://lab-learnship.3qntut.easypanel.host/api/docs` | Swagger UI con todos los endpoints |

## Si algo falla

- **`/healthz` da 502 o no responde**: Easypanel no termina de levantar. Mirá los logs del contenedor.
- **`/readyz` da 503 con `redis: "error"`**: la `REDIS_URL` está mal o el servicio Redis está caído. Probá `redis-cli -u $REDIS_URL ping` desde la consola del contenedor.
- **`/readyz` da 503 con `s3: "error"`**: las creds de MinIO o el endpoint están mal. Probá la consola MinIO `https://console-lab-minio.3qntut.easypanel.host` y verificá que el bucket `learnship` exista.
- **`/healthz` ok pero login falla con "Tenant no válido"**: el seed no corrió. Repetí paso 4.
- **MFA setup no carga el QR**: revisá que `AUTH_SECRET` esté seteado y tenga ≥ 32 caracteres.
- **Crear curso devuelve 500**: probable que la migración Prisma no se aplicó (faltan tablas `mod_courses_*`). Logs del contenedor → buscar errores de Prisma.
- **Notificación EMAIL no llega**: el tenant NO configuró SMTP en `/admin/configuracion`. Es comportamiento esperado: se loguea, no se envía. Configurá SMTP del tenant.
- **`prisma migrate deploy` da "table already exists"**: la DB tiene el schema pero `_prisma_migrations` no refleja el baseline. Ver `docs/ESTADO.md` sección 2.3 (correr `prisma migrate resolve --applied 0_init` para cada migración pre-baseline).

## Saneamiento post-prueba

Una vez verificado que el flujo va, **rotá**:

- `AUTH_SECRET` (forzaría re-login a todos los usuarios)
- `TENANT_SETTINGS_ENC_KEY` — **solo si tenés un mecanismo de re-cifrado**. Sin re-encrypt, perdés todos los settings cifrados (SMTP, Zoom, etc. del tenant).
- `S3_ACCESS_KEY` / `S3_SECRET_KEY` — pasar de root admin a service account scoped (ver bloque OBJECT STORAGE arriba). **CRÍTICO** antes de considerar prod.
- Password de Postgres y de Redis (Easypanel → servicio → Settings → Change password).
- `BOOTSTRAP_PASSWORD` desde la propia UI cuando tengamos cambio de contraseña, o seteando otra y re-corriendo el seed
- Borrar el bloque BOOTSTRAP_* del entorno una vez confirmado el seed
