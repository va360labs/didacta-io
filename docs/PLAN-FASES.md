# LearnShip — Plan de fases

> **Versión**: 1.0
> **Fecha**: abril 2026
> **Estado**: Aprobado
> **Documento padre**: `docs/PRD.md`

---

## 1. Resumen del roadmap

| Fase | Duración | Entregable principal |
|---|---|---|
| **Fase 0** | 2 semanas | Discovery técnico, repo, infraestructura base, modelo de datos v1 |
| **Fase 1.A** | 8 semanas | CORE + cursos asíncronos + certificados (dogfooding VA360) |
| **Fase 1.B** | 8 semanas | Zoom directo + comunidad + Fundae básico (grupo bonificable real) |
| **Fase 1.C** | 8 semanas | IA integrada + piloto completo + auditoría externa |
| **Fase 2+** | Post-MVP | Migradores, SSO, comercial, IFAPA (iterativo) |

**Duración total Fase 0 + Fase 1**: 26 semanas (≈6 meses).

## 2. Principios de ejecución

1. **Cada fase es entregable y dogfoodeable** en VA360 por sí sola.
2. **Ningún módulo se construye "para el futuro"**: solo lo necesario para la fase actual.
3. **El contrato de módulo se congela en Fase 0** y no se modifica sin ADR aprobada.
4. **Los tests son parte de la definición de hecho**, no un extra.
5. **La documentación viva se actualiza en el mismo PR que el código**.
6. **Si una fase se retrasa, se recorta alcance, no se posponen las siguientes**.

---

## Fase 0 — Discovery técnico y fundaciones

**Duración**: 2 semanas
**Equipo mínimo**: 1 tech lead + Claude Code (asistido)

### Objetivos

Dejar lista la infraestructura de desarrollo, las decisiones clave documentadas y el
esqueleto del monorepo funcionando, de forma que la Fase 1.A pueda arrancar sin
fricción.

### Entregables

- [ ] Repo monorepo `learnship` creado en GitHub con Turborepo + pnpm workspaces.
- [ ] Estructura de carpetas completa (`apps/`, `packages/`, `modules/`, `docs/`, `infra/`).
- [ ] `docker-compose.yml` para dev local: Postgres 16, Redis 7, MinIO, MailHog, MailPit.
- [ ] Dockerfiles multi-stage para `apps/api` y `apps/web`.
- [ ] Pipeline CI en GitHub Actions: lint + type-check + test unitario + build.
- [ ] Entornos en Easypanel: `learnship-dev`, `learnship-staging`, `learnship-prod`.
- [ ] Prisma schema v1 con todos los modelos core + stubs de modelos de módulos Fase 1.
- [ ] Migraciones iniciales aplicadas en los 3 entornos.
- [ ] ADRs iniciales escritas (mínimo 8 — ver lista abajo).
- [ ] `CONTRIBUTING.md`, `README.md`, `CODE_OF_CONDUCT.md`.
- [ ] Convención de commits: conventional commits + commitlint.
- [ ] Esqueleto NestJS en `apps/api` con endpoint `/healthz`.
- [ ] Esqueleto Next.js en `apps/web` con página `/` funcionando.
- [ ] Contrato de módulo (`packages/core-kernel`) con interfaz `Module`, `ModuleRegistry`, tests.
- [ ] Módulo de ejemplo `modules/hello-world` que implemente el contrato y sirva de plantilla.

### ADRs iniciales (mínimo)

1. ADR-001: Monolito modular vs microservicios → monolito modular.
2. ADR-002: Multi-tenancy strategy → RLS con `tenant_id`.
3. ADR-003: Auth provider → Better-Auth / Auth.js v5.
4. ADR-004: Streaming provider Fase 1 → Zoom API + SDK Web.
5. ADR-005: ORM → Prisma 5.
6. ADR-006: API versioning → URL path `/api/v1/` con desprecación explícita.
7. ADR-007: Event bus → outbox pattern + BullMQ + webhooks.
8. ADR-008: Contrato de módulo → manifest `module.json` + interfaces TS estrictas.

### Definición de hecho (DoD)

Un developer puede:
- Clonar el repo en blanco.
- Ejecutar `pnpm install && pnpm dev` en menos de 10 minutos.
- Abrir `http://localhost:3000` (web) y `http://localhost:4000/healthz` (api) sin errores.
- Ver migraciones aplicadas en `psql` con `\dt` mostrando tablas core.
- Ejecutar `pnpm test` y obtener 100% verde.
- Ejecutar `pnpm lint && pnpm typecheck` sin warnings.

