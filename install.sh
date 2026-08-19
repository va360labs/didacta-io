#!/usr/bin/env bash
#
# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# Instalador de Didacta Community en un comando:
#
#   curl -fsSL https://raw.githubusercontent.com/va360labs/didacta-io/main/install.sh | bash
#
# Descarga el compose, genera la única credencial obligatoria, levanta el stack,
# espera a que responda y termina imprimiendo el enlace del asistente de
# configuración — para no tener que ir a buscar el token a los logs.
#
# No pregunta nada: se ejecuta con la entrada estándar ocupada por el propio
# script cuando viene de una tubería, así que aquí no puede haber un `read`.
#
# Se puede leer antes de ejecutar, que es lo sensato con cualquier instalador:
#   curl -fsSL <url> -o install.sh && less install.sh && bash install.sh
#
# Variables (todas opcionales):
#   DIDACTA_DIR           Carpeta de la instalación        (default: ./didacta)
#   DIDACTA_IMAGE_TAG     Versión de la imagen             (default: la de abajo)
#   DIDACTA_COMPOSE_URL   De dónde bajar el compose
#   DIDACTA_COMPOSE_FILE  Usar un compose local en vez de descargarlo
#   DIDACTA_COMPOSE_EXTRA Fichero extra de compose (override), para convivir con
#                         otra instalación en la misma máquina
#   DIDACTA_PROJECT       Nombre del proyecto de compose
#   DIDACTA_NAME_SUFFIX   Sufijo de los nombres de contenedor. Hace falta para
#                         convivir: los `container_name` son globales del host
#                         y NO los escopa el nombre de proyecto (ej. "-2")
#   WEB_PORT / API_PORT / MAILPIT_UI_PORT …    Puertos publicados
set -euo pipefail

DEFAULT_IMAGE_TAG='0.1.0-beta.6'

DIR="${DIDACTA_DIR:-didacta}"
IMAGE_TAG="${DIDACTA_IMAGE_TAG:-$DEFAULT_IMAGE_TAG}"
DIDACTA_RAW="${DIDACTA_RAW_BASE:-https://raw.githubusercontent.com/va360labs/didacta-io/main}"
COMPOSE_URL="${DIDACTA_COMPOSE_URL:-$DIDACTA_RAW/docker-compose.alpha.yml}"
INIT_SQL_URL="${DIDACTA_INIT_SQL_URL:-$DIDACTA_RAW/infra/docker/postgres/init.sql}"
WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-4000}"
MAILPIT_UI_PORT="${MAILPIT_UI_PORT:-8025}"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; off=$'\033[0m'
# Sin color cuando la salida no es una terminal (una tubería, un fichero de log,
# un CI): si no, el destinatario recibe los códigos de escape como basura.
if [[ ! -t 1 ]]; then bold=''; dim=''; red=''; off=''; fi
say()  { printf '%s▸%s %s\n' "$bold" "$off" "$1"; }
fail() { printf '%s✗ %s%s\n' "$red" "$1" "$off" >&2; exit 1; }

printf '\n%sDidacta Community%s — instalador\n\n' "$bold" "$off"

# ─── 1. Requisitos ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 ||
  fail 'Falta Docker. Instálalo desde https://docs.docker.com/get-docker/ y vuelve a lanzar esto.'
docker compose version >/dev/null 2>&1 ||
  fail 'Falta el plugin Docker Compose v2 (el comando "docker compose"). Actualiza Docker Desktop o instala docker-compose-plugin.'
docker info >/dev/null 2>&1 ||
  fail 'Docker está instalado pero el demonio no responde. Arranca Docker y vuelve a lanzar esto.'

DOCKER_V="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
COMPOSE_V="$(docker compose version --short 2>/dev/null || echo '?')"
say "Docker $DOCKER_V · Compose $COMPOSE_V"

# ─── 2. Carpeta y compose ────────────────────────────────────────────────────
mkdir -p "$DIR"
cd "$DIR"

fetch() { # fetch <url> <destino>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || fail "No se pudo descargar $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || fail "No se pudo descargar $1"
  else
    fail 'Hace falta curl o wget.'
  fi
}

if [[ -n "${DIDACTA_COMPOSE_FILE:-}" ]]; then
  cp "$DIDACTA_COMPOSE_FILE" docker-compose.alpha.yml
  say "Usando el compose local $DIDACTA_COMPOSE_FILE"
else
  say 'Descargando el compose'
  fetch "$COMPOSE_URL" docker-compose.alpha.yml
fi

# El compose monta `./infra/docker/postgres/init.sql` (extensiones de Postgres),
# así que hay que traerlo también: es lo único que ata el compose al árbol del
# repositorio, y sin él el contenedor de Postgres no llega a inicializarse.
# Se descarga en vez de escribirlo aquí para no tener dos copias del mismo SQL
# que se desincronicen. Si algún día el compose deja de montarlo, este fichero
# de más es inofensivo.
if grep -q 'infra/docker/postgres/init.sql' docker-compose.alpha.yml 2>/dev/null; then
  mkdir -p infra/docker/postgres
  fetch "$INIT_SQL_URL" infra/docker/postgres/init.sql
