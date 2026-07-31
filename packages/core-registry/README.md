# @didacta/core-registry

Module Registry del core. Valida, ordena y coordina el lifecycle de los módulos de Didacta.

## Responsabilidades

- Validar `coreVersionRequired` de cada módulo contra la versión del core actual.
- Resolver el orden topológico respetando `dependencies.modules`.
- Detectar **ciclos** y **dependencias faltantes** con errores descriptivos.
- Verificar rangos SemVer de cada dependencia.
- Coordinar el lifecycle por tenant: `onRegister` → `onEnable` → `onDisable` → `onUninstall`.
- Mantener idempotencia (activar dos veces no dispara `onEnable` dos veces).

## Lo que **no** hace (aún)

- **Persistencia**: el core-tenancy aplicará transiciones sobre `tenant_module` en BD.
- **Discovery desde filesystem**: por ahora los módulos se pasan como colección al `register()`. El scan de `modules/*/module.json` será un ADR/PR posterior cuando definamos cómo se empaquetan.

## Uso

```ts
import { ModuleRegistry } from '@didacta/core-registry';
import { coursesModule } from '@didacta/mod-courses';
import { learningModule } from '@didacta/mod-learning';

const registry = new ModuleRegistry({
  coreVersion: '1.0.0',
  context: buildModuleContext(), // del core
  logger,
});

await registry.register([coursesModule, learningModule]);

await registry.enableForTenant('tenant-abc', 'mod.courses');
await registry.enableForTenant('tenant-abc', 'mod.learning');
```

## Errores tipados

- `CoreVersionMismatchError` — el módulo requiere un core distinto.
- `CircularDependencyError` — ciclo detectado, incluye la cadena completa.
- `MissingDependencyError` — dependencia obligatoria ausente.
- `DependencyVersionMismatchError` — versión instalada fuera del rango SemVer declarado.

## Tests

```bash
pnpm --filter @didacta/core-registry test
```
