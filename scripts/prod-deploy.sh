#!/usr/bin/env bash
# ============================================================================
# prod-deploy.sh — despliega a PRODUCCIÓN (aula.va360.academy).
# ============================================================================
# Pipeline documentado de prod (análogo a dev-push.sh pero CON rebuild):
#
#   1. Sync del source + MANIFESTS del monorepo → /opt/didacta-prod.
#   2. docker build  → imagen `didactaio/community:prod`.
#   3. docker compose up -d app → recrea el contenedor con la imagen nueva.
#
# El entrypoint del contenedor corre `prisma db push` + RLS + seed.sql en cada
# arranque, así que el schema se sincroniza solo (no hace falta migrate manual).
#
# IMPORTANTE — sincroniza TODO lo que el Dockerfile necesita en el build context:
#   - Árboles de fuente (apps/*/src, packages/database/{prisma,src}, modules/).
#   - Manifests: pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json, el package.json
#     raíz y TODOS los package.json/tsconfig de apps/* y packages/*.
#   - El propio Dockerfile, .dockerignore y docker-compose.prod.yml.
# Sin esto, un build "limpio" usaría manifests/Dockerfile viejos del server
# (drift silencioso entre el código y la imagen). NO toca /opt/didacta-prod/.env
# (secretos los gestiona el operador con setup-prod-env.sh).
#
# Paso post-deploy de Fase 2 (mod.access-groups) — NO se automatiza aquí porque
# es una migración de datos one-shot ya aplicada; córrela a mano si hace falta
# re-sembrar el grupo por defecto / adoptar enrollments legacy:
#   docker compose -f docker-compose.prod.yml run --rm app \
#     pnpm --filter @didacta/database db:backfill:access-groups
# (verificá luego que el grupo va360-pro existe en GET /modules/access-groups).
#
# Diferencia con dev:
#   - dev (dev-push.sh): bind-mount + HMR/watch → SIN rebuild (segundos).
#   - prod (este script): imagen built (Dockerfile multi-stage) → CON rebuild.
#
# Uso:
#   ./scripts/prod-deploy.sh                 # deploy completo (sync+build+up)
#   ./scripts/prod-deploy.sh --no-build      # solo sync (sin rebuild)
#
# Variables (o .env.prod-deploy):
#   PROD_SERVER  — user@host (default: root@135.181.150.202)
#   PROD_PATH    — ruta del repo en el server (default: /opt/didacta-prod)
#   PROD_SSH_KEY — clave SSH (default: ~/.ssh/id_ed25519)
# ============================================================================
set -euo pipefail

if [[ -f ".env.prod-deploy" ]]; then
  # shellcheck disable=SC1091
  source .env.prod-deploy
fi

SERVER="${PROD_SERVER:-root@135.181.150.202}"
REMOTE="${PROD_PATH:-/opt/didacta-prod}"
SSH_KEY="${PROD_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

DO_BUILD=1
[[ "${1:-}" == "--no-build" ]] && DO_BUILD=0

# Árboles de fuente que entran al build context (cada uno es un árbol CERRADO,
# por eso es seguro espejarlos con --delete: borra huérfanos sin tocar hermanos).
SYNC_DIRS=(
  "apps/api/src"
  "apps/web/src"
  "apps/web/public"
  "packages/database/prisma"
  "packages/database/src"
  "modules"
  # El Dockerfile COPIA el entrypoint desde aquí; sin sincronizarlo, el build
  # usaría el entrypoint viejo del server (drift). Cerrado: árbol completo.
  "infra/docker"
)

# Archivos sueltos del build context (manifests + config de build). Se COPIAN
# (overwrite), nunca se borran del server.
collect_files() {
  local files=()
  for f in \
    pnpm-lock.yaml pnpm-workspace.yaml turbo.json package.json \
    Dockerfile .dockerignore docker-compose.prod.yml \
    tsconfig.json tsconfig.base.json; do
    [[ -f "$f" ]] && files+=("$f")
  done
  # package.json + tsconfig de cada app/package (los necesita el stage de
  # manifests del Dockerfile). modules/ ya va completo en SYNC_DIRS.
  while IFS= read -r m; do
    [[ -n "$m" ]] && files+=("$m")
  done < <(find apps packages -maxdepth 2 \( -name 'package.json' -o -name 'tsconfig*.json' \) -not -path '*/node_modules/*' 2>/dev/null)
  printf '%s\n' "${files[@]}"
}

t0=$SECONDS
printf '\n  prod-deploy → %s:%s\n\n' "$SERVER" "$REMOTE"

echo "==> 1/3 Sync source + manifests"
# Compatible con bash 3.2 (macOS): `mapfile`/`readarray` sólo existe en bash 4+.
FILES=()
while IFS= read -r __f; do
  [[ -n "$__f" ]] && FILES+=("$__f")
done < <(collect_files)
if command -v rsync >/dev/null 2>&1; then
  for d in "${SYNC_DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    printf '  %-32s → (rsync --delete)\n' "$d"
    rsync -az --checksum --delete -e "ssh ${SSH_OPTS}" "$d/" "${SERVER}:${REMOTE}/${d}/"
  done
  printf '  %-32s → (rsync --relative)\n' "manifests (${#FILES[@]} archivos)"
  rsync -az --checksum --relative -e "ssh ${SSH_OPTS}" "${FILES[@]}" "${SERVER}:${REMOTE}/"
else
  # Fallback sin rsync: un único tar con dirs + manifests (preserva rutas).
  # OJO: tar NO borra huérfanos; para limpiar archivos eliminados usá rsync.
  printf '  %s\n' "tar one-shot (sin rsync; no limpia huérfanos)"
  tar -czf - "${SYNC_DIRS[@]}" "${FILES[@]}" | ssh ${SSH_OPTS} "$SERVER" "tar -xzf - -C '${REMOTE}'"
fi

if [[ $DO_BUILD -eq 1 ]]; then
  echo ""
  echo "==> 2/3 Build imagen didactaio/community:prod"
  ssh ${SSH_OPTS} "$SERVER" "cd '${REMOTE}' && docker build -t didactaio/community:prod -f Dockerfile ."

  echo ""
  echo "==> 3/3 Recrear contenedor app"
  ssh ${SSH_OPTS} "$SERVER" "cd '${REMOTE}' && docker compose -f docker-compose.prod.yml up -d app"
else
  echo "==> (--no-build) Solo sync, sin rebuild."
fi

elapsed=$((SECONDS - t0))
printf '\n  Listo en %ds\n' "$elapsed"
printf '  URL: https://aula.va360.academy\n\n'
