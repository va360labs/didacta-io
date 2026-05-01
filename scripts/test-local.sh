#!/usr/bin/env bash
# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# Runner local de pruebas de Didacta Community.
#
# Política activa desde 2026-05-01: las pruebas (unit + integración) NO se
# ejecutan en GitHub Actions. Este script es la ÚNICA vía autorizada para
# correrlas en local sobre Docker Desktop antes de mergear.
#
# Hace, en orden:
#   1. Pre-flight: Docker Desktop arriba, puertos 5433/6380 libres, ningún
#      contenedor didacta-*-test colgado de runs previos.
#   2. Genera el cliente Prisma (necesario en clean clone).
#   3. Compila los packages internos que los tests importan como deps de
#      workspace (@didacta/database, @didacta/core-kernel, @didacta/core-registry,
#      @didacta/license-sdk). Sin esto, vite no resuelve `@didacta/database`
#      en los tests de integración.
#   4. Corre la suite unit (`pnpm test`) — falla rápido si algo basal está roto.
#   5. Levanta `docker-compose.test.yml` (postgres-test:5433, redis-test:6380),
#      espera healthcheck, corre la suite de integración, baja el compose
#      SIEMPRE en `trap EXIT` (incluso si vitest crashea o el shell muere).
#   6. Resumen final tabular.
#
# Uso:
#   bash scripts/test-local.sh          # full: pre-flight + build + unit + integ
#   bash scripts/test-local.sh unit     # sólo pre-flight + unit
#   bash scripts/test-local.sh integ    # sólo pre-flight + build + integ
#
# Requisitos:
#   - Docker Desktop running
#   - pnpm 10.21.0 en PATH (mismo que packageManager)
#   - Puertos 5433 y 6380 libres
#
# Si algo falla, el contenedor se baja igualmente. Si Ctrl-C, también.
# La DB y Redis efímeros: tmpfs en postgres, sin persistence en redis.

set -euo pipefail

# ----------------------------------------------------------------------------
# Resolución de paths y config
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.test.yml"
MODE="${1:-full}"

# Container names (deben coincidir con docker-compose.test.yml)
PG_CONTAINER="didacta-postgres-test"
REDIS_CONTAINER="didacta-redis-test"
PG_PORT=5433
REDIS_PORT=6380

# Resultado por etapa para resumen final
declare -A RESULTS
RESULTS[preflight]="pending"
RESULTS[prisma]="pending"
RESULTS[build]="pending"
RESULTS[unit]="pending"
RESULTS[integration]="pending"

COMPOSE_UP=0  # 1 cuando hayamos hecho up — para saber si bajar en cleanup

# ----------------------------------------------------------------------------
# Helpers de log
# ----------------------------------------------------------------------------
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
log()     { c_blue "[test-local] $*"; }
warn()    { c_yellow "[test-local] WARN: $*"; }
err()     { c_red "[test-local] ERROR: $*" >&2; }

# ----------------------------------------------------------------------------
# Resolución del binario docker (Windows + Git Bash)
# ----------------------------------------------------------------------------
resolve_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  local win_paths=(
    "/c/Program Files/Docker/Docker/resources/bin/docker.exe"
    "$DOCKER_BIN"
  )
  for p in "${win_paths[@]}"; do
    [ -z "$p" ] && continue
    if [ -x "$p" ]; then
      echo "$p"
      return
    fi
  done
  echo ""
}

DOCKER_BIN="$(resolve_docker)"

# ----------------------------------------------------------------------------
# Cleanup (siempre se ejecuta, incluso en Ctrl-C o error)
# ----------------------------------------------------------------------------
cleanup() {
  local rc=$?
  if [ "$COMPOSE_UP" -eq 1 ]; then
    log "Bajando compose y limpiando volúmenes (down -v)..."
    "$DOCKER_BIN" compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || \
      warn "compose down falló — revisa contenedores manualmente: docker ps -a | grep didacta"
  fi
  print_summary
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# Resumen final
# ----------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "=========================================================="
  echo " RESUMEN test-local ($MODE)"
  echo "=========================================================="
  for stage in preflight prisma build unit integration; do
    local status="${RESULTS[$stage]}"
    case "$status" in
      ok)      printf "  %-12s " "$stage"; c_green "OK" ;;
      fail)    printf "  %-12s " "$stage"; c_red   "FAIL" ;;
      skipped) printf "  %-12s " "$stage"; c_yellow "skipped" ;;
      pending) printf "  %-12s " "$stage"; c_yellow "no-ejecutado" ;;
    esac
  done
  echo "=========================================================="
}

