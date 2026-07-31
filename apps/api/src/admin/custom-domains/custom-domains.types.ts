/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos compartidos del módulo `custom-domains` (cuarto piloto License SDK).
 *
 * El backend persiste la lista de dominios personalizados del tenant en
 * `tenant_setting` (mismo patrón que `mfa-policy`):
 *   module_name='tenancy', key='custom-domains', is_secret=false.
 * El payload es un JSON con un array de dominios. Postgres JSONB acepta
 * arrays nativos sin problema (validado en MFA piloto y demás `tenant_setting`
 * existentes).
 *
 * La capability EE `feat:custom_domains` gatea TODOS los endpoints (CRUD
 * completo). Sin licencia EE el cliente recibe 402 vía LicenseExceptionFilter.
 *
 * En plan community los tenants se acceden vía `<slug>.didacta.io` o
 * `localhost:3000`; este piloto NO modifica el resolver de tenant (eso queda
 * fuera de scope) — sólo expone la gestión de la lista de dominios.
 */

export const CUSTOM_DOMAINS_MODULE_NAME = 'tenancy';
export const CUSTOM_DOMAINS_KEY = 'custom-domains';

/** Estados posibles de un dominio personalizado. */
export type CustomDomainStatus = 'pending' | 'verified' | 'inactive';

/**
 * Forma persistida de un dominio personalizado dentro de `tenant_setting`.
 *
 * - `id`: uuid generado al añadir el dominio. Estable durante toda su vida.
 * - `hostname`: nombre canónico (lowercase, sin protocolo). Validado por DTO
 *   contra una versión simplificada de RFC 1035 (sin punycode IDN, fuera de
 *   scope del piloto).
 * - `status`:
 *     - `pending` (default al crear): cliente aún no ha configurado DNS.
 *     - `verified`: el cron de DNS-01 challenge confirmó CNAME + TXT (en este
 *       piloto: forzado manualmente cuando el caller pasa el token correcto).
 *     - `inactive`: admin lo ha desactivado pero queda registrado.
 * - `cnameTarget`: valor que el cliente debe poner en su DNS (CNAME desde su
 *   hostname → este target). Default `cname.didacta.io`, override por env
 *   `DIDACTA_CNAME_TARGET`.
 * - `verificationToken`: TXT record sugerido para DNS-01 challenge. En el
 *   piloto se usa también como "shared secret" para que el endpoint
 *   `/verify` lo acepte sin hacer DNS lookup real.
 * - `createdAt`: ISO timestamp de creación.
 * - `verifiedAt`: ISO timestamp del cambio a `verified`. Null mientras no se
 *   haya validado.
 */
export interface CustomDomain {
  id: string;
  hostname: string;
  status: CustomDomainStatus;
  cnameTarget: string;
  verificationToken: string;
  createdAt: string;
  verifiedAt: string | null;
}

/** Estado persistido completo dentro de `tenant_setting`. */
export interface CustomDomainsConfig {
  domains: CustomDomain[];
}

/** Configuración por defecto cuando el tenant aún no ha registrado nada. */
export function defaultCustomDomainsConfig(): CustomDomainsConfig {
  return { domains: [] };
}

/**
 * Devuelve el CNAME target de la plataforma. Prioriza la variable de entorno
 * `DIDACTA_CNAME_TARGET`; si no está definida, cae a `cname.didacta.io`.
 *
 * Centralizado aquí para que los tests puedan stubbearlo y para no duplicar
 * el default en service y types.
 */
export function resolveCnameTarget(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['DIDACTA_CNAME_TARGET'];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return 'cname.didacta.io';
}
