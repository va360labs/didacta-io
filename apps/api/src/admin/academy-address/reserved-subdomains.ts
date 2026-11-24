/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Subdominios que un aula NUNCA puede elegir como dirección.
 *
 * Copia LITERAL de `RESERVED_SLUGS` del plano de control de Didacta Cloud
 * (`didacta-cloud/apps/cloud-api/src/provisioning/slug.ts`), que es la lista con
 * la que Cloud da subdominio a las aulas nuevas. Las dos tienen que ser la
 * misma: si un aula pudiera cambiarse a un nombre que Cloud nunca concede
 * (`support`, `billing`, `login`…), quedaría a un paso de que un correo suyo
 * pareciera de Didacta, que es justo lo que la lista evita.
 *
 * Es una copia y no un import a propósito: Cloud no comparte código con el
 * producto (ADR-001 de Cloud) y este repositorio es público. El test
 * `reserved-subdomains.test.ts` congela su contenido; si cambia allí, se cambia
 * aquí a mano y el test con él.
 *
 * En una instalación propia la lista también aplica: son nombres de
 * infraestructura (`www`, `mail`, `api`…) que ningún aula debería tener.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  // De UC-C402 AC3
  'www',
  'api',
  'docs',
  'registry',
  'dev',
  'admin',
  'app',
  'status',
  'cdn',
  'static',
  'mail',
  'smtp',
  'mx',
  'ns1',
  'ns2',
  // Infraestructura y correo
  'ns',
  'ns3',
  'imap',
  'pop',
  'webmail',
  'autodiscover',
  'autoconfig',
  'mta-sts',
  'dmarc',
  'spf',
  'dkim',
  // Servicios propios, presentes o previstos
  'cloud',
  'panel',
  'console',
  'dashboard',
  'staging',
  'test',
  'demo',
  'preview',
  'canary',
  'grafana',
  'metrics',
  'assets',
  'files',
  'media',
  'download',
  'downloads',
  'blog',
  'help',
  'support',
  'billing',
  'pay',
  'checkout',
  'login',
  'signin',
  'signup',
  'account',
  'accounts',
  'auth',
  'sso',
  'id',
  'security',
  'legal',
  'privacy',
  'terms',
  'root',
  'localhost',
]);

/** ¿Está reservado? Se compara en minúsculas y sin espacios. */
export function isReservedSubdomain(label: string): boolean {
  return RESERVED_SUBDOMAINS.has(label.trim().toLowerCase());
}
