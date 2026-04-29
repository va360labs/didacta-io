# Didacta Enterprise — features and activation

> Under the Didacta Enterprise License (see `/LICENSE_EE`).
>
> ⚠️ **DRAFT — under legal review.** Feature list is provisional and pending product confirmation.

## What is Enterprise

Didacta Enterprise is the same software as Community **with additional advanced features unlocked** by a signed license key. The Docker image is the same; the difference is the `DIDACTA_LICENSE_KEY` environment variable (or the activation entered in the admin panel).

## Why a signed license

Enterprise features (files matching `*.ee.*` or under `ee/` / `*.ee/` folders) are gated at runtime by the License SDK, which verifies a JWT signed with our Ed25519 private key. The signature ensures that nobody can forge or extend a license without our private key.

## Provisional list of Enterprise features

> The final list is decided by product. This document is updated as features ship.

### Auth & SSO

- `feat:sso.saml` — SAML 2.0 corporate SSO.
- `feat:sso.oidc` — OIDC corporate SSO.
- `feat:scim` — SCIM provisioning.
- `feat:mfa.enforcement` — Mandatory MFA at organization level.

### Multi-tenancy

- `feat:multi_tenant.real` — Real multi-tenancy (multiple isolated organizations on one instance).

### Branding

- `feat:white_label` — Branding customization, custom logos.
- `feat:custom_domains` — Per-tenant custom domains.

### Audit & compliance

- `feat:audit_advanced` — Long retention, signed exports of audit logs.
- `feat:fundae` — Spanish Fundae regulatory compliance package.

### AI

- `feat:ai.premium` — Premium AI tutor / grader with no soft caps.
- `feat:ai.rag.enterprise` — Enterprise-grade RAG with private indexes.

### Reporting

- `feat:reports_advanced` — Advanced corporate reports, scheduled exports.

### Integrations

- `feat:zoom_live` — Zoom live virtual classroom integration.
- `feat:migrators.moodle` — Moodle migrator.
- `feat:migrators.learndash` — LearnDash migrator.
- `feat:migrators.ispring` — iSpring migrator.

### API

- `feat:api.webhooks.outbound` — Outbound webhooks at scale.
- `feat:api.rate_limit.high` — Elevated API rate limits.

## How to activate

### Option A — Environment variable

```bash
export DIDACTA_LICENSE_KEY="eyJhbGciOiJFZERTQSI..."
docker compose up -d
```

### Option B — Admin panel

1. Open `/admin/license`.
2. Paste the license key.
3. Save. The instance reloads license state without restart.

## Verification

The License SDK verifies:

1. JWT signature with the embedded Ed25519 public key (`packages/license-sdk/src/public-keys/`).
2. Issuer `iss=didacta.io`.
3. Audience `aud=didacta-runtime`.
4. Expiration (`exp`) with optional grace period.
5. Domain constraints (if set in license).

The state of the license is visible in the admin panel: Active / Grace / Expired / Invalid / Community.

## How to get a license

Email **licensing@didacta.io** or sign up at **cloud.didacta.io** (Cloud licenses are auto-provisioned).

## Air-gapped operation

By default, the SDK does NOT phone home. Validation is offline. If you operate in an air-gapped environment (regulated industries, public sector), this is the default. Online refresh can be enabled via `DIDACTA_LICENSE_REFRESH_ENABLED=true` for organizations that prefer it.
