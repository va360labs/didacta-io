# LearnShip — Product Requirements Document (PRD)

> **Versión**: 2.0
> **Fecha**: abril 2026
> **Propietario**: Valentín Ayesa — VA360 LABS S.L.
> **Estado**: Aprobado para ejecución
> **Sustituye a**: `deep-research-report.md` (v1.0)

---

## 0. Historial de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 2026-04 | Deep research inicial sobre cumplimiento Fundae/IFAPA |
| 2.0 | 2026-04 | Reescritura completa: arquitectura modular extrema, estrategia dogfooding+SaaS, stack cerrado, plan de fases ejecutable |

---

## 1. Resumen ejecutivo

**LearnShip** es una plataforma LMS (Learning Management System) modular, moderna y
extensible, propiedad de **VA360 LABS S.L.**, diseñada con dos objetivos consecutivos:

1. **Dogfooding**: reemplazar el stack actual de VA360 (LearnDash + FluentCommunity +
   Zoom externo + n8n externo) para cursos propios de VA360.academy y PotenzIA.
2. **Comercialización**: evolucionar a producto SaaS multi-tenant vendible a empresas,
   academias y centros de formación terceros.

El principio rector del producto es **modularidad extrema**: el núcleo es mínimo y todo
lo demás son **módulos activables** con contratos estables. Esta arquitectura permite:

- Construir el MVP con un subconjunto pequeño de módulos.
- Añadir módulos futuros (migradores desde Moodle/LearnDash, SSO WordPress, integración
  Stripe, módulo IFAPA, conectores ERP, etc.) sin tocar el core.
- Activar/desactivar módulos por tenant en función de su plan o caso de uso.
- Permitir a terceros desarrollar módulos externos en el futuro (plugin ecosystem).

El cumplimiento **Fundae/IFAPA** es un **módulo activable**, no el centro del producto.
La propuesta de valor diferencial frente a LearnDash, Moodle o TalentLMS son:

- Arquitectura moderna (TypeScript end-to-end, Next.js, NestJS, Postgres).
- **IA nativa integrada** en cada nivel del producto (tutor, corrección, generación,
  analítica predictiva).
- Integración first-class con **n8n** para automatizaciones.
- Modularidad extrema con API pública versionada desde el día 1.
- Experiencia de producto moderna (móvil-first, accesible, multi-idioma).

## 2. Objetivos y no-objetivos

### 2.1 Objetivos (in scope)

- Plataforma LMS multi-tenant con row-level security en Postgres.
- Módulos core: identidad, cursos asíncronos, aula virtual síncrona, comunidad,
  evaluaciones, certificados, evidence vault, reporting.
- Módulo IA: tutor, corrector, generador de contenido, analítica de abandono.
- Módulo Fundae: cumplimiento normativo activable (Ley 30/2015, RD 694/2017,
  RD 1189/2025, resolución SEPE 2026).
- API REST pública versionada con OpenAPI.
- Webhooks y eventos para integración externa (n8n principal).
- Panel de administración por tenant y super-admin global.
- Experiencia de alumno web responsive.

### 2.2 No-objetivos explícitos (out of scope en Fase 1)

- Módulo IFAPA sectorial (se documentan requisitos, se implementa en Fase 2+).
- Migradores desde Moodle y LearnDash (Fase 2+).
- SSO con WordPress, Google Workspace, Azure AD, SAML (Fase 2+).
- Checkout propio, pasarelas de pago, facturación (Fase 2+).
- App móvil nativa (Fase 3+).
- Autoría de contenido in-app estilo Notion (Fase 3+, inicialmente import SCORM/HTML).
- Marketplace público de cursos entre tenants (Fase 3+).
- Whitelabel completo con dominio personalizado (Fase 2+).

## 3. Usuarios y roles

### 3.1 Roles del sistema

| Rol | Scope | Responsabilidades |
|---|---|---|
| `super_admin` | Global (toda la plataforma) | Gestión de tenants, configuración global, módulos activables, monitorización |
| `tenant_admin` | Tenant | Gestión de usuarios, formadores, cursos, configuración del tenant |
| `formador` | Tenant | Creación/gestión de cursos asignados, impartición, evaluación de alumnos |
| `alumno` | Tenant | Consumo de cursos, participación en aula virtual y comunidad |
| `auditor` | Tenant + acceso restringido | Acceso de solo lectura a expedientes, evidencias y logs (auditoría Fundae/IFAPA) |
| `empresa_manager` | Tenant + scope de empresa | Gestor de RRHH de una empresa bonificada, ve progreso de sus empleados |

