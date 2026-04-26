# ADR-008 — Contrato de módulo

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

Didacta se construye como monolito modular (ADR-001) con la promesa de que **módulos nuevos se pueden desarrollar en paralelo sin tocar el core ni otros módulos**. Esta promesa solo es real si existe un **contrato de módulo estable, blindado y testeable**.

Sin contrato explícito se termina con acoplamientos implícitos (imports cruzados, FKs cross-module, eventos no declarados) que destruyen la modularidad y bloquean el roadmap a los 6-12 meses.

## Decisión

El contrato consta de tres piezas:

### 1. Manifest `module.json` declarado programáticamente

```ts
import { parseModuleManifest } from '@didacta/core-kernel';

export const manifest = parseModuleManifest({
  name: 'mod.courses', // 'core' o 'mod.<kebab>'
  version: '1.0.0',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_courses_', // obligatorio
  apiNamespace: '/modules/courses',
  permissions: [...],
  eventsEmitted: [...],
  eventsConsumed: [...],
  // ...
});
```

Validado en **runtime con Zod** en `@didacta/core-kernel`. Si el manifest es inválido, el core falla al arrancar con errores descriptivos (path + mensaje por cada issue).

### 2. Interfaz `DidactaModule`

```ts
interface DidactaModule {
  readonly manifest: ModuleManifest;
  onRegister(ctx: ModuleContext): Promise<void>;
  onEnable(tenantId: string, ctx: ModuleContext): Promise<void>;
  onDisable(tenantId: string, ctx: ModuleContext): Promise<void>;
  onUninstall(tenantId: string, ctx: ModuleContext): Promise<void>;
}
```

### 3. `ModuleContext` como única fuente de servicios

Los módulos **nunca instancian** servicios de infraestructura. Reciben vía contexto:

- `eventBus`, `hookRegistry` — comunicación
- `storage`, `auditLog`, `evidenceVault`, `notificationHub` — servicios cross-cutting
- `i18n`, `logger`, `config` — transversales

## Reglas de oro (no negociables)

1. **Prefijo `mod_<nombre>_` en todas las tablas** del módulo.
2. **`tenant_id` obligatorio** en tablas de datos de negocio, con política RLS (ADR-002).
3. **Cero FKs cross-module**: un módulo nunca referencia tablas de otro con FK. Usa IDs lógicos.
4. **Cero imports directos** de código privado de otro módulo. Comunicación solo vía eventos, hooks o APIs públicas del core.
5. **Todos los eventos emitidos/consumidos declarados en el manifest**.
6. **Namespace API `/api/v1/modules/<nombre>/*`**.
7. **Lifecycle hooks implementados** (no basta con el `onRegister`; los 4 hooks son obligatorios).

## Consecuencias

Positivas:

- **Paralelizable**: `mod.courses`, `mod.learning`, `mod.assessments` pueden desarrollarse por equipos separados si existieran.
- **Testeable en aislamiento**: el módulo `mod.hello-world` es la prueba de que el contrato funciona end-to-end sin infra real.
- **Evolucionable**: breaking changes al contrato son posibles con ADR aprobada + major bump del core + migration guide.
- **Auto-documentado**: `@didacta/core-registry` expone `/api/v1/modules` con todos los módulos registrados y sus manifests.

Negativas / riesgos:

- **Disciplina en revisión de PRs**: un reviewer distraído puede mergear un import cross-module. **Mitigación**: tests de contrato en CI (T-F0-015) que fallan ante violaciones.
- **Curva de aprendizaje** para devs nuevos: deben leer `docs/ARQUITECTURA-MODULAR.md` y este ADR antes de tocar `modules/*`.
- **Rigidez aparente**: a veces parece que el contrato te obliga a dar rodeos. La respuesta es casi siempre: **es correcto**. Si realmente el contrato no sirve, se escribe ADR para modificarlo.

## Versionado

El contrato es **SemVer estricto**:

- `@didacta/core-kernel` define las interfaces.
- Un **major bump** del core obliga a que todos los módulos bump su `coreVersionRequired` y migren según un migration guide publicado.
- **Deprecación** marcada con JSDoc `@deprecated` al menos una minor antes del remove.

## Validación automática

El paquete `@didacta/core-registry`:

- Valida `coreVersionRequired` de cada módulo vs versión actual del core.
- Resuelve dependencias topológicamente (detecta ciclos).
- Ejecuta `onRegister` en orden correcto.
- Lanza errores tipados (`CircularDependencyError`, `MissingDependencyError`, `DependencyVersionMismatchError`, `CoreVersionMismatchError`) con mensajes en español.

## Referencias

- `packages/core-kernel/src/module/manifest.ts`
- `packages/core-kernel/src/module/module.ts`
- `packages/core-registry/src/`
- `modules/hello-world/` (implementación de referencia)
- `docs/ARQUITECTURA-MODULAR.md` (documento madre)
