# mod.hello-world

Módulo de ejemplo. **Usá este módulo como plantilla de referencia para crear módulos nuevos en LearnShip.**

## Qué demuestra

- Manifest válido parseado con `parseModuleManifest` del core.
- Implementación de los 4 hooks de lifecycle (`onRegister`, `onEnable`, `onDisable`, `onUninstall`).
- Un service de dominio (`HelloWorldService`) que recibe `ModuleContext` y consume `eventBus` + `i18n`.
- Suite de tests unitaria que registra el módulo en un `ModuleRegistry` y verifica el contrato end-to-end.

## Estructura

```
modules/hello-world/
├── src/
│   ├── manifest.ts    # declaración + validación del manifest
│   ├── service.ts     # lógica de dominio (consume ModuleContext)
│   └── index.ts       # exporta el LearnShipModule y su service
├── tests/
│   └── contract.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Cómo crear un módulo nuevo a partir de este

1. Copiá esta carpeta a `modules/<tu-modulo>/`.
2. Renombrá `name`, `tablePrefix`, `apiNamespace` y permisos en `src/manifest.ts`.
3. Implementá tu lógica de dominio en `src/service.ts` (o varios archivos).
4. Implementá los hooks según el ciclo de vida del módulo (`onEnable` suele ser dónde seed de datos por tenant).
5. Actualizá los tests.
6. Respetá el checklist de `docs/ARQUITECTURA-MODULAR.md` §9 antes de abrir PR.

## Anti-patrones que NO se usan acá

- Nunca importar código de otro módulo directamente.
- Nunca acceder a tablas ajenas con Prisma.
- Nunca modificar el core para añadir features de este módulo.
- Nunca emitir eventos sin declararlos en `eventsEmitted` del manifest.
