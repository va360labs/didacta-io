/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTOs Zod para los endpoints de `custom-domains`. El gating runtime lo hace
 * el controller con @RequiresCapability(LICENSE_CAPABILITIES.CUSTOM_DOMAINS) —
 * los DTOs en sí son CE para que cualquier consumidor del API conozca el
 * shape esperado.
 *
 * Validación de hostname (versión simplificada de RFC 1035 / RFC 1123):
 *   - lowercase (no aceptamos mayúsculas; el cliente debe normalizar)
 *   - sin protocolo (`http://`, `https://`)
 *   - sin path, query ni fragment
 *   - sin puerto
 *   - al menos un punto (forzamos TLD; `localhost` se rechaza a propósito —
 *     en plan community los tenants ya tienen `localhost:3000` por defecto)
 *   - cada label entre 1 y 63 chars, longitud total <= 253
 *   - sólo chars [a-z0-9-], labels no pueden empezar/terminar con guión
 *
 * Internacionalización (IDN/punycode) queda fuera del piloto. Si un cliente
 * necesita `cliënt.es`, debe pasar el equivalente xn-- ya convertido.
 */

import { z } from 'zod';

/**
 * Regex simplificada de hostname:
 *   - 1+ labels separados por puntos
 *   - cada label: [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?
 *   - obliga al menos un punto (al menos un TLD)
 */
const HOSTNAME_LABEL = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)';
const HOSTNAME_REGEX = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`);

/**
 * Schema de hostname reutilizable. Aplica:
 *   1. lowercase estricto
 *   2. longitud total <= 253
 *   3. cada label <= 63 chars (cubierto por la regex)
 *   4. sin esquema/path/puerto (todos rechazados por la regex global)
 */
export const hostnameSchema = z
  .string({ message: 'hostname debe ser string' })
  .trim()
  .min(3, 'hostname demasiado corto')
  .max(253, 'hostname demasiado largo (máx. 253 caracteres)')
  .refine((v) => v === v.toLowerCase(), {
    message: 'hostname debe ir en minúsculas',
  })
  .refine((v) => !v.includes('://'), {
    message: 'hostname no debe llevar protocolo (ej: https://)',
  })
  .refine((v) => !v.includes('/'), {
    message: 'hostname no debe llevar path',
  })
  .refine((v) => !v.includes(':'), {
    message: 'hostname no debe llevar puerto',
  })
  .refine((v) => v.includes('.'), {
    message: 'hostname debe incluir TLD (ej: ejemplo.com)',
  })
  .refine((v) => HOSTNAME_REGEX.test(v), {
    message: 'hostname tiene caracteres inválidos o labels mal formados',
  });

/** POST /custom-domains body. */
export const addCustomDomainDtoSchema = z.object({
  hostname: hostnameSchema,
});
export type AddCustomDomainDto = z.infer<typeof addCustomDomainDtoSchema>;

/** POST /custom-domains/:id/verify body. */
export const verifyCustomDomainDtoSchema = z.object({
  providedToken: z
    .string({ message: 'providedToken debe ser string' })
    .trim()
    .min(1, 'providedToken requerido'),
});
export type VerifyCustomDomainDto = z.infer<typeof verifyCustomDomainDtoSchema>;

/**
 * PATCH /custom-domains/:id body. Permite cambiar el status entre `verified`
 * (re-activar) e `inactive` (suspender) sin perder el dominio. NO permite
 * volver a `pending` desde aquí (eso solo lo hace `addDomain`).
 */
export const setCustomDomainStatusDtoSchema = z.object({
  status: z.enum(['verified', 'inactive'], {
    message: 'status debe ser "verified" o "inactive"',
  }),
});
export type SetCustomDomainStatusDto = z.infer<typeof setCustomDomainStatusDtoSchema>;