# ----------------------------------------------------------------------------
# 1. Pre-flight
# ----------------------------------------------------------------------------
preflight() {
  log "Pre-flight checks..."

  if [ -z "$DOCKER_BIN" ]; then
    err "No se encontró el binario de docker. ¿Está Docker Desktop instalado y arriba?"
    RESULTS[preflight]="fail"
    return 1
  fi
  log "  docker bin: $DOCKER_BIN"

  if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    err "Docker no responde a 'docker info'. Arranca Docker Desktop y reintenta."
    RESULTS[preflight]="fail"
    return 1
  fi
  log "  docker daemon: OK"

  if ! command -v pnpm >/dev/null 2>&1; then
    err "pnpm no está en PATH. Instala pnpm 10.21.0 (corepack o npm i -g)."
    RESULTS[preflight]="fail"
    return 1
  fi
  log "  pnpm: $(pnpm --version)"

  # Contenedores previos colgados (de un Ctrl-C anterior, por ejemplo)
  for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
    if "$DOCKER_BIN" ps -a --format '{{.Names}}' | grep -qx "$c"; then
      warn "Contenedor previo detectado: $c — lo elimino antes de seguir."
      "$DOCKER_BIN" rm -f "$c" >/dev/null 2>&1 || true
    fi
  done

  # Puertos libres
  for port in "$PG_PORT" "$REDIS_PORT"; do
    if check_port_busy "$port"; then
      err "Puerto $port en uso. Cierra el proceso que lo ocupa antes de correr tests."
      RESULTS[preflight]="fail"
      return 1
    fi
  done
  log "  puertos $PG_PORT, $REDIS_PORT: libres"

  if [ ! -f "$COMPOSE_FILE" ]; then
    err "No existe $COMPOSE_FILE"
    RESULTS[preflight]="fail"
    return 1
  fi

  RESULTS[preflight]="ok"
  c_green "[test-local] Pre-flight OK"
}

check_port_busy() {
  local port=$1
  # Try multiple methods (windows + linux + mac compat)
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port$" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "[.:]$port[[:space:]].*LISTEN" -q && return 0
  fi
  return 1
}

