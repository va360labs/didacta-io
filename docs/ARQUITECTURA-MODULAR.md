# LearnShip — Arquitectura modular

> **Versión**: 1.0
> **Fecha**: abril 2026
> **Estado**: Aprobado
> **Documento padre**: `docs/PRD.md`

---

## 1. Objetivo

Este documento define el contrato de módulo de LearnShip. Es el documento más
importante del proyecto después del PRD, porque garantiza que:

- El core se mantiene mínimo y estable.
- Los módulos (presentes y futuros) se construyen de forma independiente.
- Los módulos futuros (migradores Moodle/LearnDash, SSO WordPress, IFAPA, Stripe,
  etc.) se pueden añadir **sin tocar el core** ni otros módulos.
- El desarrollo se puede paralelizar.
- La plataforma puede evolucionar durante años sin deuda estructural.

**Regla de oro**: *si algo no respeta este contrato, no es un módulo de LearnShip*.

## 2. Principios

### 2.1 Core mínimo

El core contiene **solo** lo que necesitan todos los tenants en todo momento:

- Identity & Access Management (IAM).
- Multi-tenancy y aislamiento.
- Registry de módulos.
- Event Bus (outbox).
- Audit Log inmutable.
- Evidence Vault.
- Storage abstraction.
- API Gateway (versionado, auth, rate limiting).
- Notification Hub.
- i18n framework.

**NO pertenecen al core**: cursos, alumnos, certificados, quizzes, comunidad, aula
virtual, cumplimiento normativo, IA, pagos, migradores, SSO terceros. Todo eso son
módulos.

### 2.2 Módulos como ciudadanos de primera clase

Un módulo es un artefacto completo que incluye:

- Código backend (NestJS module).
- Código frontend (componentes React + páginas).
- Migraciones de base de datos propias.
- Tipos compartidos.
- Tests unitarios y de integración.
- Documentación (README, API, ejemplos).
- Manifest (`module.json`).

### 2.3 Contratos estables, implementaciones cambiantes

El contrato de módulo (las interfaces TypeScript definidas en `packages/core-kernel`)
es **SemVer estricto**. Un cambio breaking en el contrato exige:

- ADR aprobada.
- Major version bump del core.
- Período de deprecación documentado.
- Migration guide para todos los módulos existentes.

### 2.4 Independencia operativa

Un módulo se puede:

- **Activar/desactivar** por tenant en caliente (sin redespliegue).
- **Desinstalar** completamente (sus tablas pueden conservarse o archivarse).
- **Versionar** independientemente del core y de otros módulos.
- **Testear** en aislamiento sin bootear otros módulos.
- **Desarrollar** por un equipo separado sin tocar el core.

### 2.5 Comunicación por contrato

Los módulos se comunican entre sí **solo** a través de:

- **Eventos** (event bus del core).
- **Hooks** (puntos de extensión publicados por otros módulos).
- **APIs públicas internas** (NestJS `@Injectable` services exportados).

**Prohibido**: imports cruzados entre módulos de lógica privada, acceso directo a
tablas de otro módulo, dependencias de implementación.

## 3. Estructura de un módulo

### 3.1 Layout de directorio

