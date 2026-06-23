#!/usr/bin/env bash
# ============================================================================
# setup-dev-server.sh — configura el servidor dev POR PRIMERA VEZ.
# ============================================================================
# Ejecutar desde tu máquina local (no en el servidor):
#   bash scripts/setup-dev-server.sh [user@host]
#
# Qué hace:
#   1. Clona el repo en /opt/didacta-dev (o hace git pull si ya existe)
#   2. Copia tu .env local al servidor
#   3. Construye la imagen didactaio/community-dev:latest (~5 min, una vez)
#   4. Arranca el stack con docker-compose.dev.yml
#
# Prerrequisitos en el servidor:
#   - Docker + Docker Compose plugin instalados
#   - Puerto 4000 y 3010 accesibles (o via reverse proxy)
#   - SSH key autorizada
#
# Prerrequisitos locales:
#   - .env con las variables de producción/dev (DATABASE_URL, etc.)
#   - rsync y ssh instalados
# ============================================================================
set -euo pipefail

SERVER="${1:-root@135.181.150.202}"
REMOTE="/opt/didacta-dev"
REPO_URL="https://github.com/va360labs/didacta-community.git"

ok()   { printf '  ✓ %s\n' "$*"; }
info() { printf '  → %s\n' "$*"; }
warn() { printf '  ⚠  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

step "1/5" "Preparando servidor $SERVER"

ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$SERVER" bash <<REMOTE
set -euo pipefail
# Clonar o actualizar repo
if [ -d "$REMOTE/.git" ]; then
  echo "Repo existente, actualizando..."
  cd "$REMOTE" && git pull --ff-only
else
  echo "Clonando repo..."
  git clone "$REPO_URL" "$REMOTE"
fi
echo "ok"
REMOTE
ok "Repo listo en $SERVER:$REMOTE"

step "2/5" "Copiando .env al servidor"
if [[ -f ".env" ]]; then
  scp .env "${SERVER}:${REMOTE}/.env"
  ok ".env copiado"
else
  warn ".env no encontrado localmente. Cópialo manualmente:"
  warn "  scp .env ${SERVER}:${REMOTE}/.env"
fi

step "3/5" "Construyendo imagen dev (solo la primera vez, ~5 min)..."
info "Esto tardará unos minutos. Solo se repite si cambian deps o packages."
ssh "$SERVER" bash <<REMOTE
set -euo pipefail
cd "$REMOTE"
docker build -f Dockerfile.dev -t didactaio/community-dev:latest .
echo "ok"
REMOTE
ok "Imagen didactaio/community-dev:latest construida"

step "4/5" "Arrancando stack de desarrollo"
ssh "$SERVER" bash <<REMOTE
set -euo pipefail
cd "$REMOTE"
docker compose -f docker-compose.dev.yml up -d
echo "ok"
REMOTE
ok "Stack arrancado"

step "5/5" "Verificando health"
sleep 10
if ssh "$SERVER" "curl -fsS --max-time 10 http://localhost:4000/healthz | grep -q '\"status\":\"ok\"'" 2>/dev/null; then
  ok "API respondiendo en /healthz"
else
  warn "API no responde todavía (puede tardar hasta 90s en el primer arranque)"
fi

cat <<'DONE'

╔══════════════════════════════════════════════════════════════╗
║  ✓ Dev server listo en https://dev.didacta.io               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Deploy caliente (segundos):                                 ║
║    pnpm dev:push                                             ║
║                                                              ║
║  Ver logs:                                                   ║
║    ssh SERVER "docker compose -f /opt/didacta-dev/           ║
║      docker-compose.dev.yml logs -f"                        ║
║                                                              ║
║  Rebuild imagen (si cambian deps):                           ║
║    ssh SERVER "cd /opt/didacta-dev &&                        ║
║      docker compose -f docker-compose.dev.yml build &&       ║
║      docker compose -f docker-compose.dev.yml up -d"         ║
╚══════════════════════════════════════════════════════════════╝
DONE
