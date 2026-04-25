# syntax=docker/dockerfile:1.7
# ============================================================================
# LearnShip — Dockerfile multi-stage único (api + web)
# ----------------------------------------------------------------------------
# Construye apps/api (NestJS) y apps/web (Next.js) en un solo contenedor.
# Easypanel hace deploy desde el repo en cada merge a main.
# El entrypoint corre `prisma migrate deploy` y `db:rls:apply` antes de levantar.
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
    NODE_ENV=production

# ----------------------------------------------------------------------------
# Stage 2: deps — instala dependencias con cache eficiente
# ----------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core-kernel/package.json packages/core-kernel/
COPY packages/core-registry/package.json packages/core-registry/
COPY packages/database/package.json packages/database/
COPY modules/hello-world/package.json modules/hello-world/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ----------------------------------------------------------------------------
# Stage 3: builder — genera Prisma client y buildea api + web
# ----------------------------------------------------------------------------
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm --filter @learnship/database db:generate
RUN pnpm turbo run build --filter=@learnship/api --filter=@learnship/web

# ----------------------------------------------------------------------------
# Stage 4: runner — imagen final mínima con solo lo necesario para runtime
# ----------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    API_PORT=4000 \
    WEB_PORT=3000

RUN groupadd --system --gid 1001 learnship \
 && useradd  --system --uid 1001 --gid learnship --shell /bin/bash learnship

# Workspace minimal: lockfile + manifests para que pnpm pueda resolver
COPY --chown=learnship:learnship package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY --chown=learnship:learnship apps/api/package.json                apps/api/
COPY --chown=learnship:learnship apps/web/package.json                apps/web/
COPY --chown=learnship:learnship packages/core-kernel/package.json    packages/core-kernel/
COPY --chown=learnship:learnship packages/core-registry/package.json  packages/core-registry/
COPY --chown=learnship:learnship packages/database/package.json       packages/database/
COPY --chown=learnship:learnship modules/hello-world/package.json     modules/hello-world/

# Solo prod deps (más pequeño y sin devDeps)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Artefactos buildeados
COPY --chown=learnship:learnship --from=builder /repo/apps/api/dist                 apps/api/dist
COPY --chown=learnship:learnship --from=builder /repo/apps/web/.next                apps/web/.next
COPY --chown=learnship:learnship --from=builder /repo/apps/web/public               apps/web/public/
COPY --chown=learnship:learnship --from=builder /repo/apps/web/next.config.ts       apps/web/
COPY --chown=learnship:learnship --from=builder /repo/packages/core-kernel/dist     packages/core-kernel/dist
COPY --chown=learnship:learnship --from=builder /repo/packages/core-registry/dist   packages/core-registry/dist
COPY --chown=learnship:learnship --from=builder /repo/packages/database/dist        packages/database/dist
COPY --chown=learnship:learnship --from=builder /repo/packages/database/prisma      packages/database/prisma
COPY --chown=learnship:learnship --from=builder /repo/modules/hello-world/dist      modules/hello-world/dist

# Cliente Prisma generado
COPY --chown=learnship:learnship --from=builder /repo/node_modules/.pnpm/@prisma+client* node_modules/.pnpm/

# Entrypoint: migraciones + rls + arranque
COPY --chown=learnship:learnship infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER learnship
EXPOSE 4000 3000

# Healthcheck contra /healthz de la API (más representativo del estado del proceso)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:${API_PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["start"]
