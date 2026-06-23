#!/usr/bin/env bash
# ============================================================================
# dev-push.sh — sincroniza src/ con el servidor dev en segundos.
# ============================================================================
# Uso:
#   ./scripts/dev-push.sh              # usa DEV_SERVER y DEV_PATH del entorno
#   DEV_SERVER=root@1.2.3.4 ./scripts/dev-push.sh
#
# Variables de entorno (o defínelas en .env.dev-push):
#   DEV_SERVER  — user@host del servidor (default: root@135.181.150.202)
#   DEV_PATH    — ruta del repo en el servidor (default: /opt/didacta-dev)
#   DEV_EXTRA   — directorios extra separados por espacio (opcional)
#
# Requisitos:
#   - rsync instalado localmente (en Windows: usar desde WSL2 o Git Bash)
#   - SSH key autorizada en DEV_SERVER
#
# Tiempo esperado: 2-8 segundos para cambios típicos.
# ============================================================================
set -euo pipefail

# Cargar .env.dev-push si existe (para no tener que exportar vars cada vez)
if [[ -f ".env.dev-push" ]]; then
  # shellcheck disable=SC1091
  source .env.dev-push
fi

SERVER="${DEV_SERVER:-root@135.181.150.202}"
REMOTE="${DEV_PATH:-/opt/didacta-dev}"

t0=$SECONDS
changed=0

sync_dir() {
  local src="$1"
  local dst="${REMOTE}/${1}"
  if [[ -d "$src" ]]; then
    printf '  %-40s → %s\n' "$src" "$dst"
    rsync -az --delete --checksum \
      -e "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
      "$src" "${SERVER}:${REMOTE}/$(dirname "$src")/"
    changed=1
  fi
}

printf '\n🚀 dev-push → %s:%s\n\n' "$SERVER" "$REMOTE"

sync_dir "apps/api/src/"
sync_dir "apps/web/src/"
sync_dir "apps/web/public/"

# Directorios extra opcionales (ej: DEV_EXTRA="packages/core-kernel/src/")
for extra in ${DEV_EXTRA:-}; do
  sync_dir "$extra"
done

elapsed=$((SECONDS - t0))

if [[ $changed -eq 0 ]]; then
  printf '\n⚠  No hay directorios que sincronizar.\n'
  exit 1
fi

printf '\n✓ Listo en %ds\n' "$elapsed"
printf '  Web HMR:   instantáneo en el browser\n'
printf '  API watch: ~10s para que nest recompile\n'
printf '  URL:       https://dev.didacta.io\n\n'