---

## Fase 1.A — CORE + Learning asíncrono

**Duración**: 8 semanas
**Objetivo de dogfooding**: migrar 1 curso asíncrono de VA360.academy a LearnShip y que 10+ alumnos reales lo terminen.

### Módulos involucrados

- Core: IAM, Tenancy, Audit, Evidence Vault, Module Registry, Notification Hub, i18n.
- `mod.courses`: catálogo, curso, módulo, lección.
- `mod.learning`: matriculación, player, progreso, reanudación.
- `mod.assessments`: quiz básico.
- `mod.certificates`: plantilla + emisión PDF.

### Entregables funcionales

- [ ] Super-admin puede crear y configurar tenants.
- [ ] Tenant-admin puede gestionar usuarios, formadores, alumnos.
- [ ] MFA obligatorio para super_admin y tenant_admin.
- [ ] Formador puede crear cursos con estructura módulo → lección.
- [ ] Tipos de lección: vídeo (Video.js), HTML (iframe), PDF, texto, quiz.
- [ ] Import SCORM 1.2 y 2004 (con scorm-again library).
- [ ] Import xAPI básico (registro de statements).
- [ ] Alumno puede matricularse (por admin, por código, por enlace invitación).
- [ ] Player con progreso persistente y reanudación desde último punto.
- [ ] Quizzes: opción múltiple, verdadero/falso, completar, respuesta corta (corrección manual).
- [ ] Reglas de finalización parametrizables (por defecto 75% completitud).
- [ ] Certificados PDF con plantilla personalizable (incluye logo tenant, datos alumno, firma).
- [ ] Audit log de todas las acciones críticas.
- [ ] Evidence Vault v1: hash SHA-256 + almacenamiento S3 + metadatos.
- [ ] Panel admin del tenant con métricas básicas.
- [ ] API REST v1 documentada con OpenAPI.
- [ ] Webhooks outgoing para eventos `learning.*`.

### Entregables técnicos

- [ ] Al menos 200 tests unitarios (>70% coverage en lógica de negocio).
- [ ] Al menos 20 tests e2e con Playwright cubriendo flujos críticos.
- [ ] Documentación OpenAPI publicada en `/api/docs`.
- [ ] Runbooks básicos en `docs/ops/` para incidencias comunes.
- [ ] Pipeline CI/CD desplegando automáticamente a staging en cada merge a `main`.

### Criterio de éxito

1 curso real de VA360 (candidato: "Introducción a n8n" o "PotenzIA Fundamentos")
migrado a LearnShip. 10 alumnos reales completan el curso. Se genera paquete de
evidencia completo.

---

## Fase 1.B — Directo + Comunidad + Fundae básico

**Duración**: 8 semanas
**Objetivo de dogfooding**: emitir 1 grupo Fundae bonificable real end-to-end con aula virtual Zoom integrada y comunidad activa.

### Módulos involucrados

- `mod.zoom-live`
- `mod.community`
- `mod.fundae`

### Entregables funcionales

#### Zoom Live

- [ ] Tenant-admin configura credenciales Zoom (OAuth o Server-to-Server).
- [ ] Formador puede programar sesión síncrona vinculada a grupo/curso.
- [ ] Sistema crea automáticamente meeting en Zoom vía API.
- [ ] Alumnos reciben enlace único (si se usa registration) o enlace de meeting.
- [ ] Registro de participantes nominal: timestamp entrada, salida, duración.
- [ ] Descarga automática de grabación al Evidence Vault.
- [ ] Acceso habilitado para rol `auditor` con vista restringida.
- [ ] Evidencia síncrona vinculada al expediente del grupo (si Fundae activo).

#### Community

- [ ] Tenant-admin crea espacios de comunidad (público, privado, secreto).
- [ ] Alumnos/formadores publican posts con markdown + imágenes.
- [ ] Sistema de comentarios, menciones, reacciones.
- [ ] Feed personalizado por usuario.
- [ ] Moderación: reportar, ocultar, eliminar (con audit log).
- [ ] Notificaciones in-app y email configurables.

#### Fundae