fi

COMPOSE=(docker compose -f docker-compose.alpha.yml)
[[ -n "${DIDACTA_COMPOSE_EXTRA:-}" ]] && COMPOSE+=(-f "$DIDACTA_COMPOSE_EXTRA")
[[ -n "${DIDACTA_PROJECT:-}" ]] && COMPOSE+=(-p "$DIDACTA_PROJECT")

# ─── 3. AUTH_SECRET ──────────────────────────────────────────────────────────
# Es la ÚNICA credencial obligatoria: firma las sesiones. Se genera aquí y se
# guarda en el .env. Si ya hay una, NO se toca: regenerarla en un `up` posterior
# echaría a todo el mundo de su sesión sin avisar.
random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\r\n'
  elif [[ -r /dev/urandom ]]; then
    LC_ALL=C tr -dc 'A-Za-z0-9+/' </dev/urandom | head -c 44
  else
    fail 'No encuentro forma de generar un secreto aleatorio (ni openssl ni /dev/urandom).'
  fi
}

if [[ -f .env ]] && grep -q '^AUTH_SECRET=.\{32,\}' .env; then
  say 'Reutilizando el AUTH_SECRET del .env que ya había'
else
  say 'Generando AUTH_SECRET (queda guardado en el .env, no se enseña por pantalla)'
  printf 'AUTH_SECRET=%s\n' "$(random_secret)" >>.env
fi

# La versión se fija SIEMPRE de forma explícita: no hay tag `latest`, y un
# despliegue que no sepa qué versión corre no se puede reproducir.
if grep -q '^DIDACTA_IMAGE_TAG=' .env 2>/dev/null; then
  IMAGE_TAG="$(grep '^DIDACTA_IMAGE_TAG=' .env | tail -n1 | cut -d= -f2-)"
  say "Manteniendo la versión que ya estaba fijada: $IMAGE_TAG"
else
  printf 'DIDACTA_IMAGE_TAG=%s\n' "$IMAGE_TAG" >>.env
fi
for var in WEB_PORT API_PORT MAILPIT_UI_PORT; do
  grep -q "^${var}=" .env 2>/dev/null || printf '%s=%s\n' "$var" "${!var}" >>.env
done

# ─── 4. Arrancar ─────────────────────────────────────────────────────────────
say "Descargando la imagen ghcr.io/va360labs/didacta-community:$IMAGE_TAG"
"${COMPOSE[@]}" pull --quiet 2>/dev/null || "${COMPOSE[@]}" pull

say 'Arrancando (la primera vez tarda: aplica migraciones, RLS y grants antes de servir)'
"${COMPOSE[@]}" up -d --quiet-pull >/dev/null 2>&1 ||
  fail "No se pudo arrancar. Mira qué pasó con: cd $DIR && docker compose -f docker-compose.alpha.yml logs"

printf '  esperando a que responda'
READY=0
for _ in $(seq 1 150); do
  if curl -fsS "http://localhost:${API_PORT}/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'
[[ "$READY" == "1" ]] ||
  fail "La instalación no respondió a tiempo. Revisa: cd $DIR && docker compose -f docker-compose.alpha.yml logs didacta"

# ─── 5. El enlace del asistente ──────────────────────────────────────────────
# El token lo emite `SetupTokenService` en el arranque y SOLO si la instancia no
# tiene ningún tenant. Buscarlo aquí evita el paso de ir a leer los logs a mano
# — que es donde se atasca todo el mundo la primera vez.
TOKEN="$("${COMPOSE[@]}" logs didacta 2>&1 |
  grep -oE 'Setup token[^:]*: *[A-Za-z0-9_-]+' | tail -n1 | awk '{print $NF}' || true)"

printf '\n╭──────────────────────────────────────────────────────────────────────╮\n'
printf   '│ Didacta está funcionando.                                            │\n'
printf   '╰──────────────────────────────────────────────────────────────────────╯\n\n'

if [[ -n "$TOKEN" ]]; then
  printf '  Abre esto para crear tu cuenta (el enlace vale una sola vez):\n\n'
  printf '      %shttp://localhost:%s/setup?token=%s%s\n\n' "$bold" "$WEB_PORT" "$TOKEN" "$off"
else
  printf '  Esta instalación ya estaba configurada: entra en\n\n'
  printf '      %shttp://localhost:%s/signin%s\n\n' "$bold" "$WEB_PORT" "$off"
fi

printf '  Web       http://localhost:%s\n' "$WEB_PORT"
printf '  API       http://localhost:%s/api/docs\n' "$API_PORT"
printf '  Correos   http://localhost:%s   %s(Mailpit, para probar sin SMTP real)%s\n' \
  "$MAILPIT_UI_PORT" "$dim" "$off"
printf '  Carpeta   %s/   %s(ahí están el compose y el .env)%s\n\n' "$DIR" "$dim" "$off"
printf '  %sParar:%s      cd %s && docker compose -f docker-compose.alpha.yml down\n' \
  "$bold" "$off" "$DIR"
printf '  %sActualizar:%s cambia DIDACTA_IMAGE_TAG en el .env y repite el arranque\n\n' \
  "$bold" "$off"