### 3.2 Personas

**Valen (super_admin — VA360 LABS)**: configura la plataforma, habilita módulos,
monitoriza. Requiere panel global, métricas de uso, gestión de tenants.

**Macarena (tenant_admin — VA360.academy)**: gestiona el catálogo de cursos de
VA360, invita formadores, crea grupos, gestiona alumnos, genera informes.

**Jesús (formador — PotenzIA)**: crea contenido de su curso, imparte aula virtual,
corrige ejercicios (con ayuda de IA), ve analítica de sus cursos.

**María (alumna de PotenzIA)**: consume cursos asíncronos, asiste a aula virtual,
participa en comunidad, descarga certificados.

**Carlos (empresa_manager — Adidas)**: ve el progreso de los 50 empleados de su
empresa inscritos en cursos, descarga certificados en lote, cierra expedientes
Fundae.

**Rosa (auditora SEPE/Fundae)**: accede al expediente completo de un grupo bonificado,
descarga paquete de auditoría, verifica evidencias.

## 4. Arquitectura del producto

### 4.1 Principios arquitectónicos

| Principio | Implementación |
|---|---|
| **Modularidad extrema** | Core mínimo + módulos activables con contratos estables |
| **Monolito modular** | Una sola aplicación desplegable, módulos separados por bounded contexts |
| **API-first** | Toda funcionalidad expuesta vía API versionada desde día 1 |
| **Event-driven** | Outbox pattern para eventos de dominio, integración con n8n |
| **Multi-tenant nativo** | Row-level security en Postgres, `tenant_id` en todas las tablas |
| **Observable por defecto** | Logs estructurados, trazas OpenTelemetry, métricas |
| **Cumplimiento como módulo** | Fundae/IFAPA son módulos activables, no el core |
| **Evidencia por diseño** | Audit log inmutable + evidence vault hasheado desde el día 1 |
| **IA como módulo** | La IA es un módulo activable, no está embebida en todas partes |

### 4.2 Arquitectura de alto nivel

