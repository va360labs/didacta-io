# Variables de entorno — entorno de test en Easypanel

> **URL del entorno**: https://lab-learnship.3qntut.easypanel.host/
> **Branch deploy**: `main`
> **Última actualización**: 2026-04-25

Pegá este bloque tal cual en el panel "Environment" del servicio en Easypanel. Las marcadas con `# CAMBIAR` necesitan que rellenes vos según tus servicios internos.

## Bloque listo para copiar

```bash
# ============================================================================
# ENTORNO
# ============================================================================
NODE_ENV=production
API_PORT=4000
WEB_PORT=3000

# Easypanel sirve un solo dominio https://lab-learnship.3qntut.easypanel.host/
# Por ahora la API y el web responden en ese mismo origen.
# Si en el futuro separás API y web en dos servicios, ajustá WEB_URL/API_URL.
WEB_URL=https://lab-learnship.3qntut.easypanel.host
API_URL=https://lab-learnship.3qntut.easypanel.host

# ============================================================================
# AUTH (ADR-003 → JWT firmado con jose, MFA TOTP obligatorio para admins)
# ============================================================================
# Secret generado con: openssl rand -hex 32
AUTH_SECRET=ae508afa4eb2e2be2faea735df7bfdadff76d5266847d8a6968a6333f4d06c7c
AUTH_URL=https://lab-learnship.3qntut.easypanel.host

# ============================================================================
# POSTGRES — usá el servicio Postgres del propio proyecto Easypanel.
# Asegurate de que la imagen incluya las extensiones uuid-ossp, pgcrypto, vector
# (pgvector/pgvector:pg16 las trae preinstaladas).
# ============================================================================
# Hostname interno típico de Easypanel: <project>_<service>
# Si tu servicio Postgres se llama "postgres", el host suele ser "lab-learnship_postgres".
# Reemplazá <PG_HOST> y <PG_PASSWORD> por lo que muestre Easypanel en la pestaña del servicio Postgres.
DATABASE_URL=postgresql://learnship:<PG_PASSWORD>@<PG_HOST>:5432/learnship?schema=public  # CAMBIAR

# ============================================================================
# REDIS — servicio Redis interno del proyecto Easypanel
# ============================================================================
# Hostname interno típico: lab-learnship_redis
REDIS_URL=redis://<REDIS_HOST>:6379  # CAMBIAR

# ============================================================================
# OBJECT STORAGE — Hetzner Object Storage (recomendado en prod) o MinIO interno
# ============================================================================
# Opción A: MinIO interno de Easypanel
S3_ENDPOINT=http://<MINIO_HOST>:9000
S3_REGION=us-east-1
S3_BUCKET=learnship
S3_ACCESS_KEY=CAMBIAR
S3_SECRET_KEY=CAMBIAR

# Opción B (preferida para staging/prod): Hetzner Object Storage
# S3_ENDPOINT=https://fsn1.your-objectstorage.com
# S3_REGION=fsn1
# S3_BUCKET=learnship-test
# S3_ACCESS_KEY=CAMBIAR
# S3_SECRET_KEY=CAMBIAR

# ============================================================================
# SMTP — Brevo (ya lo usás en VA360)
# ============================================================================
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=CAMBIAR_TU_LOGIN_BREVO
SMTP_PASSWORD=CAMBIAR_TU_KEY_BREVO
SMTP_FROM=noreply@va360labs.com

# ============================================================================
# FUTURO — dejar vacías hasta que los módulos correspondientes se activen
# ============================================================================
# Anthropic API (Fase 1.C — mod.ai-tutor / ai-grader / ai-content / ai-analytics)
ANTHROPIC_API_KEY=

# Zoom API (Fase 1.B — mod.zoom-live)
ZOOM_ACCOUNT_ID=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=

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

## Pasos para arrancar

### 1. Servicios dependientes en el mismo proyecto Easypanel

Antes de configurar la app, asegurate de tener corriendo en el proyecto `lab-learnship`:

| Servicio | Imagen recomendada | Notas |
|---|---|---|
| Postgres | `pgvector/pgvector:pg16` | Trae `pgvector` preinstalado. Crear DB `learnship` y usuario `learnship`. |
| Redis | `redis:7-alpine` | Sin auth en red interna del proyecto. |
| MinIO (opcional) | `minio/minio:latest` | Bucket `learnship` precreado. |

Anotá los hostnames internos (Easypanel los muestra en la pestaña del servicio) y reemplazá `<PG_HOST>`, `<PG_PASSWORD>`, `<REDIS_HOST>`, `<MINIO_HOST>` arriba.

### 2. Configurar el servicio de la app LearnShip

- **Source**: GitHub `va360labs/learnship`, branch `main`
- **Builder**: Dockerfile (raíz del repo)
- **Puerto interno expuesto**: `4000` (API). El `WEB_PORT=3000` corre en el mismo contenedor pero por ahora solo se proxea al 4000 del nginx interno de Easypanel. Si querés el web también, abrí un segundo dominio apuntando al `:3000`.
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

Caés en `/cursos` (vacío). Para probar el flujo:

1. **Mis cursos** → **Nuevo curso** → llenar título + slug (ej. `prueba-1`) → crear
2. En el editor, **Añadir módulo** → "Introducción"
3. Dentro del módulo, **Añadir lección** tipo TEXT → "Bienvenida"
4. Botón **Publicar** (el hook `courses.publish.validate` corre, pero como no hay otros módulos hooked, pasa libre)
5. Volvé a **Catálogo** → ahí está
6. Click → matricularte (probá el botón Matricularme; si exige código, generá uno como admin)
7. Reproducí lecciones → la barra de progreso sube cada 30s
8. Marcá lecciones como completadas → al cruzar el 75% el evento `learning.course.completed` se loguea (todavía es stub, no emite certificado real hasta `mod.certificates`)

## Verificación rápida sin login

Estas URLs deberían responder sin auth:

| URL | Esperado |
|---|---|
| `https://lab-learnship.3qntut.easypanel.host/healthz` | `200 {"status":"ok",...}` |
| `https://lab-learnship.3qntut.easypanel.host/readyz` | `200 {"status":"ok",...}` |
| `https://lab-learnship.3qntut.easypanel.host/api/docs` | Swagger UI con todos los endpoints |

## Si algo falla

- **`/healthz` da 502 o no responde**: Easypanel no termina de levantar. Mirá los logs del contenedor.
- **`/healthz` ok pero login falla con "Tenant no válido"**: el seed no corrió. Repetí paso 4.
- **MFA setup no carga el QR**: revisá que `AUTH_SECRET` esté seteado y tenga ≥ 32 caracteres.
- **Crear curso devuelve 500**: probable que la migración Prisma no se aplicó (faltan tablas `mod_courses_*`). Logs del contenedor → buscar errores de Prisma.
- **El SMTP da timeouts**: las creds de Brevo están mal o el puerto bloqueado. No es bloqueante para login (todavía no se mandan emails).

## Saneamiento post-prueba

Una vez verificado que el flujo va, **rotá**:

- `AUTH_SECRET` (forzaría re-login a todos los usuarios)
- `BOOTSTRAP_PASSWORD` desde la propia UI cuando tengamos cambio de contraseña, o seteando otra y re-corriendo el seed
- Borrar el bloque BOOTSTRAP_* del entorno una vez confirmado el seed
