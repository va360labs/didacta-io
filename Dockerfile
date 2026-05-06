# syntax=docker/dockerfile:1.7
# ============================================================================
# Didacta Community — Dockerfile multi-stage único (api + web) sobre Alpine
# ----------------------------------------------------------------------------
# Construye apps/api (NestJS) y apps/web (Next.js) en un solo contenedor.
# El entrypoint corre `prisma db push` y aplica RLS antes de levantar.
#
# Imagen base: `node:22-alpine` (musl). Recorta ~700MB frente a
# `node:22-bookworm-slim`. Contrapartidas:
#   - Deps del sistema con `apk` (no apt).
#   - Native modules (argon2) compilan contra musl: el builder necesita
#     `python3 make g++`.
#   - Prisma necesita el binary target `linux-musl-openssl-3.0.x`
#     (definido en packages/database/prisma/schema.prisma).
#
# IMPORTANTE — patrón de stages:
#
#   base → fetcher → builder → pruner → runner
#
# El runner parte de un `node:22-alpine` LIMPIO (no `FROM builder`). Si
# heredase del builder, todas las layers intermedias del build (instalación
# completa con devDeps, caches de turbo, .tsbuildinfo, etc.) seguirían en
# la imagen final aunque el filesystem las borrase: una imagen Docker es la
# SUMA de sus layers, no un snapshot del filesystem final del último stage.
#
# Por eso el `pruner` deja el repo en estado runtime-only (solo prod deps,
# solo dist/, sin src/, sin tests/, sin tsconfigs) y el runner hace un
# único `COPY --from=pruner` en una sola layer. Esa es la diferencia entre
# 3GB y <1GB.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: base — Node 22 LTS sobre Alpine + pnpm 10
# ----------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN npm install --global pnpm@10.21.0
WORKDIR /repo
ENV NODE_ENV=production \
    HUSKY=0

# ----------------------------------------------------------------------------
# Stage 2: fetcher — descarga el store completo (devDeps + prodDeps) sin código
# ----------------------------------------------------------------------------
FROM base AS fetcher
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm fetch

# ----------------------------------------------------------------------------
# Stage 3: builder — copia código y buildea TODO el monorepo (devDeps activas)
# ----------------------------------------------------------------------------
FROM fetcher AS builder
# CI=true: pnpm aborta el remove de node_modules sin TTY a menos que sepa que
# corre en un entorno no interactivo (necesario si .npmrc/lockfile cambian).
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
# Build deps para compilar native modules (argon2). Alpine viene sin
# toolchain por defecto.
RUN apk add --no-cache --virtual .build-deps \
    g++ \
    make \
    python3
COPY . .
# Defensa frente a `incremental: true` en tsconfig.base.json: si algún
# .tsbuildinfo se cuela desde el host (a pesar del .dockerignore), tsc lo
# usa como cache y omite la emisión de dist/. Borrarlos garantiza un build
# limpio reproducible.
RUN find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete || true
# Install completo: crítico que cree los symlinks workspace en
# node_modules/@didacta/* que tsc necesita para resolver imports
# cross-package. NOTA: NO usamos --offline porque el cache montado del stage
# fetcher no parece propagarse de forma fiable a los symlinks workspace.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @didacta/database db:generate
# Build escalonado: cada "wave" garantiza que los dist/*.d.ts de la
# anterior están escritos antes de empezar la siguiente. `pnpm -r build`
# y `turbo run build` paralelizan sin respetar este orden, lo que provoca
# TS2307 (Cannot find module '@didacta/core-kernel'...) en cascada.
#
# Wave 1: paquetes core sin deps internas.
RUN pnpm --filter @didacta/core-kernel --filter @didacta/database run build
# Wave 2: paquetes core que dependen de wave 1.
# module-package-spec: zero-deps (solo Node builtins) pero apps/api lo importa,
# tiene que estar compilado antes de wave 4. Va aquí por consistencia con el
# patron de paquetes core.
RUN pnpm --filter @didacta/core-registry --filter @didacta/license-sdk --filter @didacta/module-package-spec run build
# Wave 3: módulos que dependen de wave 1+2.
RUN pnpm --filter "@didacta/mod-*" run build
# Wave 4: apps (api + web) que dependen de todo lo anterior.
RUN pnpm --filter @didacta/api --filter @didacta/web run build

