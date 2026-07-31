/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { XMLParser } from 'fast-xml-parser';

export interface ScormManifestParsed {
  /** "1.2" o "2004" — derivado del schemaversion. */
  version: '1.2' | '2004';
  /** Path relativo al asset que se carga primero (entry del player). */
  entryPath: string;
  /** Lista de organizations declaradas (para diagnóstico futuro). */
  organizations: string[];
  /** Resumen del manifest (opcional, útil para guardar en DB). */
  raw: Record<string, unknown>;
}

export class ScormManifestError extends Error {
  constructor(
    public readonly code: 'INVALID_XML' | 'NO_RESOURCES' | 'NO_ENTRY' | 'UNSUPPORTED_VERSION',
    message: string,
  ) {
    super(message);
    this.name = 'ScormManifestError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

/**
 * Parsea el contenido de imsmanifest.xml y devuelve la metadata necesaria
 * para registrar un paquete SCORM en la plataforma.
 *
 * Soporta SCORM 1.2 (<schemaversion>1.2</schemaversion>) y SCORM 2004
 * (<schemaversion>CAM 1.3</schemaversion> o "2004 X Edition").
 *
 * El entry se resuelve buscando el primer <resource> con scormType="sco" o,
 * si no hay, el primer resource con href definido.
 */
export function parseScormManifest(xml: string): ScormManifestParsed {
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new ScormManifestError('INVALID_XML', `XML inválido: ${(err as Error).message}`);
  }

  const manifest = (parsed['manifest'] ?? parsed['imsmanifest']) as
    | Record<string, unknown>
    | undefined;
  if (!manifest) {
    throw new ScormManifestError('INVALID_XML', 'No se encontró elemento <manifest>');
  }

  const version = detectVersion(manifest);
  const entryPath = findEntryPath(manifest);
  if (!entryPath) {
    throw new ScormManifestError('NO_ENTRY', 'El manifest no declara un resource con href válido');
  }

  const organizations = extractOrganizationIds(manifest);

  return {
    version,
    entryPath,
    organizations,
    raw: manifest,
  };
}

function detectVersion(manifest: Record<string, unknown>): '1.2' | '2004' {
  const metadata = manifest['metadata'] as Record<string, unknown> | undefined;
  const schemaversion = metadata?.['schemaversion'];
  const text = typeof schemaversion === 'string' ? schemaversion : '';
  const lower = text.toLowerCase();
  if (lower.includes('1.2')) return '1.2';
  if (lower.includes('1.3') || lower.includes('2004') || lower.includes('cam')) return '2004';
  // Fallback: si no se reconoce, asumimos 1.2 (más permisivo, soporta runtime menos rígido).
  return '1.2';
}

function findEntryPath(manifest: Record<string, unknown>): string | null {
  const resources = (manifest['resources'] as Record<string, unknown> | undefined)?.[
    'resource'
  ] as unknown;
  if (!resources) {
    throw new ScormManifestError('NO_RESOURCES', 'El manifest no tiene <resources>');
  }
  const list = Array.isArray(resources) ? resources : [resources];

  // Preferir resource con scormType="sco".
  const sco = list.find((r) => {
    const obj = r as Record<string, unknown>;
    const scormType = (obj['@_scormType'] ??
      obj['@_adlcp:scormtype'] ??
      obj['@_adlcp:scormType']) as string | undefined;
    return scormType?.toLowerCase() === 'sco';
  });
  const target = sco ?? list[0];
  if (!target) return null;
  const href = (target as Record<string, unknown>)['@_href'] as string | undefined;
  return href && href.length > 0 ? href : null;
}

function extractOrganizationIds(manifest: Record<string, unknown>): string[] {
  const orgs = (manifest['organizations'] as Record<string, unknown> | undefined)?.[
    'organization'
  ] as unknown;
  if (!orgs) return [];
  const list = Array.isArray(orgs) ? orgs : [orgs];
  return list
    .map((o) => (o as Record<string, unknown>)['@_identifier'])
    .filter((id): id is string => typeof id === 'string');
}
