# ADR-015 — Independencia estricta de módulos: la UI vive dentro del ZIP

- **Status**: Accepted
- **Date**: 2026-05-17
- **Supersedes / Relates**: ADR-008 (contrato base de módulo), ADR-009 (marketplace y surfaces)

## Contexto

El repositorio define `modules/<slug>/` como la unidad de distribución de módulos third-party. Los módulos se firman con AWS KMS y se distribuyen como ZIPs (`*.didactamod`) que el operador instala en runtime sin rebuildear el host. La arquitectura completa de surfaces UI dinámicas ya está implementada en el código base (ver "Estado de la infraestructura" más abajo).

Sin embargo, hasta alpha.59 el módulo `mod.migrator-learndash` mantuvo su UI (wizard + admin-config-card) dentro de `apps/web/src/modules/migrator-learndash/`, importada directamente desde la página del host bajo `apps/web/src/app/(app)/admin/integraciones/migrator-learndash/page.tsx`. En 2026-05-17 se añadió un componente nuevo (`jobs-monitor.tsx`) siguiendo el mismo patrón equivocado, lo cual desencadenó esta ADR.

El problema operativo es:

1. **Rompe el contrato de marketplace**: un cambio en la UI del módulo requiere bumpear la versión de la imagen Docker del host y un rebuild completo. El módulo deja de ser "instalable in-place"; en la práctica es código del core disfrazado de módulo.
2. **Bloquea publishers third-party**: la promesa de Fase 2+ del marketplace (publishers externos firmando sus propios módulos tras review de Didacta) se rompe si la UI de cada módulo tiene que vivir en el repo del host.
3. **Acopla ciclos de release**: cada hotfix de un módulo arrastra el ciclo completo de release del API + web + Docker mirror.
4. **Mata la auditabilidad de la firma**: el manifest declara `surfaces: ["admin"]` y el sistema verifica `dist/ui/<surface>.js` dentro del ZIP firmado. Si la UI vive fuera, la firma KMS no la cubre.

## Decisión

**Toda UI específica de un módulo `mod.<slug>` vive en `modules/<slug>/src/ui/<surface>.tsx` y se bundlea con esbuild a `modules/<slug>/dist/ui/<surface>.js`**, incluida dentro del ZIP firmado. El host la carga en runtime mediante `loadModuleUI(moduleName, surface)` (ya implementado en `apps/web/src/lib/module-loader.ts`).

Reglas derivadas:

1. Prohibido cualquier archivo `.ts`/`.tsx` específico de un módulo bajo `apps/web/` o `apps/api/`. La única excepción son los componentes/controllers GENÉRICOS de marketplace que tratan a TODOS los módulos por igual (dispatcher, router, surface loader, sidebar genérico que itera el `manifest.surfaces.<X>.menu`).
2. La página del host en `apps/web/src/app/(app)/admin/integraciones/[slug]/page.tsx` debe ser genérica: parametrizada por `slug`, llama a `loadModuleUI(slug, 'admin')`, y renderiza con `React.Suspense`. Una sola página sirve para todos los módulos.
3. El bundle del módulo se compila con `esbuild --format=iife --jsx-factory=__didacta__.React.createElement` (o equivalente con shim de imports) y termina con `window.__didacta_module_exports__ = { default: AdminSurface }`.
4. Las dependencias del bundle (React, shadcn/ui, helpers del host) NO se importan directo: se leen del global `window.__didacta__` expuesto por `initModuleRuntime()`. El bundle es delgado (solo lógica del módulo).
5. La permission gate del componente surface se declara en `manifest.surfaces.admin.roles`; el host la enforce antes de montar el componente.

## Consecuencias

**Positivas**:

- Un fix de la UI de un módulo se distribuye como ZIP nuevo (segundos) sin tocar el host.
- La firma KMS cubre el bundle UI completo — auditable y verificable post-mortem.
- Cualquier publisher externo puede entregar un módulo con UI sin PR al repo del host.
- El host queda agnóstico al inventario de módulos: solo conoce el contrato.

**Negativas**:

- El módulo necesita su propia tooling de bundle UI (esbuild config para IIFE, shim de imports `react`/`@/components/ui/*` → `__didacta__`).
- El runtime expone un subset de shadcn/ui, no todo. Componentes que el módulo necesite y no estén en `module-runtime.ts` requieren PR al host para agregarlos al runtime (cambio backwards-compatible, todos los módulos lo aprovechan).
- TypeScript del bundle UI necesita declarar `__didacta__` y usar tipos del host (sin importarlos en runtime).

## Alternativas descartadas

- **Module Federation de Webpack**: requiere plugin pesado, frágil en Next.js 15 App Router, no se compone bien con el sandbox del marketplace.
- **iframes por módulo**: aislamiento real pero rompe la UX del shell admin (sidebar, breadcrumbs, theming).
- **Surfaces solo para módulos de Fase 2+**: dejar la deuda actual y aplicar la regla solo a módulos nuevos. Descartado porque genera arquitectura inconsistente y los devs nuevos copian el patrón viejo por inercia.

## Implementación

Migración de cada módulo violatorio en orden de prioridad:

1. `mod.migrator-learndash` (alpha.60, esta ADR) — primer migrante, valida el camino.
2. Resto de módulos con UI: el catálogo `apps/web/src/modules/index.ts` deja de existir; el host descubre las surfaces leyendo el manifest de cada módulo instalado.

## Code review trigger automático

Si un PR toca archivos cuyo path matches alguna de estas rutas:

- `apps/web/src/modules/<slug>/**`
- `apps/web/src/app/.../integraciones/<slug>/**` (con código específico, no genérico parametrizado por slug)
- `apps/api/src/marketplace/sandboxed-<slug>*.ts` (excepto los contratos genéricos: `sandboxed-{db,http,jobs,secrets,didacta}`)
- `apps/api/src/marketplace/<slug>-*.ts`

→ el PR debe explicar por qué no puede estar en `modules/<slug>/`. Por defecto, **se rechaza**.

## Histórico de violaciones

- 2026-05-13 — alpha.58: `apps/web/src/modules/migrator-learndash/jobs-monitor.tsx` (370 LOC) añadido como nuevo componente del módulo en el árbol del host.
- 2026-05-17 — alpha.60 (esta ADR): corrección. Wizard + monitor + admin-config-card movidos a `modules/migrator-learndash/src/ui/`. El host pasa a usar `loadModuleUI` genérico.
