#!/usr/bin/env bash
# ============================================================================
# setup-prod-env.sh — puebla /opt/didacta-prod/.env en el server.
# Genera los secrets ALEATORIOS (AUTH_SECRET, TENANT_SETTINGS_ENC_KEY,
# POSTGRES_PASSWORD) y REUTILIZA la config de Telegram/SMTP del .env de dev
# (mismo bot VA360). BOOTSTRAP_PASSWORD se copia de dev; si dev no la tiene,
# genera una y la reporta (única vez).
#
# Idempotente: re-ejecutar regenera AUTH/ENC/PG (cuidado: invalida sesiones y
# rompe el acceso a settings cifrados previos). Pensado para el bootstrap.
#
# No expone secretos en la salida salvo SMTP_HOST (hostname, no secreto) y la
# BOOTSTRAP_PASSWORD generada (necesaria para el primer login).
# ============================================================================
set -euo pipefail

PROD=/opt/didacta-prod/.env
DEV=/opt/didacta-dev/.env
[ -f "$PROD" ] || { echo "ERROR: no existe $PROD"; exit 1; }

set_kv() {
  local key="$1" val="$2"
  grep -v "^${key}=" "$PROD" > "$PROD.tmp" 2>/dev/null || true
  mv "$PROD.tmp" "$PROD"
  printf '%s=%s\n' "$key" "$val" >> "$PROD"
}
get_dev() { grep "^$1=" "$DEV" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# 1) Secrets aleatorios (internos)
set_kv AUTH_SECRET "$(openssl rand -hex 32)"
set_kv TENANT_SETTINGS_ENC_KEY "$(openssl rand -hex 32)"
set_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)"

# 2) Reutilizar config de dev (mismo bot/SMTP + password de super_admin)
for K in TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME TELEGRAM_GROUP_ID \
         SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM BOOTSTRAP_PASSWORD; do
  V="$(get_dev "$K")"
  if [ -n "$V" ]; then set_kv "$K" "$V"; fi
done

# 3) BOOTSTRAP_PASSWORD: si quedó pendiente, generar y reportar
BP="$(grep '^BOOTSTRAP_PASSWORD=' "$PROD" | head -1 | cut -d= -f2- || true)"
if [ -z "$BP" ] || echo "$BP" | grep -q CHANGE_ME; then
  NEWBP="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)"
  set_kv BOOTSTRAP_PASSWORD "$NEWBP"
  unset NEWBP
  # NO se imprime el valor (evita credential leakage en logs). Para consultarla:
  #   grep '^BOOTSTRAP_PASSWORD=' /opt/didacta-prod/.env
  echo "BOOTSTRAP_PASSWORD: generada y escrita al .env (no se muestra aquí)."
fi

# 4) Reporte de estado (sin exponer secretos; SMTP_HOST sí, no es secreto)
echo "--- estado /opt/didacta-prod/.env ---"
echo "CHANGE_ME restantes: $(grep -c CHANGE_ME "$PROD" 2>/dev/null || echo 0)"
for K in AUTH_SECRET TENANT_SETTINGS_ENC_KEY POSTGRES_PASSWORD BOOTSTRAP_PASSWORD \
         TELEGRAM_BOT_TOKEN TELEGRAM_GROUP_ID SMTP_HOST SMTP_PASSWORD MEMBER_APPROVAL_EMAIL BOOTSTRAP_DOMAINS; do
  V="$(grep "^$K=" "$PROD" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -z "$V" ] || echo "$V" | grep -q CHANGE_ME; then st="PENDIENTE"; else st="set"; fi
  case "$K" in
    SMTP_HOST|MEMBER_APPROVAL_EMAIL|BOOTSTRAP_DOMAINS) echo "$K = $V ($st)";;
    *) echo "$K = [$st]";;
  esac
done
