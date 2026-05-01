/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Public entry point of @didacta/license-sdk.
 *
 * Backend: importar desde `@didacta/license-sdk`.
 * Frontend (React): importar desde `@didacta/license-sdk/react`.
 */

export {
  LICENSE_CAPABILITIES,
  ALL_CAPABILITIES,
  isKnownCapability,
  type LicenseCapability,
} from './capabilities.js';

export {
  licensePayloadSchema,
  CapabilityRequiredError,
  LicenseSignatureError,
  LicenseExpiredError,
  type LicensePayload,
  type LicenseSubject,
  type LicenseState,
  type LicenseStatus,
} from './types.js';

export { verifyLicense, resetPublicKeysCache, registerPublicKeyForTest } from './verifier.js';

export { LicenseService, type LoadOptions } from './runtime.js';

export {
  LicenseGuard,
  RequiresCapability,
  REQUIRES_CAPABILITY_KEY,
  LICENSE_SERVICE_TOKEN,
} from './guards.js';

export {
  LicenseModule,
  LicenseExceptionFilter,
  LICENSE_OPTIONS_TOKEN,
  type LicenseModuleOptions,
} from './nest.js';

export {
  RegistryClient,
  registerInputSchema,
  telemetrySnapshotSchema,
  type RegisterInput,
  type RegisterResponse,
  type TelemetrySnapshot,
  type RegistryClientOptions,
} from './registry/client.js';

export { toPublicLicenseState, type PublicLicenseState } from './public-state.js';
