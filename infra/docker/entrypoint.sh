#!/usr/bin/env bash
# ============================================================================
# entrypoint.sh — aplica migraciones versionadas, políticas RLS y arranca la app
# Se ejecuta en el contenedor en cada arranque/deploy.
#
# Desde la retomada fair-code (2026-07-31) el schema se aplica con
# `prisma migrate deploy` sobre migraciones versionadas: un self-hoster tiene
# que poder actualizar entre versiones de forma reproducible. `db push` queda
# solo para desarrollo local (entrypoint.dev.sh).
#
# Instalaciones que venían de la era `db push` (BD ya poblada sin tabla
# _prisma_migrations): marcar el baseline como aplicado UNA sola vez antes
# del primer arranque con esta imagen:
#   prisma migrate resolve --applied 20260731120000_baseline_faircode
# (procedimiento completo en https://didacta.io/docs).
#
# ----------------------------------------------------------------------------
# RLS F3 — flip real a didacta_app (release post-intermedia alpha.95)
# ----------------------------------------------------------------------------
# Dos conexiones distintas, dos variables:
#   - ADMIN_DATABASE_URL: usuario bootstrap (superuser/owner). Aplica
#     `prisma migrate deploy` + rls.sql + grants.sql + seed.sql. Opcional: si
#     falta, cae a DATABASE_URL (camino de actualización de abajo).
#   - DATABASE_URL: conexión de RUNTIME de la app (api/web). Si el operador la
#     define explícitamente se respeta tal cual — incluida una instalación
#     existente que la traía apuntando al usuario bootstrap (upgrade path:
#     sigue arrancando sin tocar nada, con una degradación logueada). Si NO
#     la define, este script la DERIVA de ADMIN_DATABASE_URL sustituyendo
#     usuario/contraseña por `didacta_app` (rol NOBYPASSRLS de grants.sql) y
#     la contraseña resuelta de POSTGRES_APP_PASSWORD (env, o autogenerada y
#     persistida en /app/data/.postgres-app-password — mismo patrón que
#     TENANT_SETTINGS_ENC_KEY en apps/api/src/auth/cipher-key.ts).
#
# El aislamiento REAL de RLS (queries sin contexto de tenant devuelven 0
# filas) solo existe cuando el proceso de la app conecta como didacta_app. Con
# DATABASE_URL apuntando al bootstrap (superuser, BYPASSRLS implícito), RLS
# sigue sin filtrar — se loguea como degradación explícita al arrancar.
# ============================================================================
set -euo pipefail

log() {
  printf '[entrypoint] %s\n' "$*"
}

POSTGRES_APP_PASSWORD_FILE="${POSTGRES_APP_PASSWORD_FILE:-/app/data/.postgres-app-password}"

# Conexión de administración (migraciones + rls.sql + grants.sql + seed.sql):
# ADMIN_DATABASE_URL si está definida, si no cae a DATABASE_URL (upgrade path:
# instalaciones existentes que solo tenían DATABASE_URL=<bootstrap>).
resolve_admin_url() {
  if [[ -n "${ADMIN_DATABASE_URL:-}" ]]; then
    printf '%s' "$ADMIN_DATABASE_URL"
  else
    printf '%s' "${DATABASE_URL:-}"
  fi
}

# Contraseña del rol didacta_app: env explícita, archivo persistente existente,
# o autogenerada + persistida (0600) en /app/data la primera vez. Sobrevive
# redeploys mientras el volumen persista (mismo patrón que TENANT_SETTINGS_ENC_KEY).
resolve_app_password() {
  if [[ -n "${POSTGRES_APP_PASSWORD:-}" ]]; then
    printf '%s' "$POSTGRES_APP_PASSWORD"
    return 0
  fi
  if [[ -f "$POSTGRES_APP_PASSWORD_FILE" ]]; then
    cat "$POSTGRES_APP_PASSWORD_FILE"
    return 0
  fi
  log "POSTGRES_APP_PASSWORD: generando y persistiendo en $POSTGRES_APP_PASSWORD_FILE (primer arranque)…" >&2
  mkdir -p "$(dirname "$POSTGRES_APP_PASSWORD_FILE")"
  local generated
  generated="$(openssl rand -hex 32)"
  printf '%s' "$generated" >"$POSTGRES_APP_PASSWORD_FILE"
  chmod 600 "$POSTGRES_APP_PASSWORD_FILE" 2>/dev/null || true
  printf '%s' "$generated"
}

