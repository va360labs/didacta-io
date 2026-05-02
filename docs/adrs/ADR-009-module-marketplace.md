# ADR-009 — Marketplace de módulos (carga dinámica vía ZIP)

- **Estado**: Propuesto
- **Fecha**: 2026-05-03
- **Deciders**: Valentín Ayesa
- **Relacionada con**: ADR-001 (monolito modular), ADR-008 (contrato de módulo)

## Contexto

Hoy los módulos viven dentro del monorepo y se compilan en la imagen Docker `didactaio/community`. Activar/desactivar un módulo desde `/admin/modules` solo cambia el estado **por tenant** de un módulo que YA ESTÁ en la imagen. Para añadir un módulo nuevo: PR + rebuild + nueva versión alpha.

Esto bloquea dos casos de uso clave para el modelo open-core:

1. **Operador self-host instala un módulo de terceros** (escuela quiere `mod.gamification` de un dev externo).
2. **Didacta entrega módulos verticales sin rebuild** (cliente Fundae recibe `mod.ifapa` sin esperar la siguiente alpha).

n8n, WordPress, Strapi y Drupal resuelven esto con un marketplace + upload de paquete. Didacta debe seguir el mismo patrón para que la promesa de "modularidad extrema" sea operativa, no solo arquitectónica.

## Decisión

Permitir que un `super_admin` suba un paquete `*.zip` (ZIP firmado) desde `/admin/modules/install`, validarlo end-to-end contra el contrato de módulo (ADR-008), persistirlo en object storage y cargarlo en el process del API sin reinicio.

### Alcance MVP (Sprint 4-5, esfuerzo XL)

- **Solo super_admin** puede instalar; tenant_admins solo activan/desactivan los ya instalados.
- **Solo módulos firmados por Didacta** en MVP. Marketplace de terceros = Fase 2+.
- **Solo modules CE**. Capabilities EE siguen siendo del core (no se cargan dinámicamente).
- **Sin marketplace público todavía**: el operador descarga el ZIP de un canal interno (Notion/Drive privado) y lo sube al panel.

## Arquitectura

### 1. Formato del paquete `*.zip`

ZIP con estructura fija:

```
mod.example-1.0.0.zip
├── manifest.json           # ADR-008 manifest serializado
├── manifest.jwt            # JWT compact ES256 (manifest como payload) (clave Didacta)
├── dist/                   # Código JS compilado (output tsc, no TS source)
│   ├── service.js
│   ├── controller.js
│   └── index.js
├── prisma/
│   └── migrations/         # Migraciones SQL del módulo (creación de tablas mod_<name>_*)
├── package.json            # deps runtime + version + entry "dist/index.js"
├── README.md
└── LICENSE                 # SUL para CE, EE License para Enterprise
```

### 2. Manifest extendido

Sobre el manifest de ADR-008 añadimos:

```ts
{
  name: 'mod.example',
  version: '1.0.0',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  // Nuevos campos del marketplace:
  vendor: 'va360' | 'community',  // En MVP solo 'va360'
  signedAt: '2026-05-03T00:00:00Z',
  permissions: [...],
  eventsEmitted: [...],
  eventsConsumed: [...],
  hooksProvided: [...],
  hooksConsumed: [...],
  // Restricciones runtime:
  requiredCapabilities: [],          // EE caps que el core debe tener (ej: 'feat:scim')
  requiredEnvVars: ['EXAMPLE_API_KEY'],
  isolation: 'vm' | 'worker_thread', // Default 'vm' MVP
}
```

### 3. Flujo de instalación

```
super_admin → POST /api/v1/admin/modules/install (multipart, file=mod.example-1.0.0.zip)
  │
  ├─ 1. Validate mime + size (max 50MB por módulo)
  ├─ 2. Extract ZIP a /tmp/<uuid>/ (adm-zip, ya usado por mod.learning para SCORM)
  ├─ 3. Read manifest.jwt
  ├─ 4. Verify firma con Didacta public key (env MARKETPLACE_PUBLIC_KEYS_DIR)
  ├─ 5. Parse manifest contra schema Zod (reusa ADR-008)
  ├─ 6. Check coreVersionRequired ≤ core actual
  ├─ 7. Check name único (no colisiona con módulos ya instalados ni built-in)
  ├─ 8. Lint estático del dist/ (no requires fuera de allowlist, no fs writes fuera de su namespace)
  ├─ 9. Persist:
  │     - ZIP completo a S3 didacta-modules/<tenantInstance>/<name>-<version>.zip
  │     - Row en table installed_modules (id, name, version, status='installing', ...)
  ├─10. Run prisma/migrations/ del módulo en transacción
  ├─11. Boot del módulo en VM aislada (vm2 o worker_thread):
  │     - Carga dist/index.js
  │     - Resuelve required deps con resolver del core (NO acceso libre al node_modules)
  │     - Llama a module.onInstall(globalCtx)
  ├─12. Registra controller/service/bridges en NestJS dynamic module
  ├─13. Mark status='installed', emit event 'module.installed'
  └─14. Devuelve 200 con manifest visible
```

### 4. Aislamiento runtime

Tres niveles de defensa:

- **Lint estático** (paso 8): rechaza require/import fuera de allowlist (`@didacta/core-kernel`, `@didacta/database`, `@nestjs/common`, std node modules sin `fs`/`child_process`).
- **VM aislada** (paso 11): `node:vm` o `vm2` con `require` interceptado. Resolver del core inyecta solo APIs públicas autorizadas.
- **DB scoping**: el módulo solo puede tocar tablas con su `tablePrefix`. Enforcer en runtime via interceptor SQL (post-RLS strict — ver `docs/RLS-STRICT-PLAN.md`).

