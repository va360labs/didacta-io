/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * AuditExportService — quinto piloto License SDK (`feat:reports.advanced_signed`).
 *
 * Construye un ZIP firmado con las entries del audit log de un tenant en un
 * rango concreto. El gating EE vive en el controller; este service confía en
 * que el caller ya pasó el guard.
 *
 * Decisiones de diseño:
 *
 *  - Reusamos `PrismaAuditLogService.list()` para no duplicar el filtro
 *    tenant-strict (mismo filtro que el panel /admin/auditoria). Pasamos un
 *    `limit` alto por si se exportan rangos largos; en producción esto se
 *    paginará con cursor (out of scope del piloto).
 *  - Serializamos a NDJSON (line-delimited JSON) para que sea apto a herramientas
 *    estándar (jq, awk) y para evitar cargar todo el array en consumidores
 *    grandes.
 *  - El manifest contiene SHA-256 de cada artefacto para detección de
 *    tampering posterior. Re-cálculo in situ en el validador offline.
 *  - La firma es HMAC-SHA256 sobre el contenido bruto del manifest. Clave
 *    derivada del tenantId (`HMAC(masterKey, tenantId)`) para aislar firmas
 *    por tenant — comprometer un export no compromete a otros.
 *  - Empaquetado con `adm-zip`: API síncrona, sin streaming. Suficiente para
 *    el piloto (audit log típico < 100 MB). Si supera RAM, migrar a archiver.
 */

import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import {
  AUDIT_REPORT_ENTRIES_FILENAME,
  AUDIT_REPORT_MANIFEST_FILENAME,
  AUDIT_REPORT_MANIFEST_VERSION,
  AUDIT_REPORT_SIGNATURE_ALGORITHM,
  AUDIT_REPORT_SIGNATURE_FILENAME,
  deriveTenantHmacKey,
  resolveAuditReportMasterKey,
  type AuditExportArtifact,
  type AuditExportEntry,
  type AuditExportManifest,
  type AuditExportRange,
  type AuditExportSignature,
  type AuditExportZipResult,
} from './audit-export.types';

/** Token DI para inyectar la masterKey en tests sin tocar process.env. */
export const AUDIT_EXPORT_MASTER_KEY_TOKEN = 'AUDIT_EXPORT_MASTER_KEY';

export interface BuildSignedZipOptions {
  /** Limite inferior (inclusivo). Si se omite, sin floor. */
  from?: Date;
  /** Limite superior (inclusivo). Si se omite, sin ceiling. */
  to?: Date;
  /**
   * Limite máximo de entries por export. Default 10_000. El controller debería
   * imponer un cap razonable; service no truncará silenciosamente — devuelve
   * lo que `list()` retorna.
   */
  limit?: number;
  /** Override del timestamp `generatedAt` (para tests deterministas). */
  now?: Date;
}

@Injectable()
export class AuditExportService {
  constructor(
    private readonly auditLog: PrismaAuditLogService,
    @Optional() @Inject(AUDIT_EXPORT_MASTER_KEY_TOKEN) private readonly injectedMasterKey?: string,
  ) {}

  /**
   * Construye el paquete ZIP firmado para un tenant + rango.
   *
   * Errores:
   *   - No lanza: si el rango está vacío, devuelve un ZIP con `entryCount: 0`.
   *   - El controller decide si servir 200 con ZIP vacío o 404; este piloto
   *     elige 200 (reproducible con `from > to`, p.e.) para que el operador
   *     pueda confirmar que no hay tampering en el rango pedido.
   */
  async buildSignedZip(
    tenantId: string,
    options: BuildSignedZipOptions = {},
  ): Promise<AuditExportZipResult> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 10_000;

    // 1. Listado filtrado por tenant + rango (reusa el list() del audit log).
    const rows = await this.auditLog.list(tenantId, {
      dateFrom: options.from,
      dateTo: options.to,
      limit,
    });

