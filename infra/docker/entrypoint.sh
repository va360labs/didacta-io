#!/usr/bin/env bash
# ============================================================================
# entrypoint.sh — sincroniza schema, aplica políticas RLS y arranca la app
# Se ejecuta en el contenedor de Easypanel en cada deploy.
#
# Decisión actual (Fase 1.A): usamos `prisma db push` en lugar de
# `prisma migrate deploy`. Razón: el schema cambia rápido entre PRs y todavía
# no estabilizamos las migraciones versionadas. `db push` sincroniza el schema
# directamente con la BD sin necesidad de archivos en prisma/migrations.
# Cuando entremos a producción real migramos a `migrate deploy` con archivos
# versionados generados por `prisma migrate dev`.
# ============================================================================
set -euo pipefail

log() {
  printf '[entrypoint] %s\n' "$*"
}

# psql nativo no acepta `?schema=public` ni params propios de Prisma.
# Devuelve la URL sin query string para usarla en psql.
strip_url_query() {
  printf '%s' "${1%%\?*}"
}

run_migrations() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    log "DATABASE_URL no definido, salto sincronización de schema."
    return 0
  fi

  log "Sincronizando schema con prisma db push…"
  pnpm --filter @didacta/database exec prisma db push --skip-generate --accept-data-loss

  if command -v psql >/dev/null 2>&1; then
    log "Aplicando políticas RLS…"
    local psql_url
    psql_url="$(strip_url_query "$DATABASE_URL")"
    psql "$psql_url" -v ON_ERROR_STOP=1 -f packages/database/prisma/rls.sql
    log "RLS aplicado correctamente."
  else
    log "psql no disponible, salto RLS (verificá imagen base)."
  fi
}

start_api() {
  log "Levantando API en :${API_PORT:-4000}…"
  exec pnpm --filter @didacta/api exec node dist/main.js
}

start_web() {
  log "Levantando Web en :${WEB_PORT:-3000}…"
  exec pnpm --filter @didacta/web exec next start -p "${WEB_PORT:-3000}"
}

start_all() {
  run_migrations

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
  seed)    run_migrations; pnpm --filter @didacta/database db:seed; exit 0 ;;
  shell)   exec bash ;;
  *)       exec "$@" ;;
esac
