# Didacta — Contexto para asistentes IA

> Instrucciones base para Claude Code (o cualquier otro asistente IA) al trabajar en este repositorio.

## ⚠️ REGLAS CRÍTICAS (NO NEGOCIABLES)

### 1. Documentación SOLO en Notion
**TODA la documentación vive en Notion, NUNCA en el repositorio.**
- Fuente de verdad: [LMS Ship](https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4)
- PRD, ADRs, HANDOFFs, Estado, Arquitectura → TODO en Notion
- Si necesitas documentar algo, hazlo en Notion
- Si encuentras documentación en el repo, migrala a Notion y elimínala

### 2. No avanzar sin documentación y tests
**PROHIBIDO avanzar a nuevas tareas si:**
- La tarea actual no está correctamente documentada en Notion
- Los tests no pasan o no existen para la funcionalidad
- Hay decisiones arquitectónicas sin ADR

Aunque el usuario lo pida, NO avanzar. Primero documentar y probar.

---

## Sobre el proyecto

**Didacta** es una plataforma LMS modular propiedad de **VA360 LABS S.L.**

Arquitectura: NestJS 11 + Next.js 15 + PostgreSQL 16 (con Row-Level Security) + Redis 7 + Anthropic API.

**Principio rector**: modularidad extrema. Core mínimo + módulos activables con contratos estables.

## Documentación (Notion)

Toda la documentación vive en Notion → [LMS Ship](https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4):
- **PRD — Didacta**: Product Requirements Document
- **ADRs**: Architecture Decision Records (12 ADRs)
- **HANDOFFs**: Notas de sesión
- **Módulos — Registry**: 15 módulos documentados
- **Skills y Asistentes IA**: Sistema de skills para desarrollo
- **Estado del arte**: Cobertura actual vs competencia

## Reglas de trabajo

- **Idioma**: español para commits, comentarios y documentación. Identificadores técnicos (nombres de funciones, variables, tipos, endpoints) en inglés.
- **Commits**: Conventional Commits obligatorios. Nunca añadir "Co-Authored-By" ni atribuciones a la IA.
- **Tests**: obligatorios para lógica de negocio. Coverage mínimo 70% en services y handlers.
- **Contrato de módulo**: respetar en todo cambio a `modules/*`. Si algo no cumple el contrato, no es un módulo de Didacta.
- **Sin dependencias cruzadas entre módulos**: comunicación solo vía eventos, hooks o APIs públicas del core.
- **ADRs obligatorias**: para decisiones arquitectónicas no triviales. Ver `docs/adrs/` (cuando exista).
- **Ramas**: `feat/<descripción-corta>`, `fix/<descripción>`, `chore/<descripción>`, `docs/<descripción>`.
- **Pull Requests**: uno por feature. Descripción en español con resumen, cambios y plan de test.

## Estado actual

Proyecto en **Fase 0 — Discovery técnico y fundaciones**.

Planificación viva en Notion: [LMS Ship](https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4).

## Stack cerrado (ver PRD §6.1)

- Backend: Node.js 22 + NestJS 11 + TypeScript 5.x estricto
- Frontend: Next.js 15 (App Router) + React 19 + Tailwind 4 + shadcn/ui
- Base de datos: PostgreSQL 16 + Prisma 5
- Cache/colas: Redis 7 + BullMQ
- Object storage: S3-compatible (MinIO dev, Hetzner prod)
- Auth: Better-Auth o Auth.js v5 (pendiente ADR-003)
- IA: Anthropic API (Claude Sonnet 4.5) + pgvector
- Aula virtual: Zoom API + SDK Web
- Monorepo: Turborepo + pnpm workspaces
- Testing: Vitest + Playwright + Supertest
- Observabilidad: OpenTelemetry + Pino

## Anti-patrones prohibidos

- Import directo de código de otro módulo.
- Lectura directa de tablas ajenas vía Prisma (saltea permisos y API pública).
- Modificar el core para añadir features de un módulo.
- Eventos emitidos sin declararlos en el manifest.
- FKs entre tablas de módulos distintos.
- Módulos que no respetan `tenant_id` (riesgo de data leak).
- Lógica de negocio en controllers.
- Estado global compartido entre módulos.
