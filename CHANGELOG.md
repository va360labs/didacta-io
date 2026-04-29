# Changelog

> Todos los cambios notables del repo `didacta-community` se documentan aquí.
> Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
> Esquema de versiones: ver [`docs/versioning.md`](docs/versioning.md).

## [Unreleased]

### Added
- (Acumulando cambios para el siguiente tag.)

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

Ver [`docs/versioning.md`](docs/versioning.md). TL;DR: SemVer estricto, pre-releases `-alpha.N` / `-beta.N` / `-rc.N`, `:latest` en Docker NUNCA apunta a pre-release.
