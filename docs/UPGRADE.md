# Actualizar Didacta Community

Didacta versiona con SemVer y publica cada versión como un tag de imagen
Docker (`ghcr.io/va360labs/didacta-community:<versión>`). No existe tag
`latest`: cada instalación fija su versión con `DIDACTA_IMAGE_TAG` y decide
cuándo subir.

## Actualización normal

```bash
# 1. SIEMPRE: copia de seguridad (ver INSTALL.md § Copias de seguridad)
docker exec didacta-postgres pg_dump -U didacta -d didacta -Fc > pre-upgrade.dump

# 2. Cambia la versión en .env
#    DIDACTA_IMAGE_TAG=<nueva versión>

# 3. Baja la imagen nueva y recrea el contenedor de la app
docker compose -f docker-compose.alpha.yml pull didacta
docker compose -f docker-compose.alpha.yml up -d didacta
```

En el arranque, el contenedor aplica solo las migraciones **pendientes**
(`prisma migrate deploy`) y reaplica las políticas RLS. Si una migración
falla, el arranque se detiene ruidosamente (error `P3009`) sin tocar datos:
revisa el log del contenedor, corrige la causa y vuelve a arrancar.

- El schema nunca se modifica fuera de migraciones versionadas. `prisma db push`
  está reservado a entornos de desarrollo.
- No saltes versiones major sin leer el CHANGELOG: los breaking changes llevan
  siempre nota de migración.

## Rollback

1. Restaura la copia: `docker exec -i didacta-postgres pg_restore -U didacta -d didacta --clean < pre-upgrade.dump`
2. Vuelve a poner el `DIDACTA_IMAGE_TAG` anterior y `docker compose ... up -d didacta`.

Nunca hagas rollback de la imagen sin restaurar la base de datos: una BD con
migraciones de una versión más nueva no es compatible con la imagen antigua.

## Flip a `didacta_app` (aislamiento RLS real)

Desde esta versión, la app deja de conectar con el usuario bootstrap/superuser
en runtime. Dos variables en vez de una:

- `ADMIN_DATABASE_URL`: el usuario bootstrap (el que ya usabas como
  `DATABASE_URL`). El entrypoint la usa SOLO para migraciones + políticas RLS
  + grants — nunca para servir tráfico.
- `DATABASE_URL`: la conexión de RUNTIME de la app. **Dejala vacía** — el
  entrypoint la deriva automáticamente del host/puerto/base de
  `ADMIN_DATABASE_URL`, conectando como el rol `didacta_app` (sin bypass de
  RLS). La contraseña de ese rol es `POSTGRES_APP_PASSWORD` si la fijás, o se
  autogenera y persiste en el volumen de datos la primera vez.

**Migración de una instalación existente:**

```bash
# En tu .env:
# 1. Renombra la línea DATABASE_URL=<valor> a ADMIN_DATABASE_URL=<el mismo valor>
# 2. Borra (o deja vacía) la línea DATABASE_URL

# 3. Recrea el contenedor
docker compose -f docker-compose.alpha.yml up -d didacta
```

Al arrancar, el log confirma el modo: `runtime conecta como didacta_app
(aislamiento RLS real)`. Si por algún motivo necesitás mantener temporalmente
la app conectando con el usuario bootstrap (no recomendado — sin aislamiento
real entre tenants), dejá `DATABASE_URL` definida explícitamente: el
entrypoint la respeta tal cual y lo advierte en el log como degradación
explícita, sin romper el arranque.

## Caso especial: instalaciones anteriores al baseline (era `db push`)

Hasta la retomada fair-code (2026-07-31) el
schema se aplicaba con `prisma db push` y la base de datos **no tiene tabla
`_prisma_migrations`**. Esas instalaciones deben adoptar el baseline UNA sola
vez antes de arrancar la primera imagen con migraciones:

```bash
# Con la BD de la instalación accesible en DATABASE_URL y la imagen nueva:
docker compose -f docker-compose.alpha.yml run --rm didacta shell
# dentro del contenedor:
pnpm --filter @didacta/database exec prisma migrate resolve --applied 20260731120000_baseline_faircode
exit
docker compose -f docker-compose.alpha.yml up -d didacta
```

`migrate resolve --applied` no ejecuta SQL: solo registra que el schema del
baseline ya existe (lo creó `db push` en su día). A partir de ahí, las
actualizaciones siguen el camino normal.
