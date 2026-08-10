#!/usr/bin/env bash
# ============================================================================
# Didacta — entorno canónico del arnés E2E.
# ----------------------------------------------------------------------------
# ÚNICA fuente de verdad de las variables que necesita la suite de Playwright.
# La consumen los dos caminos, y por eso dejaron de divergir:
#
#   local  →  source scripts/e2e-env.sh          (lo hace scripts/e2e-stack.sh)
#   CI     →  bash scripts/e2e-env.sh --github-env >> "$GITHUB_ENV"
#
# Antes cada camino tenía su propia copia de la lista y CI se había quedado
# sin cuatro piezas (seed.sql, onboarding del admin, secretos de Stripe y el
# contenedor de Postgres del spec de catálogo). Con un solo fichero eso no
# puede volver a pasar: si falta algo, falta en los dos sitios a la vez y
# `global-setup.ts` lo grita antes de correr un solo test.
#
# Toda variable ya presente en el entorno GANA (patrón `: "${VAR:=...}"`), de
# forma que un runner o un desarrollador pueden apuntar a otra base de datos
# sin editar este fichero.
#
# La infraestructura por defecto es `docker-compose.test.yml` — el MISMO
# compose en local y en CI. De ahí salen el usuario/base `didacta_test` y el
# nombre de contenedor `didacta-postgres-test` que `catalogo-publico.spec.ts`
# necesita para su `docker exec`.
#
# Los secretos de aquí son sintéticos y de un solo uso para tests: no abren
# nada, no son rotables y no existen fuera de este arnés.
# ============================================================================

# ── Infraestructura (docker-compose.test.yml) ───────────────────────────────
: "${E2E_PG_CONTAINER:=didacta-postgres-test}"
: "${E2E_PG_USER:=didacta_test}"
: "${E2E_PG_DB:=didacta_test}"
: "${E2E_PG_PORT:=5433}"
: "${DATABASE_URL:=postgresql://${E2E_PG_USER}:${E2E_PG_USER}@localhost:${E2E_PG_PORT}/${E2E_PG_DB}?schema=public}"

# REDIS_URL NO es opcional en el arnés. Sin él `messaging-realtime.publisher`
# degrada a no-op silencioso y los specs de realtime fallan sin decir por qué
# (5 tests en la sesión anterior). `global-setup.ts` aborta si no está.
: "${REDIS_URL:=redis://localhost:6380}"

# ── Secretos sintéticos de la API (mínimo 32 caracteres) ────────────────────
: "${JWT_SECRET:=e2e-test-secret-must-be-at-least-32-chars-long-aaaa}"
: "${JWT_REFRESH_SECRET:=e2e-refresh-secret-must-be-32-chars-long-bbbb}"
: "${AUTH_SECRET:=e2e-auth-secret-must-be-at-least-32-chars-long-cccc}"
: "${AUTH_URL:=http://localhost:4000}"
# Master key AES-256-GCM (64 hex) para TenantSettings cifrado. Obligatoria en
# NODE_ENV=production; valor determinista de-prueba, nunca un secreto real.
: "${TENANT_SETTINGS_ENC_KEY:=0000000000000000000000000000000000000000000000000000000000000000}"

# ── Runtime de la API y la web ──────────────────────────────────────────────
: "${NODE_ENV:=production}"
# El registro público está cerrado por defecto (auth.service). Los specs lo
# usan para fabricar alumnos de prueba → se reabre solo aquí.
: "${AUTH_SIGNUP_ENABLED:=true}"
: "${PORT:=4000}"
: "${API_PORT:=4000}"
: "${API_INTERNAL_URL:=http://localhost:4000}"

