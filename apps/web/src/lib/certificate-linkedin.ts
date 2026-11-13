/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Certificate } from '@/modules/certificates';

/**
 * URL del flujo "Add to Profile" de LinkedIn pre-rellenado con los datos del
 * certificado. `certUrl` apunta a la página pública de verificación
 * (`/verify/<id>`), así la credencial en LinkedIn es verificable.
 * `organizationName` es el nombre del tenant emisor (resuelto por host).
 * `courseName` viene ya resuelto por el caller (con su fallback traducido).
 */
export function linkedInAddUrl(
  cert: Pick<Certificate, 'id' | 'number' | 'issuedAt' | 'snapshot'>,
  organizationName: string,
  courseName: string,
  origin: string,
): string {
  const issued = new Date(cert.snapshot?.issuedAt ?? cert.issuedAt);
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: courseName,
    organizationName,
    certId: cert.number,
    certUrl: `${origin}/verify/${cert.id}`,
  });
  if (!Number.isNaN(issued.getTime())) {
    params.set('issueYear', String(issued.getFullYear()));
    params.set('issueMonth', String(issued.getMonth() + 1));
  }
  return `https://www.linkedin.com/profile/add?${params.toString()}`;
}

/** Abre ese flujo en una pestaña nueva. */
export function openLinkedIn(cert: Certificate, organizationName: string, courseName: string) {
  window.open(
    linkedInAddUrl(cert, organizationName, courseName, window.location.origin),
    '_blank',
    'noopener,noreferrer',
  );
}