# ----------------------------------------------------------------------------
# Stage 4: pruner — deja el repo en estado runtime-only
# ----------------------------------------------------------------------------
# Importante: este stage NO se usa como `FROM` de runner. Solo sirve como
# fuente de COPY. Sus layers no llegan a la imagen final.
FROM builder AS pruner
# 1) Quitar build-deps del sistema (ya no se necesitan).
RUN apk del .build-deps || true
# 2a) Rescatar artefactos que viven dentro de `src/` y necesitamos en
#     runtime. Los pasamos a un sibling fuera del path que el pruner
#     borra. Hoy cubre las claves públicas del license-sdk (que también
#     usa el marketplace para verificar firmas de módulos firmados con
#     la KMS de Didacta).
RUN if [ -d packages/license-sdk/src/public-keys ]; then \
      cp -r packages/license-sdk/src/public-keys packages/license-sdk/public-keys; \
    fi
# 2b) Borrar fuentes y configs de build: el runner solo ejecuta dist/ y .next/.
#    También .turbo (cache de turbo) y vitest configs.
#
#    OJO: Next 15 compila el middleware en `apps/web/.next/server/src/middleware.js`
#    cuando el source vive en `src/middleware.ts`. Si hacemos find sobre el árbol
#    sin descartar `.next`, el `-name src` matchea ese directorio y rompe el runtime
#    (Next emite 404 a todas las rutas con matcher porque no encuentra el bundle).
#    Por eso prunamos `.next` y `node_modules` antes de descender.
RUN find apps packages modules -type d \
      \( -name node_modules -o -name .next \) -prune \
      -o -type d \
      \( -name src -o -name tests -o -name __tests__ -o -name .turbo \) \
      -print -exec rm -rf {} + 2>/dev/null || true
RUN find apps packages modules \
      \( -name node_modules -o -name .next \) -prune \
      -o -type f \
      \( -name "tsconfig*.json" \
      -o -name "vitest.config.*" \
      -o -name ".eslintrc*" \
      -o -name "eslint.config.*" \
      -o -name "*.tsbuildinfo" \) \
      -delete 2>/dev/null || true
# Borrar cache de Next.js: solo se usa para builds incrementales, no para
# runtime. Pesa ~200MB y aparece dentro de apps/web/.next/cache después
# de `next build`. apps/e2e no se ejecuta en producción.
RUN rm -rf apps/web/.next/cache apps/e2e || true
# 3) Reinstalar SOLO prod deps. CI=true para que pnpm pueda eliminar
#    node_modules sin TTY (sin esto aborta silenciosamente y la imagen se
#    queda con devDeps).
ENV CI=true
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod \
 && pnpm store prune || true

# ----------------------------------------------------------------------------
# Stage 5: runner — imagen final desde alpine LIMPIO (no hereda del builder)
# ----------------------------------------------------------------------------
# DIDACTA_VERSION: version de la app, inyectada en build time.
# Sobreescribible con: docker build --build-arg DIDACTA_VERSION=0.0.1-alpha.52
ARG DIDACTA_VERSION=0.0.1-alpha.52

FROM node:22-alpine AS runner
# Re-declarar ARG para que este disponible en este stage (Docker multi-stage)
ARG DIDACTA_VERSION
# Deps de RUNTIME (no build):
#   - bash: entrypoint.sh usa bashismos ([[, arrays, `wait -n`).
#   - ca-certificates + openssl: TLS para S3, Anthropic, SMTP.
#   - curl: healthcheck.
#   - libc6-compat: algunos binarios prebuilt asumen glibc.
#   - postgresql16-client: psql para aplicar rls.sql.
#   - tini: init proper en PID 1 (manejo correcto de SIGTERM y zombies).
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    libc6-compat \
    openssl \
    postgresql16-client \
    tini
# pnpm como binario global (sin corepack: requiere $HOME escribible).
RUN npm install --global pnpm@10.21.0
WORKDIR /repo
ENV NODE_ENV=production \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    API_PORT=4000 \
    WEB_PORT=3000 \
    DIDACTA_CORE_VERSION=${DIDACTA_VERSION:-0.0.1-alpha.52}

# Usuario no-root.
RUN addgroup -S -g 1001 didacta \
 && adduser  -S -u 1001 -G didacta -h /home/didacta -s /bin/bash didacta \
 && mkdir -p /home/didacta/.cache /home/didacta/.local /home/didacta/.npm \
 && chown -R didacta:didacta /home/didacta

# Repo limpio: una sola layer con el árbol final, sin acumular layers gordas
# del builder. Aquí está el truco para bajar de 3GB a <1GB.
COPY --from=pruner --chown=didacta:didacta /repo /repo

# Entrypoint: migraciones + rls + arranque.
COPY --chown=didacta:didacta infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER didacta

ENV HOME=/home/didacta \
    XDG_CACHE_HOME=/home/didacta/.cache \
    XDG_DATA_HOME=/home/didacta/.local/share \
    NPM_CONFIG_CACHE=/home/didacta/.npm

EXPOSE 4000 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:${API_PORT}/healthz || exit 1

# tini en Alpine vive en /sbin/tini (en Debian es /usr/bin/tini).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["start"]