# ── Política de MFA obligatoria para admins (opt-in del producto) ───────────
# `isAdminMfaEnforced()` en apps/api/src/auth/mfa-config.ts. Default OFF, que
# es el estado que el golden path da por supuesto: con la política activa el
# guard responde 403 `mfa_required` a CUALQUIER llamada admin cuyo token no
# venga del flujo MFA, y eso tumba a los specs que hacen signin() de admin sin
# pasar por él (admin-email-templates, clase-en-comunidad, community-api-posts,
# admin-smtp-settings) además del propio arranque, que cierra el onboarding del
# admin con `PATCH /me/profile` (no exento).
#
# Se declara aquí —aunque el valor sea el default del producto— para que el
# stack la lleve SIEMPRE explícita y se pueda ver en `e2e-stack.sh check`. Los
# dos specs que sí la ejercitan corren en su propio arranque, que la pone a
# true: `bash scripts/e2e-stack.sh mfa`.
: "${DIDACTA_REQUIRE_MFA_ADMIN:=false}"

# ── Rate limit: ver comentario largo abajo ──────────────────────────────────
# Con REDIS_URL activo el rate limiter global DEJA de fallar abierto y entra en
# vigor el cupo por defecto del plan community: 100 req/min autenticadas y
# 30 req/min públicas, ESTAS ÚLTIMAS COMPARTIDAS por todo el tráfico anónimo
# (bucket 'anonymous' en rate-limit.interceptor.ts). Una suite serie de 270
# tests hace muchísimo más que eso en un minuto: cada `signin()` es pública.
#
# La API ya expone el cupo como configuración de primera clase
# (`resolveRateLimitConfig()` en apps/api/src/rate-limit/rate-limit.types.ts),
# así que el arnés sube el cupo por env en vez de parchear el producto o
# dormir 65 s entre tandas. No se desactiva el limiter: sigue contando,
# sigue devolviendo los headers X-RateLimit-* y sigue siendo el mismo código
# que en producción — sólo con un techo que no estrangula al arnés.
: "${RATE_LIMIT_COMMUNITY_AUTH_PER_MIN:=100000}"
: "${RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN:=100000}"

# ── Bootstrap del tenant principal ──────────────────────────────────────────
: "${BOOTSTRAP_TENANT_SLUG:=demo}"
: "${BOOTSTRAP_EMAIL:=e2e-admin@example.test}"
: "${BOOTSTRAP_PASSWORD:=E2eAdminPassword123!}"

# ── Tenant limpio para los specs de smoke ───────────────────────────────────
# `redesign-smoke` y `mobile-nav` afirman estados vacíos ("No hay grupos
# disponibles", "No tienes conversaciones todavía"). En `demo` eso es falso a
# mitad de suite porque otros specs crean grupos, clases y mensajes. Se siembra
# un segundo tenant real con el mismo `seed.ts` (idempotente y env-driven) y
# ahí sí los estados vacíos son ciertos de verdad.
#
# Cada tenant necesita su PROPIO hostname, y no es un capricho: el alta y el
# login resuelven el tenant por el Host header ANTES de mirar el `tenantSlug`
# del body (`resolveTenantIdFromHost` en apps/api/src/auth/auth.controller.ts
# gana sobre `explicitSlug` en auth.service.ts). Con los dos tenants apuntando
# a `localhost` sería imposible autenticarse contra el segundo.
#
#   demo  → localhost   (E2E_BASE_URL / E2E_API_URL, todo lo demás)
#   smoke → 127.0.0.1   (E2E_SMOKE_API_URL, sólo el alta del alumno de smoke)
#
# 127.0.0.1 se elige a propósito por encima de un `*.localhost`: resuelve en
# cualquier sistema operativo sin tocar el fichero hosts.
: "${E2E_SMOKE_TENANT_SLUG:=e2e-smoke}"
: "${E2E_SMOKE_TENANT_DOMAIN:=127.0.0.1}"
: "${E2E_SMOKE_ADMIN_EMAIL:=e2e-smoke-admin@example.test}"
# Contra la API DIRECTA: a través del rewrite de Next el Host que llega es
# siempre `localhost:4000` (Next reescribe `host` y mueve el original a
# `x-forwarded-host`, que este resolver no mira), así que por ahí nunca se
# podría alcanzar al segundo tenant.
: "${E2E_SMOKE_API_URL:=http://127.0.0.1:${API_PORT}}"

