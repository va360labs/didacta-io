# @didacta/core-kernel

Contrato de módulo y primitivas del core de Didacta (arquitectura modular: ADR-011 / ADR-015 / ADR-016, decision log interno).

## ¿Qué hay aquí?

- **`ModuleManifest`** — tipo y schema Zod del manifest que todo módulo debe declarar.
- **`DidactaModule`** — interfaz con el ciclo de vida (`onRegister`, `onEnable`, `onDisable`, `onUninstall`).
- **`ModuleContext`** — conjunto de servicios que el core provee a cada módulo (eventBus, hookRegistry, storage, auditLog, evidenceVault, notificationHub, i18n, logger, config).
- **`parseModuleManifest`** — validador runtime que lanza `ModuleManifestValidationError` con detalles si el manifest es inválido.

## Reglas

- **Zero runtime dependencies** (solo Zod). Este paquete es el contrato, no debe importar infra.
- **Tipos, no implementaciones**. Las implementaciones concretas de `EventBus`, `StorageService`, etc. viven en `packages/core-*` específicos.
- **SemVer estricto**. Cualquier cambio breaking en esta interfaz requiere ADR y major bump del core.

## Uso

```ts
import { parseModuleManifest, type DidactaModule, type ModuleContext } from '@didacta/core-kernel';

const manifest = parseModuleManifest({
  name: 'mod.courses',
  displayName: 'Gestión de cursos',
  description: 'Catálogo, cursos, módulos y lecciones',
  version: '1.0.0',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_courses_',
  apiNamespace: '/modules/courses',
  eventsEmitted: ['courses.course.created', 'courses.course.published'],
});

export const coursesModule: DidactaModule = {
  manifest,
  async onRegister(_ctx: ModuleContext) {
    /* registrar handlers globales */
  },
  async onEnable(_tenantId, _ctx) {
    /* seed data por tenant */
  },
  async onDisable(_tenantId, _ctx) {
    /* cancelar jobs */
  },
  async onUninstall(_tenantId, _ctx) {
    /* archivar datos */
  },
};
```

## Tests

```bash
pnpm --filter @didacta/core-kernel test
```