```
modules/<nombre-modulo>/
├── module.json                  # Manifest
├── package.json                 # Dependencias npm del módulo
├── tsconfig.json
├── README.md                    # Overview, configuración, ejemplos
├── CHANGELOG.md
├── src/
│   ├── backend/
│   │   ├── <modulo>.module.ts   # NestJS DynamicModule
│   │   ├── controllers/         # HTTP controllers
│   │   ├── services/            # Lógica de negocio
│   │   ├── repositories/        # Acceso a DB (Prisma clients)
│   │   ├── events/              # Handlers de eventos entrantes
│   │   ├── webhooks/            # Handlers de webhooks
│   │   ├── jobs/                # Workers BullMQ
│   │   ├── dto/                 # Zod schemas + tipos
│   │   ├── guards/              # Permisos propios
│   │   └── hooks/               # Puntos de extensión
│   ├── frontend/
│   │   ├── pages/               # Páginas Next.js (opcionalmente)
│   │   ├── components/          # Componentes React
│   │   ├── extensions/          # Extensiones a UI del core
│   │   └── hooks/               # React hooks
│   ├── shared/
│   │   ├── types.ts             # Tipos compartidos FE/BE
│   │   └── constants.ts
│   └── prisma/
│       ├── schema.prisma         # Fragmento de schema (concatenado al principal)
│       └── migrations/           # Migraciones propias del módulo
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 3.2 Manifest (`module.json`)

```json
{
  "name": "mod.fundae",
  "displayName": "Cumplimiento Fundae",
  "description": "Módulo de cumplimiento con Fundae, RD 694/2017, Resolución SEPE 2026",
  "version": "1.0.0",
  "author": "VA360 LABS",
  "license": "Proprietary",
  "category": "compliance",
  "coreVersionRequired": "^1.0.0",
  "dependencies": {
    "modules": [
      { "name": "mod.courses", "version": "^1.0.0" },
      { "name": "mod.learning", "version": "^1.0.0" }
    ],
    "optionalModules": [
      { "name": "mod.zoom-live", "version": "^1.0.0" },
      { "name": "mod.certificates", "version": "^1.0.0" }
    ]
  },
  "tablePrefix": "mod_fundae_",
  "permissions": [
    "fundae.company.manage",
    "fundae.group.manage",
    "fundae.audit.read",
    "fundae.export.generate"
  ],
  "roles": [
    {
      "name": "fundae_manager",
      "permissions": ["fundae.company.manage", "fundae.group.manage"]
    }
  ],
  "eventsEmitted": [
    "fundae.company.created",
    "fundae.group.started",
    "fundae.group.finished",
    "fundae.audit-package.generated"
  ],
  "eventsConsumed": [
    "learning.progress.updated",
    "learning.course.completed",
    "certificates.issued",
    "zoom.attendance.recorded"
  ],
  "hooksExposed": [
    "fundae.group.before-start",
    "fundae.cost.calculate"
  ],
  "hooksConsumed": [
    "courses.publish.validate",
    "learning.completion.calculate"
  ],
  "configSchema": {
    "$ref": "./config.schema.json"
  },
  "defaultConfig": {
    "defaultCompletionThreshold": 75,
    "startNoticeMinDaysBefore": 2,
    "retentionYears": 4
  },
  "uiExtensions": [
    {
      "slot": "admin.settings.nav",
      "component": "./src/frontend/extensions/AdminNav.tsx"
    },
    {
      "slot": "course.sidebar",
      "component": "./src/frontend/extensions/CourseSidebar.tsx"
    }
  ],
  "pages": [
    { "path": "/admin/fundae", "component": "./src/frontend/pages/Dashboard.tsx" },
    { "path": "/admin/fundae/companies", "component": "./src/frontend/pages/Companies.tsx" },
    { "path": "/admin/fundae/groups/:id", "component": "./src/frontend/pages/GroupDetail.tsx" }
  ],
  "apiNamespace": "/modules/fundae"
}
```

### 3.3 Interfaz del contrato (TypeScript)

Definido en `packages/core-kernel/src/module.ts`:

```ts
export interface ModuleManifest {
  name: string;
  version: string;
  coreVersionRequired: string;
  dependencies: ModuleDependencies;
  tablePrefix: string;
  permissions: string[];
  roles?: RoleDefinition[];
  eventsEmitted: string[];
  eventsConsumed: string[];
  hooksExposed?: HookDefinition[];
  hooksConsumed?: string[];
  configSchema: JSONSchema;
  defaultConfig: Record<string, unknown>;
  uiExtensions?: UIExtension[];
  pages?: PageDefinition[];
  apiNamespace: string;
}

export interface LearnShipModule {
  manifest: ModuleManifest;

  // Lifecycle
  onRegister(ctx: ModuleContext): Promise<void>;
  onEnable(tenantId: string, ctx: ModuleContext): Promise<void>;
  onDisable(tenantId: string, ctx: ModuleContext): Promise<void>;
  onUninstall(tenantId: string, ctx: ModuleContext): Promise<void>;

  // Module instance
  getNestModule(): DynamicModule;
}

