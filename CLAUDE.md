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

### 3. PROHIBIDO usar datos falsos o de cartón

**NUNCA inventar datos, mocks, fixtures ni constantes hardcodeadas para mostrar en UI.**

- Todos los datos que aparecen en pantalla vienen de la BD real a través de la API.
- Si una pantalla necesita datos que aún no existen en la BD: comunicar exactamente qué seed/migración hace falta y esperar aprobación antes de escribir código.
- Están prohibidos: arrays `const POSTS = [...]`, `const FAKE_SESSION = {...}`, objetos con nombres de persona inventados ("Marta Ruiz", "Carlos N."), contadores fijos (1240 miembros, 38 cursos…).
- Excepción única: fixtures en tests (`*.spec.ts`, `*.test.ts`). En el código de producción, cero datos inventados.

### 4. Validar entrega con Playwright antes de declarar "listo"

**Antes de decir que algo está listo, ejecutar los tests E2E:**

```
pnpm exec playwright test --config apps/e2e/playwright.config.ts apps/e2e/tests/<spec>.spec.ts --reporter=line
```

- Si algún test falla: corregir primero, informar después.
- No declarar éxito hasta ver `N passed` en la salida.
- Si no existe spec para la funcionalidad entregada, crearla.

### 5. Prohibido duplicar secciones o rutas

**Antes de crear una página o sección nueva, verificar que no exista ya:**

- Buscar en `apps/web/src/app/(app)/` si hay una ruta con el mismo propósito.
- Buscar en `buildGroups()` del layout si ya hay un item del sidebar que apunte a contenido equivalente.
- Si existe: reutilizar o consolidar, nunca crear un segundo camino al mismo destino.
- Histórico: `/inicio` (feed hardcodeado del rediseño) duplicaba `/comunidad` (feed real). Resultado: confusión + datos de cartón visibles en producción.

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

---

## ⛔ REGLA DE INDEPENDENCIA DE MÓDULOS (zero-tolerance)

**Cualquier código específico de un módulo `mod.<slug>` vive EXCLUSIVAMENTE en `modules/<slug>/`.** Nunca bajo `apps/web/` ni `apps/api/`.

### Por qué

Los módulos third-party se instalan en runtime desde un ZIP firmado por el marketplace. Si su código vive en `apps/*`, requiere rebuild del Docker image del host → rompe el contrato de marketplace. Ver ADR-009 + ADR-015.

### CHECKLIST OBLIGATORIO antes de escribir/editar cualquier archivo

1. **¿El path empieza con `apps/`?**
   - SÍ → ¿es código específico de UN módulo (importa `mod.<slug>`, agrega ruta específica de ese módulo, define UI de ese módulo)?
     - SÍ → **STOP**. Ir a `modules/<slug>/`.
     - NO (es infra genérica del host: dispatcher, router, surface loader, sidebar genérico) → OK, sigue.
   - NO → OK, sigue.

2. **¿Es UI de un módulo?** → va en `modules/<slug>/src/ui/<surface>.tsx`, se bundlea a `dist/ui/<surface>.js` con esbuild `--format=iife`, va dentro del ZIP firmado.

3. **¿Es backend de un módulo?** → va en `modules/<slug>/src/`. Expone routes via `module.exports.routes`. NUNCA agrega controllers en `apps/api/`.

### El host SOLO tiene infra genérica relacionada a marketplace

| OK en `apps/api/src/marketplace/`                              | NO en `apps/api/src/marketplace/`                 |
| -------------------------------------------------------------- | ------------------------------------------------- |
| `modules-dispatcher.controller.ts` (rutea `/api/v1/modules/*`) | `sandboxed-migrator-learndash.service.ts` ❌      |
| `module-assets.controller.ts` (sirve `dist/ui/*.js` del ZIP)   | `learndash-helpers.ts` ❌                         |
| `sandboxed-db.service.ts` (cliente DB genérico para módulos)   | Cualquier cosa que mencione un slug específico ❌ |

| OK en `apps/web/src/`                                                                         | NO en `apps/web/src/`                                                                    |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `lib/module-loader.ts` (carga genérica de surfaces)                                           | `modules/migrator-learndash/wizard.tsx` ❌                                               |
| `lib/module-runtime.ts` (expone `__didacta__` global)                                         | `app/(app)/admin/integraciones/migrator-learndash/page.tsx` con import del componente ❌ |
| `app/(app)/admin/integraciones/[module]/page.tsx` que solo hace `loadModuleUI(slug, 'admin')` | Cualquier `.tsx` específico de un módulo ❌                                              |

### Infraestructura disponible (NO inventes paralela)

- `loadModuleUI(moduleName, surface)` en `apps/web/src/lib/module-loader.ts`
- `initModuleRuntime()` en `apps/web/src/lib/module-runtime.ts` expone `window.__didacta__` con React + shadcn/ui + api
- `GET /api/v1/modules/:slug/ui/:surface.js` del `ModuleAssetsController` sirve el bundle del ZIP
- Manifest field `surfaces: { admin: { entry: 'dist/ui/admin.js', routes, menu, roles } }`
- Bundle del módulo termina con `window.__didacta_module_exports__ = { default: AdminSurface }`

### Code review trigger automático

Si vas a tocar un archivo cuyo path matches:

- `apps/web/src/modules/<slug>/`
- `apps/web/src/app/.../modules/<slug>/` o `.../integraciones/<slug>/` con código específico
- `apps/api/src/marketplace/sandboxed-<slug>*.ts` (excepto los genéricos: `sandboxed-db|http|jobs|secrets|didacta`)

**PARÁ. Verificá si lo que vas a hacer pertenece a `modules/<slug>/`. Si dudás, preguntá al usuario.**

### Histórico de violaciones (no repetir)

- 2026-05-13/17 — alpha.58/59: monitor del migrator añadido en `apps/web/src/modules/migrator-learndash/jobs-monitor.tsx` cuando debió ir a `modules/migrator-learndash/src/ui/`. Resultado: rebuild del Docker image para cambios del módulo, anti-patrón de marketplace. Corregido en alpha.60 moviendo todo a surface bundle.