```
┌─────────────────────────────────────────────────────────────┐
│                    LearnShip Platform                        │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   CORE (obligatorio)                  │  │
│  │  - Identity & Access (IAM)                            │  │
│  │  - Multi-tenancy                                      │  │
│  │  - Módulo Registry (activación/desactivación)         │  │
│  │  - Event Bus (outbox pattern)                         │  │
│  │  - Audit Log inmutable                                │  │
│  │  - Evidence Vault                                     │  │
│  │  - API Gateway + versionado                           │  │
│  │  - Webhooks & integraciones                           │  │
│  │  - Storage abstraction (S3-compatible)                │  │
│  │  - Notification hub                                   │  │
│  │  - i18n framework                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │  Módulos   │  │  Módulos   │  │  Módulos   │             │
│  │    Core    │  │  Activables│  │  Futuros   │             │
│  │  (Fase 1)  │  │  (Fase 1)  │  │  (Fase 2+) │             │
│  ├────────────┤  ├────────────┤  ├────────────┤             │
│  │ • Cursos   │  │ • Fundae   │  │ • IFAPA    │             │
│  │ • Learning │  │ • IA       │  │ • Migrador │             │
│  │ • Quiz     │  │ • Comuni.  │  │   Moodle   │             │
│  │ • Certif.  │  │ • Zoom     │  │ • Migrador │             │
│  │ • Admin    │  │            │  │   LrnDash  │             │
│  │            │  │            │  │ • SSO WP   │             │
│  │            │  │            │  │ • SSO SAML │             │
│  │            │  │            │  │ • Stripe   │             │
│  │            │  │            │  │ • Checkout │             │
│  │            │  │            │  │ • White-   │             │
│  │            │  │            │  │   label    │             │
│  └────────────┘  └────────────┘  └────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 Contrato de módulo

Todo módulo (tanto los de Fase 1 como los futuros) debe cumplir un contrato único que
garantice la modularidad real. El contrato está en `docs/ARQUITECTURA-MODULAR.md` pero
los puntos clave son:

1. **Manifest (`module.json`)**: declara nombre, versión, dependencias, hooks expuestos
   y hooks consumidos.
2. **Migraciones propias**: cada módulo gestiona su propio esquema de DB con prefijo
   (ej. `mod_fundae_*`).
3. **Endpoints API propios**: bajo namespace propio (`/api/v1/modules/fundae/*`).
4. **Eventos emitidos y consumidos**: declarados en el manifest.
5. **Permisos y roles añadibles**: cada módulo puede registrar sus permisos.
6. **UI pluggable**: componentes React exportados en puntos de extensión definidos
   (navigation, course detail sidebar, admin settings, etc.).
7. **Activación por tenant**: configuración en BD, sin redespliegue.
8. **Tests aislados**: el módulo se testea de forma independiente del core.

Esta disciplina es la que permitirá que, en Fase 2, el módulo "Migrador Moodle" se
pueda desarrollar completamente en paralelo sin interferir con el core ni con otros
módulos.

## 5. Módulos del producto

### 5.1 Core (obligatorio, no desactivable)

| Componente | Descripción |
|---|---|
| **IAM** | Usuarios, roles, permisos granulares, sesiones, MFA |
| **Multi-tenancy** | Gestión de tenants, aislamiento RLS, configuración por tenant |
| **Module Registry** | Activación/desactivación de módulos por tenant |
| **Event Bus** | Outbox pattern, cola interna, webhooks externos |
| **Audit Log** | Registro inmutable de todas las acciones críticas |
| **Evidence Vault** | Almacenamiento hasheado con SHA-256, sellado temporal |
| **Storage** | Abstracción sobre S3-compatible (MinIO dev, Hetzner prod) |
| **Notification Hub** | Email, in-app, webhooks; templates por tenant |
| **API Gateway** | Versionado, rate limiting, autenticación, OpenAPI |
| **i18n** | Soporte multi-idioma (es, en por defecto) |

### 5.2 Módulos Fase 1 (MVP dogfooding + comercial)

| Módulo | Fase | Activable | Descripción |
|---|---|---|---|
| `mod.courses` | 1.A | Sí (default ON) | Gestión de cursos, módulos, lecciones, catálogo |
| `mod.learning` | 1.A | Sí (default ON) | Player, progreso, reanudación, SCORM/xAPI |
| `mod.assessments` | 1.A | Sí (default ON) | Quizzes, exámenes, rúbricas |
| `mod.certificates` | 1.A | Sí (default ON) | Plantillas, emisión PDF, numeración |
| `mod.zoom-live` | 1.B | Sí | Integración Zoom: sesiones, evidencia, grabación |
| `mod.community` | 1.B | Sí | Espacios, feeds, posts, comentarios, reacciones |
| `mod.fundae` | 1.B | Sí | Expediente regulatorio, RLPT, costes, exportes |
| `mod.ai-tutor` | 1.C | Sí | Tutor conversacional por curso con RAG |
| `mod.ai-grader` | 1.C | Sí | Corrector de respuestas abiertas con rúbrica |
| `mod.ai-content` | 1.C | Sí | Generación de resúmenes, flashcards, quizzes |
| `mod.ai-analytics` | 1.C | Sí | Detección de abandono, predicciones |
| `mod.n8n-bridge` | 1.C | Sí | Webhooks outgoing + nodos n8n dedicados |

### 5.3 Módulos Fase 2+ (post-MVP, roadmap)

| Módulo | Prioridad | Descripción |
|---|---|---|
| `mod.migrator-moodle` | P1 | Importar cursos, usuarios, progreso desde Moodle |
| `mod.migrator-learndash` | P1 | Importar desde WordPress + LearnDash |
| `mod.sso-wordpress` | P1 | SSO bidireccional con WordPress (para VA360.academy) |
| `mod.sso-saml` | P2 | SSO empresarial SAML 2.0 |
| `mod.sso-oidc` | P2 | OIDC genérico (Google Workspace, Azure AD, Okta) |
| `mod.ifapa` | P2 | Cumplimiento sectorial IFAPA (SIENA, guía, foros, tests) |
| `mod.stripe` | P2 | Integración Stripe para pagos |
| `mod.checkout` | P2 | Landing de curso + carrito + checkout |
| `mod.subscriptions` | P2 | Suscripciones recurrentes a catálogos |
| `mod.facturascripts` | P2 | Integración con FacturaScripts (tu stack actual) |
| `mod.whitelabel` | P3 | Dominio personalizado, branding completo por tenant |
| `mod.marketplace` | P3 | Cursos ofrecidos entre tenants |
| `mod.mobile-api` | P3 | API optimizada para app móvil |
| `mod.affiliate` | P3 | Programa de afiliados |
| `mod.gamification` | P3 | Puntos, badges, leaderboards |
| `mod.webinars` | P3 | Webinars públicos con registro |
| `mod.scorm-authoring` | P3 | Autoría visual de contenido SCORM |
| `mod.live-streaming-native` | P3 | Alternativa self-hosted a Zoom (LiveKit) |

### 5.4 Matriz módulo × fase

| Módulo | Fase 0 | Fase 1.A | Fase 1.B | Fase 1.C | Fase 2+ |
|---|---|---|---|---|---|
| Core | ■ | ■ | ■ | ■ | ■ |
| Courses | | ■ | ■ | ■ | ■ |
| Learning | | ■ | ■ | ■ | ■ |
| Assessments | | ■ | ■ | ■ | ■ |
| Certificates | | ■ | ■ | ■ | ■ |
| Zoom Live | | | ■ | ■ | ■ |
| Community | | | ■ | ■ | ■ |
| Fundae | | | ■ | ■ | ■ |
| AI (4 módulos) | | | | ■ | ■ |
| n8n-bridge | | | | ■ | ■ |
| Migradores | | | | | ■ |
| SSO (3 módulos) | | | | | ■ |
| IFAPA | | | | | ■ |
| Comercial (5 módulos) | | | | | ■ |

## 6. Stack tecnológico cerrado

### 6.1 Decisiones técnicas firmes

| Capa | Tecnología | Justificación |
|---|---|---|
| **Backend** | Node.js 22 + NestJS 11 | Arquitectura modular nativa, DI, decorators, tipado fuerte |
| **Lenguaje** | TypeScript 5.x estricto | Tipos compartidos end-to-end |
| **Frontend** | Next.js 15 (App Router) + React 19 | SSR/SSG, RSC, SEO, ecosistema |
| **UI** | Tailwind CSS 4 + shadcn/ui + Radix | Componentes accesibles, consistencia |
| **Base de datos** | PostgreSQL 16 | Robustez, RLS nativo, JSONB, pgvector |
| **ORM** | Prisma 5 | Schema único, migraciones, tipos generados |
| **Multi-tenancy** | Row-Level Security (RLS) + `tenant_id` | Simplicidad, suficiente para miles de tenants |
| **Cache + colas** | Redis 7 + BullMQ | Jobs, rate limit, session store |
| **Object storage** | S3-compatible (MinIO dev, Hetzner prod) | Evidence vault, vídeos, documentos |
| **Auth** | Better-Auth o Auth.js v5 | MFA, OIDC, providers multi |
| **Aula virtual** | Zoom API + SDK Web | Pragmático, ya conectado vía MCP |
| **Player async** | Video.js + scorm-again | SCORM 1.2/2004 + xAPI, open source |
| **IA** | Anthropic API (Claude Sonnet 4.5) + pgvector | Coherente con PotenzIA |
| **Automatización** | n8n (ya desplegado) via webhooks + API | Reutilizar infra |
| **Email** | Brevo vía SMTP + templates | Ya configurado |
| **Hosting** | Hetzner + Easypanel | Stack actual, autohospedado |
| **CI/CD** | GitHub Actions | Estándar |
| **Monorepo** | Turborepo + pnpm workspaces | Builds rápidos, cache inteligente |
| **Testing** | Vitest + Playwright + Supertest | Moderno, rápido |
| **Observabilidad** | OpenTelemetry + Grafana/Loki o Sentry | Trazas, logs, métricas |
| **Logs estructurados** | Pino | Estándar Node, rápido |
| **Validación** | Zod | Validación runtime + tipos |
| **API docs** | OpenAPI 3.1 via NestJS Swagger | Auto-generada |

### 6.2 Estructura del monorepo

```
learnship/
├── apps/
│   ├── api/              # NestJS backend principal
│   ├── web/              # Next.js frontend (app de alumno + admin de tenant)
│   ├── super-admin/      # Next.js panel super_admin (separado)
│   ├── marketing/        # Next.js sitio marketing (Fase 2)
│   └── workers/          # Workers BullMQ
├── packages/
│   ├── database/         # Prisma schema, migraciones, seeds
│   ├── types/            # Tipos compartidos
│   ├── ui/               # Componentes shadcn compartidos
│   ├── sdk/              # Cliente API generado desde OpenAPI
│   ├── core-kernel/      # Contratos de módulo, registry, event bus
│   ├── core-iam/         # IAM core
│   ├── core-tenancy/     # Multi-tenancy
│   ├── core-audit/       # Audit log
│   ├── core-evidence/    # Evidence vault
│   └── shared/           # Utils compartidos
├── modules/
│   ├── courses/          # mod.courses
│   ├── learning/         # mod.learning
│   ├── assessments/      # mod.assessments
│   ├── certificates/     # mod.certificates
│   ├── zoom-live/        # mod.zoom-live
│   ├── community/        # mod.community
│   ├── fundae/           # mod.fundae
│   ├── ai-tutor/         # mod.ai-tutor
│   ├── ai-grader/        # mod.ai-grader
│   ├── ai-content/       # mod.ai-content
│   ├── ai-analytics/     # mod.ai-analytics
│   └── n8n-bridge/       # mod.n8n-bridge
├── docs/
│   ├── PRD.md
│   ├── PLAN-FASES.md
│   ├── ARQUITECTURA-MODULAR.md
│   ├── casos-uso/
│   ├── tareas/
│   ├── adrs/             # Architecture Decision Records
│   └── api/              # Docs de API (auto-generadas + manuales)
├── infra/
│   ├── docker/
│   ├── easypanel/
│   └── github-actions/
├── .github/
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

La decisión de separar `packages/` de `modules/` no es cosmética: refleja la separación
entre **core platform** (que no se puede desactivar) y **módulos de negocio** (que sí).

## 7. Requisitos funcionales por módulo

La especificación funcional completa (requisitos FR-NNN por módulo) se desarrolla en
los documentos de casos de uso (`docs/casos-uso/*`). Aquí solo el resumen de alto nivel.

### 7.1 Core

- FR-CORE-01 — Gestión de tenants: alta, baja, configuración, activación de módulos.
- FR-CORE-02 — IAM: usuarios, roles, MFA obligatorio para `super_admin` y `tenant_admin`.
- FR-CORE-03 — Row-Level Security en todas las tablas con `tenant_id`.
- FR-CORE-04 — Module Registry: activar/desactivar módulos por tenant en BD.
- FR-CORE-05 — Event Bus con outbox pattern y webhooks outgoing.
- FR-CORE-06 — Audit Log inmutable con append-only, hashing encadenado opcional.
- FR-CORE-07 — Evidence Vault: almacenamiento + hash SHA-256 + metadatos.
- FR-CORE-08 — API versionada con OpenAPI auto-generada.
- FR-CORE-09 — Storage abstraction sobre S3-compatible.
- FR-CORE-10 — Notification Hub con templates por tenant.
- FR-CORE-11 — i18n con ES/EN desde el día 1.

### 7.2 Módulos Fase 1

Ver documentos de casos de uso específicos:

- `docs/casos-uso/fase-1a-core-learning.md`
- `docs/casos-uso/fase-1b-directo-comunidad-fundae.md`
- `docs/casos-uso/fase-1c-ia-piloto.md`

## 8. Requisitos no funcionales

### 8.1 Rendimiento

| Métrica | Objetivo |
|---|---|
| Latencia API p95 | < 300ms |
| Latencia API p99 | < 800ms |
| TTFB web (cursos asíncronos) | < 800ms |
| Concurrencia por tenant | 500 alumnos simultáneos mínimo |
| Concurrencia total plataforma | 10.000 usuarios simultáneos objetivo Fase 2 |
| Tamaño máximo archivo upload | 2 GB (vídeos); 50 MB (documentos) |

### 8.2 Disponibilidad

| Métrica | Objetivo |
|---|---|
| SLA objetivo | 99,5% (Fase 1), 99,9% (Fase 2) |
| RTO (recovery time objective) | < 4h |
| RPO (recovery point objective) | < 1h |
| Backups | Diarios automáticos, retención 30 días; snapshot semanal retención 12 meses |

### 8.3 Seguridad

- Cifrado en tránsito: TLS 1.3 mínimo.
- Cifrado en reposo: AES-256 en PostgreSQL y S3.
- MFA obligatorio para `super_admin` y `tenant_admin`.
- Contraseñas: bcrypt con cost ≥ 12 o argon2id preferido.
- Rate limiting por IP y por usuario autenticado.
- CORS estricto, CSP headers, HSTS.
- Secrets gestionados via variables de entorno y/o vault externo (Fase 2).
- Pentest anual (Fase 2), análisis de vulnerabilidades continuo (Fase 1.C).

### 8.4 Cumplimiento

- **RGPD / LOPDGDD**: privacidad desde el diseño; RAT, base jurídica documentada,
  gestión de consentimientos, derechos ARSULIPO (acceso, rectificación, supresión,
  limitación, portabilidad, oposición), gestión de brechas.
- **Módulo Fundae**: Ley 30/2015, RD 694/2017, RD 1189/2025, Resolución SEPE 2026.
- **ENS (Esquema Nacional de Seguridad)**: preparación para nivel medio en Fase 2
  si hay contrato con administración pública.
- **Residencia de datos**: UE/EEE por defecto (Hetzner DE + Backups DE).

### 8.5 Accesibilidad

- WCAG 2.1 nivel AA objetivo.
- Contraste de colores adecuado, navegación por teclado, ARIA labels, screen reader
  friendly.
- Responsive desde 320px.
- Soporte para subtítulos en vídeos (Fase 1.B).

### 8.6 Internacionalización

- ES (España) por defecto.
- EN desde el día 1.
- Arquitectura i18n preparada para añadir idiomas sin refactor.
- Formatos de fecha, número y moneda por locale.

## 9. Modelo de datos de alto nivel

El esquema completo se genera en `packages/database/prisma/schema.prisma`. Aquí solo los
agregados principales:

### 9.1 Core

- `Tenant` (id, name, slug, config, active_modules[], created_at, ...)
- `User` (id, tenant_id, email, name, password_hash, mfa_secret, roles[], ...)
- `Role`, `Permission` (roles y permisos extensibles por módulos)
- `Session`, `ApiKey`
- `Module` (name, version, enabled_by_default) + `TenantModule` (tenant_id, module_id, enabled, config)
- `AuditLog` (id, tenant_id, actor_id, action, resource_type, resource_id, metadata, ip, user_agent, timestamp, prev_hash, hash)
- `EvidenceVaultEntry` (id, tenant_id, resource_type, resource_id, hash, size, storage_key, metadata, created_at)
- `OutboxEvent` (id, tenant_id, event_type, payload, processed, ...)
- `Webhook` (tenant_id, url, events[], secret, enabled)
- `NotificationTemplate` (tenant_id, key, channel, locale, subject, body)

### 9.2 Módulos (prefijo `mod_`)

Cada módulo tiene sus propias tablas prefijadas. Ejemplos:

- `mod_courses_course`, `mod_courses_module`, `mod_courses_lesson`
- `mod_learning_enrollment`, `mod_learning_progress`, `mod_learning_session`
- `mod_assessments_quiz`, `mod_assessments_question`, `mod_assessments_attempt`
- `mod_certificates_template`, `mod_certificates_issued`
- `mod_zoom_meeting`, `mod_zoom_attendance`
- `mod_community_space`, `mod_community_post`, `mod_community_comment`, `mod_community_reaction`
- `mod_fundae_company`, `mod_fundae_rlpt_notice`, `mod_fundae_training_action`, `mod_fundae_group`, `mod_fundae_cost`
- `mod_ai_tutor_conversation`, `mod_ai_tutor_message`, `mod_ai_embeddings`

Esta separación por prefijo permite que al desactivar un módulo sus tablas sigan
existiendo (no se destruye data) pero no sean accesibles vía API.

## 10. Flujos principales

### 10.1 Flujo del alumno asíncrono

1. Alumno recibe invitación por email.
2. Se registra / hace login.
3. Ve el catálogo y/o es matriculado directamente por admin.
4. Accede al curso: ve módulos y lecciones.
5. Consume lecciones (vídeo, HTML, PDF, quiz).
6. Sistema registra progreso, tiempo, interacciones (evento `learning.progress.updated`).
7. Al superar el umbral de finalización (por defecto 75%), sistema emite certificado.
8. Alumno descarga certificado.
9. Sistema registra todo en audit log y evidence vault.

### 10.2 Flujo del grupo Fundae bonificable

1. Admin crea empresa bonificada en módulo Fundae.
2. Configura RLPT (si aplica) y guarda evidencia.
3. Crea acción formativa y grupo.
4. Asigna alumnos (empleados de la empresa).
5. Genera comunicación de inicio (export).
6. Se imparte el curso (asíncrono, síncrono o mixto).
7. Sistema registra evidencias de asistencia/actividad.
8. Alumnos completan (umbral 75%) y reciben certificado.
9. Admin cierra grupo, registra costes.
10. Genera comunicación de finalización (export).
11. Descarga paquete de auditoría ZIP firmado.

### 10.3 Flujo del tutor IA

1. Alumno abre un curso con `mod.ai-tutor` activado.
2. Sistema ya ha indexado el contenido del curso en pgvector (background job al publicar).
3. Alumno hace pregunta en el chat del tutor.
4. Sistema hace RAG: recupera chunks relevantes, los pasa a Claude vía Anthropic API.
5. Devuelve respuesta con citas a las lecciones del curso.
6. Conversación se guarda para contexto del alumno.

## 11. APIs y contratos

- **API REST pública**: `/api/v1/*`, versionada, documentada con OpenAPI.
- **Webhooks outgoing**: eventos suscribibles por tenant (`learning.*`, `community.*`,
  `fundae.*`, etc.).
- **SDK TypeScript**: auto-generado desde OpenAPI, publicable en npm.
- **Integración n8n**: módulo `mod.n8n-bridge` expone webhooks con firma HMAC y
  opcionalmente nodos n8n dedicados en Fase 1.C.
- **No se expone API externa oficial a Fundae/SEPE** (no existe): export-first.

## 12. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Alcance excesivo Fase 1 | Alto | División en 3 sub-fases de 8 semanas; dogfooding real en cada una |
| Dependencia de Zoom | Medio | Abstracción detrás de interfaz `LiveSessionProvider`; sustituible por LiveKit en Fase 3 |
| Cumplimiento Fundae mal interpretado | Alto | Validación legal externa en Fase 1.B antes de abrir piloto bonificable |
| Rendimiento de RLS con miles de tenants | Medio | Benchmark en Fase 0; considerar particionado futuro |
| Coste de Anthropic API en escala | Medio | Cache de respuestas tutor IA, límites por plan, tokens tracking |
| Complejidad del evidence vault | Medio | Hashing simple SHA-256 en Fase 1; sellado temporal avanzado en Fase 2 |
| Módulos futuros incompatibles con el core | Alto | Contrato de módulo blindado desde Fase 0; tests de contrato |
| Migradores rompen al cambiar core | Medio | Versionado estricto de API interna, tests de integración |

## 13. Criterios de éxito

### 13.1 Fase 1.A

- Al menos 1 curso asíncrono real de VA360 migrado y funcionando en LearnShip.
- 10+ alumnos reales consumen el curso completo y obtienen certificado.
- Evidence vault genera paquete exportable de cada alumno.

### 13.2 Fase 1.B

- 1 grupo Fundae bonificable completo ejecutado end-to-end.
- Aula virtual Zoom integrada con registro nominal de conexiones.
- Comunidad con 50+ usuarios activos (dogfooding VA360).
- Paquete de auditoría descargable y validable por asesoría legal.

### 13.3 Fase 1.C

- Tutor IA activado en 3+ cursos con feedback positivo (NPS ≥ 7) de alumnos.
- Corrector IA gestiona al menos el 80% de correcciones sin intervención humana
  con acuerdo ≥ 85% con correctores humanos.
- 1 curso de VA360 100% migrado desde stack antiguo.
- Auditoría externa jurídica aprobada.

### 13.4 Fase 2+

- Primer cliente externo (no-VA360) en pre-venta/piloto.
- Módulo de migrador Moodle funcionando con 1 curso real migrado.
- SSO WordPress funcionando con VA360.academy como piloto de integración.

## 14. Documentación relacionada

- `docs/PLAN-FASES.md` — Plan detallado de fases con entregables y duración.
- `docs/ARQUITECTURA-MODULAR.md` — Contrato de módulo y guía de implementación.
- `docs/casos-uso/*.md` — Casos de uso por fase (generados en Ronda 1 con Claude Code).
- `docs/tareas/*.md` — Descomposición técnica en tareas (generadas en Ronda 2).
- `docs/adrs/*.md` — Architecture Decision Records.
- `prompts/*.md` — Prompts para Claude Code.
- `deep-research-report.md` — PRD v1 original (histórico, no modificar).

---

**FIN PRD v2.0**
