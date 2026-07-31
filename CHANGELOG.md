# Changelog

> Todos los cambios notables del repo `didacta-community` se documentan aquí.
> Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
> Esquema de versiones: [SemVer](https://semver.org) estricto con pre-releases `0.0.1-alpha.N`.

## [Unreleased]

### Added

- (Acumulando cambios para el siguiente tag.)

### [0.0.1-alpha.88-va360] — 2026-07-31

#### Notes

- **Congelación de la era a-medida.** Entre `0.0.1-alpha.82` y este tag, el repo
  sirvió en exclusiva al despliegue a medida de `aula.va360.academy`, sin
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
