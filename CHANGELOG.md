# Changelog

> Todos los cambios notables del repo `didacta-community` se documentan aquí.
> Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
> Esquema de versiones: [SemVer](https://semver.org) estricto con pre-releases `0.0.1-alpha.N`.

## [Unreleased]

### Added

- (Acumulando cambios para el siguiente tag.)

### [0.0.1-alpha.91] — 2026-08-01

#### Notes

- **Captación completa: el viaje 2 (venta de cursos sueltos) ya es público.**
  Con esta versión, los tres viajes de una academia funcionan de punta a
  punta sin sesión previa: alta manual con matrícula, compra de un curso
  suelto por un visitante, y membresía. Además, los grupos de acceso quedan
  formalizados como módulo first-party.

#### Added

- **`mod.access-groups` formalizado**: paquete `modules/access-groups` con
  manifest (dependencias duras de `mod.courses` y `mod.learning`;
  `mod.payment-connections` y `mod.subscriptions` opcionales) y semántica
  portable del ORIGEN de cada membresía de grupo: lo asignado a mano es
  `MANUAL` y es pegajoso; cada puente automático solo crea y retira lo suyo.
  Registrado como módulo core (no desactivable; intentarlo responde 422).
- **Membresías de grupo con origen `MEMBERSHIP`**: el puente de la membresía
  asigna sus miembros con origen propio y solo revoca esos al terminar la
  suscripción — nunca toca lo concedido manualmente. Backfill conservador
  para instalaciones existentes (solo asignaciones del grupo configurado con
  suscripción de membresía viva) y badges «Por membresía» en
  `/admin/grupos-acceso` y en el dossier de usuario.
- **Viaje 2 público (venta de cursos sueltos sin cuenta)**: catálogo de
  cursos a la venta consultable SIN sesión (`/catalogo` en la web;
  `/api/v1/modules/billing/public/{catalog,offer,checkout}` con tenant por
  dominio), ficha pública de venta con opciones de compra, precio tachado y
  % de descuento, y **checkout anónimo de Stripe**: al confirmarse el pago,
  la plataforma crea la cuenta del comprador con el email confirmado en el
  checkout (bienvenida con enlace «Define tu contraseña», personalizable por
  tenant con la plantilla `billing.welcome`) y lo matricula automáticamente.
  Idempotente ante reentregas del webhook; el reembolso total sigue
  retirando el acceso. Sin Stripe configurado, el catálogo público responde
  vacío y la instalación no se ve afectada.

#### Changed

- `mod_billing_order.user_id` pasa a ser opcional (migración versionada, no
  destructiva): las compras del checkout público nacen sin dueño y el
  webhook las completa al materializar al comprador.
- `mod.access-groups` promovido a dependencia dura en el manifest de
  `mod.member-registration` (cierra el estado transitorio de alpha.90).

#### Fixed

- Los endpoints de administración con `:userId` malformado (no UUID)
  responden 404 en lugar de un error 500 del cast de Prisma (solicitudes de
  inscripción, expediente y sanciones; la consulta por lotes descarta los
  ids malformados).

### [0.0.1-alpha.90] — 2026-08-01

#### Notes

- **Captación de alumnos sobre módulos existentes.** Esta versión compone los
  viajes de una academia (alta manual con matrícula, venta de membresías)
  sobre los módulos ya construidos, y formaliza la inscripción de miembros
  como módulo first-party.

#### Added

- **Registro de miembros componible por tenant**: política con 4 modos
  (cerrado / libre / OTP por email / Telegram+OTP) fail-closed, bot de
  Telegram y aprobador como settings de tenant (secreto cifrado at-rest, con
  fallback a las env legacy del despliegue), wizard público con pasos
  dinámicos y card «Registro» en `/admin/configuracion`.
- **`mod.member-registration` formalizado**: paquete `modules/member-registration`
  con manifest (dependencia de `mod.payment-connections`; `mod.access-groups`
  como opcional hasta su formalización), eventos
  `member_registration.request.{created,approved,rejected}` emitidos vía
  outbox y las 4 plantillas de email del flujo registradas por el módulo en el
  catálogo de `/admin/emails`. Host NestJS in-tree (ADR-011/015).
- **Viaje 1 (alta manual) redondeado**: matrícula directa desde admin, ficha
  de usuario accionable (grupos, matrículas y baja administrativa), invitación
  con grupo de acceso (membresía + matrícula antes del primer login).
- **Membresías flexibles**: periodicidad de planes de 1 a 12 meses (tope de
  facturación de Stripe) y moneda por plan (selector con 8 divisas de dos
  decimales; `/unete` y precios de referencia heredan la moneda del plan).
- **Cimientos RLS**: worklist de acceso sin contexto de tenant cerrada a cero
  huecos + benchmark de coste; el flip de enforcement llegará en una fase
  posterior.

#### Changed

- **Rutas del flujo de inscripción (BREAKING)**: las rutas legacy
  `/api/v1/inscripcion*` se retiran; las únicas son
  `/api/v1/modules/member-registration[/admin|/payment-flags]`. Migración
  coordinada: ninguna instalación corre aún el canal de release; las
  integraciones externas (n8n/Woo) deben actualizarse al adoptar esta versión.
- Enum `MemberDecisionAction` renombrado a `MemberRegistrationDecisionAction`
  y claves de plantillas `inscripcion.*` → `member_registration.*` (migración
  versionada incluida; los overrides per-tenant se conservan).
- Impagos del registro clavados a email/userId (`telegramId` queda como clave
  legacy); los datos de Telegram del registro viven en
  `mod_member_registration_profile` (dual-write; las columnas equivalentes de
  `user` quedan deprecadas hasta su retirada coordinada).
- `mod.payment-connections`: el ruleset por defecto ya no clasifica accesos
  por nombre de producto; la regla «lifetime» queda como ejemplo documentado
  (`EXAMPLE_LIFETIME_RULE`) que cada tenant adopta si le aplica.
- Defaults whitelabel: referidos sin exigencia de membresía activa por
  defecto, TZ de crons a UTC y placeholders neutros.

### [0.0.1-alpha.89] — 2026-07-31

#### Notes

- **Primera versión de la retomada fair-code.** El producto vuelve a ser
  whitelabel: incluye todo lo construido durante la era a-medida (moderación
  con expediente, gamificación, encuestas, recursos, mensajería + chat,
  referidos, tutor IA con revisión humana, calendario y clases en directo,
  invitaciones por lotes, métricas, espejo de pedidos WooCommerce…) sin
  ningún acoplamiento a un cliente concreto.

#### Added

- **Telemetría anónima de instalaciones**: latido diario con id de instancia
  aleatorio + versión + edición + node/SO hacia `registry.didacta.io`. Sin
  PII ni datos de negocio; falla en silencio sin red; opt-out con
  `DIDACTA_TELEMETRY_DISABLED=true` (documentado en README § Telemetría).
  El registro opt-in identificado (email + organización) sigue siendo
  voluntario y separado.
- Guías de instalación y actualización self-host (`docs/INSTALL.md`,
  `docs/UPGRADE.md`) y `CONTRIBUTORS.md`.
- Cabecera SPDX `LicenseRef-Didacta-Sustainable-Use` en todo el código de
  producción (823 ficheros); los `.ee` conservan la suya de Enterprise.

#### Changed

- **Migraciones**: baseline único `20260731120000_baseline_faircode` generado
  del schema real (con `pgvector` declarado en el datasource) y validado
  contra un Postgres pgvector virgen. El entrypoint de producción aplica
  `prisma migrate deploy`; `db push` queda solo para desarrollo. Las BD de la
  era `db push` se adoptan con
  `prisma migrate resolve --applied 20260731120000_baseline_faircode`
  (ver `docs/UPGRADE.md`).
- Copy, emails, seeds y placeholders derivan del tenant (branding por
  instalación); fixtures de test sin PII real ni marca de ningún cliente.
- CI fair-code reactivada: `ci.yml`, `ee-fence.yml`, `gitleaks.yml`,
  `license-check.yml` (ee-fence: 0 violaciones en 1.288 ficheros).

#### Removed

- Operación interna del despliegue a medida: composes de prod/dev del
  cliente, scripts de deploy por rsync, workflows de deploy interno, seeds y
  backfills con datos del cliente, sync de precios de una tienda concreta.

### [0.0.1-alpha.88-va360] — 2026-07-31

#### Notes

- **Congelación de la era a-medida.** Entre `0.0.1-alpha.82` y este tag, el repo
  sirvió en exclusiva a un despliegue a medida para un cliente, sin
  registrar aquí las versiones intermedias (que no se reconstruyen).
- Este tag congela ese estado tal cual. A partir de aquí arranca la retomada
  whitelabel de Didacta.io: limpieza del acoplamiento a VA360 y reactivación de
  la CI fair-code.

### [0.0.1-alpha.82]

#### Fixed

- **Upload del logo de tenant (mod.theming)**: el parser global de
  `application/json` en `apps/api/src/main.ts` heredaba el `bodyLimit` por
  defecto de Fastify (1 MB). El uploader acepta imágenes de hasta 2 MB que
  viajan en base64 dentro de un JSON (~+33% → ~2.7 MB), así que Fastify
  rechazaba el request con `413 FST_ERR_CTP_BODY_TOO_LARGE` ANTES del handler
  y el logo nunca se subía. Se eleva el `bodyLimit` del parser JSON a 4 MB
  (headroom para el peor caso). El upload valida tipo (PNG/JPG/SVG/WebP) y
  tamaño (≤2 MB), guarda en storage persistente con key estable
  (`tenants/{id}/branding/logo`), es idempotente (re-subir reemplaza el blob)
  y devuelve `logoUrl` + `logoUploaded`.

#### Added

- **Branding por tenant aplicado a TODO el entorno**:
  - `TenantThemeProvider` movido al ROOT layout (`apps/web/src/app/layout.tsx`)
    para cubrir tanto la app autenticada como las pantallas de auth
    (signin/reset). Expone el theme vivo vía contexto React (`useTenantTheme`).
  - **Sidebar dinámico** (`app-sidebar.tsx`): el logo consume `theme.logoUrl`
    (fallback al anagrama Didacta) y los colores del rail/panel usan las CSS
    vars `--sidebar-bg` / `--sidebar-rail-bg` (antes hex hardcodeados
    `#0D1B2A`/`#0a1421`), tintadas al hue/saturation del tenant por el provider.
  - **Emails con logo**: el email de reset de contraseña (`buildResetEmail`)
    embebe el logo del tenant en el header HTML cuando está configurado (URL
    absoluta, resuelta vía `PUBLIC_API_URL`/`resolveWebBaseUrl`). Best-effort:
    si no hay logo o falla la lectura, el email se envía igual (no rompe el reset).
  - **Favicon dinámico**: sigue funcionando tras mover el provider al root.
- **Errores específicos de logo en `mod.theming`**: `UnsupportedLogoTypeError`
  y `EmptyLogoError` (antes un tipo inválido lanzaba `UnsupportedFontError`,
  semánticamente incorrecto). Mapeados a `422` en `ThemingErrorFilter`.

### [0.0.1-alpha.81]

#### Added

- **`suppressInvite` en `ctx.didacta.users.upsertByExternalRef`**: nuevo flag
  opcional en el contrato de la API pública del core para módulos del
  marketplace. Cuando es `true`, el user se crea igualmente en estado `PENDING`
  (con rol y registro de auditoría) pero NO se dispara el email de
  invitación/activación. El migrador lo usa siempre para importar miles de users
  de un LMS de origen sin bombardearlos con emails; el operador los notifica
  después de forma explícita (p. ej. con resend-invite). `AdminUsersService.invite`
  acepta ahora `options.sendInvite` (default `true`) para soportar este path.

#### Notes

- El comportamiento por defecto NO cambia: el invite manual de un admin (y
  cualquier llamada sin `suppressInvite`) sigue enviando el email de bienvenida.
  La idempotencia se mantiene: si el user ya existe por `externalRef`, nunca se
  reenvía email, independientemente del flag.

### [0.0.1-alpha.79]

#### Added

- **Notificaciones en tiempo real (SSE)**: la campana del header ahora recibe
  notificaciones por Server-Sent Events en lugar de polling. Flujo
  ticket-JWT (`POST /me/notifications/stream-ticket`) +
  `EventSource` (`GET /me/notifications/stream?ticket=…`), con de-dup por `id`,
  reconexión con backoff exponencial + jitter (cap 30s) y degradación
  automática a polling (60s) tras 4 fallos o sin soporte de `EventSource`.

#### Fixed

- **Sidebar**: el item "Comunidad" (`/comunidad`) ya no se marca activo en
  rutas hijas como `/comunidad/menciones`. Nuevo flag `exactMatch` en los items
  de sidebar aportados por módulos.

---

## [0.0.1-alpha.0] — pendiente

> ⚠️ **Pre-release**. Alpha cerrada con grupo restringido de testers (5-10 personas) bajo NDA. NO usar en producción con datos reales.

### Added

#### Modelo de licencias y arquitectura

- **Didacta Sustainable Use License v1.0** (fair-code, adaptada de n8n SUL).
- **Didacta Enterprise License** para archivos `*.ee.*` y carpetas `ee/`/`*.ee/` dentro del core.
- Documentación de licensing completa (`docs/licensing/`, `LICENSE_NOTICE.md`, `COMMERCIAL_USE.md`, `TRADEMARKS.md`).
- Política de versionado (`docs/versioning.md`).

#### License SDK (`@didacta/license-sdk`)

- Verifier ES256 (ECDSA P-256) con clave pública embebida (`src/public-keys/`).
- Privada gestionada en AWS KMS (`alias/didacta-issuer-2026`, `eu-west-1`).
- 11 capabilities Enterprise: `feat:multi_tenant.real`, `feat:sso.saml`, `feat:sso.oidc`, `feat:scim`, `feat:mfa.enforcement`, `feat:white_label`, `feat:custom_domains`, `feat:audit.long_retention`, `feat:reports.advanced_signed`, `feat:api.webhooks.high_throughput`, `feat:api.rate_limit.elevated`.
- 6 estados de licencia: `community`, `active`, `grace`, `expired`, `invalid`, `dev`.
- `LicenseService` (NestJS) + decorator `@RequiresCapability` + `LicenseGuard`.
- Hook React `useLicense()` + componente `<EeGate>`.
- `RegistryClient` para opt-in (instalaciones Community → Cloud god).
- `LicenseExceptionFilter` mapea `CapabilityRequiredError` → HTTP 402.

#### Backend integration

- `LicenseModule.forRoot()` global registrado en `apps/api/src/app.module.ts`.
- `GET /api/license` — endpoint público para frontend (`PublicLicenseState` sin secretos).
- **Capability piloto white-label**: `apps/api/src/branding/` con `BrandingController` (CE) + `WhiteLabelController` (EE) gateado por `@RequiresCapability(WHITE_LABEL)`.
- **Sistema registro opt-in**: `apps/api/src/registry/` con tabla `core_installation_registry`. Endpoints `POST /admin/registry/opt-in`, `GET /admin/registry/status`, `DELETE /admin/registry/opt-in`. Singleton lógico, persistencia local, RGPD-friendly.

#### Tooling

- `scripts/ee-fence.ts` valida convención `.ee` open-core (con excepción para `*.module.ts` que registran controllers EE).
- `scripts/module-doctor.ts` valida contrato de módulo.
- `scripts/license-check.ts` audita licencias de dependencias.
- `scripts/dev-issue-license.ts` (CLI) — issuer mínimo de desarrollo que firma con AWS KMS para tests locales.

#### Empaquetado y distribución

- `Dockerfile` multi-stage (api + web en una imagen).
- `docker-compose.alpha.yml` para alpha testers (postgres + redis + minio + mailpit + api + web).
- `.env.example` con todas las variables documentadas.
- Workflow GitHub Actions `release.yml` que publica imagen a GHCR cuando se taggea `vX.Y.Z` o `vX.Y.Z-pre.N`.
- Issue templates para alpha testers (bug / feedback / feature request).

#### CI/CD

- Workflows: `ci.yml`, `ee-fence.yml`, `license-check.yml`, `module-doctor.yml`, `release.yml`.

### Pendiente para alphas posteriores

- Sistema de registro opt-in conectado a Cloud god (Sprint 2, MIG-049/050/051).
- Más capabilities Enterprise sembradas (multi-tenant real, SSO/SAML, etc.).
- Marketplace de módulos con instalación con un click.
- Agente IA de moderación de marketplace.

---

## Política de versiones

SemVer estricto, pre-releases `-alpha.N` / `-beta.N` / `-rc.N`, `:latest` en Docker NUNCA apunta a pre-release. La política completa vive en el Notion del equipo.
