#!/usr/bin/env bash
#
# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# Deja la instancia como el primer arranque de un self-hoster: base de datos
# migrada, con RLS y grants, CERO tenants, y la API reiniciada contra ella.
#
# Por qué hace falta reiniciar la API y no basta con vaciar la base:
#   1. el registro de módulos se siembra en el bootstrap de NestJS — con la BD
#      recién vaciada bajo una API viva, cualquier `/admin/modules/...` devuelve
#      500 «No Module found»;
#   2. el token de un solo uso de `POST /setup/init` lo emite `SetupTokenService`
#      en `onApplicationBootstrap` y SOLO si no hay ningún tenant. Sin reinicio
#      no hay token, y sin token el asistente responde 403.
#
# Uso:
#   source shots/env.example.sh          # o tu propio env
#   bash shots/reset-instance.sh
#
# Al terminar imprime el `export SHOTS_SETUP_TOKEN=…` que necesita la tanda de
# capturas.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_CONTAINER="${SHOTS_PG_CONTAINER:-didacta-e2e-postgres}"
PG_USER="${SHOTS_PG_USER:-didacta}"
PG_DB="${SHOTS_PG_DB:-didacta}"
API_PORT="${SHOTS_API_PORT:-4000}"
API_LOG="${SHOTS_API_LOG:-$REPO_ROOT/apps/e2e/shots-output/api.log}"
MAILPIT_CONTAINER="${SHOTS_MAILPIT_CONTAINER:-didacta-shots-mailpit}"
MAILPIT_SMTP_PORT="${SHOTS_MAILPIT_SMTP_PORT:-1027}"
MAILPIT_HTTP_PORT="${SHOTS_MAILPIT_HTTP_PORT:-8027}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL no está seteada. Sourcea tu env antes (ver shots/env.example.sh)." >&2
  exit 1
fi

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# ─── 1. Parar la API que esté escuchando en el puerto ────────────────────────
say "Parando la API en :$API_PORT (si la hay)"
if command -v netstat >/dev/null 2>&1; then
  # `netstat -ano` es lo único que funciona igual en Git Bash y en PowerShell.
  API_PIDS="$(netstat -ano 2>/dev/null | grep -E "[:.]${API_PORT}[[:space:]]+.*LISTENING" | awk '{print $NF}' | sort -u || true)"
else
  API_PIDS="$(lsof -ti ":${API_PORT}" 2>/dev/null || true)"
fi
for pid in $API_PIDS; do
  echo "  matando PID $pid"
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  else
    kill "$pid" 2>/dev/null || true
  fi
done

# ─── 2. Base de datos limpia ─────────────────────────────────────────────────
say "Vaciando el esquema public de $PG_CONTAINER"
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' >/dev/null

say "Aplicando migraciones"
node "$REPO_ROOT/node_modules/prisma/build/index.js" migrate deploy \
  --schema "$REPO_ROOT/packages/database/prisma/schema.prisma"

say "Aplicando RLS y grants"
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f - \
  < "$REPO_ROOT/packages/database/prisma/rls.sql" >/dev/null
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f - \
  < "$REPO_ROOT/packages/database/prisma/grants.sql" >/dev/null

# OJO: no se corre `db:seed`. El recorrido empieza en el asistente de
# configuración, y el seed crearía un tenant que lo cerraría para siempre.

# ─── 3. Mailpit propio ───────────────────────────────────────────────────────
say "Mailpit ($MAILPIT_CONTAINER) en :$MAILPIT_SMTP_PORT / :$MAILPIT_HTTP_PORT"
if ! docker ps --format '{{.Names}}' | grep -qx "$MAILPIT_CONTAINER"; then
  docker rm -f "$MAILPIT_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$MAILPIT_CONTAINER" \
    -p "127.0.0.1:${MAILPIT_SMTP_PORT}:1025" \
    -p "127.0.0.1:${MAILPIT_HTTP_PORT}:8025" \
    axllent/mailpit:latest >/dev/null
fi
curl -sf -X DELETE "http://localhost:${MAILPIT_HTTP_PORT}/api/v1/messages" >/dev/null 2>&1 || true

# ─── 4. Arrancar la API y capturar el token del asistente ────────────────────
say "Arrancando la API"
mkdir -p "$(dirname "$API_LOG")"
: > "$API_LOG"
(
  cd "$REPO_ROOT/apps/api"
  nohup node dist/main.js >> "$API_LOG" 2>&1 &
  echo $! > "$REPO_ROOT/apps/e2e/shots-output/api.pid"
)

printf '  esperando /healthz'
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${API_PORT}/healthz" >/dev/null 2>&1; then
    printf ' ok\n'
    break
  fi
  printf '.'
  sleep 1
done

# La web NO la gestiona este script (se compila y se arranca una vez, ver
# README). Lo que sí hace es avisar si se ha caído: sin ella no hay capturas.
WEB_URL="${SHOTS_BASE_URL:-http://localhost:3010}"
if ! curl -sf "${WEB_URL}/healthz" >/dev/null 2>&1; then
  echo "ERROR: la web no responde en ${WEB_URL}. Arráncala antes (ver shots/README.md)." >&2
  exit 1
fi

SETUP_TOKEN="$(grep -o 'Setup token[^:]*: [A-Za-z0-9_-]\+' "$API_LOG" | tail -n1 | awk '{print $NF}' || true)"
if [[ -z "$SETUP_TOKEN" ]]; then
  echo "ERROR: no se encontró el token de setup en $API_LOG." >&2
  echo "       ¿La instancia tenía ya un tenant? SetupTokenService solo emite token si hay cero." >&2
  exit 1
fi

cat <<EOF

╭──────────────────────────────────────────────────────────────────────╮
│ Instancia virgen lista.                                              │
╰──────────────────────────────────────────────────────────────────────╯

  export SHOTS_SETUP_TOKEN='$SETUP_TOKEN'

Ahora lanza las capturas (ver shots/README.md):

  SHOTS_LOCALE=es-ES node ../../node_modules/@playwright/test/cli.js \\
    test --config playwright.shots.config.ts

EOF