# ── Lo que lee la suite de Playwright ───────────────────────────────────────
# `next start` tiene el puerto fijo en el script (`-p 3010`, apps/web/package.json).
: "${E2E_BASE_URL:=http://localhost:3010}"
: "${E2E_API_URL:=http://localhost:3010}"
: "${E2E_API_DIRECT_URL:=http://localhost:4000}"
: "${E2E_TENANT_SLUG:=demo}"
: "${E2E_ADMIN_EMAIL:=${BOOTSTRAP_EMAIL}}"
: "${E2E_ADMIN_PASSWORD:=${BOOTSTRAP_PASSWORD}}"

# ── Webhooks de pago (firmados en local, sin tocar Stripe) ──────────────────
# Sin estos, `membership-trial`, `referrals-flow` y `catalogo-publico` reciben
# 400/401 al entregar el webhook que ellos mismos firman. No son claves reales:
# la `sk_test_` lleva guiones a propósito para no parecerse a una de Stripe.
#
# UN solo valor y cuatro nombres derivados. Son los nombres que ya leen, por un
# lado la API (STRIPE_/SUBSCRIPTIONS_) y por otro cada spec, que tiene el suyo
# (E2E_STRIPE_ en membership-trial y referrals-flow, E2E_BILLING_ en
# catalogo-publico). Derivarlos es lo que impide que vuelvan a divergir: en la
# tanda anterior sólo estaba puesto E2E_BILLING_ y los tres specs de webhook
# firmaban con un secreto distinto del que validaba la API.
: "${E2E_WEBHOOK_SECRET:=whsec_e2e_de_prueba}"
: "${STRIPE_SECRET_KEY:=sk_test_de-prueba-no-es-una-clave-real}"
: "${STRIPE_WEBHOOK_SECRET:=${E2E_WEBHOOK_SECRET}}"
: "${SUBSCRIPTIONS_WEBHOOK_SECRET:=${E2E_WEBHOOK_SECRET}}"
: "${E2E_STRIPE_WEBHOOK_SECRET:=${E2E_WEBHOOK_SECRET}}"
: "${E2E_BILLING_WEBHOOK_SECRET:=${E2E_WEBHOOK_SECRET}}"

E2E_ENV_VARS="
DATABASE_URL REDIS_URL
E2E_PG_CONTAINER E2E_PG_USER E2E_PG_DB E2E_PG_PORT
JWT_SECRET JWT_REFRESH_SECRET AUTH_SECRET AUTH_URL TENANT_SETTINGS_ENC_KEY
NODE_ENV AUTH_SIGNUP_ENABLED PORT API_PORT API_INTERNAL_URL
DIDACTA_REQUIRE_MFA_ADMIN
RATE_LIMIT_COMMUNITY_AUTH_PER_MIN RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN
BOOTSTRAP_TENANT_SLUG BOOTSTRAP_EMAIL BOOTSTRAP_PASSWORD
E2E_SMOKE_TENANT_SLUG E2E_SMOKE_TENANT_DOMAIN E2E_SMOKE_ADMIN_EMAIL E2E_SMOKE_API_URL
E2E_BASE_URL E2E_API_URL E2E_API_DIRECT_URL
E2E_TENANT_SLUG E2E_ADMIN_EMAIL E2E_ADMIN_PASSWORD
E2E_WEBHOOK_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
SUBSCRIPTIONS_WEBHOOK_SECRET E2E_STRIPE_WEBHOOK_SECRET E2E_BILLING_WEBHOOK_SECRET
"

# shellcheck disable=SC2086
export $(echo "$E2E_ENV_VARS" | tr -s '[:space:]' ' ')

# `--github-env` vuelca `KEY=value` para redirigirlo a $GITHUB_ENV. Se ejecuta,
# no se sourcea, así que aquí sí conviene escribir por stdout.
if [ "${1:-}" = "--github-env" ]; then
  for _v in $E2E_ENV_VARS; do
    eval "printf '%s=%s\n' \"$_v\" \"\${$_v}\""
  done
fi
