# syntax=docker/dockerfile:1.7
# ============================================================================
# Didacta Community — Dockerfile multi-stage único (api + web) sobre Alpine
# ----------------------------------------------------------------------------
# Construye apps/api (NestJS) y apps/web (Next.js) en un solo contenedor.
# El entrypoint aplica `prisma migrate deploy` y las políticas RLS antes de levantar.
#
# Imagen base: `node:22-alpine` (musl). Recorta ~700MB frente a
# `node:22-bookworm-slim`. Contrapartidas:
#   - Deps del sistema con `apk` (no apt).
#   - Native modules (argon2) compilan contra musl: el builder necesita
#     `python3 make g++`.
#   - Prisma necesita el binary target `linux-musl-openssl-3.0.x`
#     (definido en packages/database/prisma/schema.prisma).
#   - Los motores de Prisma (cliente Y CLI de `migrate deploy`) se descargan
#     en el BUILD y viajan dentro de la imagen. El contenedor tiene que
#     arrancar sin acceso a binaries.prisma.sh: ver `openssl` en el stage
#     base, los motores que el pruner aparta y restaura alrededor del
#     `pnpm install --prod`, y la comprobación `--network=none` del runner.
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
# `openssl` NO es opcional en el build. Prisma 5 decide qué variante de sus
# motores bajar mirando la versión de OpenSSL del sistema; en Alpine solo la
# reconoce por el binario `openssl` (no busca libssl.so.3 en /usr/lib). Sin
# él cae a OpenSSL 1.1 y el `prisma generate` del builder baja los motores
# del CLI para `linux-musl`, mientras que el runner (que SÍ lleva openssl)
# pide los de `linux-musl-openssl-3.0.x`. Resultado hasta beta.22: el
# `prisma migrate deploy` del entrypoint descargaba los motores de
# binaries.prisma.sh en CADA arranque, y sin red el contenedor no levantaba.
RUN apk add --no-cache openssl \
 && npm install --global pnpm@10.21.0
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
# Stage 3: manifests — extrae package.json + configs de workspace sin código
# fuente. Permite que el install de pnpm quede en una capa independiente del
# código: si solo cambia .tsx/.ts, la capa de install se reutiliza del
# registry cache en vez de reinstalar (~1-2 min ahorrados por iteración).
# ----------------------------------------------------------------------------
FROM base AS manifests
COPY . .
RUN find . \( -name "package.json" \
              -o -name "pnpm-workspace.yaml" \
              -o -name "turbo.json" \) \
      ! -path "*/node_modules/*" ! -path "*/.next/*" \
    | while read f; do \
        install -D "$f" "/out/$f"; \
      done

# ----------------------------------------------------------------------------
# Stage 4: builder — instala deps y buildea TODO el monorepo (devDeps activas)
# ----------------------------------------------------------------------------
FROM fetcher AS builder
ARG SKIP_TYPE_CHECK=0
# CI=true: pnpm aborta el remove de node_modules sin TTY a menos que sepa que
# corre en un entorno no interactivo (necesario si .npmrc/lockfile cambian).
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    SKIP_TYPE_CHECK=${SKIP_TYPE_CHECK}
# Build deps para compilar native modules (argon2). Alpine viene sin
# toolchain por defecto.
RUN apk add --no-cache --virtual .build-deps \
    g++ \
    make \
    python3
# 1) Solo manifests: la capa de install queda cacheada mientras no cambie
#    ningún package.json / pnpm-workspace.yaml / turbo.json.
COPY --from=manifests /out/ ./
# Install completo: crítico que cree los symlinks workspace en
# node_modules/@didacta/* que tsc necesita para resolver imports
# cross-package. NOTA: NO usamos --offline porque el cache montado del stage
# fetcher no parece propagarse de forma fiable a los symlinks workspace.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# 2) Código fuente: solo invalida las waves de build, NO el install.
COPY . .
# Defensa frente a `incremental: true` en tsconfig.base.json: si algún
# .tsbuildinfo se cuela desde el host (a pesar del .dockerignore), tsc lo
# usa como cache y omite la emisión de dist/. Borrarlos garantiza un build
# limpio reproducible.
RUN find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete || true
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
# Stage 5: pruner — deja el repo en estado runtime-only
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
# Motores del CLI de Prisma (los que usa `prisma migrate deploy` al arrancar).
# Los baja el `prisma generate` del builder para la plataforma del build
# (`linux-musl-openssl-3.0.x`, gracias al openssl del stage base). Pero el
# `pnpm install --prod` de abajo vuelve a enlazar @prisma/engines desde la
# caché de pnpm, que trae los motores que hubiera guardado un build anterior
# (hasta beta.22, `linux-musl` de OpenSSL 1.1) y pisa los buenos. Por eso los
# apartamos antes del install y los restauramos después, quitando lo que
# haya traído la caché. Si falta alguno, `cp` falla y el build se corta.
# La ruta va por el patrón de pnpm (en el builder no hay hoisting a la raíz:
# el .npmrc con shamefully-hoist no entra hasta el `COPY . .`); si casa con
# cero o con más de un directorio, `[ -d ]` falla y el build se corta.
RUN engines="$(echo node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines)" \
 && [ -d "$engines" ] \
 && mkdir -p /prisma-engines \
 && cp -a "$engines"/libquery_engine-* "$engines"/schema-engine-* /prisma-engines/