export interface ModuleContext {
  prisma: PrismaClient;
  eventBus: EventBus;
  hookRegistry: HookRegistry;
  storage: StorageService;
  auditLog: AuditLogService;
  evidenceVault: EvidenceVaultService;
  notificationHub: NotificationHubService;
  i18n: I18nService;
  logger: Logger;
  config: TenantConfigService;
}
```

## 4. Reglas de diseño para módulos

### 4.1 Base de datos

| Regla | Implementación |
|---|---|
| **Prefijo obligatorio** | Todas las tablas llevan `mod_<nombre>_*`, ej: `mod_fundae_company` |
| **tenant_id obligatorio** | Toda tabla tiene `tenant_id UUID NOT NULL` y política RLS |
| **No FK cross-module** | Un módulo NO puede tener FK a tablas de otro módulo. Usa `<modulo>_id` lógico sin FK |
| **Migraciones propias** | Cada módulo gestiona sus migraciones; el core las compone |
| **Soft delete preferido** | `deleted_at` timestamp en lugar de borrado físico |
| **Created/updated timestamps** | Todas las tablas `created_at`, `updated_at`, `created_by`, `updated_by` |

### 4.2 API

| Regla | Implementación |
|---|---|
| **Namespace propio** | `/api/v1/modules/<nombre>/*` |
| **Versionado SemVer** | Breaking changes exigen major version |
| **OpenAPI obligatorio** | Cada endpoint documentado con `@ApiOperation`, ejemplos |
| **Validación Zod** | Todo payload entrante validado con Zod antes de lógica |
| **Permisos explícitos** | Cada endpoint declara qué permisos exige con decorator |
| **Rate limiting** | Endpoints costosos (IA, exports) con límites específicos |
| **Errores tipados** | Clases de excepción tipadas con código y i18n key |

### 4.3 Eventos

| Regla | Implementación |
|---|---|
| **Nombre jerárquico** | `<modulo>.<recurso>.<acción>`, ej: `fundae.group.started` |
| **Payload versionado** | `{ version: 1, data: {...}, metadata: {...} }` |
| **Metadata obligatoria** | `{ tenant_id, user_id, timestamp, trace_id, idempotency_key }` |
| **Idempotencia garantizada** | Los handlers deben ser idempotentes |
| **Documentación viva** | Catálogo de eventos auto-generado en `/api/docs/events` |
| **Outbox pattern** | Evento se persiste en `outbox_events` antes de publicar |

### 4.4 Frontend

| Regla | Implementación |
|---|---|
| **Sin acoplamiento a otros módulos** | Componentes consumen core + props, nunca imports de otro módulo |
| **Puntos de extensión** | Extensiones a UI del core via slots declarados (tipo plugin) |
| **Tailwind + shadcn obligatorio** | Consistencia visual garantizada |
| **i18n** | Todos los strings via `useTranslations()` |
| **Accesibilidad** | ARIA labels, keyboard nav, WCAG 2.1 AA |
| **RSC preferido** | Server Components por defecto; `"use client"` solo donde necesario |

### 4.5 Tests

| Regla | Implementación |
|---|---|
| **Coverage mínimo 70%** | Lógica de negocio en services y handlers |
| **Tests de contrato** | Suite que verifica que el módulo cumple el contrato |
| **Tests aislados** | Módulo testeable sin levantar otros módulos |
| **Fixtures propias** | Cada módulo tiene sus seeds de testing |
| **E2E para flujos críticos** | Playwright, mínimo 3-5 escenarios por módulo |

## 5. Puntos de extensión (hooks)

Los hooks son **el mecanismo primario** para que un módulo modifique el comportamiento
de otro sin acoplarse. Ejemplo:

```ts
// En mod.courses, antes de publicar un curso, se ejecutan todos los hooks registrados
// en 'courses.publish.validate'. Cada hook puede añadir validaciones.

await hookRegistry.run('courses.publish.validate', {
  course,
  tenantId,
});

// Si mod.fundae está activo, registra un hook que valida que el curso
// tenga objetivos, contenidos y duración antes de permitir publicación.
```

### 5.1 Catálogo inicial de hooks

| Hook | Emitido por | Propósito |
|---|---|---|
| `courses.publish.validate` | `mod.courses` | Validación extra al publicar curso |
| `learning.completion.calculate` | `mod.learning` | Customizar cálculo de finalización |
| `certificates.issue.before` | `mod.certificates` | Pre-validaciones antes de emitir certificado |
| `fundae.group.before-start` | `mod.fundae` | Validaciones antes de iniciar grupo bonificable |
| `user.login.after` | Core | Acciones tras login (analítica, riesgo, etc.) |
| `tenant.module.enabled` | Core | Acciones al activar un módulo en un tenant |

El registro de hooks es dinámico: cualquier módulo puede declarar que expone o consume
hooks en su manifest, y el core los resuelve en tiempo de arranque.

## 6. Ciclo de vida de un módulo

### 6.1 Registration (al arrancar la plataforma)

1. Core escanea `modules/*/module.json`.
2. Valida contra el schema de manifest.
3. Resuelve dependencias (grafo topológico).
4. Carga el NestJS DynamicModule.
5. Llama a `module.onRegister()`.
6. Registra permisos, hooks expuestos, handlers de eventos, páginas.

### 6.2 Enablement (cuando un tenant activa el módulo)

1. Tenant-admin (o super-admin) activa módulo en panel.
2. Core llama a `module.onEnable(tenantId)`.
3. Se aplican migraciones del módulo si no estaban aplicadas (solo la primera vez).
4. Se crea configuración inicial del módulo para ese tenant.
5. Se inicializan datos seed si aplica.
6. Se emite evento `tenant.module.enabled`.

### 6.3 Runtime

- El módulo responde a requests en su namespace API.
- Consume y emite eventos normalmente.
- Respeta `tenant_id` en todas las operaciones.
- Registra en audit log acciones críticas.

### 6.4 Disablement

1. Tenant desactiva el módulo.
2. Core llama a `module.onDisable(tenantId)`.
3. Endpoints del módulo devuelven 404 para ese tenant.
4. Jobs en cola son cancelados o pausados.
5. Datos se conservan (no se borran).
6. Se emite evento `tenant.module.disabled`.

### 6.5 Uninstall

1. Super-admin fuerza desinstalación (raro).
2. Core llama a `module.onUninstall(tenantId)`.
3. Módulo debe exportar/archivar datos propios.
4. Datos del módulo se archivan (no se borran por defecto, política configurable).
5. Se emite evento `tenant.module.uninstalled`.

## 7. Ejemplos prácticos

### 7.1 Cómo se añadiría el módulo "Migrador Moodle" en Fase 2

Sin tocar el core ni ningún otro módulo, el developer:

1. Crea `modules/migrator-moodle/`.
2. Escribe `module.json` declarando que depende de `mod.courses`, `mod.learning`, `mod.assessments`.
3. Escribe lógica de conexión a Moodle API / export SQL.
4. Expone endpoint `POST /api/v1/modules/migrator-moodle/import` que acepta credenciales Moodle.
5. Por cada curso Moodle, llama a la API pública de `mod.courses` para crear curso.
6. Por cada alumno, usa `mod.learning` para matricular.
7. Por cada intento de quiz, usa `mod.assessments` para registrar.
8. Todo vía API HTTP interna, sin imports directos.

El core ni `mod.courses` se enteran. Si mañana se cambia la API de `mod.courses`,
el migrador se adapta (o se versiona).

### 7.2 Cómo se añadiría el módulo "SSO WordPress"

1. Crear `modules/sso-wordpress/`.
2. Manifest declara dependencia del core (no requiere otros módulos).
3. Expone endpoint `/api/v1/modules/sso-wordpress/callback` para recibir tokens de WordPress.
4. Escucha evento `user.login.after` para propagar sesión a WordPress si configurado.
5. Provee componente UI "Login con WordPress" que se registra en slot `auth.login.providers`.
6. Al activar, tenant configura URL de WordPress, client ID, secret.
7. Core IAM acepta este proveedor igual que cualquier otro OIDC.

### 7.3 Cómo se añadiría el módulo "Stripe Checkout"

1. Crear `modules/stripe/`.
2. Declara dependencia opcional en `mod.courses` (para vincular productos a cursos).
3. Escucha evento `stripe.checkout.session.completed` (webhook de Stripe).
4. Emite evento `learning.enrollment.created` llamando a API de `mod.learning`.
5. El módulo `mod.learning` no sabe que la matriculación viene de Stripe — solo recibe una
   llamada a su API interna con `source: 'stripe'` en metadata.

## 8. Anti-patrones (prohibidos)

| Anti-patrón | Por qué está mal |
|---|---|
| Import directo de código de otro módulo | Rompe la independencia, crea acoplamientos |
| Lectura directa de tablas de otro módulo vía Prisma | Salta los permisos y la API pública |
| Modificar el core para añadir features de un módulo | El core debe permanecer estable |
| Eventos emitidos sin declararlos en el manifest | Impide auditoría y documentación |
| FK entre tablas de módulos distintos | Acoplamiento a nivel de DB |
| Módulos que no respetan `tenant_id` | Rompe multi-tenancy, riesgo de data leak |
| Lógica de negocio en controllers | Dificulta tests y reutilización |
| Estado global compartido entre módulos | Rompe aislamiento |

## 9. Checklist de revisión de módulos

Antes de merger un módulo nuevo:

- [ ] Manifest `module.json` válido y completo.
- [ ] Todas las tablas tienen prefijo `mod_<nombre>_`.
- [ ] Todas las tablas tienen `tenant_id` y política RLS.
- [ ] No hay imports de otros módulos.
- [ ] No hay FKs a otros módulos.
- [ ] Endpoints bajo `/api/v1/modules/<nombre>/*`.
- [ ] Todos los endpoints tienen OpenAPI.
- [ ] Todos los payloads validados con Zod.
- [ ] Todos los eventos emitidos declarados en manifest.
- [ ] Todos los eventos consumidos declarados en manifest.
- [ ] Tests unitarios >70% coverage en lógica de negocio.
- [ ] Al menos 1 test e2e del flujo principal.
- [ ] README actualizado con overview, config, ejemplos.
- [ ] CHANGELOG actualizado.
- [ ] ADR escrita si hay decisión arquitectónica no trivial.
- [ ] i18n: strings en ES y EN.
- [ ] Accesibilidad: revisión WCAG 2.1 AA de nuevos componentes UI.
- [ ] Lifecycle hooks (`onEnable`, `onDisable`) implementados y testeados.

---

**FIN ARQUITECTURA-MODULAR v1.0**