    // 2. Serialización a NDJSON. Una entry por línea, sin trailing newline
    //    extra (algunas herramientas como jq -c lo manejan, otras no — el
    //    validador offline tolera ambos casos).
    const entries: AuditExportEntry[] = rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: r.metadata,
      ip: r.ip,
      userAgent: r.userAgent,
      timestamp: r.timestamp.toISOString(),
    }));
    const ndjson =
      entries.length === 0 ? '' : entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const entriesBuf = Buffer.from(ndjson, 'utf8');

    // 3. Construcción del manifest con SHA-256 del NDJSON.
    const range: AuditExportRange = {
      from: options.from ? options.from.toISOString() : null,
      to: options.to ? options.to.toISOString() : null,
    };
    const entriesArtifact: AuditExportArtifact = {
      name: AUDIT_REPORT_ENTRIES_FILENAME,
      size: entriesBuf.length,
      sha256: sha256Hex(entriesBuf),
    };

    const manifest: AuditExportManifest = {
      version: AUDIT_REPORT_MANIFEST_VERSION,
      tenantId,
      generatedAt: now.toISOString(),
      range,
      entryCount: entries.length,
      artefactos: [entriesArtifact],
      signatureAlgorithm: AUDIT_REPORT_SIGNATURE_ALGORITHM,
    };
    // Serialización canónica del manifest: indent 2, key order el del objeto.
    // Importante: NO usamos JSON.stringify "estable por keys" — el receptor
    // valida sobre los BYTES exactos del archivo, no sobre la semántica JSON.
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // 4. Firma HMAC-SHA256 sobre los bytes del manifest, con clave derivada
    //    del tenantId. La masterKey viene de DI o del entorno.
    const masterKey = this.injectedMasterKey ?? resolveAuditReportMasterKey();
    const tenantKey = deriveTenantHmacKey(masterKey, tenantId);
    const signature: AuditExportSignature = {
      algorithm: AUDIT_REPORT_SIGNATURE_ALGORITHM,
      manifestSha256: sha256Hex(manifestBuf),
      signatureHmacSha256: createHmac('sha256', tenantKey).update(manifestBuf).digest('hex'),
    };
    const signatureBuf = Buffer.from(JSON.stringify(signature, null, 2) + '\n', 'utf8');

    // 5. Empaquetado del ZIP. adm-zip API síncrona — el ZIP queda en RAM.
    const zip = new AdmZip();
    zip.addFile(AUDIT_REPORT_MANIFEST_FILENAME, manifestBuf);
    zip.addFile(AUDIT_REPORT_ENTRIES_FILENAME, entriesBuf);
    zip.addFile(AUDIT_REPORT_SIGNATURE_FILENAME, signatureBuf);

    const filename = buildFilename(tenantId, range);
    return { zip: zip.toBuffer(), manifest, signature, filename };
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Nombre sugerido para el archivo descargado. Ejemplo:
 *   audit-tenant-1-2026-04-01_2026-04-30.zip
 *
 * Si no hay rango, se cae a `audit-{tenantId}-full-{ISO}.zip` con el timestamp
 * del momento de generación. Sanitizamos `:` y `T` del ISO para que el
 * filename sea válido en Windows.
 */
function buildFilename(tenantId: string, range: AuditExportRange): string {
  const safe = (v: string) => v.replace(/[:T]/g, '-');
  if (range.from && range.to) {
    return `audit-${tenantId}-${safe(range.from.slice(0, 10))}_${safe(range.to.slice(0, 10))}.zip`;
  }
  if (range.from) {
    return `audit-${tenantId}-from-${safe(range.from.slice(0, 10))}.zip`;
  }
  if (range.to) {
    return `audit-${tenantId}-to-${safe(range.to.slice(0, 10))}.zip`;
  }
  return `audit-${tenantId}-full-${safe(new Date().toISOString())}.zip`;
}
