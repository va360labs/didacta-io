# ADR-011 — Módulos self-contained: todo el código (back + front + assets) bajo `modules/<name>/`

- **Estado**: Aceptada
- **Fecha**: 2026-05-02
- **Deciders**: Valentín Ayesa
- **Relacionada con**: ADR-008 (contrato de módulo), ADR-009 (marketplace)

## Contexto

Hasta ahora la regla **"todo lo no-core son módulos"** (ADR-008) se aplicaba al código backend: cada módulo tenía sus controllers/services en `apps/api/src/modules/*` y respetaba `tablePrefix` + ausencia de FKs cross-module. Pero la **UI del módulo** (componentes React, clientes HTTP, páginas dedicadas) se filtraba al core:

- `apps/web/src/app/(app)/admin/configuracion/page.tsx` declaraba un componente `ZoomCredentialsCard` hard-coded.
- `apps/web/src/lib/zoom-live.ts` vivía bajo `lib/`, no bajo el módulo.
- Tabs del panel admin (`Aula virtual`, `Plantillas`, etc.) se declaraban en una constante `TABS` en el core, sin conocimiento del módulo dueño.

Síntoma observable (alpha.16): el operador desactivaba `mod.zoom-live` y el tab "Aula virtual" seguía apareciendo. El fix síntoma (filtrar tabs por `requiresModule`) NO arreglaba el problema arquitectónico de fondo: **piezas del módulo seguían viviendo en el core**.

Esto rompe tres promesas del producto:
1. **Modularidad operativa**: si el módulo tiene UI en el core, desactivarlo no quita visualmente sus superficies (sin maquillaje extra).
2. **Distribución vía marketplace** (ADR-009): un `*.zip` debe poder traer su UI también, no solo backend. Sin esto, los módulos de terceros nunca pueden añadir paneles.
3. **Aislamiento**: cualquier acoplamiento del core con un módulo (un import, una constante con su nombre) impide eliminar el módulo del producto sin tocar el core.

## Decisión

**Todo el código de un módulo vive bajo su carpeta**, en ambos apps:

```
apps/api/src/modules/<name>/
  ├─ <name>.module.ts        # NestJS sub-module
  ├─ <name>.controller.ts
  ├─ <name>-error.filter.ts
  └─ ... (services, bridges, workers del módulo)

apps/web/src/modules/<name>/
  ├─ index.ts                # exporta ModuleWebExtension + helpers
  ├─ admin-config-card.tsx   # tabs admin (si aplica)
  ├─ <pages dedicadas>.tsx
  ├─ client.ts               # cliente HTTP del módulo
  └─ types.ts (opcional)
```

El core **NO importa nada de un módulo concreto**. Solo importa:
- El `<Name>Module` de NestJS (sub-module) en `apps/api/src/modules/modules.module.ts`.
- El `<name>Extension` en `apps/web/src/modules/index.ts` (catálogo agregado).

### Extension point frontend

El core declara un shape `ModuleWebExtension` en `apps/web/src/lib/module-registry.ts`. Cada módulo exporta una constante de ese shape desde su `index.ts`:

```ts
// apps/web/src/modules/zoom-live/index.ts
export const zoomLiveExtension: ModuleWebExtension = {
  name: 'mod.zoom-live',
  adminConfigTabs: [
    { key: 'aula-virtual', label: 'Aula virtual', description: '…', Component: ZoomCredentialsCard },
  ],
  sidebarItems: [
    { group: 'Formador', href: '/formador/aula-virtual', label: 'Aula virtual', icon: 'calendar', requiresRole: 'formador' },
  ],
};
```

El catálogo agregado vive en `apps/web/src/modules/index.ts`:

```ts
import { zoomLiveExtension } from './zoom-live';
export const moduleExtensions: readonly ModuleWebExtension[] = [zoomLiveExtension];
```

El core consume esto en su shell (`/admin/configuracion`, sidebar) filtrando por `activeModules` del tenant.

### Carga dinámica (marketplace, fase 2+)

Cuando el marketplace dinámico esté operativo (ADR-009 implementado), este patrón se extiende con un **loader runtime** que lee `installed_module` de la BD y mounta extensions desde paquetes `*.zip` instalados sin restart. La interfaz `ModuleWebExtension` no cambia — solo se reemplaza el import estático del catálogo por una resolución dinámica.

