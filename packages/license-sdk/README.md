# `@didacta/license-sdk`

> Didacta License SDK — verifies signed JWT licenses (ECDSA P-256 / ES256) for Enterprise capabilities and integrates with the opt-in registry of installations.

## Overview

In the Didacta WordPress-matizado model:

- All modules under `modules/*` are Community (free).
- Enterprise capabilities live in the **core** as `*.ee.ts` files (e.g. multi-tenant, SCIM, white-label, audit retention).
- This SDK verifies JWT licenses signed by AWS KMS (`alias/didacta-issuer-2026`, `eu-west-1`) and gates Enterprise capabilities at runtime.

## Public API

### NestJS

```ts
import { LicenseService, RequiresCapability, LICENSE_CAPABILITIES } from '@didacta/license-sdk';

@Controller('admin/multi-tenant')
export class MultiTenantController {
  @Post('create')
  @RequiresCapability(LICENSE_CAPABILITIES.MULTI_TENANT_REAL)
  createTenant(@Body() dto: CreateTenantDto) {
    // Only reachable with valid license that includes the capability.
  }
}
```

### Service-level

```ts
constructor(private license: LicenseService) {}

async someFlow() {
  if (this.license.isCapabilityEnabled(LICENSE_CAPABILITIES.WHITE_LABEL)) {
    return this.applyWhiteLabel();
  }
  return this.applyDefaultBranding();
}
```

### React (frontend)

```tsx
import { useLicense, EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';

export function SamlSettings() {
  return (
    <EeGate capability={LICENSE_CAPABILITIES.SSO_SAML} mode="locked">
      <SamlConfigurationPanel />
    </EeGate>
  );
}
```

## States

The SDK distinguishes 6 states:

| State       | Meaning                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `community` | No license set. Default.                                                                                |
| `active`    | License signature valid, not expired.                                                                   |
| `grace`     | License expired but inside `gracePeriodDays` (default 30). Capabilities still work, warnings prominent. |
| `expired`   | Past grace period. Capabilities disabled.                                                               |
| `invalid`   | Signature invalid or malformed. Capabilities disabled.                                                  |
| `dev`       | Development bypass. Only when `NODE_ENV !== 'production'` and `DIDACTA_DEV_BYPASS=true`.                |

## Boot

```ts
// apps/api/src/main.ts
const license = app.get(LicenseService);
await license.load({
  key: process.env.DIDACTA_LICENSE_KEY,
  allowDevBypass: process.env.DIDACTA_DEV_BYPASS === 'true',
});
```

## Crypto

- Algorithm: **ECDSA P-256 + SHA-256** (`ES256`).
- Public keys: `src/public-keys/didacta-issuer-<year>.pem`.
- Private keys: **never** in this repo. Held inside AWS KMS (`alias/didacta-issuer-2026`, `eu-west-1`) using `kms:Sign` operation.

## Registry opt-in client

The SDK also exposes a `RegistryClient` for the opt-in installation registration system:

- `register(input)` — registers the instance with `cloud.didacta.io`.
- `sendTelemetry(snapshot)` — sends nightly aggregated metrics.

See `src/registry/` for details.