# ----------------------------------------------------------------------------
# 2. Prisma client
# ----------------------------------------------------------------------------
# En Windows + Git Bash los shims `.cmd` de `node_modules/.bin/` no siempre
# se resuelven al ejecutarse vía `pnpm run`. Invocamos el entry JS de Prisma
# directamente con `node` para ser independientes del shell — mismo patrón
# que usa `tests/integration/helpers/setup-db.ts`.
gen_prisma() {
  log "Generando cliente Prisma..."
  local prisma_entry="$REPO_ROOT/node_modules/prisma/build/index.js"
  if [ ! -f "$prisma_entry" ]; then
    err "No se encontró $prisma_entry. ¿Hiciste 'pnpm install'?"
    RESULTS[prisma]="fail"
    return 1
  fi
  if node "$prisma_entry" generate --schema "$REPO_ROOT/packages/database/prisma/schema.prisma"; then
    RESULTS[prisma]="ok"
  else
    err "Prisma generate falló."
    RESULTS[prisma]="fail"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# 3. Build packages internos
# ----------------------------------------------------------------------------
# Invocamos `tsc` con `node` directo en cada paquete. Razón: en este entorno
# Windows + pnpm@10 instalado vía corepack, los lifecycle scripts de pnpm no
# propagan `node_modules/.bin` al PATH del child process — `pnpm tsc` falla
# con "tsc no se reconoce como comando". Mismo workaround documentado en la
# memoria del proyecto (feedback_pnpm_hook_workaround.md). Usamos el entry
# JS de TypeScript que SÍ es portable a través de cualquier shell.
build_packages() {
  log "Compilando packages internos (database, core-kernel, core-registry, license-sdk)..."
  local tsc_entry="$REPO_ROOT/node_modules/typescript/bin/tsc"
  if [ ! -f "$tsc_entry" ]; then
    err "No se encontró $tsc_entry. ¿Hiciste 'pnpm install'?"
    RESULTS[build]="fail"
    return 1
  fi
  local pkgs=(
    "packages/database"
    "packages/core-kernel"
    "packages/core-registry"
    "packages/license-sdk"
  )
  for pkg in "${pkgs[@]}"; do
    log "  → $pkg"
    if ! ( cd "$REPO_ROOT/$pkg" && node "$tsc_entry" -p tsconfig.json ); then
      err "tsc falló en $pkg"
      RESULTS[build]="fail"
      return 1
    fi
  done
  RESULTS[build]="ok"
}

# ----------------------------------------------------------------------------
# 4. Suite unit
# ----------------------------------------------------------------------------
# Igual que con `tsc`, no podemos usar `turbo run test` porque turbo invoca
# `vitest` como shim y en este Windows no se resuelve. Iteramos sobre los
# paquetes con `vitest.config.ts` y corremos vitest con `node` directo.
# Más verboso pero robusto. La lista la genera find dinámicamente para que
# nuevos paquetes con tests entren sin tocar el script.
run_unit() {
  log "Ejecutando suite unit (vitest por paquete)..."
  local vitest_entry="$REPO_ROOT/node_modules/vitest/vitest.mjs"
  if [ ! -f "$vitest_entry" ]; then
    err "No se encontró $vitest_entry. ¿Hiciste 'pnpm install'?"
    RESULTS[unit]="fail"
    return 1
  fi

  # Lista de paquetes con vitest.config.ts (excepto los integration que ya
  # corre run_integration con su config separada).
  local pkgs
  mapfile -t pkgs < <(
    cd "$REPO_ROOT" && \
    find apps modules packages -maxdepth 3 -name "vitest.config.ts" \
      -not -path "*/node_modules/*" 2>/dev/null \
    | xargs -n1 dirname
  )

  local failed_pkgs=()
  for pkg in "${pkgs[@]}"; do
    log "  → $pkg"
    if ! ( cd "$REPO_ROOT/$pkg" && node "$vitest_entry" run --config vitest.config.ts ); then
      failed_pkgs+=("$pkg")
    fi
  done

  if [ ${#failed_pkgs[@]} -gt 0 ]; then
    err "Suite unit falló en: ${failed_pkgs[*]}"
    RESULTS[unit]="fail"
    return 1
  fi
  RESULTS[unit]="ok"
}

# ----------------------------------------------------------------------------
# 5. Suite integración (compose + vitest)
# ----------------------------------------------------------------------------
run_integration() {
  log "Levantando compose efímero (postgres-test:$PG_PORT, redis-test:$REDIS_PORT)..."
  if ! "$DOCKER_BIN" compose -f "$COMPOSE_FILE" up -d; then
    err "compose up falló."
    RESULTS[integration]="fail"
    return 1
  fi
  COMPOSE_UP=1

  # Healthcheck explícito antes de lanzar vitest
  log "Esperando healthcheck postgres-test..."
  local timeout=60
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status
    status="$("$DOCKER_BIN" inspect --format='{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo unknown)"
    if [ "$status" = "healthy" ]; then
      log "  postgres-test: healthy"
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  if [ $elapsed -ge $timeout ]; then
    err "postgres-test no quedó healthy en ${timeout}s."
    RESULTS[integration]="fail"
    return 1
  fi

  log "Ejecutando vitest integration (apps/api)..."
  local vitest_entry="$REPO_ROOT/node_modules/vitest/vitest.mjs"
  if ! ( cd "$REPO_ROOT/apps/api" && node "$vitest_entry" run --config vitest.integration.config.ts ); then
    err "Suite integración falló."
    RESULTS[integration]="fail"
    return 1
  fi
  RESULTS[integration]="ok"
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
cd "$REPO_ROOT"

case "$MODE" in
  full)
    preflight
    gen_prisma
    build_packages
    run_unit
    run_integration
    ;;
  unit)
    preflight
    gen_prisma
    run_unit
    RESULTS[build]="skipped"
    RESULTS[integration]="skipped"
    ;;
  integ|integration)
    preflight
    gen_prisma
    build_packages
    RESULTS[unit]="skipped"
    run_integration
    ;;
  *)
    err "Modo desconocido: $MODE. Usa: full | unit | integ"
    exit 2
    ;;
esac

c_green "[test-local] TODO VERDE en modo $MODE"
