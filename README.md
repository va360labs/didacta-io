# Didacta Community

> 📚 **Plataforma LMS modular, fair-code y source-available** — VA360 LABS S.L.

[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/va360labs/didacta-community/pkgs/container/didacta-community)
[![License](https://img.shields.io/badge/license-Sustainable%20Use%201.0-orange)](LICENSE)
[![Versioning](https://img.shields.io/badge/versioning-SemVer-green)](docs/versioning.md)
[![Stage](https://img.shields.io/badge/stage-alpha%20cerrada-red)](docs/alpha/INSTALL.md)

## Estado actual

🚧 **Alpha cerrada** — primer milestone público en `v0.0.1-alpha.0`.

Si eres un alpha tester invitado, empieza por [`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md).

## Quickstart (alpha testers)

```bash
# 1. Login en GHCR (privado durante alpha)
echo $GITHUB_PAT | docker login ghcr.io -u <usuario> --password-stdin

# 2. Clone + configurar .env
git clone https://github.com/va360labs/didacta-community.git
cd didacta-community
cp .env.example .env
# editar .env: AUTH_SECRET y DIDACTA_IMAGE_TAG

# 3. Arrancar
docker compose -f docker-compose.alpha.yml up -d

# 4. Abrir
# http://localhost:4000/api/docs   (Swagger)
# http://localhost:3000             (Web)
# http://localhost:8025             (Mailpit)
```

Detalle completo: [`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md). Para reportar bugs / feedback: [`docs/alpha/FEEDBACK.md`](docs/alpha/FEEDBACK.md).

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
