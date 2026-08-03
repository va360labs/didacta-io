# Changelog

> Todos los cambios notables del repo `didacta-community` se documentan aquí.
> Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
> Esquema de versiones: [SemVer](https://semver.org) estricto con pre-releases `0.0.1-alpha.N`.

## [Unreleased]

### Added

- (Acumulando cambios para el siguiente tag.)

### [0.0.1-alpha.99] — 2026-08-03

#### Added

- **Grupo de acceso opcional en el envío por lotes de invitaciones**
  (`/admin/invitaciones`): además de reenviar la invitación al siguiente lote
  de pendientes, se puede elegir un grupo de acceso para añadirlos a todos
  (aditivo, sin quitarles los que ya tuvieran). Mismo criterio que la
  invitación individual y el CSV de alta masiva, que ya lo tenían.

### [0.0.1-alpha.98] — 2026-08-03

#### Added

- **Alta masiva de alumnos desde CSV** (`/admin/usuarios/importar`): un
  operador sube un CSV con columnas `email`/`correo` y `name`/`nombre`,
  elige rol y grupo de acceso una única vez para todo el lote, y cada fila
  se invita en segundo plano reutilizando la misma validación que la
  invitación individual. El parseo ocurre en el navegador (sin subida
  multipart) y el progreso se sigue con una barra + lista de fallidos,
  mismo patrón ya usado para el envío por lotes de invitaciones.

### [0.0.1-alpha.97] — 2026-08-03

#### Changed

- **Marketplace: el guard SQL de `ctx.db` (aislamiento de módulos third-party
  a sus propias tablas `mod_<slug>_*`) pasa de un validador regex a parsear
  el AST real con `node-sql-parser`.** Corrige dos huecos explotables del
  validador anterior: listas `FROM` separadas por coma
  (`FROM mod_x_a, "user"`) y subqueries anidadas dentro de
  `extract`/`substring`/`trim`/`overlay`/`position` que el regex enmascaraba
  a ciegas. Sin cambios de contrato público — el SQL que efectivamente se
  ejecuta contra Postgres no cambió, solo la validación previa.

### [0.0.1-alpha.96] — 2026-08-03

#### Notes

- **Flip real de aislamiento RLS: la app deja de conectar con el usuario de
  arranque.** Cambio de comportamiento para el operador: `ADMIN_DATABASE_URL`
  (nueva, opcional con fallback a `DATABASE_URL`) es la conexión de
  administración — solo migraciones, políticas RLS y grants. `DATABASE_URL`
  pasa a ser la conexión de **runtime**: si se deja vacía (recomendado), el
  entrypoint la deriva sola hacia el rol `didacta_app` (sin `BYPASSRLS`), con
  contraseña autogenerada y persistida en el volumen de datos si no se define
  `POSTGRES_APP_PASSWORD`. Una instalación existente con solo `DATABASE_URL`
  apuntando al usuario de arranque **sigue arrancando sin tocar nada** — el
  log advierte la degradación (sin aislamiento RLS real) sin romper el
  arranque. Guía de migración en `docs/UPGRADE.md`.

#### Added

- **Bypass real de acceso global sancionado**: `didacta_app` es miembro del
  rol `didacta_super` (`BYPASSRLS`); las operaciones legítimamente
  cross-tenant sin contexto conocido (autenticación por API key, refresh
  token, resolución de tenant por dominio, despachador del outbox, el setup
  wizard) hacen `SET LOCAL ROLE didacta_super` dentro de su propia
  transacción — transaccional, auditado por el código, sin conexión separada.
- Test de aislamiento honesto contra Postgres real: conecta de verdad como
  `didacta_app` con dos tenants, valida `SELECT`/`INSERT` cross-tenant y que
  el bypass sancionado sigue funcionando.

#### Fixed

- **Contraseña del rol `didacta_app` nunca se aplicaba de verdad**: el
  entrypoint la asignaba con `psql -c "... :'pw'"`, y `psql -c` no interpola
  variables (`:'var'` solo funciona en modo script `-f`/stdin) — bug latente
  desde la fase 0 del despliegue de RLS. Corregido a script por stdin.

### [0.0.1-alpha.95] — 2026-08-03

#### Notes

- **Release intermedia del despliegue de Row-Level Security.** Un cambio de
  comportamiento para el operador: la telemetría de aislamiento pasa a `on`
  por defecto y las queries sin contexto de tenant se registran como **error**
  en el log (antes warning, y había que activarlo). No cambia ninguna
  respuesta de la API ni el aislamiento efectivo — la aplicación sigue
  conectando con el usuario de arranque. Se puede volver al comportamiento
  anterior con `RLS_ENFORCEMENT=warn` (u `off`). El aislamiento real a nivel
  de base de datos (rol `didacta_app`) llega en una próxima versión.

#### Changed

- **Aislamiento por tenant (RLS), fase 3 — telemetría en `on` por defecto**:
  `RLS_ENFORCEMENT` pasa de `warn` a `on`. Cualquier operación sin contexto de
  tenant que una instalación destape con una configuración distinta a las
  cubiertas por tests sale a log-error sin romper nada.
- **Webhooks y workers escopados por tenant**: los webhooks de Stripe
  (billing y suscripciones, incluida la materialización de la membresía) y de
  Zoom resuelven primero el tenant dueño del evento (lookup global auditado) y
  procesan bajo su contexto; los workers de aprobación de comisiones de
  referidos y de expiración del periodo de gracia separan el barrido global
  del procesado por tenant. Última pieza del worklist previo a la activación
  del enforcement real.

#### Fixed

- **Validador de contratos vs módulos marketplace-style**: `module-doctor` ya
  no exige el campo legado `edition` a los `module.json` con el shape del
  marketplace (bloques `vendor`/`isolation`/`http`/`didacta`) y pasa a marcar
  como error las keys legadas (`edition`, `category`, `requiredLicenseFeature`)
  que el schema estricto del host rechazaría al instalar el módulo
  (`MANIFEST_SCHEMA_INVALID`). Se elimina `edition` del `module.json` del
  migrador de LearnDash, resolviendo la contradicción con sus tests de
  consistencia.

### [0.0.1-alpha.94] — 2026-08-03

#### Notes

- **Endurecimiento de seguridad y aislamiento por tenant.** Sin cambios de
  configuración para el operador. Un cambio de comportamiento a tener en
  cuenta si integras la API por tu cuenta: varios endpoints que antes
  aceptaban cualquier sesión autenticada ahora exigen el rol adecuado
  (respuesta **403** en vez de dejar pasar) — ver «Security» abajo.

#### Security

- **Control de acceso por rol en las escrituras del catálogo**: crear, editar,
  publicar, archivar y borrar cursos, módulos y lecciones
  (`/modules/courses/*`) exige rol formador o administrador. Antes cualquier
  usuario autenticado del tenant podía modificar el catálogo.
- **Invitaciones de matrícula protegidas**: listar, crear y revocar
  invitaciones (`/modules/learning/invitations`) exige rol formador o
  administrador.
- **Certificados por propiedad**: el detalle y la descarga de un certificado
  (`/modules/certificates/:id`, `/:id/download`) solo los sirve a su titular o
  al personal (formador/admin); una petición a un certificado ajeno responde
  **404**. La verificación pública compartible (`/verify/:id`) no cambia.
- **Registro de la instalación restringido**: los endpoints `/admin/registry/*`
  (opt-in/opt-out con Cloud) exigen sesión de super-admin.
- **White-label con sesión de administrador**: los endpoints Enterprise de
  white-label exigen sesión de administrador además de la capability
  `feat:white_label`.
- **Códigos de estado coherentes**: los rechazos por falta de rol devuelven
  **403** (había sesión, faltaba autorización) en lugar de 401 en más de 20
  endpoints de administración y módulos.
- **Contador de miembros de grupo**: unirse a un grupo es idempotente; repetir
  la acción ya no infla el contador de miembros.

#### Changed

- **Aislamiento por tenant (Row-Level Security), fase 2**: los endpoints
  públicos (resueltos por dominio, slug o ticket), los webhooks entrantes, los
  workers en segundo plano y el SSO establecen ahora su contexto de tenant de
  forma explícita, de cara al aislamiento por RLS. Sin cambios de
  comportamiento observable en esta versión (el enforcement real llega en una
  fase posterior); reduce el ruido de la telemetría interna.
- **Contratos de módulos**: el validador de contratos (`module-doctor`) coteja
  ahora `module.json` con el manifiesto del módulo y con la versión del núcleo,
  y vuelve a ejecutarse en cada push y pull request. Todos los módulos quedan
  alineados.

### [0.0.1-alpha.93] — 2026-08-03

#### Notes

- **Actualización mayor del runtime del backend**: NestJS 11 y Fastify 5.
  Sin cambios de API pública ni de configuración para el operador. Esta
  versión incluye una **migración de base de datos** (renombrado de las
  tablas del módulo de aula virtual) que se aplica automáticamente al
  arrancar, como siempre.

#### Changed

- Backend migrado a **NestJS 11 + Fastify 5** (`@fastify/static` 10, Swagger
  11). Se retiran dependencias sin uso (`@auth/core`, `@auth/prisma-adapter`).
- Las tablas de `mod.zoom-live` pasan del prefijo histórico `mod_zoom_` al
  canónico `mod_zoom_live_` (migración versionada no destructiva: RENAME de
  tablas, índices y claves foráneas). El validador de contratos de módulos
  (`module-doctor`) queda a **0 errores**; los módulos `mod.messaging`,
  `mod.resources` y `mod.surveys` estrenan README técnico.
- Endurecimiento del enforcement de RLS (fase 1): la autenticación por API
  key, el asistente de instalación y los streams SSE establecen ahora su
  contexto de tenant correctamente de cara al aislamiento por Row-Level
  Security; benchmark de latencia incluido en la suite de integración.

#### Fixed

- La extensión de RLS ya no extrae de su transacción las operaciones que
  forman parte de un `$transaction` propio de un servicio. En instalaciones
  con `RLS_ENFORCEMENT=warn` (el valor por defecto) esto podía provocar
  errores intermitentes de clave foránea al crear conversaciones de
  mensajería.
- La cola de despacho del outbox (BullMQ) encola de verdad: el identificador
  de job anterior era rechazado por BullMQ y todos los eventos caían en
  silencio al despacho síncrono. Los eventos siempre se entregaron; ahora
  además lo hacen por la cola con reintentos y backoff, como estaba
  diseñado.

### [0.0.1-alpha.92] — 2026-08-03

#### Notes

- Corte menor de mantenimiento: presentación pública de los tres viajes de
  captación en el README y actualización de dependencias.

#### Added

- **README: sección «Tres formas de llenar tu academia de alumnos»** — cómo
  conviven los tres caminos de captación (alta manual por invitación con
  grupo de acceso, venta de cursos sueltos desde el catálogo público con
  compra sin registro previo, y membresías con planes flexibles), más el
  registro con solicitud y verificadores componibles.

#### Changed

- Dependencias (revisión de Dependabot): `next` 15.5.15 → 15.5.22 (parches
  del runtime web) y `@auth/core` 0.37.4 → 0.41.3. El salto a
  `@fastify/static` 10 queda pospuesto hasta la migración a Fastify 5: el
  API corre Fastify 4 y Swagger UI usa esa librería en runtime.

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