# Deriva `postgresql://didacta_app:<password>@host:port/db?params` a partir de
# una URL admin, preservando host/puerto/db/query string. Solo entiende el
# formato user:pass@host — si no matchea, falla ruidosamente (mejor abortar
# que arrancar con una URL mal formada).
build_didacta_app_url() {
  local admin_url="$1" password="$2"
  if [[ "$admin_url" =~ ^postgres(ql)?://[^:@/]+(:[^@/]*)?@([^/]+)(/.*)?$ ]]; then
    local hostport="${BASH_REMATCH[3]}"
    local rest="${BASH_REMATCH[4]:-}"
    printf 'postgresql://didacta_app:%s@%s%s' "$password" "$hostport" "$rest"
  else
    return 1
  fi
}

# Resuelve la DATABASE_URL efectiva para el PROCESO de la app (api/web):
#   1. Si el operador definió DATABASE_URL, se respeta tal cual (upgrade path).
#      Si no apunta a didacta_app, se loguea la degradación (RLS no filtra de
#      verdad — la app conecta con un rol que hace bypass).
#   2. Si no, se deriva de ADMIN_DATABASE_URL + la contraseña resuelta.
resolve_runtime_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    if [[ "$DATABASE_URL" != postgres*://didacta_app:* ]]; then
      log "⚠ DEGRADADO: DATABASE_URL no conecta como 'didacta_app' — RLS no aplica de verdad (el rol actual puede hacer bypass). Para aislamiento real, quita DATABASE_URL del entorno y define ADMIN_DATABASE_URL con el usuario bootstrap; este script derivará la conexión de didacta_app automáticamente. Ver https://didacta.io/docs § flip a didacta_app." >&2
    fi
    printf '%s' "$DATABASE_URL"
    return 0
  fi

  local admin_url
  admin_url="$(resolve_admin_url)"
  if [[ -z "$admin_url" ]]; then
    log "ERROR: ni DATABASE_URL ni ADMIN_DATABASE_URL están definidas. Al menos una es obligatoria." >&2
    return 1
  fi

  local app_password derived
  app_password="$(resolve_app_password)"
  if ! derived="$(build_didacta_app_url "$admin_url" "$app_password")"; then
    log "ERROR: no pude derivar la URL de didacta_app desde ADMIN_DATABASE_URL (formato inesperado). Definí DATABASE_URL explícitamente." >&2
    return 1
  fi
  log "DATABASE_URL derivada de ADMIN_DATABASE_URL: runtime conecta como didacta_app (aislamiento RLS real)." >&2
  printf '%s' "$derived"
}

# ----------------------------------------------------------------------------
# init-as-root — chown del volumen persistente y drop a UID 1001 (didacta)
# ----------------------------------------------------------------------------
# Razón: Docker monta un volumen NUEVO sobre `/app/data` con owner root:root,
# pero la app corre como `didacta` (UID 1001). Sin este bloque, la primera
# escritura del marketplace (`mkdir /app/data/storage`) falla con EACCES y el
# install de cualquier módulo devuelve 500.
#
# Patrón inspirado en las imágenes oficiales de Postgres/Redis: el container
# arranca como root SOLO para arreglar perms del volumen y enseguida baja
# privilegios con `su-exec`. El proceso final (Node) corre como didacta.
#
# El bloque es idempotente: si el volumen ya tiene los perms correctos (re-
# arranques posteriores), el chown es no-op. Si ya corremos como didacta
# (ej. tests locales sin Docker), saltea el bloque entero.
if [[ "$(id -u)" == "0" ]]; then
  log "Arrancando como root: aseguro perms del volumen persistente /app/data…"
  mkdir -p /app/data/storage
  chown -R didacta:didacta /app/data
  log "Drop a didacta:didacta con su-exec."
  exec su-exec didacta:didacta "$0" "$@"
fi
# A partir de aquí siempre corremos como didacta (UID 1001).

# psql nativo no acepta `?schema=public` ni params propios de Prisma.
# Devuelve la URL sin query string para usarla en psql.
strip_url_query() {
  printf '%s' "${1%%\?*}"
}

ensure_pgvector_extension() {
  local admin_url="$1"
  if ! command -v psql >/dev/null 2>&1; then
    log "psql no disponible, salto activación pgvector (verificá imagen base)."
    return 0
  fi
  local psql_url
  psql_url="$(strip_url_query "$admin_url")"
  log "Activando extensión pgvector si no existe…"
  if ! psql "$psql_url" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1; then
    log "WARN: no se pudo activar pgvector. Si tu Postgres no es pgvector/pgvector la app fallará al crear tablas con tipo 'vector'."
    log "WARN: solucionalo con 'CREATE EXTENSION vector;' en la BD destino, o usá la imagen pgvector/pgvector:pg17."
  fi
}

# Migraciones + RLS + grants + seed corren SIEMPRE con la conexión ADMIN
# (bootstrap/superuser): son operaciones de owner (DDL, roles de cluster,
# ALTER DEFAULT PRIVILEGES). El rol didacta_app nunca las ejecuta.
run_migrations() {
  local admin_url
  admin_url="$(resolve_admin_url)"
  if [[ -z "$admin_url" ]]; then
    log "DATABASE_URL/ADMIN_DATABASE_URL no definida, salto sincronización de schema."
    return 0
  fi

  ensure_pgvector_extension "$admin_url"

  # `migrate deploy` solo aplica migraciones pendientes y NUNCA improvisa
  # cambios: si la BD trae una migración fallida a medias, aborta ruidosamente
  # (P3009) y se resuelve a mano con `prisma migrate resolve`, nunca
  # destruyendo datos en el arranque del contenedor.
  log "Aplicando migraciones versionadas con prisma migrate deploy (conexión admin)…"
  DATABASE_URL="$admin_url" pnpm --filter @didacta/database exec prisma migrate deploy

  if command -v psql >/dev/null 2>&1; then
    local admin_psql_url
    admin_psql_url="$(strip_url_query "$admin_url")"

    log "Aplicando políticas RLS…"
    psql "$admin_psql_url" -v ON_ERROR_STOP=1 -f packages/database/prisma/rls.sql
    log "RLS aplicado correctamente."

    log "Aplicando roles y grants de runtime (didacta_app + didacta_super)…"
    psql "$admin_psql_url" -v ON_ERROR_STOP=1 -f packages/database/prisma/grants.sql

    local app_password
    app_password="$(resolve_app_password)"
    log "Actualizando contraseña del rol didacta_app…"
    # `psql -c` NO interpola `:'var'` (solo lo hace en modo script -f/stdin) —
    # por eso esto va como script por stdin, nunca como -c.
    printf "ALTER ROLE didacta_app PASSWORD :'pw';\n" |
      psql "$admin_psql_url" -v ON_ERROR_STOP=1 -v pw="$app_password" -f - >/dev/null
    log "Grants aplicados correctamente."

    log "Aplicando seed idempotente (espacios de sistema)…"
    psql "$admin_psql_url" -v ON_ERROR_STOP=1 -f packages/database/prisma/seed.sql
    log "Seed aplicado correctamente."
  else
    log "psql no disponible, salto RLS, grants y seed (verificá imagen base)."
  fi
}

start_api() {
  local runtime_url
  if ! runtime_url="$(resolve_runtime_database_url)"; then
    exit 1
  fi
  export DATABASE_URL="$runtime_url"
  log "Levantando API en :${API_PORT:-4000}…"
  exec pnpm --filter @didacta/api exec node dist/main.js
}

start_web() {
  log "Levantando Web en :${WEB_PORT:-3000}…"
  exec pnpm --filter @didacta/web exec next start -p "${WEB_PORT:-3000}"
}

start_all() {
  run_migrations

  local runtime_url
  if ! runtime_url="$(resolve_runtime_database_url)"; then
    exit 1
  fi
  export DATABASE_URL="$runtime_url"

  log "Arrancando API y Web en paralelo…"
  pnpm --filter @didacta/api exec node dist/main.js &
  api_pid=$!
  pnpm --filter @didacta/web exec next start -p "${WEB_PORT:-3000}" &
  web_pid=$!

  shutdown() {
    log "Recibida señal, parando procesos…"
    kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  }
  trap shutdown TERM INT

  wait -n "$api_pid" "$web_pid"
  status=$?
  log "Un proceso terminó (status=$status). Cerrando el otro…"
  shutdown
  exit "$status"
}

case "${1:-start}" in
  start)   start_all ;;
  api)     run_migrations; start_api ;;
  web)     start_web ;;
  migrate) run_migrations; log "Solo sincronización de schema, salgo."; exit 0 ;;
  # db:seed escribe datos globales cross-tenant (tenant + admin) sin contexto
  # RLS: corre con la conexión ADMIN, igual que rls.sql/grants.sql/seed.sql.
  seed)    run_migrations; DATABASE_URL="$(resolve_admin_url)" pnpm --filter @didacta/database db:seed; exit 0 ;;
  shell)   exec bash ;;
  *)       exec "$@" ;;
esac
