#!/usr/bin/env bash
# ============================================================================
# Didacta — arnés E2E: levanta el producto ENTERO y lo deja reproducible.
# ----------------------------------------------------------------------------
# Antes de este script la receta de arranque vivía repartida entre el workflow
# de CI y un documento, y ninguno de los dos levantaba el producto completo:
# faltaban los espacios de sistema (`prisma/seed.sql`), el onboarding del admin
# sembrado, Redis (realtime) y los secretos de webhooks de pago. El resultado
# eran 25 tests en rojo que parecían fallos de producto y no lo eran.
#
# Uso (siempre desde la raíz del repo):
#
#   bash scripts/e2e-stack.sh up        # infra docker (postgres + redis)
#   bash scripts/e2e-stack.sh schema    # migraciones + RLS + grants, SIN sembrar
#   bash scripts/e2e-stack.sh db        # schema + seeds (tenants y espacios)
#   bash scripts/e2e-stack.sh build     # packages + modules + api + web
#   bash scripts/e2e-stack.sh start     # arranca api y web y espera healthz
#   bash scripts/e2e-stack.sh stop      # para SOLO los procesos que arrancó
#   bash scripts/e2e-stack.sh reset     # BD limpia + REINICIO de la api
#   bash scripts/e2e-stack.sh check     # diagnóstico del stack
#   bash scripts/e2e-stack.sh all       # up + db + build + start
#   bash scripts/e2e-stack.sh test [args…]   # reset + playwright
#
# `reset` existe porque la suite NO es idempotente: los specs de Fundae usan
# NIFs fijos y en la segunda pasada devuelven 409. Y reinicia la API a
# propósito: el registro de módulos y el token de setup se emiten en el
# bootstrap de NestJS, así que una BD nueva bajo una API viva deja
# `module-toggle` fallando con un 500 que no tiene nada que ver.
#
# Nunca mata procesos que no haya arrancado él (esta máquina tiene huérfanos de
# otros proyectos): guarda los PID en .e2e-stack/ y sólo toca esos.
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/e2e-env.sh
. "$REPO_ROOT/scripts/e2e-env.sh"

RUN_DIR="$REPO_ROOT/.e2e-stack"
API_PID_FILE="$RUN_DIR/api.pid"
WEB_PID_FILE="$RUN_DIR/web.pid"
API_LOG="$RUN_DIR/api.log"
WEB_LOG="$RUN_DIR/web.log"
COMPOSE_FILE="$REPO_ROOT/docker-compose.test.yml"

# Segundos que esperamos a que api+web respondan. La primera arrancada de Next
# en Windows tarda bastante más que en un runner Linux.
readonly HEALTH_TIMEOUT_SECONDS=180

NODE_BIN="node"
PRISMA_CLI="$REPO_ROOT/node_modules/prisma/build/index.js"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"
TSC_BIN="$REPO_ROOT/node_modules/typescript/bin/tsc"
NEST_CLI="$REPO_ROOT/node_modules/@nestjs/cli/bin/nest.js"
NEXT_CLI="$REPO_ROOT/node_modules/next/dist/bin/next"
PLAYWRIGHT_CLI="$REPO_ROOT/node_modules/@playwright/test/cli.js"

