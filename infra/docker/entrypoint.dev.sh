#!/usr/bin/env bash
# ============================================================================
# entrypoint.dev.sh — arranca api + web en modo watch/HMR para desarrollo.
# Corre en el contenedor didactaio/community-dev:latest.
# ============================================================================
set -euo pipefail

log() { printf '[dev] %s\n' "$*"; }

cd /repo

# --------------------------------------------------------------------------
# Migraciones — idempotente, corre en cada arranque del contenedor.
# --------------------------------------------------------------------------
run_migrations() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    log "DATABASE_URL no definido, salto migraciones."
    return 0
  fi

  log "Activando pgvector (si no existe)..."
  local psql_url="${DATABASE_URL%%\?*}"
  psql "$psql_url" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 || \
    log "WARN: no se pudo activar pgvector."

  log "Sincronizando schema (prisma db push)..."
  pnpm --filter @didacta/database exec prisma db push \
    --skip-generate --accept-data-loss 2>&1 | grep -v "^$" || \
    log "WARN: prisma db push falló, continuando..."

  if command -v psql >/dev/null 2>&1; then
    log "Aplicando RLS..."
    psql "$psql_url" -v ON_ERROR_STOP=1 \
      -f packages/database/prisma/rls.sql >/dev/null 2>&1 || \
      log "WARN: RLS no aplicado."
    log "Aplicando seed idempotente..."
    psql "$psql_url" -v ON_ERROR_STOP=1 \
      -f packages/database/prisma/seed.sql >/dev/null 2>&1 || \
      log "WARN: seed no aplicado."
  fi
}

# --------------------------------------------------------------------------
# Arranque
# --------------------------------------------------------------------------
case "${1:-start}" in
  start)
    run_migrations

    log "Arrancando API en modo watch (:4000) y Web en modo HMR (:${WEB_PORT:-3010})..."
    log "  → API: nest start --watch  (auto-restart en cambios de src/)"
    log "  → Web: next dev            (HMR, cambios en menos de 1 segundo)"
    log ""
    log "Para desplegar cambios desde tu máquina: pnpm dev:push"
    log ""

    # API en background
    pnpm --filter @didacta/api dev &
    api_pid=$!

    # Web en background
    pnpm --filter @didacta/web dev &
    web_pid=$!

    shutdown() {
      log "Señal recibida, parando servicios..."
      kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
      wait "$api_pid" 2>/dev/null || true
      wait "$web_pid" 2>/dev/null || true
    }
    trap shutdown TERM INT

    # Termina cuando cualquiera de los dos procesos muere
    wait -n "$api_pid" "$web_pid"
    status=$?
    log "Un proceso terminó (status=$status), cerrando el otro..."
    shutdown
    exit "$status"
    ;;

  api)
    run_migrations
    exec pnpm --filter @didacta/api dev
    ;;

  web)
    exec pnpm --filter @didacta/web dev
    ;;

  migrate)
    run_migrations
    log "Solo migraciones, saliendo."
    ;;

  *)
    exec "$@"
    ;;
esac
