#!/usr/bin/env bash
# ============================================================================
# dev-deploy.sh — despliega a DEV (dev.didacta.io) CON rebuild de imagen.
# ============================================================================
# Para cambios en `modules/*` o `packages/*` (que NO se bind-montean en
# docker-compose.dev.yml: vienen de la imagen). Para cambios solo en
# `apps/*/src` usa `dev-push.sh` (rsync + watch, sin rebuild, segundos).
#
# Pipeline (análogo a prod-deploy.sh pero con Dockerfile.dev):
#   1. Sync del source + MANIFESTS del monorepo → /opt/didacta-dev.
#   2. docker build -f Dockerfile.dev → imagen `didactaio/community-dev:latest`.
#   3. docker compose -f docker-compose.dev.yml up -d app.
#
# El `entrypoint.dev.sh` corre `prisma db push` + RLS + seed en cada arranque,
# así que el schema se sincroniza solo (las tablas nuevas se crean aditivas).
# NO toca /opt/didacta-dev/.env (secretos los gestiona el operador).
#
# Uso:
#   ./scripts/dev-deploy.sh                 # deploy completo (sync+build+up)
#   ./scripts/dev-deploy.sh --no-build      # solo sync (sin rebuild)
#
# Variables (o .env.dev-push):
#   DEV_SERVER  — user@host (default: root@135.181.150.202)
#   DEV_PATH    — ruta del repo en el server (default: /opt/didacta-dev)
#   DEV_SSH_KEY — clave SSH (default: ~/.ssh/id_ed25519)
# ============================================================================
set -euo pipefail

if [[ -f ".env.dev-push" ]]; then
  # shellcheck disable=SC1091
  source .env.dev-push
fi

SERVER="${DEV_SERVER:-root@135.181.150.202}"
REMOTE="${DEV_PATH:-/opt/didacta-dev}"
SSH_KEY="${DEV_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

DO_BUILD=1
[[ "${1:-}" == "--no-build" ]] && DO_BUILD=0

# Árboles de fuente que entran al build context. Cada uno es un árbol CERRADO,
# por eso es seguro espejarlos con --delete (borra huérfanos sin tocar hermanos).
SYNC_DIRS=(
  "apps/api/src"
  "apps/web/src"
  "apps/web/public"
  "packages/database/prisma"
  "packages/database/src"
  "modules"
  "infra/docker"
)

# Archivos sueltos del build context (manifests + config de build). Se COPIAN
# (overwrite), nunca se borran del server.
collect_files() {
  local files=()
  for f in \
    pnpm-lock.yaml pnpm-workspace.yaml turbo.json package.json \
    Dockerfile Dockerfile.dev .dockerignore docker-compose.dev.yml \
    tsconfig.json tsconfig.base.json; do
    [[ -f "$f" ]] && files+=("$f")
  done
  while IFS= read -r m; do
    [[ -n "$m" ]] && files+=("$m")
  done < <(find apps packages -maxdepth 2 \( -name 'package.json' -o -name 'tsconfig*.json' \) -not -path '*/node_modules/*' 2>/dev/null)
  printf '%s\n' "${files[@]}"
}

t0=$SECONDS
printf '\n  dev-deploy → %s:%s\n\n' "$SERVER" "$REMOTE"

echo "==> 1/3 Sync source + manifests"
mapfile -t FILES < <(collect_files)
if command -v rsync >/dev/null 2>&1; then
  for d in "${SYNC_DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    printf '  %-32s → (rsync --delete)\n' "$d"
    rsync -az --checksum --delete -e "ssh ${SSH_OPTS}" "$d/" "${SERVER}:${REMOTE}/${d}/"
  done
  printf '  %-32s → (rsync --relative)\n' "manifests (${#FILES[@]} archivos)"
  rsync -az --checksum --relative -e "ssh ${SSH_OPTS}" "${FILES[@]}" "${SERVER}:${REMOTE}/"
else
  # tar NO borra huérfanos. Para conseguir semántica --delete en los árboles
  # CERRADOS (que el tar reprovee completos), los borramos en remoto ANTES de
  # extraer. Evita el gotcha Frankenstein: archivos de otra rama (p.ej.
  # backfill-access-groups.ts) que rompen el `tsc` del build.
  printf '  %s\n' "tar one-shot (sin rsync) + limpieza previa de árboles cerrados"
  RM_CMD=""
  for d in "${SYNC_DIRS[@]}"; do RM_CMD+="rm -rf '${REMOTE}/${d}'; "; done
  ssh ${SSH_OPTS} "$SERVER" "$RM_CMD"
  tar -czf - "${SYNC_DIRS[@]}" "${FILES[@]}" | ssh ${SSH_OPTS} "$SERVER" "tar -xzf - -C '${REMOTE}'"
fi

if [[ $DO_BUILD -eq 1 ]]; then
  echo ""
  echo "==> 2/3 Build imagen didactaio/community-dev:latest"
  ssh ${SSH_OPTS} "$SERVER" "cd '${REMOTE}' && docker build -t didactaio/community-dev:latest -f Dockerfile.dev ."

  echo ""
  echo "==> 3/3 Recrear contenedor app"
  ssh ${SSH_OPTS} "$SERVER" "cd '${REMOTE}' && docker compose -f docker-compose.dev.yml up -d app"
else
  echo "==> (--no-build) Solo sync, sin rebuild."
fi

elapsed=$((SECONDS - t0))
printf '\n  Listo en %ds\n' "$elapsed"
printf '  URL: https://dev.didacta.io\n\n'