Para MVP usamos `node:vm` nativo (vm2 es deprecated). El módulo NO tiene acceso a `fs`, `child_process`, `net` directos — pasa todo por proxies del core que loguean y limitan.

### 5. Distribución (NO marketplace público en MVP)

Didacta publica `*.zip` en un canal privado (Notion → "Módulos disponibles" + Drive con assets). El operador descarga manualmente. Marketplace público (catálogo browseable, ratings, payments) = work item separado en Fase 2+.

### 6. Lifecycle por tenant tras instalación global

Un módulo instalado a nivel **instancia** sigue siendo activable/desactivable por tenant via `/admin/modules` (flujo existente). Instalación instancia ≠ activación tenant.

| Acción | Quién | Endpoint |
|---|---|---|
| Instalar (subir ZIP) | super_admin | `POST /admin/modules/install` |
| Desinstalar (borrar de instancia) | super_admin | `POST /admin/modules/:name/uninstall?archive=true` |
| Listar instalados | super_admin | `GET /admin/modules/installed` |
| Activar para mi tenant | tenant_admin | `POST /admin/modules/:name/enable` |
| Desactivar para mi tenant | tenant_admin | `POST /admin/modules/:name/disable` |

### 7. Hot-reload sin restart

Para evitar SLA hits durante install, registramos el módulo via `DynamicModule.forRootAsync` cargado tras boot. Riesgo: memoria del worker crece (sin GC del módulo viejo si se actualiza versión). Mitigación: rolling restart del API tras 5 instalaciones acumuladas (counter en Redis).

### 8. Rollback y versionado

- Cada install crea row en `installed_modules` con `version` + `prevVersion`.
- Si install falla en pasos 10-12, transacción rollback de DB + cleanup S3 + status='failed'.
- Update de versión: el sistema instala nueva, marca antigua deprecated, mantiene ambas en disco hasta que rolling restart limpia. Permite revert ≤ 24h.

## Riesgos y mitigaciones

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Módulo malicioso ejecuta código en el host | Alta | VM + lint allowlist + firma ES256 (KMS). Solo Didacta firma en MVP. |
| Migración Prisma del módulo rompe schema del core | Alta | `tablePrefix` obligatorio + check estático antes de aplicar. Tests del migrator validan idempotencia. |
| Módulo consume demasiados recursos | Media | Cuotas CPU/memoria por VM. Limit p99 latency del módulo en interceptor. Kill si excede. |
| FKs cross-module se cuelan en migraciones | Alta | Linter SQL rechaza `REFERENCES` fuera del propio `tablePrefix`. |
| Two-phase rollback falla y deja DB inconsistente | Media | Migraciones envueltas en savepoint Postgres. Si commit a installed_modules falla, savepoint rollback restaura schema. |
| Marketplace público trae adversarial supply chain | Alta | Out of scope en MVP. Cuando llegue: revisión manual, scan estático automático, sandbox extendido. |

## Alternativas consideradas

### Alternativa A — No hacer marketplace, todo es PR al monorepo

**Status quo**. Ventaja: simple, controlado. Desventaja: bloquea modelo open-core, fricción para devs externos. Rechazada por el ADR-001 (modularidad extrema).

### Alternativa B — Microservicios por módulo

Cada módulo = container separado. Comunicación HTTP/gRPC. Ventaja: aislamiento real, multi-tenant trivial. Desventaja: 5x complejidad ops para self-host single-host (target alpha). Rechazada para MVP, reconsiderar en Fase 3 cuando haya cluster managed.

### Alternativa C — Solo activación de built-ins, marketplace fuera del core

Built-ins en imagen + un "loader" que en runtime descarga módulos del CDN Didacta. Ventaja: no hay upload-zip en el panel, todo controlado por Didacta. Desventaja: rompe la promesa self-host (operador no decide qué instala). Rechazada.

## Decisión final

Adoptar el flujo descrito (vendor='va360' firmado, vm2-style isolation, install endpoint super_admin) como **MVP del marketplace de módulos**.

Marketplace público de terceros queda explícitamente **out of scope** y se trata en una ADR separada cuando haya tracción comercial.

## Plan de implementación (resumen)

| Sprint | Trabajo |
|---|---|
| Sprint 4 | Schema `installed_modules`, endpoint `POST /admin/modules/install` con upload + verify firma + extract. NO ejecuta el módulo aún (solo persiste). |
| Sprint 4 | Hot-reload via DynamicModule + VM aislamiento + install allowlist requires. |
| Sprint 5 | Migración Prisma del módulo + lint SQL `tablePrefix` enforcement. |
| Sprint 5 | UI `/admin/modules/install` con drag & drop + preview manifest + confirm. |
| Sprint 5 | Tests E2E con `mod.hello-world.zip` real (módulo sample firmado). |
| Sprint 6 | RLS strict (depende de `docs/RLS-STRICT-PLAN.md`) — sin esto el módulo accede a tablas ajenas. |
| Sprint 6 | Métricas + circuit breaker por módulo (kill si p99 > 5s). |

## Pre-requisitos no negociables

1. **RLS strict (`docs/RLS-STRICT-PLAN.md`) debe estar en producción** antes de aceptar el primer módulo de terceros. Sin enforcement BD, un módulo malicioso lee tablas de otros módulos.
2. **Suite de regresión completa** del core debe correr automáticamente en cada install (validar que el módulo no rompe core).
3. **ADR pública del esquema de firma**: clave Didacta + rotación + revocación. Sin esto, no hay seguridad operativa.

## Estimación

XL (~3-4 sprints, 4-6 semanas con dedicación). NO arrancar antes de `0.0.1-beta.1`.
