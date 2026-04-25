# syntax=docker/dockerfile:1.7
# ============================================================================
# LearnShip — Dockerfile multi-stage único (api + web)
# ----------------------------------------------------------------------------
# Construye apps/api (NestJS) y apps/web (Next.js) en un solo contenedor.
# Easypanel hace deploy desde el repo en cada merge a main.
# El entrypoint corre `prisma migrate deploy` y `db:rls:apply` antes de levantar.
#
# Patrón usado: `pnpm fetch` + `pnpm install --offline`. Esto evita tener que
# enumerar cada workspace package.json en COPYs separados — el lockfile basta.
# Cuando se añaden módulos nuevos no hay que tocar el Dockerfile.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: base — Node 22 LTS + pnpm 10 + dependencias del sistema
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    postgresql-client \
    tini \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.21.0 --activate
WORKDIR /repo
ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=$PNPM_HOME:$PATH \
    NODE_ENV=production \
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
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm --filter @learnship/database db:generate
RUN pnpm turbo run build

# ----------------------------------------------------------------------------
# Stage 4: runner — imagen final con prune de devDeps
# ----------------------------------------------------------------------------
FROM builder AS runner
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod \
 && pnpm store prune || true

RUN groupadd --system --gid 1001 learnship \
 && useradd  --system --uid 1001 --gid learnship --shell /bin/bash learnship \
 && chown -R learnship:learnship /repo

# Entrypoint: migraciones + rls + arranque
COPY --chown=learnship:learnship infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER learnship

ENV API_PORT=4000 \
    WEB_PORT=3000

EXPOSE 4000 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:${API_PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["start"]
