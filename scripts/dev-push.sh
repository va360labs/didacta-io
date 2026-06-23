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
#   DEV_SSH_KEY — ruta a la clave SSH (default: ~/.ssh/id_ed25519)
#   DEV_EXTRA   — directorios extra separados por espacio (opcional)
#
# Tiempo esperado: 2-8 segundos para cambios típicos.
# ============================================================================
set -euo pipefail

# Cargar .env.dev-push si existe
if [[ -f ".env.dev-push" ]]; then
  # shellcheck disable=SC1091
  source .env.dev-push
fi

SERVER="${DEV_SERVER:-root@135.181.150.202}"
REMOTE="${DEV_PATH:-/opt/didacta-dev}"
SSH_KEY="${DEV_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i ${SSH_KEY}"

t0=$SECONDS
changed=0

# ---- motor de sync: rsync si está disponible, tar+ssh si no --------------------
if command -v rsync >/dev/null 2>&1; then
  sync_dir() {
    local src="$1"
    if [[ -d "$src" ]]; then
      printf '  %-40s → %s/%s\n' "$src" "$REMOTE" "$(dirname "$src")"
      rsync -az --delete --checksum \
        -e "ssh ${SSH_OPTS}" \
        "$src" "${SERVER}:${REMOTE}/$(dirname "$src")/"
      changed=1
    fi
  }
else
  # Fallback: tar local | ssh tar remoto (~2-5s extra pero sin rsync)
  sync_dir() {
    local src="$1"
    if [[ -d "$src" ]]; then
      local remote_dst="${REMOTE}/$(dirname "$src")"
      printf '  %-40s → %s\n' "$src" "$remote_dst"
      tar -czf - "$src" | ssh ${SSH_OPTS} "$SERVER" \
        "mkdir -p '${remote_dst}' && tar -xzf - -C '${REMOTE}'"
      changed=1
    fi
  }
fi

printf '\n  dev-push → %s:%s\n\n' "$SERVER" "$REMOTE"

sync_dir "apps/api/src/"
sync_dir "apps/web/src/"
sync_dir "apps/web/public/"

# Directorios extra opcionales
for extra in ${DEV_EXTRA:-}; do
  sync_dir "$extra"
done

elapsed=$((SECONDS - t0))

if [[ $changed -eq 0 ]]; then
  printf '\n  No hay directorios que sincronizar.\n'
  exit 1
fi

printf '\n  Listo en %ds\n' "$elapsed"
printf '  Web HMR:   instantaneo en el browser\n'
printf '  API watch: ~10s para que nest recompile\n'
printf '  URL:       https://dev.didacta.io\n\n'
