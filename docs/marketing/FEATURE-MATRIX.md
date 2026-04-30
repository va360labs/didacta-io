# Didacta Community — Feature Matrix

> Comparativa honesta de Didacta Community vs los principales LMS comerciales del mercado: Moodle 4.x, LearnDash, TalentLMS, Docebo, 360Learning, Thinkific.
>
> Estado del documento: **alpha cerrada** v0.0.1 (2026-04-30). Se actualiza con cada release.

---

## TL;DR

Didacta Community cubre **~95% del feature set core** de un LMS top, **~70% de las features de IA diferenciadoras** (RAG con citas, corrección IA con rúbrica) y aporta **3 diferenciadores únicos**: cumplimiento Fundae España al 100%, modelo arquitectónico modular tipo "WordPress" para tooling agnóstico de IA, y fair-code (Sustainable Use License). Los huecos están en monetización (billing, marketplace) y conectividad enterprise (SSO/SCIM), que se construirán Q2-Q3 2026.

**A quién le sirve hoy** (alpha cerrada):
- Academias / consultoras de formación que necesitan **bonificaciones Fundae** sin pagar 200€/mes a TalentLMS.
- Empresas con plantilla pequeña-mediana que quieren **autohospedarlo** sin licencias por usuario.
- Equipos que valoran **fair-code source-available** y odian SaaS lock-in.
- Casos de uso donde **IA por curso (tutor + grader)** sea diferenciador comercial real.

**A quién NO le sirve hoy**:
- Organizaciones grandes que necesitan SSO SAML / SCIM provisioning desde day one (en roadmap).
- Marketplaces de cursos pagados B2C masivos (sin Stripe integrado todavía).
- Apps móviles nativas (no en alpha — solo web responsive).

---

## Matriz feature-by-feature

Leyenda: ✅ Disponible · 🟡 Parcial · 🔵 EE (Enterprise gateado por licencia) · 🚧 En roadmap · ❌ No previsto

### Core LMS

| Feature | Didacta Community v0.0.1 | Moodle 4.x | LearnDash | TalentLMS | Docebo |
|---------|--------------------------|------------|-----------|-----------|--------|
| Cursos asíncronos con módulos + lecciones | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tipos de lección VIDEO/HTML/PDF/TEXT/QUIZ/SCORM | ✅ | ✅ | ✅ | ✅ | ✅ |
| YouTube embed nativo | ✅ | 🟡 (con plugin) | 🟡 | ✅ | ✅ |
| SCORM 1.2 / 2004 importer | ✅ | ✅ | 🟡 (premium) | ✅ | ✅ |
| Drag & drop builder de cursos | ✅ (cross-module) | ✅ | ✅ | ✅ | ✅ |
| Catálogo público + buscador + filtros | ✅ | ✅ | ✅ | ✅ | ✅ |
| Quizzes con 6 tipos de pregunta | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-corrección + corrección manual SHORT/LONG | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Certificados PDF con plantilla custom + logo | ✅ | ✅ (con plugin) | ✅ | ✅ | ✅ |
| Numeración única + EvidenceVault con SHA-256 | ✅ | 🟡 | ❌ | 🟡 | 🟡 |
| Comentarios/anotaciones en lecciones (con aprobación) | ✅ | 🟡 | ❌ | 🟡 | 🟡 |

### Engagement / Community

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Foro / posts comunidad | ✅ | ✅ | 🟡 (BuddyPress) | ✅ | ✅ |
| Reacciones + nested replies | ✅ | 🟡 | ✅ | 🟡 | ✅ |
| Menciones @usuario con autocomplete + notificación | ✅ | 🟡 | ❌ | 🟡 | 🟡 |
| Tags curados con color + icono | ✅ | 🟡 | ❌ | 🟡 | 🟡 |
| Pin de mensajes admin | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Email digest opt-in | ✅ | ✅ | 🟡 | ✅ | ✅ |

### Aula virtual / sincrónica

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Integración Zoom S2S OAuth | ✅ | ✅ (con plugin) | 🟡 | ✅ | ✅ |
| Sesión Zoom vinculada a curso/lección | ✅ | 🟡 | 🟡 | ✅ | ✅ |
| Banner "Próxima sesión" en TZ local | ✅ | 🟡 | ❌ | 🟡 | ✅ |
| Webhook recording.completed → URL grabación | ✅ | 🟡 | ❌ | ✅ | ✅ |
| Streaming nativo sin Zoom | 🚧 | ❌ | ❌ | 🟡 | ✅ |

### Inteligencia Artificial (DIFERENCIADOR)

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Tutor IA por curso con RAG sobre contenido | ✅ | ❌ | ❌ | 🟡 (beta) | ✅ |
| Citas a lecciones específicas en respuestas | ✅ | ❌ | ❌ | ❌ | 🟡 |
| Corrección IA con rúbrica + revisión humana | ✅ | ❌ | ❌ | 🟡 | 🟡 |
| AI Gateway multi-provider (Anthropic + OpenAI + Voyage) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Provider configurable per-tenant | ✅ | ❌ | ❌ | ❌ | ❌ |
| Generador de contenido formativo | 🚧 | ❌ | ❌ | 🟡 | ✅ |
| Analytics IA con insights | 🚧 | ❌ | ❌ | 🟡 | ✅ |