# NOTA: no usamos `--offline` ni `pnpm store prune` aquí. El `store prune`
# corrompe el cache mount compartido de buildkit (borra paquetes que un build
# posterior con --offline ya no encuentra → prisma CLI sin `build/`, etc.).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod
RUN engines="$(echo node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines)" \
 && [ -d "$engines" ] \
 && rm -f "$engines"/libquery_engine-* "$engines"/schema-engine-* \
 && cp -a /prisma-engines/. "$engines"/ \
 && ls -l "$engines"

# ----------------------------------------------------------------------------
# Stage 6: runner — imagen final desde alpine LIMPIO (no hereda del builder)
# ----------------------------------------------------------------------------
FROM node:22-alpine AS runner
# DIDACTA_VERSION: version de la app, inyectada en build time por release.yml
# (`build-args: DIDACTA_VERSION=<version del tag>`). El default tiene que vivir
# en ESTE stage: un ARG declarado en otro stage no cruza, y sin default aqui el
# valor llegaba vacio y se horneaba una version falsa.
# Sobreescribible con: docker build --build-arg DIDACTA_VERSION=0.0.1-alpha.96
# El default 0.0.0 es el mismo valor conservador que asume el runtime cuando
# DIDACTA_CORE_VERSION no esta set (resolveCoreVersion en install-package.service.ts):
# una imagen construida a mano se identifica como "sin version" en /healthz y en
# telemetria, y el gate del marketplace queda fail-closed, en vez de mentir con
# el numero de una release que no es.
ARG DIDACTA_VERSION=0.0.0
# Deps de RUNTIME (no build):
#   - bash: entrypoint.sh usa bashismos ([[, arrays, `wait -n`).
#   - ca-certificates + openssl: TLS para S3, Anthropic, SMTP.
#   - curl: healthcheck.
#   - libc6-compat: algunos binarios prebuilt asumen glibc.
#   - postgresql16-client: psql para aplicar rls.sql.
#   - su-exec: drop privileges de root -> didacta tras chown del volumen.
#     Sin esto la primera escritura en /app/data falla con EACCES porque
#     Docker monta el volumen vacío como root:root y el proceso de la app
#     corre como UID 1001 (ver entrypoint.sh, bloque init-as-root).
#   - tini: init proper en PID 1 (manejo correcto de SIGTERM y zombies).
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    libc6-compat \
    openssl \
    postgresql16-client \
    su-exec \
    tini
# pnpm como binario global (sin corepack: requiere $HOME escribible).
RUN npm install --global pnpm@10.21.0
WORKDIR /repo
ENV NODE_ENV=production \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    API_PORT=4000 \
    WEB_PORT=3000 \
    DIDACTA_CORE_VERSION=${DIDACTA_VERSION:-0.0.0}
# Sin el aviso de versiones del CLI de Prisma (checkpoint.prisma.io) en cada
# `migrate deploy`: el arranque no tiene que salir a internet.
ENV CHECKPOINT_DISABLE=1

# Usuario no-root.
RUN addgroup -S -g 1001 didacta \
 && adduser  -S -u 1001 -G didacta -h /home/didacta -s /bin/bash didacta \
 && mkdir -p /home/didacta/.cache /home/didacta/.local /home/didacta/.npm \
 && chown -R didacta:didacta /home/didacta

# Repo limpio: una sola layer con el árbol final, sin acumular layers gordas
# del builder. Aquí está el truco para bajar de 3GB a <1GB.
COPY --from=pruner --chown=didacta:didacta /repo /repo

# El `pnpm install --prod` del pruner restaura @prisma/client a su estado de
# paquete (stub de 2KB que lanza "did not initialize yet" en runtime),
# perdiendo el `prisma generate` del builder. Como regenerar tras el prune
# falla (engines podados), copiamos el client YA GENERADO desde el builder
# (que conserva index.js real + el query engine linux-musl-openssl-3.0.x).
# La versión del path debe coincidir con la de pnpm-lock.yaml
# (@prisma/client 5.22.0).
COPY --from=builder --chown=didacta:didacta \
  /repo/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma \
  /repo/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma

# Guardia: la imagen tiene que poder ejecutar el CLI de Prisma SIN red. Si
# faltase el motor de la plataforma real (`linux-musl-openssl-3.0.x`), el CLI
# intentaría bajarlo de binaries.prisma.sh, aquí fallaría por no haber red y
# el build se cortaría en vez de publicar una imagen que no arranca sin
# internet. `validate` pasa por la misma comprobación de motores que el
# `migrate deploy` del entrypoint; la URL es ficticia (no se conecta).
RUN --network=none \
    DATABASE_URL=postgresql://offline-check@localhost:5432/offline-check \
    pnpm --filter @didacta/database exec prisma validate

# Entrypoint: migraciones + rls + arranque.
COPY --chown=didacta:didacta infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# IMPORTANTE — NO declaramos `USER didacta` aquí. El entrypoint arranca como
# root SOLO para chownear el volumen persistente `/app/data` (que Docker monta
# como root:root la primera vez) y luego baja a `didacta:didacta` con su-exec.
# Sin este patrón, la primera escritura en /app/data/storage falla con EACCES
# en cualquier deploy nuevo (compose, k8s, o un PaaS sin fsGroup).
# Ver entrypoint.sh, bloque `init-as-root`.

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
