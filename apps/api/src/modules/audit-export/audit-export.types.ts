/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos compartidos del módulo `audit-export` (quinto piloto License SDK —
 * `feat:reports.advanced_signed`).
 *
 * El backend genera un paquete ZIP firmado con el listado del audit log de un
 * tenant en un rango de fechas concreto. La estructura del ZIP es:
 *
 *   manifest.json        — metadatos + SHA-256 de cada artefacto
 *   audit-entries.ndjson — entries serializadas (line-delimited JSON)
 *   signature.json       — HMAC-SHA256 del manifest.json
 *
 * Usamos NDJSON para que el formato sea apto a streaming y a herramientas
 * estándar de análisis (jq, grep, awk). Cada línea es una entry independiente,
 * lo que evita cargar todo el array en memoria en consumidores grandes.
 *
 * IMPORTANTE — limitación criptográfica del piloto:
 * La "firma" es HMAC-SHA256 con clave derivada de `AUDIT_REPORT_HMAC_KEY` (env)
 * + `tenantId`. Esto es PSEUDO-FIRMA: garantiza integridad y autenticidad
 * frente al servidor que tenga la clave compartida, pero NO es no-repudio
 * verificable por terceros (eso requiere firma asimétrica X.509). En
 * producción, este HMAC se sustituye por una firma RSA-SHA256 / ECDSA con
 * la clave privada del tenant. El validador offline está diseñado para que
 * la migración a X.509 sea drop-in (mismo manifest, mismo signature.json,
 * cambia el algoritmo).
 */

/** Schema version del manifest. Cambiar al introducir breaking changes. */
export const AUDIT_REPORT_MANIFEST_VERSION = 'v1-audit-signed';

/** Algoritmo de firma del piloto. En producción: 'RSA-SHA256' o 'ECDSA-P256'. */
export const AUDIT_REPORT_SIGNATURE_ALGORITHM = 'HMAC-SHA256';

/** Clave HMAC por defecto para tests/dev cuando la env no está set. */
export const AUDIT_REPORT_HMAC_FALLBACK_KEY =
  'didacta-audit-report-hmac-fallback-do-not-use-in-prod';

/** Nombre del archivo de entries dentro del ZIP. */
export const AUDIT_REPORT_ENTRIES_FILENAME = 'audit-entries.ndjson';

/** Nombre del manifest dentro del ZIP. */
export const AUDIT_REPORT_MANIFEST_FILENAME = 'manifest.json';

/** Nombre del archivo de firma dentro del ZIP. */
export const AUDIT_REPORT_SIGNATURE_FILENAME = 'signature.json';

/**
 * Forma serializada de una entry dentro del NDJSON. Espejo del shape devuelto
 * por `PrismaAuditLogService.list()`, con `timestamp` ya en ISO string para
 * que sea estable cross-platform y trivial de consumir desde otros runtimes.
 */
export interface AuditExportEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  timestamp: string;
}

/** Rango temporal aplicado al filtro de entries. Strings ISO 8601. */
export interface AuditExportRange {
  /** Limite inferior (inclusivo). Null si no se aplicó. */
  from: string | null;
  /** Limite superior (inclusivo). Null si no se aplicó. */
  to: string | null;
}

/**
 * Entrada del manifest por cada artefacto incluido en el ZIP. El SHA-256 se
 * calcula sobre el contenido bruto en bytes — los consumidores deben re-leer
 * el archivo del ZIP y volver a hashear para validar.
 */
export interface AuditExportArtifact {
  name: string;
  size: number;
  sha256: string;
}

/** Forma persistida del `manifest.json` dentro del ZIP. */
export interface AuditExportManifest {
  version: typeof AUDIT_REPORT_MANIFEST_VERSION;
  tenantId: string;
  generatedAt: string;
  range: AuditExportRange;
  entryCount: number;
  artefactos: AuditExportArtifact[];
  signatureAlgorithm: typeof AUDIT_REPORT_SIGNATURE_ALGORITHM;
}

/** Forma persistida del `signature.json` dentro del ZIP. */
export interface AuditExportSignature {
  algorithm: typeof AUDIT_REPORT_SIGNATURE_ALGORITHM;
  /** SHA-256 hex del `manifest.json` sobre el que se calculó la firma. */
  manifestSha256: string;
  /** Firma HMAC-SHA256(manifestBytes, derivedKey) en hex. */
  signatureHmacSha256: string;
}

/** Resultado del builder: el ZIP en memoria + metadatos del export. */
export interface AuditExportZipResult {
  zip: Buffer;
  manifest: AuditExportManifest;
  signature: AuditExportSignature;
  filename: string;
}

/**
 * Deriva la clave HMAC para un tenant concreto. La política es:
 *
 *   key = HMAC-SHA256(masterKey, tenantId)
 *
 * Esto evita que el `masterKey` se exponga en el ZIP y aísla la firma por
 * tenant: comprometer un export no permite forjar firmas de otros tenants.
 *
 * En producción, `masterKey` se reemplaza por una clave privada X.509 del
 * tenant (HSM o KMS). Aquí mantenemos el contrato simétrico para que el
 * validador offline pueda verificar sin intercambio de claves.
 */
export function deriveTenantHmacKey(masterKey: string, tenantId: string): Buffer {
  // Importación local para que las consumidoras de este módulo (controllers,
  // tests) no acoplen `node:crypto` salvo que llamen a esta función.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  return createHmac('sha256', masterKey).update(tenantId).digest();
}

/**
 * Resuelve la masterKey HMAC desde el entorno con fallback al valor de tests.
 * Centralizado para que tanto el service como el validador offline (si vive en
 * el mismo runtime) usen la misma fuente.
 *
 * El validador offline (`tools/audit-report-verify.mjs`) recibe la masterKey
 * por flag `--key` o env y NO depende de esta función.
 */
export function resolveAuditReportMasterKey(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['AUDIT_REPORT_HMAC_KEY'];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return AUDIT_REPORT_HMAC_FALLBACK_KEY;
}