- [ ] Activación del módulo por tenant.
- [ ] Expediente de empresa bonificada: NIF, razón social, CCC, plantilla, crédito, RLPT.
- [ ] Expediente de entidad organizadora y centro.
- [ ] Registro de RLPT: notificación, acuse, plazos, actas de discrepancias.
- [ ] Acción formativa: código, modalidad, duración, objetivos, contenidos.
- [ ] Grupo formativo: fechas, horario, modalidad, formadores, aula virtual si aplica.
- [ ] Asociación grupo ↔ curso del catálogo.
- [ ] Matriculación de alumnos con vínculo a empresa bonificada.
- [ ] Comunicación de inicio: export en formato oficial + validación de plazos (2 días naturales mínimo).
- [ ] Bloqueos de workflow: no se puede iniciar grupo sin RLPT resuelta si aplica.
- [ ] Registro de costes directos/indirectos/organización por grupo.
- [ ] Cálculo de finalización con umbral 75% parametrizable.
- [ ] Emisión de certificados/diplomas vinculados al expediente.
- [ ] Comunicación de finalización: export con participantes finalizados y costes.
- [ ] Paquete de auditoría descargable: ZIP con manifest JSON + todos los artefactos firmados + logs.
- [ ] Conservación documental automática ≥ 4 años.

### Criterio de éxito

1 grupo Fundae real bonificable ejecutado end-to-end en VA360. Paquete de auditoría
generado y validado por asesoría jurídica externa. Comunidad con 50+ usuarios activos.

---

## Fase 1.C — IA integrada + Piloto + Auditoría externa

**Duración**: 8 semanas
**Objetivo**: producto completo con IA nativa + piloto real con auditoría externa aprobada.

### Módulos involucrados

- `mod.ai-tutor`
- `mod.ai-grader`
- `mod.ai-content`
- `mod.ai-analytics`
- `mod.n8n-bridge`

### Entregables funcionales

#### AI Tutor

- [ ] Activación por curso (no global).
- [ ] Job de indexación al publicar curso: extrae contenido de lecciones, genera embeddings con voyage-code o equivalente, almacena en pgvector.
- [ ] Chat del tutor en la UI del alumno.
- [ ] RAG sobre contenido del curso + últimas N conversaciones del alumno.
- [ ] Respuestas con citas a lecciones específicas (enlace profundo).
- [ ] Límite configurable de tokens por alumno/día/tenant.
- [ ] Histórico de conversaciones consultable por formador (con consentimiento).

#### AI Grader

- [ ] Activación por quiz.
- [ ] Formador define rúbrica (criterios + pesos).
- [ ] Alumno responde pregunta abierta.
- [ ] Claude corrige con rúbrica y devuelve: nota, justificación, feedback.
- [ ] Formador puede revisar y ajustar (human-in-the-loop).
- [ ] Métricas de acuerdo entre corrección IA y humana.

#### AI Content

- [ ] Botón "Generar resumen" en cada lección.
- [ ] Botón "Generar flashcards" (exportables a Anki).
- [ ] Botón "Generar quiz" desde contenido de lección.
- [ ] Todo generado queda en modo borrador, formador revisa y publica.

#### AI Analytics

- [ ] Modelo de detección de abandono (features: ritmo, tiempo sin login, progreso, engagement en comunidad).
- [ ] Alertas proactivas al formador/admin.
- [ ] Dashboard de riesgo de abandono por curso.
- [ ] Trigger automático via n8n para campañas de recuperación.

#### n8n Bridge

- [ ] Webhooks outgoing firmados con HMAC.
- [ ] Catálogo de eventos documentado.
- [ ] Posibilidad de configurar webhooks desde UI admin.
- [ ] Documentación con ejemplos de workflows n8n típicos.
- [ ] Nodo n8n dedicado (opcional, stretch goal).

### Entregables de pulido y hardening

- [ ] Revisión completa RGPD: RAT actualizado, DPA con proveedores (Anthropic, Zoom, Brevo).
- [ ] MFA obligatorio para backoffice ya activo (validar en auditoría).
- [ ] Análisis de vulnerabilidades con OWASP ZAP o similar.
- [ ] Pentest externo básico (si presupuesto).
- [ ] Revisión de accesibilidad WCAG 2.1 AA.
- [ ] Optimización de rendimiento (cache, índices DB, CDN para assets).
- [ ] Traducciones ES y EN completas.

### Piloto y auditoría

- [ ] 1 curso completo de VA360 con IA activa y 30+ alumnos reales.
- [ ] Ejecución completa de un grupo Fundae con módulo IA activo.
- [ ] Auditoría externa de asesoría jurídica sobre evidencias Fundae.
- [ ] Informe de hallazgos + plan de remediación.
- [ ] Go/no-go para lanzamiento comercial Fase 2.

### Criterio de éxito

- NPS de alumnos piloto ≥ 40.
- Acuerdo IA-humano en corrección ≥ 85%.
- Auditoría externa aprobada (o remediación clara y acotada).
- Decisión go/no-go tomada.

