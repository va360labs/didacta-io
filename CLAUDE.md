# Didacta — Contexto para asistentes IA

> Instrucciones base para Claude Code (o cualquier otro asistente IA) al trabajar en este repositorio.

## Qué es este repositorio

**Didacta** (didacta.io) es una plataforma LMS modular **fair-code** propiedad de **VA360 LABS S.L.** Este repo es **el producto whitelabel**, no la instalación de ningún cliente. Tres ediciones:

- **Community**: este código, bajo la Didacta Sustainable Use License v1.0 (`LICENSE`). Self-hosted, gratuito, uso interno libre.
- **Enterprise**: capabilities transversales del core en ficheros `*.ee.*`, desbloqueadas por licencia JWT firmada (ES256/KMS, ver `packages/license-sdk`). Cubiertas por `LICENSE_EE`.
- **Cloud**: SaaS gestionado por VA360 LABS; vive en el repo privado `didacta-cloud`, que consume este repo. Aquí no hay código de Cloud.

Historia: entre 2026-05 y 2026-07 este código sirvió como proyecto a medida para aula.va360.academy (congelado en el tag `v0.0.1-alpha.88-va360`). Desde 2026-07-31 el repo vuelve a ser el producto whitelabel; esa instalación pasará a ser el primer cliente del canal de release.

## ⚠️ REGLAS CRÍTICAS (NO NEGOCIABLES)

### 1. Whitelabel: prohibido acoplar a un cliente

Ningún copy, dominio, IP, email, slug de tenant, credencial ni heurística de un cliente concreto puede vivir en el código. Todo lo específico de una instalación es **configuración o datos de tenant** (branding, `/admin/branding`, env). Los defaults usan dominios reservados (`example.com`, `ejemplo.com`) o derivan del tenant resuelto por host. La marca de la empresa (headers «Copyright (c) VA360 LABS S.L.», campo `author`) sí se queda: es la dueña del producto, como n8n GmbH.

### 2. Modelo de ediciones «WordPress matizado»

- **Los módulos son SIEMPRE Community** y nunca se gatean por licencia. Lo único de pago son las capabilities transversales del core (lista cerrada en `packages/license-sdk/src/capabilities.ts`).
- Código Enterprise solo en ficheros `*.ee.*` o carpetas `ee/` dentro del core; el fence lo valida `scripts/ee-fence.ts` (CI `ee-fence.yml`).
- UI de gating estilo n8n: la página **siempre existe** (nunca 404 ni menú oculto), título y descripción fuera de `<EeGate>`, panel real dentro con upsell. Backend responde **402** vía `@RequiresCapability`.

### 3. Independencia de módulos (dos niveles, ADR-016)

- **Third-party del marketplace** (ZIP firmado, `sandboxed-db`): zero-tolerance — solo sus tablas, comunicación solo por eventos/hooks/APIs públicas, UI dentro del ZIP (ADR-015).
- **First-party built-in** (in-tree): la lógica vive en `modules/<slug>/`; puede tener host NestJS en `apps/api/src/modules/<slug>/` y UI in-tree (ADR-011/015). Puede **leer** (nunca escribir) tablas de otros módulos filtrando por `tenant_id` y **declarando la dependencia en el manifest**. Sin FKs cross-module, sin imports cross-module, eventos declarados en el manifest.
- Tablas de módulo con prefijo `mod_<slug>_` y `tenant_id` + RLS siempre.

### 4. PROHIBIDO usar datos falsos o de cartón

- Todo dato en pantalla viene de la BD real a través de la API.
- Prohibidos: arrays hardcodeados de contenido, contadores fijos, nombres de persona inventados.
- Excepción única: fixtures en tests (`*.spec.ts`, `*.test.ts`) con datos **neutros** (`@example.com`, tenant `demo`) — nunca PII real ni marca de un cliente.

### 5. Base de datos con disciplina de producto

- `tenant_id` + política RLS en toda tabla nueva (la RLS se autodescubre en `packages/database/prisma/rls.sql`).
- Migraciones Prisma **versionadas** para todo cambio de schema; `db push` solo en desarrollo local. Un self-hoster tiene que poder actualizar entre versiones.
- Cambios destructivos (uniques nuevas, drops) exigen plan de migración explícito.

### 6. Tests y validación antes de declarar «listo»

- Tests obligatorios para lógica de negocio (coverage mínimo 70% en services y handlers).
- Ejecutar los E2E de Playwright de la funcionalidad entregada antes de declarar éxito; si no existe spec, crearla.
- La CI fair-code (`ci.yml`, `ee-fence.yml`, `gitleaks.yml`, `license-check.yml`, `module-doctor.yml`, `module-contract.yml`) debe pasar en verde.

### 7. Git con cuidado

- Commits SIEMPRE acotados con pathspec: `git commit <ruta> -m "…"`. Nunca `git add -A`, ni `git commit -a`, ni commit sin ruta.
- Conventional Commits en español. Nunca añadir "Co-Authored-By" ni atribuciones a la IA.
- Ramas: `feat/…`, `fix/…`, `chore/…`, `docs/…`. Un PR por feature, descripción en español.

### 8. Documentación

- La documentación interna (PRD, ADRs, HANDOFFs) vive en Notion → [LMS Ship](https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4).
- El repo lleva SOLO la documentación que un repo público necesita: README, CONTRIBUTING, SECURITY, licencias, READMEs técnicos de módulos/packages y guías de instalación. Nada de planes de sesión, prompts ni runbooks de clientes.

## Stack cerrado

- Backend: Node.js 22 + NestJS 11 + TypeScript 5.x estricto
- Frontend: Next.js 15 (App Router) + React 19 + Tailwind 4 + shadcn/ui
- Base de datos: PostgreSQL 16 + Prisma 5 + RLS + pgvector
- Cache/colas: Redis 7 + BullMQ
- Object storage: S3-compatible (MinIO dev)
- Aula virtual: Zoom API + SDK Web (ADR-004)
- IA: **BYOK multi-proveedor** vía el AI Gateway (`apps/api/src/ai/`): cada instalación configura proveedor y clave; ningún proveedor cableado en el producto.
- Monorepo: Turborepo + pnpm workspaces · Testing: Vitest + Playwright + Supertest

## Instalación de referencia

`docker-compose.alpha.yml` es la experiencia self-host canónica (imagen + postgres + redis + mailpit + MinIO opcional). El primer arranque se configura con el setup wizard (`/setup/init`), no con seeds de datos.

## Anti-patrones prohibidos

- Import directo de código de otro módulo (cualquier nivel).
- **Escritura** en tablas de otro módulo. Lectura cross-table solo first-party, con `tenant_id` + dependencia declarada en manifest.
- Modificar el core para añadir features de un módulo.
- Eventos emitidos sin declararlos en el manifest.
- FKs entre tablas de módulos distintos.
- Tablas sin `tenant_id` (salvo las 9 globales de instancia justificadas).
- Lógica de negocio en controllers.
- Gatear un módulo por licencia (viola `LICENSE_EE`) u ocultar una feature EE (viola la convención de upsell).
- Acoplar el producto a un cliente concreto (regla 1).