### Multi-tenant + Enterprise

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Multi-tenant con tenant_id + RLS | ✅ | 🟡 (multi-site) | ❌ | ✅ | ✅ |
| Tenant transparente (resolución por hostname) | ✅ | 🟡 | ❌ | ✅ | ✅ |
| Multi-tenant aislamiento RLS encriptado per-row | 🔵 EE 🚧 | ❌ | ❌ | ✅ | ✅ |
| White-label completo (custom CSS + footer + hide brand) | ✅ 🔵 EE | ✅ (con plugin) | 🟡 | ✅ | ✅ |
| Custom domains por tenant | ✅ 🔵 EE | 🟡 | ❌ | ✅ | ✅ |
| MFA TOTP obligatorio para admins | ✅ | 🟡 | ❌ | ✅ | ✅ |
| MFA enforcement tenant-wide (todos usuarios) | ✅ 🔵 EE | 🟡 | ❌ | 🟡 | ✅ |
| SSO SAML 2.0 | 🚧 EE | ✅ | 🟡 | ✅ | ✅ |
| SSO OIDC | 🚧 EE | ✅ | 🟡 | ✅ | ✅ |
| Provisioning SCIM 2.0 | 🚧 EE | ❌ | ❌ | 🟡 | ✅ |
| Roles personalizados beyond fixed | 🚧 | ✅ | 🟡 | ✅ | ✅ |
| Audit log con cadena de hashes verificable | ✅ | 🟡 | ❌ | 🟡 | ✅ |
| Retención auditoría > 90 días | ✅ 🔵 EE | 🟡 | ❌ | 🟡 | ✅ |
| Export audit firmado HMAC + manifest sha256 | ✅ 🔵 EE | ❌ | ❌ | 🟡 | 🟡 |
| Rate limit elevado API (vs base community) | ✅ 🔵 EE | ❌ | ❌ | 🟡 | ✅ |
| Webhooks high-throughput | 🚧 EE | 🟡 | ❌ | 🟡 | ✅ |

### Compliance regional

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Fundae España end-to-end | ✅ | ❌ | ❌ | ❌ | ❌ |
| Empresas bonificadas + RLPT 15 días | ✅ | ❌ | ❌ | ❌ | ❌ |
| Grupos bonificables con costes | ✅ | ❌ | ❌ | ❌ | ❌ |
| XML inicio + finalización + cálculo 75% | ✅ | ❌ | ❌ | ❌ | ❌ |
| Evidencias PDF firmadas + ZIP de presentación | ✅ | ❌ | ❌ | ❌ | ❌ |
| ZIP redactado read-only para auditor | ✅ | ❌ | ❌ | ❌ | ❌ |
| Validador offline del ZIP (sin red) | ✅ | ❌ | ❌ | ❌ | ❌ |
| IFAPA Andalucía | 🚧 | ❌ | ❌ | ❌ | ❌ |
| GDPR (export usuario + delete) | ✅ | ✅ | ✅ | ✅ | ✅ |

### Comercial / monetización

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Stripe checkout integrado | 🚧 | 🟡 (con plugin) | ✅ | ✅ | ✅ |
| Suscripciones recurrentes | 🚧 | 🟡 | ✅ | ✅ | ✅ |
| Marketplace módulos third-party | 🚧 | ✅ (huge) | 🟡 | ❌ | ✅ |
| Affiliates / referrals | 🚧 | 🟡 | ✅ (premium) | ✅ | ✅ |
| Cupones / descuentos | 🚧 | 🟡 | ✅ | ✅ | ✅ |
| FacturaScripts (facturación ES) | 🚧 | ❌ | ❌ | ❌ | ❌ |

### Operativa / DevOps

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Docker compose alpha listo | ✅ | ✅ | 🟡 | N/A (SaaS) | N/A (SaaS) |
| Outbox + EventBus persistente con recovery worker | ✅ | 🟡 | ❌ | 🟡 | ✅ |
| Métricas Prometheus + dashboards Grafana | ✅ | 🟡 | ❌ | 🟡 | ✅ |
| Health-detail con DB/Redis/S3/SMTP | ✅ | 🟡 | ❌ | 🟡 | ✅ |
| Storage S3 (Hetzner / AWS / MinIO) | ✅ | ✅ | 🟡 | N/A | ✅ |
| Backup Postgres + restore documentado | ✅ | ✅ | 🟡 | N/A | ✅ |
| 561 tests automáticos verde (unit + integration) | ✅ | 🟡 | 🟡 | N/A | 🟡 |

### Mobile

| Feature | Didacta | Moodle | LearnDash | TalentLMS | Docebo |
|---------|---------|--------|-----------|-----------|--------|
| Web responsive | ✅ | ✅ | ✅ | ✅ | ✅ |
| App móvil iOS / Android | 🚧 | ✅ | 🟡 | ✅ | ✅ |
| API mobile-first | 🚧 | ✅ | 🟡 | ✅ | ✅ |