### Anti-patrones prohibidos

- ❌ Componente UI de un módulo en `apps/web/src/components/` o en una página del core.
- ❌ Cliente HTTP del módulo en `apps/web/src/lib/`.
- ❌ Hard-code de strings con el slug del módulo (`'mod.zoom-live'`) en código del core, excepto en el catálogo `apps/web/src/modules/index.ts`.
- ❌ Re-export de tipos del módulo desde el core para uso de otros módulos. Si dos módulos comparten tipos, vive en `@didacta/core-kernel`.
- ❌ Páginas Next.js bajo `apps/web/src/app/...` que importen directamente del módulo. **Excepción permitida temporalmente**: páginas que actúan como wrapper (`/formador/aula-virtual/page.tsx` haciendo `import { AulaVirtualPage } from '@/modules/zoom-live'`). Se evaluará migrar también las páginas a un loader cuando llegue Fase 2.

## Implementación

Aplicado primero a `mod.zoom-live` como caso piloto (este PR):

| Antes | Después |
|---|---|
| `apps/api/src/modules/zoom-live.controller.ts` | `apps/api/src/modules/zoom-live/zoom-live.controller.ts` |
| `apps/api/src/modules/zoom-webhook.controller.ts` | `apps/api/src/modules/zoom-live/zoom-webhook.controller.ts` |
| `apps/api/src/modules/zoom-live-error.filter.ts` | `apps/api/src/modules/zoom-live/zoom-live-error.filter.ts` |
| Filter + controllers declarados directamente en `ModulesModule` | `ZoomLiveModule` propio que `ModulesModule` importa |
| `apps/web/src/lib/zoom-live.ts` (cliente HTTP) | `apps/web/src/modules/zoom-live/client.ts` |
| `function ZoomCredentialsCard()` dentro de `configuracion/page.tsx` | `apps/web/src/modules/zoom-live/admin-config-card.tsx` |
| Tab `aula-virtual` declarado en constante `TABS` del core | Tab declarado en `zoomLiveExtension.adminConfigTabs` |

## Roadmap de migración (otros módulos)

Aplicar el mismo refactor a los módulos que aún tienen piezas en el core:

| Módulo | Backend ya separado | Frontend a migrar |
|---|---|---|
| `mod.notifications` | sí | tab Notificaciones (SMTP), tab Plantillas |
| `mod.fundae` | sí | `/admin/fundae/*` (varias páginas) |
| `mod.ai-tutor` | sí | clientes en `lib/ai-tutor.ts` |
| `mod.ai-grader` | sí | tab + clientes |
| `mod.ai-content` | sí | clientes |
| `mod.billing` | sí | `/admin/billing/products`, checkout flow |
| `mod.community` | sí | digestor metrics + UI |
| `mod.certificates` | sí | `/formador/certificados/templates`, mis-certificados |
| `mod.assessments` | sí | quiz editor + attempts |

Cada migración: 1 PR autocontenido. Estimación: ~M (modules pequeños como `mod.zoom-live`) a L (modules grandes como `mod.fundae` con varias páginas y forms anidados).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Imports circulares entre módulos | Regla: módulos NO se importan entre sí. Compartir tipos vía `@didacta/core-kernel`. |
| Catálogo `apps/web/src/modules/index.ts` se desincroniza | Test unitario que verifica que todos los `apps/web/src/modules/*/index.ts` están importados en el catálogo. |
| Carpetas `apps/api/src/modules/<name>/` ocultan dependencias | El `<Name>Module` (NestJS) declara explícitamente `imports`/`providers`. Sin barrel imports laxos. |
| UI rota tras migración (rutas `/formador/aula-virtual` rompen) | Páginas Next.js wrap del componente del módulo (no se mueve la ruta, solo el contenido). Smoke E2E al deploy. |

## Decisión

Adoptar el patrón self-contained con extension points como **regla del repo**. Aplicar a `mod.zoom-live` como piloto. PRs siguientes migran el resto.

Cualquier PR nuevo que añada UI de un módulo fuera de su carpeta debe ser **rechazado en review** y reescrito.
