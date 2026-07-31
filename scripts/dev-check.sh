#!/usr/bin/env bash
# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# dev-check.sh — chequeos locales rápidos sin Docker.
#
# Reemplaza la cadena de "tsc + lint + prettier + ..." manual.
# Para tests con Docker (unit + integración real) usa scripts/test-local.sh.
#
# Uso:
#   bash scripts/dev-check.sh                # --quick (default)
#   bash scripts/dev-check.sh --quick        # typecheck + lint + format
#   bash scripts/dev-check.sh --full         # quick + scripts/test-local.sh full
#   bash scripts/dev-check.sh --db           # prisma validate + format
#   bash scripts/dev-check.sh --types        # solo typecheck
#   bash scripts/dev-check.sh --lint         # solo eslint
#   bash scripts/dev-check.sh --format       # solo prettier check
#   bash scripts/dev-check.sh --format-fix   # prettier --write (modificá archivos)
#   bash scripts/dev-check.sh --web          # build de apps/web
#
# Notas:
#   - pnpm + corepack está roto en Windows: invocamos los binarios con `node`
#     directo (pattern heredado de la sesión).
#   - Sale con exit code != 0 al primer fallo, salvo --format-fix.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:---quick}"

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
log()     { c_blue "[dev-check] $*"; }
ok()      { c_green "[dev-check] OK · $*"; }
fail()    { c_red "[dev-check] FAIL · $*" >&2; }

# Binarios resueltos con node directo (workaround pnpm/corepack Windows).
TSC="node node_modules/typescript/bin/tsc"
ESLINT="node node_modules/eslint/bin/eslint.js"
PRETTIER="node node_modules/prettier/bin/prettier.cjs"
PRISMA="node packages/database/node_modules/prisma/build/index.js"

run_step() {
  local label="$1"; shift
  log "▶ $label"
  if "$@"; then
    ok "$label"
    return 0
  else
    fail "$label"
    return 1
  fi
}

step_types() {
  # Typecheck de los workspaces principales sin emitir.
  run_step "typecheck apps/api" $TSC --noEmit -p apps/api/tsconfig.json || return 1
  run_step "typecheck apps/web" $TSC --noEmit -p apps/web/tsconfig.json || return 1
}

step_lint() {
  if [[ -x "node_modules/eslint/bin/eslint.js" ]] || [[ -f "node_modules/eslint/bin/eslint.js" ]]; then
    run_step "eslint" $ESLINT . --max-warnings=0
  else
    log "eslint no instalado en root, salto"
  fi
}

step_format() {
  run_step "prettier --check" $PRETTIER --check .
}

step_format_fix() {
  log "▶ prettier --write (modificá archivos)"
  $PRETTIER --write .
  ok "prettier --write"
}

step_db() {
  run_step "prisma format" $PRISMA format --schema=packages/database/prisma/schema.prisma || return 1
  run_step "prisma validate" $PRISMA validate --schema=packages/database/prisma/schema.prisma || return 1
}

step_web_build() {
  log "▶ build apps/web (Next.js)"
  if (cd apps/web && node node_modules/next/dist/bin/next build); then
    ok "build apps/web"
  else
    fail "build apps/web"
    return 1
  fi
}

step_full_tests() {
  log "▶ delegando a scripts/test-local.sh full"
  bash "$SCRIPT_DIR/test-local.sh" full
}

case "$MODE" in
  --quick|"")
    step_types && step_lint && step_format && exit 0 || exit 1
    ;;
  --full)
    step_types && step_lint && step_format && step_db && step_full_tests && exit 0 || exit 1
    ;;
  --types)
    step_types
    ;;
  --lint)
    step_lint
    ;;
  --format)
    step_format
    ;;
  --format-fix)
    step_format_fix
    ;;
  --db)
    step_db
    ;;
  --web)
    step_web_build
    ;;
  -h|--help)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    fail "modo desconocido: $MODE"
    echo "Uso: bash scripts/dev-check.sh [--quick|--full|--db|--types|--lint|--format|--format-fix|--web|--help]"
    exit 2
    ;;
esac
