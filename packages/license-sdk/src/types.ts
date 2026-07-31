/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos del License SDK.
 */

import { z } from 'zod';
import type { LicenseCapability } from './capabilities.js';

/**
 * Estado calculado de la licencia cargada en runtime.
 *
 * - `community`: sin licencia, modo CE puro (default).
 * - `active`: licencia válida, no expirada.
 * - `grace`: expirada pero dentro de `gracePeriodDays`.
 * - `expired`: expirada y fuera del grace; capabilities deshabilitadas.
 * - `invalid`: firma incorrecta o payload malformado.
 * - `dev`: bypass de desarrollo (solo si `NODE_ENV !== 'production'`).
 */
export type LicenseStatus = 'community' | 'active' | 'grace' | 'expired' | 'invalid' | 'dev';

/**
 * Schema Zod para el payload Didacta dentro del JWT.
 *
 * El JWT incluye claims estándar (iss, aud, exp, nbf, iat, sub) y un objeto
 * `didacta` con metadatos específicos del producto.
 */
export const licensePayloadSchema = z
  .object({
    iss: z.string(),
    aud: z.union([z.string(), z.array(z.string())]),
    exp: z.number(),
    iat: z.number(),
    nbf: z.number().optional(),
    sub: z.string().optional(),
    didacta: z.object({
      licenseId: z.string(),
      customerId: z.string(),
      organizationId: z.string(),
      organizationName: z.string().optional(),
      product: z.literal('didacta'),
      plan: z.string(),
      edition: z.enum(['community', 'enterprise', 'cloud']),
      issuedAt: z.string(),
      expiresAt: z.string(),
      gracePeriodDays: z.number().int().nonnegative().default(30),
      capabilities: z.array(z.string()),
      constraints: z
        .object({
          allowedDomains: z.array(z.string()).optional(),
          environment: z.string().optional(),
          version: z.string().optional(),
        })
        .optional(),
      support: z
        .object({
          tier: z.string().optional(),
          slaResponseHours: z.number().int().positive().optional(),
        })
        .optional(),
    }),
  })
  .passthrough();

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** Información concreta del cliente, derivada del payload. */
export interface LicenseSubject {
  licenseId: string;
  customerId: string;
  organizationId: string;
  organizationName?: string;
  plan: string;
  edition: 'community' | 'enterprise' | 'cloud';
  issuedAt: Date;
  expiresAt: Date;
  capabilities: string[];
}

/** Estado completo del LicenseService. */
export interface LicenseState {
  status: LicenseStatus;
  payload?: LicensePayload;
  subject?: LicenseSubject;
  loadedAt: Date;
  source: 'env' | 'admin-panel' | 'config' | 'dev-bypass' | 'unknown';
  warnings: string[];
}

/** Tipos de error del SDK. */
export class CapabilityRequiredError extends Error {
  readonly code = 'DIDACTA_CAPABILITY_REQUIRED' as const;
  constructor(public readonly capability: LicenseCapability | string) {
    super(`Capability "${capability}" requires a valid Didacta Enterprise license.`);
    this.name = 'CapabilityRequiredError';
  }
}

export class LicenseSignatureError extends Error {
  readonly code = 'DIDACTA_LICENSE_SIGNATURE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LicenseSignatureError';
  }
}

export class LicenseExpiredError extends Error {
  readonly code = 'DIDACTA_LICENSE_EXPIRED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LicenseExpiredError';
  }
}