log() { printf '\033[36m[e2e-stack]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[e2e-stack] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$RUN_DIR"

# ── infra ───────────────────────────────────────────────────────────────────
cmd_up() {
  log "Levantando docker-compose.test.yml (postgres $E2E_PG_PORT, redis 6380)…"
  docker compose -f "$COMPOSE_FILE" up -d --wait
  log "Infra lista."
}

cmd_down() {
  log "Bajando la infra y BORRANDO sus datos…"
  docker compose -f "$COMPOSE_FILE" down -v
}

# psql contra el Postgres del compose. Se hace por `docker exec` a propósito:
# es el único camino que funciona igual en este Windows (sin cliente psql
# instalado) y en el runner de CI, porque el compose es el mismo en los dos.
psql_file() {
  docker exec -i "$E2E_PG_CONTAINER" psql -U "$E2E_PG_USER" -d "$E2E_PG_DB" -v ON_ERROR_STOP=1 -f - < "$1"
}

psql_query() {
  docker exec -i "$E2E_PG_CONTAINER" psql -U "$E2E_PG_USER" -d "$E2E_PG_DB" -t -A -c "$1"
}

# ── base de datos ───────────────────────────────────────────────────────────
# Sólo el esquema: migraciones + RLS + grants, SIN sembrar. Lo necesita el
# wizard de `/setup`, que sólo se puede completar una vez por instancia y por
# tanto exige una base donde todavía no exista ningún tenant.
cmd_schema() {
  assert_prisma_client
  log "Aplicando migraciones…"
  "$NODE_BIN" "$PRISMA_CLI" migrate deploy --schema packages/database/prisma/schema.prisma

  # grants.sql no es opcional: desde RLS F3 el arranque hace
  # `SET LOCAL ROLE didacta_super` y sin el rol la API no llega a levantar.
  log "Aplicando rls.sql y grants.sql…"
  psql_file packages/database/prisma/rls.sql >/dev/null
  psql_file packages/database/prisma/grants.sql >/dev/null
}

assert_prisma_client() {
  [ -d "$REPO_ROOT/node_modules/.prisma/client" ] || \
    [ -n "$(find "$REPO_ROOT/node_modules/.pnpm" -maxdepth 6 -type d -name '.prisma' -print -quit 2>/dev/null)" ] || \
    die "Falta el cliente Prisma. Corre primero: bash scripts/e2e-stack.sh build"
}

cmd_db() {
  # `prisma generate` vive en `build`, no aquí: en Windows el motor de consultas
  # (`query_engine-windows.dll.node`) queda abierto por la API viva y el rename
  # revienta con EPERM. `reset` corre `db` con la API parada, pero `db` suelto
  # se usa muchas veces con el stack arriba.
  cmd_schema

  log "Sembrando tenant principal ($BOOTSTRAP_TENANT_SLUG)…"
  ( cd packages/database && \
    BOOTSTRAP_TENANT_SLUG="$BOOTSTRAP_TENANT_SLUG" \
    BOOTSTRAP_EMAIL="$BOOTSTRAP_EMAIL" \
    BOOTSTRAP_PASSWORD="$BOOTSTRAP_PASSWORD" \
    BOOTSTRAP_DOMAINS="localhost" \
    "$NODE_BIN" "$TSX_CLI" src/seed.ts >/dev/null )

  # Segundo tenant, con el MISMO seed del producto (es idempotente y va por
  # env). Sirve a los specs que afirman estados vacíos: en `demo` dejan de ser
  # ciertos a mitad de suite. BOOTSTRAP_DOMAINS propio y obligatorio — con el
  # default le robaría `localhost` al tenant principal.
  log "Sembrando tenant de smoke ($E2E_SMOKE_TENANT_SLUG)…"
  ( cd packages/database && \
    BOOTSTRAP_TENANT_SLUG="$E2E_SMOKE_TENANT_SLUG" \
    BOOTSTRAP_TENANT_NAME="E2E Smoke" \
    BOOTSTRAP_EMAIL="$E2E_SMOKE_ADMIN_EMAIL" \
    BOOTSTRAP_PASSWORD="$BOOTSTRAP_PASSWORD" \
    BOOTSTRAP_DOMAINS="$E2E_SMOKE_TENANT_DOMAIN" \
    "$NODE_BIN" "$TSX_CLI" src/seed.ts >/dev/null )

  # seed.sql crea los 4 espacios de sistema (general/anuncios/preguntas/recursos)
  # para TODOS los tenants. Lo aplica infra/docker/entrypoint.sh en el contenedor
  # de producto, pero ni `db:seed` ni el arnés lo hacían: `mod_community_space`
  # se quedaba a 0 filas y todo lo de comunidad/espacios fallaba por datos que
  # no existían. Va DESPUÉS de los seeds porque necesita los tenants creados.
  log "Aplicando seed.sql (espacios de sistema)…"
  psql_file packages/database/prisma/seed.sql >/dev/null

  local spaces
  spaces="$(psql_query 'SELECT count(*) FROM mod_community_space;')"
  log "Base lista. Espacios de sistema sembrados: $spaces"
}

# ── compilación ─────────────────────────────────────────────────────────────
cmd_build() {
  # Requiere la API PARADA: en Windows el rename del motor de consultas de
  # Prisma da EPERM si algún proceso lo tiene abierto.
  log "Generando cliente Prisma…"
  "$NODE_BIN" "$PRISMA_CLI" generate --schema packages/database/prisma/schema.prisma >/dev/null

  log "Compilando los 5 packages…"
  for p in packages/database packages/core-kernel packages/core-registry \
           packages/license-sdk packages/module-package-spec; do
    ( cd "$p" && "$NODE_BIN" "$TSC_BIN" -p tsconfig.json )
  done

  # Los 24 modules NO son opcionales: sin dist/ la API falla en *collect*.
  log "Compilando los modules…"
  for p in modules/*/; do
    ( cd "$p" && "$NODE_BIN" "$TSC_BIN" -p tsconfig.json )
  done

  log "Compilando la API…"
  ( cd apps/api && "$NODE_BIN" "$NEST_CLI" build )

  # API_INTERNAL_URL se CONGELA en el build: los rewrites de next.config.mjs se
  # hornean en routes-manifest.json. Mover la API de puerto obliga a reconstruir.
  log "Compilando la web…"
  ( cd apps/web && API_INTERNAL_URL="$API_INTERNAL_URL" NODE_ENV=production \
      "$NODE_BIN" "$NEXT_CLI" build )
}

# ── procesos ────────────────────────────────────────────────────────────────
is_alive() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 1
  local pid
  pid="$(cat "$pid_file")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

api_responds() { curl -sf -o /dev/null "http://localhost:${PORT}/healthz" 2>/dev/null; }
web_responds() { curl -sf -o /dev/null "${E2E_BASE_URL}/signin" 2>/dev/null; }

# Segundos que lleva viva la API que está contestando. `/healthz` lo expone.
api_uptime_seconds() {
  curl -s "http://localhost:${PORT}/healthz" 2>/dev/null |
    sed -n 's/.*"uptime":[[:space:]]*\([0-9]*\).*/\1/p'
}

# Marca de tiempo de nuestro último lanzamiento; vacía si reusamos el proceso
# que ya teníamos. La usa `wait_healthy` para exigir que quien contesta sea el
# que acabamos de arrancar y no un superviviente.
API_LAUNCHED_AT=""

# ── Por qué esto no es paranoia ─────────────────────────────────────────────
# `node dist/main.js` con el puerto ocupado muere al instante con EADDRINUSE,
# pero como el proceso de antes SIGUE contestando, las sondas de `wait_healthy`
# daban verde y la suite entera corría contra el binario viejo, con el registro
# de módulos y los bridges de OTRA generación de la base. Un worker perdió una
# sesión así: `stop` no había matado nada, `start` no arrancó nada, y nadie se
# enteró. Ahora el puerto ocupado por alguien que no somos nosotros ES un
# fallo, y nunca se mata a ciegas: esta máquina tiene huérfanos de otros
# proyectos.
start_api() {
  if is_alive "$API_PID_FILE"; then
    log "API ya viva (pid $(cat "$API_PID_FILE"))."
    return
  fi
  if api_responds; then
    die "El puerto $PORT ya lo sirve un proceso que NO arrancamos nosotros (lleva $(api_uptime_seconds)s vivo).
No se mata nada por tu cuenta y riesgo: localiza al dueño y decide tú.
  netstat -ano | findstr :$PORT      # Windows
  ss -tlnp | grep :$PORT             # Linux
Si es un resto de una sesión anterior de este mismo repo, mátalo y repite."
  fi
  log "Arrancando la API en :$PORT…"
  # El subshell anota su PROPIO pid y se convierte en el proceso (`exec`), así
  # que el fichero guarda el pid del node de verdad. Con `$!` guardaba el del
  # job del subshell, que en cuanto ese subshell desaparecía dejaba de
  # resolverse: `is_alive` decía «no está», `stop` no mataba nada y borraba el
  # pid file tan contento mientras el proceso seguía sirviendo.
  ( cd apps/api && exec >"$API_LOG" 2>&1
    echo "$BASHPID" > "$API_PID_FILE"
    exec "$NODE_BIN" dist/main.js ) &
  API_LAUNCHED_AT="$(date +%s)"
}

start_web() {
  if is_alive "$WEB_PID_FILE"; then
    log "Web ya viva (pid $(cat "$WEB_PID_FILE"))."
    return
  fi
  if web_responds; then
    die "El puerto 3010 ya lo sirve un proceso que NO arrancamos nosotros.
Mismo caso que la API: localiza al dueño antes de matar nada.
  netstat -ano | findstr :3010       # Windows
  ss -tlnp | grep :3010              # Linux"
  fi
  # PORT=4000 es de la API y `next start` lo respeta por encima del -p del
  # script; hay que quitarlo del entorno del proceso web.
  log "Arrancando la web en :3010…"
  ( cd apps/web && unset PORT && exec >"$WEB_LOG" 2>&1
    echo "$BASHPID" > "$WEB_PID_FILE"
    exec "$NODE_BIN" "$NEXT_CLI" start -p 3010 ) &
}

stop_pid_file() {
  local pid_file="$1" name="$2"
  if is_alive "$pid_file"; then
    local pid
    pid="$(cat "$pid_file")"
    log "Parando $name (pid $pid)…"
    kill "$pid" 2>/dev/null || true
    # En Windows `next start` deja un hijo; el group kill lo recoge.
    kill -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

# `kill` puede no llevarse el proceso por delante (pid de MSYS que ya no mapea,
# hijo que sobrevive al padre…) y hasta ahora eso se tragaba: `stop` decía que
# había parado y el proceso seguía sirviendo. Comprobar el puerto convierte ese
# no-op en un fallo con nombre.
assert_port_stopped() {
  local probe="$1" label="$2" port="$3"
  local i=0
  while [ "$i" -lt 10 ]; do
    if ! $probe; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  die "$label sigue sirviendo en :$port después de pararla.
El kill no se la llevó por delante. Localiza el proceso y decide tú:
  netstat -ano | findstr :$port      # Windows
  ss -tlnp | grep :$port             # Linux
Seguir sin esto deja la tanda corriendo contra el binario viejo."
}

# Tercera red, por si el puerto se liberó y lo recuperó otro entre medias: la
# API que contesta no puede llevar viva más de lo que hace que la lanzamos.
# `uptime` sale de `/healthz`. El margen absorbe el redondeo a segundos.
assert_api_is_the_one_we_launched() {
  [ -n "$API_LAUNCHED_AT" ] || return 0
  local up now elapsed
  up="$(api_uptime_seconds)"
  [ -n "$up" ] || return 0
  now="$(date +%s)"
  elapsed=$((now - API_LAUNCHED_AT + 5))
  if [ "$up" -gt "$elapsed" ]; then
    die "La API que contesta en :$PORT lleva ${up}s viva y la nuestra la lanzamos hace ${elapsed}s.
O sea: quien responde NO es el proceso que acabamos de arrancar, sino otro que
ya estaba. Corriendo la suite contra él, los bridges y el registro de módulos
son los de otra generación de la base. Localízalo antes de matar nada:
  netstat -ano | findstr :$PORT      # Windows
  ss -tlnp | grep :$PORT             # Linux"
  fi
}

wait_healthy() {
  local i=0
  log "Esperando a api :$PORT, web y rewrite (máx ${HEALTH_TIMEOUT_SECONDS}s)…"
  while [ "$i" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    # Las TRES sondas, y la tercera no es redundante: la suite entera habla con
    # la API a través del rewrite de Next (E2E_API_URL es la web), no por la
    # API directa. Sin esta comprobación el arnés daba el stack por bueno con
    # el rewrite todavía sin proxyar, y el primer uso real de ese camino caía
    # dentro del arranque de Playwright.
    # `curl -f` falla con >=400, así que un 502 del proxy NO cuenta como arriba.
    if curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1 \
       && curl -sf -o /dev/null "${E2E_BASE_URL}/signin" 2>/dev/null \
       && curl -sf -o /dev/null "${E2E_API_URL}/api/v1/setup/status" 2>/dev/null; then
      assert_api_is_the_one_we_launched
      log "api + web + rewrite arriba."
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  log "----- últimas líneas de api.log -----"; tail -n 30 "$API_LOG" 2>/dev/null || true
  log "----- últimas líneas de web.log -----"; tail -n 30 "$WEB_LOG" 2>/dev/null || true
  log "sonda api directa:   $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/healthz" || echo sin-respuesta)"
  log "sonda web:           $(curl -s -o /dev/null -w '%{http_code}' "${E2E_BASE_URL}/signin" || echo sin-respuesta)"
  log "sonda por rewrite:   $(curl -s -o /dev/null -w '%{http_code}' "${E2E_API_URL}/api/v1/setup/status" || echo sin-respuesta)"
  die "api/web/rewrite no respondieron en ${HEALTH_TIMEOUT_SECONDS}s."
}

cmd_start() { start_api; start_web; wait_healthy; }

cmd_stop() {
  stop_pid_file "$API_PID_FILE" "la API"
  stop_pid_file "$WEB_PID_FILE" "la web"
  assert_port_stopped api_responds "La API" "$PORT"
  assert_port_stopped web_responds "La web" 3010
}

# ── reset entre tandas ──────────────────────────────────────────────────────
cmd_reset() {
  log "Reset completo: infra nueva + BD nueva + API reiniciada."
  stop_pid_file "$API_PID_FILE" "la API"
  # Sin esto el reset seguía adelante con la API vieja viva: `start_api` moría
  # con EADDRINUSE, `wait_healthy` daba verde contra el superviviente y la
  # tanda entera corría sobre el registro de módulos de la base ANTERIOR.
  assert_port_stopped api_responds "La API" "$PORT"
  cmd_down
  cmd_up
  cmd_db
  start_api
  start_web
  wait_healthy
}

# ── diagnóstico ─────────────────────────────────────────────────────────────
cmd_check() {
  printf 'DATABASE_URL   %s\n' "$DATABASE_URL"
  printf 'REDIS_URL      %s\n' "$REDIS_URL"
  printf 'postgres       %s\n' "$(docker inspect -f '{{.State.Status}}' "$E2E_PG_CONTAINER" 2>/dev/null || echo ausente)"
  printf 'redis          %s\n' "$(docker inspect -f '{{.State.Status}}' didacta-redis-test 2>/dev/null || echo ausente)"
  printf 'api :%s        %s\n' "$PORT" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/healthz" || echo sin-respuesta)"
  printf 'web :3010      %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "${E2E_BASE_URL}/signin" || echo sin-respuesta)"
  # El camino por el que habla la suite. Si esta línea no es 200 y la de arriba
  # sí, el problema es el rewrite de Next, no la API.
  printf 'api x rewrite  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "${E2E_API_URL}/api/v1/setup/status" || echo sin-respuesta)"
  # Cuántos procesos están consumiendo la cola del outbox. Debe ser 1: con dos,
  # BullMQ reparte los eventos entre ellos y los que se lleva el intruso no
  # llegan a los bridges de la API bajo test — pero la fila vuelve marcada como
  # procesada. Ver `assertSingleOutboxDispatcher` en apps/e2e/global-setup.ts.
  printf 'outbox workers %s (debe ser 1)\n' \
    "$(docker exec -i didacta-redis-test redis-cli client list 2>/dev/null |
        grep -c "name=bull:$(printf %s 'didacta.outbox' | base64)" || echo n/d)"
  printf 'tenants        %s\n' "$(psql_query $'SELECT string_agg(slug, \', \' ORDER BY slug) FROM tenant;' 2>/dev/null || echo n/d)"
  printf 'espacios       %s\n' "$(psql_query 'SELECT count(*) FROM mod_community_space;' 2>/dev/null || echo n/d)"
}

cmd_all() { cmd_up; cmd_db; cmd_build; cmd_start; }

cmd_test() {
  cmd_reset
  ( cd apps/e2e && "$NODE_BIN" "$PLAYWRIGHT_CLI" test "$@" )
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  schema) cmd_schema ;;
  db)    cmd_db ;;
  build) cmd_build ;;
  start) cmd_start ;;
  stop)  cmd_stop ;;
  reset) cmd_reset ;;
  check) cmd_check ;;
  all)   cmd_all ;;
  test)  shift; cmd_test "$@" ;;
  *)     die "uso: e2e-stack.sh {up|down|schema|db|build|start|stop|reset|check|all|test}" ;;
esac
