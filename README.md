# LearnShip

> Plataforma LMS modular — VA360 LABS S.L.

## Estado

🚧 **Fase 0 — Discovery técnico y fundaciones**

## Sobre el proyecto

LearnShip es una plataforma LMS (Learning Management System) modular, moderna y
extensible, propiedad de VA360 LABS S.L. Se construye con dos objetivos consecutivos:

1. **Dogfooding**: reemplazar el stack actual de VA360 (LearnDash + FluentCommunity +
   Zoom externo + n8n externo) para cursos propios de VA360.academy y PotenzIA.
2. **Comercialización**: evolucionar a producto SaaS multi-tenant.

El principio rector es **modularidad extrema**: un core mínimo y todo lo demás como
módulos activables con contratos estables.

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