---

## Fase 2+ — Post-MVP (roadmap iterativo)

### Fase 2.A — Comercial (estimado 6-8 semanas)

**Objetivo**: abrir la plataforma a clientes externos.

- `mod.stripe` + `mod.checkout` + `mod.subscriptions`.
- `mod.whitelabel` (dominio custom, branding).
- Landing pública de tenant.
- Onboarding self-service de tenants nuevos.
- Marketing site en `apps/marketing`.

### Fase 2.B — Migradores y SSO (estimado 6-8 semanas)

**Objetivo**: facilitar la migración desde stacks legacy de clientes potenciales.

- `mod.migrator-moodle`: cursos, usuarios, progreso, intentos de quiz.
- `mod.migrator-learndash`: cursos, alumnos, certificados.
- `mod.sso-wordpress`: bidireccional para VA360.academy.
- `mod.sso-oidc`: Google Workspace, Azure AD, Okta.

### Fase 2.C — IFAPA sectorial (estimado 4-6 semanas, bajo demanda)

**Objetivo**: cumplir requisitos IFAPA si aparece cliente que lo exija.

- `mod.ifapa`: activación por curso, no global.
- Exportes SIENA.
- Guía del alumnado automatizada.
- Foros obligatorios por unidad.
- Tests por unidad + prueba final.
- Memoria justificativa final.
- Autorización previa de plataforma documentada.

### Fase 3 — Escala y ecosistema (sin fechas firmes)

- `mod.sso-saml`.
- `mod.facturascripts` (integración con tu stack actual).
- `mod.affiliate`, `mod.gamification`, `mod.webinars`.
- `mod.scorm-authoring` (autoría visual).
- `mod.live-streaming-native` (alternativa self-hosted a Zoom con LiveKit).
- `mod.mobile-api` + app iOS/Android.
- `mod.marketplace`.

## 3. Ritmo de trabajo sugerido

### Sprint

- **Duración**: 2 semanas.
- **Cada fase de 8 semanas = 4 sprints**.
- **Sprint 0**: planning detallado, grooming de historias, setup.
- **Sprints 1-3**: implementación.
- **Sprint 4**: pulido, tests e2e, docs, release.

### Ceremonias mínimas

- Planning al inicio de sprint.
- Daily async (mensaje en Slack o canal dedicado).
- Review al final del sprint: demo a stakeholders (tú mismo en dogfooding).
- Retro al final del sprint: qué funcionó, qué no, qué mejorar.

### Gestión de backlog

Todo el backlog vive en Notion siguiendo el kanban generado en Ronda 3 (ver
`prompts/prompt-03-notion-kanban.md`). Claude Code tiene acceso vía MCP y
actualiza estado de tareas automáticamente.

## 4. Riesgos del plan y mitigación

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Fase 1.A se alarga más de 8 semanas | Media | Alto | Recortar scope, mantener deadline; IA se mueve a Fase 1.C completa |
| Dependencias externas (Zoom, Anthropic) cambian APIs | Baja | Medio | Interfaces abstractas, adapter pattern, tests de integración |
| Cumplimiento Fundae tiene interpretaciones distintas | Media | Alto | Consulta legal temprana en Fase 1.B, no esperar a Fase 1.C |
| Dogfooding revela gaps funcionales no previstos | Alta | Medio | Fase 1.C incluye buffer para hardening y gaps |
| Falta de tiempo para construir todo | Alta | Alto | Priorización estricta: Fase 1 deja fuera SSO, migradores, pagos |
| Tentación de añadir módulos "rápidos" fuera de fase | Alta | Alto | Disciplina de PO: nada entra sin pasar por planning de fase |

## 5. Dependencias externas críticas

| Dependencia | Proveedor | Fase donde se activa | Plan B |
|---|---|---|---|
| Zoom API | Zoom Video Communications | 1.B | LiveKit self-hosted en Fase 3 |
| Anthropic API (Claude) | Anthropic | 1.C | OpenAI como fallback con abstracción en `packages/ai` |
| Brevo SMTP | Brevo | 0 (Fase 0 usa MailPit local) | AWS SES, Resend como alternativas |
| Hetzner + Easypanel | Hetzner Cloud | 0 | AWS / DigitalOcean como alternativas |
| GitHub Actions | GitHub | 0 | GitLab CI, Jenkins self-hosted |
| pgvector | Postgres extension | 1.C | Qdrant, Weaviate externos |

---

**FIN PLAN-FASES v1.0**
