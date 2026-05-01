/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTOs Zod para el 9º piloto License SDK (`feat:sso.saml`).
 *
 * Validaciones clave:
 *   - idpEntityId: string no vacío hasta 1024 chars (URNs SAML pueden ser largas).
 *   - idpSsoUrl: HTTPS estricto (acepta http://localhost para tests).
 *   - idpCertificate: PEM con cabecera BEGIN/END CERTIFICATE.
 *   - allowedEmailDomains: array de domains lowercase sin @.
 *   - attributeMapping.email: obligatorio, no vacío.
 *
 * Edge cases:
 *   - El cert puede venir con o sin trailing newline. Normalizamos.
 *   - El cert puede tener line endings CRLF (Windows-pasted). Normalizamos a LF.
 *   - URLs con trailing slash las preservamos: SAML EntityID es case-sensitive y
 *     algunos IdPs distinguen `https://idp.example.com/sso` de `.../sso/`.
 */

import { z } from 'zod';

const httpsUrlRegex = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
const localhostUrlRegex = /^http:\/\/localhost(:\d{1,5})?(\/.*)?$/i;

const ssoUrlSchema = z
  .string()
  .trim()
  .min(8)
  .max(2048)
  .refine((v) => httpsUrlRegex.test(v) || localhostUrlRegex.test(v), {
    message: 'idpSsoUrl debe ser HTTPS (o http://localhost en dev)',
  });

const certPemSchema = z
  .string()
  .trim()
  .min(100)
  .max(16384)
  .transform((v) => v.replace(/\r\n/g, '\n').trim() + '\n')
  .refine(
    (v) => v.includes('-----BEGIN CERTIFICATE-----') && v.includes('-----END CERTIFICATE-----'),
    {
      message: 'El certificado debe estar en formato PEM con cabeceras BEGIN/END CERTIFICATE.',
    },
  );

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, {
    message: 'dominio inválido',
  });

const attributeNameSchema = z.string().trim().min(1).max(512);

const attributeMappingSchema = z.object({
  email: attributeNameSchema,
  firstName: attributeNameSchema.optional(),
  lastName: attributeNameSchema.optional(),
});

/**
 * Schema PUT /admin/sso/saml/config.
 *
 * El cert IdP es público, así que (a diferencia del clientSecret OIDC) lo
 * pedimos siempre completo en cada PUT — la rotación es trivial y no perdemos
 * nada por exigirlo.
 */
export const samlConfigPutSchema = z
  .object({
    enabled: z.boolean(),
    idpEntityId: z.string().trim().min(1).max(1024),
    idpSsoUrl: ssoUrlSchema,
    idpCertificate: certPemSchema,
    attributeMapping: attributeMappingSchema,
    allowedEmailDomains: z.array(domainSchema).max(50).default([]),
    autoProvisionUsers: z.boolean().default(false),
  })
  .strict();

export type SamlConfigPutDto = z.infer<typeof samlConfigPutSchema>;

/**
 * Schema POST /admin/sso/saml/test-connection.
 *
 * Sólo cert + URL — el admin puede probar antes de guardar. NO hace llamada
 * real al IdP (SAML no tiene discovery), sólo valida formato.
 */
export const samlTestConnectionSchema = z
  .object({
    idpSsoUrl: ssoUrlSchema,
    idpCertificate: certPemSchema,
  })
  .strict();

export type SamlTestConnectionDto = z.infer<typeof samlTestConnectionSchema>;
