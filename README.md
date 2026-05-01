# Didacta Community

> 📚 **Plataforma LMS modular, fair-code y source-available** — VA360 LABS S.L.

[![Docker](https://img.shields.io/badge/docker-hub-blue)](https://hub.docker.com/r/didactaio/community)
[![License](https://img.shields.io/badge/license-Sustainable%20Use%201.0-orange)](LICENSE)
[![Versioning](https://img.shields.io/badge/versioning-SemVer-green)](docs/versioning.md)
[![Stage](https://img.shields.io/badge/stage-alpha-red)](docs/alpha/INSTALL.md)

## Estado actual

🚧 **Alpha pública** — primer milestone público en `v0.0.1-alpha.0`.

Imagen oficial publicada en Docker Hub: [`didactaio/community`](https://hub.docker.com/r/didactaio/community). **Pública** — no requiere `docker login`.

## Verificar acceso a la imagen

```bash
# Tag oficial pinned (recomendado para alpha testers)
docker pull didactaio/community:0.0.1-alpha.0

# Alternativa: tag rolling de la última alpha
docker pull didactaio/community:alpha
```

Si baja sin pedir credenciales, estás listo para cualquiera de los dos caminos de despliegue de abajo.

## Variables de entorno obligatorias

Solo 4 ENVs son **estrictamente obligatorias** para que la app arranque. El resto tienen defaults razonables o se inyectan desde el compose. Set completo y documentado en [`.env.example`](.env.example).

| Variable                  | Qué es                                                                                                                    | Cómo generarla                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Connection string Postgres 16 con extensión `pgvector` instalada.                                                         | Apunta a tu Postgres. Para compose: `postgresql://didacta:didacta_dev@postgres:5432/didacta?schema=public`. |
| `REDIS_URL`               | Connection string Redis 7.                                                                                                | Apunta a tu Redis. Para compose: `redis://redis:6379`.                                                      |
| `AUTH_SECRET`             | Secret para firmar sesiones / cookies. Mínimo 32 chars.                                                                   | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                               |
| `TENANT_SETTINGS_ENC_KEY` | Clave AES-256 (hex 32 bytes) que cifra settings sensibles por tenant en DB (claves API IA, secrets SMTP por tenant, etc). | `openssl rand -hex 32`                                                                                      |

> ⚠️ `TENANT_SETTINGS_ENC_KEY` no se rota a la ligera: perderías acceso a los settings cifrados. Backup antes de tocarla.

## Camino A — Docker Compose (recomendado)

Stack completo en local: API + web + Postgres + Redis + MinIO (S3) + Mailpit (SMTP).

```bash
# 1. Clonar
git clone https://github.com/va360labs/didacta-community.git
cd didacta-community

# 2. Configurar .env
cp .env.example .env

# 3. Generar los 2 secrets obligatorios
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
echo "TENANT_SETTINGS_ENC_KEY=$(openssl rand -hex 32)" >> .env

# 4. Fijar la versión de la imagen (default: alpha)
echo "DIDACTA_IMAGE_TAG=0.0.1-alpha.0" >> .env

# 5. Arrancar
docker compose -f docker-compose.alpha.yml up -d

# 6. Esperar healthchecks (~60-90s la primera vez)
docker compose -f docker-compose.alpha.yml ps

# 7. Abrir
# http://localhost:3000             — Web
# http://localhost:4000/api/docs    — Swagger
# http://localhost:4000/healthz     — health probe
# http://localhost:8025             — Mailpit (emails de prueba)
# http://localhost:9001             — MinIO console
```

Manual completo con troubleshooting, primer admin, actualización de versión y operaciones del día a día: [`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md) y [`docs/alpha/RUNBOOK.md`](docs/alpha/RUNBOOK.md). Reportar bugs / feedback: [`docs/alpha/FEEDBACK.md`](docs/alpha/FEEDBACK.md).

## Camino B — Docker pull + run manual

Para operadores que ya tienen Postgres 16 + Redis 7 administrados y solo quieren correr el contenedor de la app.

**Pre-requisitos:**

- Postgres 16 con extensión `pgvector` instalada y schema vacío (la app aplica las migraciones Prisma al arrancar).
- Redis 7 accesible desde el contenedor.
- Las 4 ENVs obligatorias listadas arriba.

```bash
docker pull didactaio/community:0.0.1-alpha.0

docker run -d \
  --name didacta-app \
  -p 3000:3000 \
  -p 4000:4000 \
  -e DATABASE_URL='postgresql://USER:PASS@HOST:5432/didacta?schema=public' \
  -e REDIS_URL='redis://HOST:6379' \
  -e AUTH_SECRET='...' \
  -e TENANT_SETTINGS_ENC_KEY='...' \
  -e NODE_ENV=production \
  --restart unless-stopped \
  didactaio/community:0.0.1-alpha.0
```

**Verificar:**

```bash
docker logs -f didacta-app                  # ver bootstrap + migraciones Prisma
curl -fsS http://localhost:4000/healthz     # debe responder 200
```

**Variables opcionales útiles** (set completo en [`.env.example`](.env.example)):

| Variable                                                        | Para qué                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`    | Storage S3-compatible (MinIO, AWS, Hetzner, etc.). Obligatorio para subida de contenido.     |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envío de emails transaccionales. Sin esto, los emails se loguean pero no salen.              |
| `DIDACTA_LICENSE_KEY`                                           | JWT firmado por Didacta para activar capabilities Enterprise. Sin esto, modo Community puro. |
| `METRICS_TOKEN`                                                 | Bearer token para proteger `/metrics` (Prometheus). Si está vacío, endpoint público.         |

## Sobre el proyecto

Didacta es una plataforma LMS (Learning Management System) **modular, moderna, fair-code**, propiedad de VA360 LABS S.L. Se construye con dos objetivos consecutivos:

1. **Dogfooding**: reemplazar el stack actual de VA360 (LearnDash + FluentCommunity + Zoom externo + n8n externo) para cursos propios de VA360.academy y PotenzIA.
2. **Comercialización**: evolucionar a producto con tres ediciones (Community / Enterprise self-hosted / Cloud SaaS gestionado).

El principio rector es **modularidad extrema**: un core mínimo, todo lo demás como módulos activables con contratos estables. Inspiración: n8n.io + WordPress matizado.

## Modelo de licencias

- **Repo + módulos**: [Didacta Sustainable Use License v1.0](LICENSE) (fair-code, adaptada de n8n SUL). Permite uso interno empresarial libre. Distribución comercial / SaaS / white-label requiere acuerdo.
- **Capabilities Enterprise** (archivos `*.ee.*` dentro del CORE): [Didacta Enterprise License](LICENSE_EE). Requieren licencia firmada activa para usarse en producción.
- **Cloud**: SaaS gestionado por VA360 (`cloud.didacta.io`).

Resumen humano: [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md). FAQ: [`docs/licensing/faq.md`](docs/licensing/faq.md).

## Documentación

- 📄 [PRD (Product Requirements Document)](docs/PRD.md)
- 🗺 [Plan de fases](docs/PLAN-FASES.md)
- 🏗 [Arquitectura modular](docs/ARQUITECTURA-MODULAR.md)
- ✅ [Checklist de arranque](docs/CHECKLIST-ARRANQUE.md)

## Prompts para Claude Code

El backlog del proyecto se genera asistido con Claude Code en 3 sesiones:

- [Prompt 01 — Casos de uso e historias de usuario](prompts/prompt-01-casos-uso.md)
- [Prompt 02 — Tareas técnicas atómicas](prompts/prompt-02-tareas-tecnicas.md)
- [Prompt 03 — Volcado a Notion como kanban](prompts/prompt-03-notion-kanban.md)

## Stack tecnológico

- **Backend**: Node.js 22 + NestJS 11 + TypeScript
- **Frontend**: Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui
- **DB**: PostgreSQL 16 con Row-Level Security + Prisma 5
- **Cache/Colas**: Redis 7 + BullMQ
- **Storage**: S3-compatible (MinIO dev, Hetzner prod)
- **Aula virtual**: Zoom API + SDK Web
- **IA**: Anthropic API (Claude Sonnet 4.5) + pgvector
- **Automatización**: n8n via webhooks
- **Hosting**: Hetzner + Easypanel
- **CI/CD**: GitHub Actions
- **Monorepo**: Turborepo + pnpm workspaces

Detalle completo en [docs/PRD.md](docs/PRD.md#6-stack-tecnológico-cerrado).

## Roadmap de alto nivel

| Fase     | Duración  | Objetivo                                      |
| -------- | --------- | --------------------------------------------- |
| Fase 0   | 2 semanas | Discovery técnico, repo, infraestructura base |
| Fase 1.A | 8 semanas | CORE + cursos asíncronos + certificados       |
| Fase 1.B | 8 semanas | Zoom directo + comunidad + Fundae básico      |
| Fase 1.C | 8 semanas | IA integrada + piloto + auditoría externa     |
| Fase 2+  | Iterativo | Migradores, SSO, comercial, IFAPA             |

## Licencia

Proprietary © 2026 VA360 LABS S.L. All rights reserved.
