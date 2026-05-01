/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * LICENSE_CAPABILITIES — lista cerrada de capabilities Enterprise (transversales del core).
 *
 * Aprobada por producto el 2026-04-29. En el modelo "WordPress matizado":
 *   - Los módulos son siempre Community.
 *   - Las capabilities aquí declaradas se gatean por licencia firmada (ES256).
 *
 * Cualquier código que extiende capabilities EE debe vivir en archivos `*.ee.ts`
 * dentro del CORE (apps/api/src/, packages/core-kernel/, packages/license-sdk/src/),
 * NUNCA dentro de modules/*.
 */

export const LICENSE_CAPABILITIES = {
  /** Multi-tenant real: múltiples organizaciones aisladas en una instancia. */
  MULTI_TENANT_REAL: 'feat:multi_tenant.real',

  /** Login corporativo SAML 2.0. */
  SSO_SAML: 'feat:sso.saml',

  /** Login corporativo OIDC. */
  SSO_OIDC: 'feat:sso.oidc',

  /** Provisioning automático SCIM desde Okta/Entra/etc. */
  SCIM: 'feat:scim',

  /** Forzar MFA a nivel organización (CE permite MFA opcional). */
  MFA_ENFORCEMENT: 'feat:mfa.enforcement',

  /** Branding customizado (logo, colores, ocultar Didacta). */
  WHITE_LABEL: 'feat:white_label',

  /** Dominios personalizados por tenant. */
  CUSTOM_DOMAINS: 'feat:custom_domains',

  /** Logs auditoría 7 años firmados (CE: 90 días). */
  AUDIT_LONG_RETENTION: 'feat:audit.long_retention',

  /** Exportes XLSX/PDF firmados criptográficamente. */
  REPORTS_ADVANCED_SIGNED: 'feat:reports.advanced_signed',

  /** Webhooks salientes con SLA + reintentos avanzados. */
  API_WEBHOOKS_HIGH_THROUGHPUT: 'feat:api.webhooks.high_throughput',

  /** Cuotas API más altas que Community por defecto. */
  API_RATE_LIMIT_ELEVATED: 'feat:api.rate_limit.elevated',
} as const;

export type LicenseCapability = (typeof LICENSE_CAPABILITIES)[keyof typeof LICENSE_CAPABILITIES];

/**
 * Lista de todas las capabilities conocidas por el SDK. Útil para validaciones,
 * diagnostics y filtrado de payload de licencia.
 */
export const ALL_CAPABILITIES: readonly LicenseCapability[] = Object.freeze(
  Object.values(LICENSE_CAPABILITIES),
);

/** Type-guard: ¿es esta string una capability conocida? */
export function isKnownCapability(value: string): value is LicenseCapability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}
