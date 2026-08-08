# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# Entorno de ejemplo para el generador de capturas. Sourcéalo (o copia y ajusta)
# antes de `reset-instance.sh` y antes de lanzar Playwright.
#
#   source apps/e2e/shots/env.example.sh
#
# Es el mismo stack del job `e2e` de .github/workflows/e2e.yml, con la API en
# :4000 y la web en :3010. Ver shots/README.md.

# ── API ──────────────────────────────────────────────────────────────────────
export DATABASE_URL="postgresql://didacta:didacta@localhost:5442/didacta?schema=public"
# Secretos SINTÉTICOS, nunca credenciales. Se componen a partir de una raíz con
# la marca "de-prueba" que exige la convención del repo (ver .gitleaks.toml):
# así ninguna línea de este fichero contiene un literal con pinta de secreto.
DUMMY_SUFFIX='must-be-at-least-32-chars-de-prueba'
export JWT_SECRET="jwt-$DUMMY_SUFFIX"
export JWT_REFRESH_SECRET="refresh-$DUMMY_SUFFIX"
export AUTH_SECRET="auth-$DUMMY_SUFFIX"
export AUTH_URL="http://localhost:4000"
export TENANT_SETTINGS_ENC_KEY="0000000000000000000000000000000000000000000000000000000000000000"
export NODE_ENV="production"
export AUTH_SIGNUP_ENABLED="true"
export PORT="4000"
export API_PORT="4000"
export API_INTERNAL_URL="http://localhost:4000"
# El enlace de "define tu contraseña" que sale por email tiene que apuntar a la
# web: de ahí sale la captura 15-alumna-definir-password. Sin esta variable,
# `resolveWebBaseUrl` cae al dominio primario del tenant (`localhost`, SIN
# puerto) y el enlace del email no abre nada.
export WEB_PUBLIC_URL="http://localhost:3010"
# Sin REDIS_URL a propósito: enciende el rate-limit distribuido (30 req/min) y
# estrangula el recorrido completo.

# ── Generador de capturas ────────────────────────────────────────────────────
export SHOTS_BASE_URL="http://localhost:3010"
export SHOTS_API_URL="http://localhost:3010"
export SHOTS_PG_CONTAINER="didacta-e2e-postgres"
export SHOTS_PG_USER="didacta"
export SHOTS_PG_DB="didacta"
export SHOTS_MAILPIT_URL="http://localhost:8027"
export SHOTS_MAILPIT_SMTP_HOST="localhost"
export SHOTS_MAILPIT_SMTP_PORT="1027"
export SHOTS_MAILPIT_HTTP_PORT="8027"
# Idioma de la tanda: es-ES | en-US. Se sobreescribe por línea de comandos.
export SHOTS_LOCALE="es-ES"
# Dónde caen los PNG. Por defecto apps/e2e/shots-output/ (fuera de git).
# export SHOTS_OUT_DIR="/c/Users/…/didacta-docs/docs/assets"