---

## Diferenciadores únicos de Didacta

### 1. Fundae España al 100%

Ningún LMS comercial cubre Fundae con la profundidad de Didacta. Las academias de formación bonificada hoy:
- Pagan 200-500€/mes a TalentLMS / Docebo + tienen que **gestionar bonificaciones a mano** en Excel.
- O usan plataformas exclusivas Fundae (caras, propietarias, sin IA).

Didacta Community trae:
- Empresas bonificadas con NIF + CCC + crédito anual.
- RLPT (notificación 15 días naturales obligatoria por RD 694/2017).
- Grupos bonificables con costes + matriculación nominal.
- Cálculo de finalización con umbral 75% configurable.
- Export XML inicio + fin de grupo (formato Fundae).
- Evidencias PDF firmadas + ZIP de presentación.
- Endpoint específico para auditor (read-only sanitizado, sin emails personales).
- Validador offline del ZIP (no requiere internet).

**ROI directo**: una academia que bonifica 50k€/año puede ahorrar 6k€/año en costes de plataforma + 100h/año de gestión manual.

### 2. IA por curso con RAG y citas verificables

- AI Gateway multi-provider (Anthropic Claude / OpenAI / Voyage) configurable per-tenant.
- Indexación automática del contenido del curso al publicarlo (`courses.course.published` event).
- Embeddings en pgvector con índice ivfflat.
- Tutor IA con citas explícitas a lecciones específicas (no alucina referencias).
- Corrección IA con rúbrica + revisión humana antes de publicar nota.
- Métricas de acuerdo IA-humano para medir calidad.

A día de hoy, esto NO existe en Moodle ni LearnDash. Docebo y TalentLMS tienen tutores IA básicos, pero no con citas verificables ni multi-provider configurable.

### 3. Modelo arquitectónico modular tipo "WordPress matizado"

- Módulos siempre Community (todos los `mod.*` son CE).
- Capabilities EE gateadas por licencia firmada ES256 → 11 capabilities transversales del CORE (white-label, custom-domains, MFA enforcement, audit long retention, reports signed, rate limit elevated, multi-tenant real, SSO SAML/OIDC, SCIM, webhooks).
- Modelo "fair-code" — Sustainable Use License v1.0 inspirada en n8n. Permite uso interno empresarial libre; restringe distribución de pago / SaaS competidor.
- Repo `didacta-modules-skill` agnóstico para que cualquier asistente IA (Claude Code, Copilot, Cursor, Aider) pueda generar módulos correctos al primer intento.

**Por qué importa**: las empresas que adopten Didacta NO se quedan sin opciones — pueden self-host gratis indefinidamente en CE, y solo pagan EE cuando ya tienen necesidades enterprise reales (SSO, multi-tenant estricto, etc.). Comparable a la propuesta de n8n vs Zapier: open-core honesto, sin trampas.

---

## Roadmap de cierre de gap (orientativo)

### Q3 2026
- 5to-7mo piloto EE: SSO SAML, SSO OIDC, SCIM (los 3 grandes operativos).
- IFAPA Andalucía (después de Fundae cerrado).
- Migrator from Moodle (cursos + usuarios + enrollments).

### Q4 2026
- Stripe billing + suscripciones.
- Marketplace de módulos third-party (one-click install).
- App móvil iOS/Android.
- Streaming nativo (sin dependencia Zoom).

### 2027
- Migrator from LearnDash + TalentLMS (capturar churn).
- Affiliates / referrals.
- Gamification (badges, leaderboards, niveles).
- Mobile-first API expandida.

---

## Métricas técnicas alpha

- **528 tests unit + 13 tests integración Postgres real** verde en `didacta-community`.
- **424 tests + 118 fundae module tests** verde en `learnship` (repo principal pre-rebrand).
- **22 módulos** (11 en cada repo) en verde con linter `audit-module-contract`.
- **5 capabilities EE pilotadas end-to-end** (de 11 oficiales).
- **Imagen Docker alpha**: 1.3 GB (alpine), publicada en Docker Hub `didactaio/community:0.0.1-alpha.0`.
- **Stack**: NestJS 11 + Next 15 + Postgres 16 + Prisma 5 + Redis 7 + pgvector + S3 + Anthropic / OpenAI / Voyage.

## Cómo probar el alpha

Ver [`docs/alpha/INSTALL.md`](../alpha/INSTALL.md). Tiempo estimado de instalación local: 10 minutos.

## Contacto

- **Repo**: https://github.com/va360labs/didacta-community
- **Skills agnósticas**: https://github.com/va360labs/didacta-modules-skill
- **Licencia**: [Sustainable Use License v1.0](../../LICENSE) (fair-code)
- **Comercial / consultoría**: contactar VA360 LABS S.L.

---

> Esta matriz refleja el estado actual al final del Sprint 1 alpha. Las casillas 🚧 se actualizan a ✅ a medida que cierran sprints. Si encuentras un error de comparación con un LMS específico, abre issue.
