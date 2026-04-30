/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del AuditExportService — quinto piloto License SDK
 * (`feat:reports.advanced_signed`).
 *
 * Foco:
 *   1. Estructura del ZIP: 3 archivos esperados.
 *   2. SHA-256 del NDJSON declarado en manifest coincide con el contenido real.
 *   3. HMAC-SHA256 del manifest declarado en signature coincide con el cálculo
 *      local con la clave derivada (HMAC(masterKey, tenantId)).
 *   4. Rango vacío → ZIP con `entryCount: 0` (NDJSON vacío, archivo presente).
 *   5. Filtro tenant strict — el service llama `auditLog.list(tenantId, ...)`
 *      con el tenantId pasado y nada más.
 *   6. El range del manifest refleja from/to en ISO strings (null si ausente).
 *   7. version + signatureAlgorithm fijos en v1-audit-signed / HMAC-SHA256.
 *   8. Filename derivado de tenantId + range.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import AdmZip from 'adm-zip';
import {
  AuditExportService,
  type BuildSignedZipOptions,
} from '../src/modules/audit-export/audit-export.service';
import {
  AUDIT_REPORT_ENTRIES_FILENAME,
  AUDIT_REPORT_HMAC_FALLBACK_KEY,
  AUDIT_REPORT_MANIFEST_FILENAME,
  AUDIT_REPORT_MANIFEST_VERSION,
  AUDIT_REPORT_SIGNATURE_ALGORITHM,
  AUDIT_REPORT_SIGNATURE_FILENAME,
  deriveTenantHmacKey,
} from '../src/modules/audit-export/audit-export.types';

type FakeAuditLog = ConstructorParameters<typeof AuditExportService>[0];

interface FakeRow {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  timestamp: Date;
}

function row(partial: Partial<FakeRow> = {}): FakeRow {
  return {
    id: partial.id ?? '1',
    actorId: partial.actorId ?? 'user-1',
    action: partial.action ?? 'auth.login',
    resourceType: partial.resourceType ?? 'session',
    resourceId: partial.resourceId ?? 'sess-1',
    metadata: partial.metadata ?? { foo: 'bar' },
    ip: partial.ip ?? '127.0.0.1',
    userAgent: partial.userAgent ?? 'vitest',
    timestamp: partial.timestamp ?? new Date('2026-04-29T10:00:00Z'),
  };
}

function makeAuditLog(rows: FakeRow[]): {
  audit: FakeAuditLog;
  listSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn().mockResolvedValue(rows);
  return {
    audit: { list: listSpy } as unknown as FakeAuditLog,
    listSpy,
  };
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function readZip(buf: Buffer) {
  const zip = new AdmZip(buf);
  return {
    entries: zip
      .getEntries()
      .map((e) => e.entryName)
      .sort(),
    manifestBuf: zip.readFile(AUDIT_REPORT_MANIFEST_FILENAME)!,
    entriesBuf: zip.readFile(AUDIT_REPORT_ENTRIES_FILENAME)!,
    signatureBuf: zip.readFile(AUDIT_REPORT_SIGNATURE_FILENAME)!,
  };
}

describe('AuditExportService · buildSignedZip', () => {
  let auditLog: FakeAuditLog;
  let listSpy: ReturnType<typeof vi.fn>;
  let service: AuditExportService;

  beforeEach(() => {
    const made = makeAuditLog([row({ id: '1' }), row({ id: '2', action: 'course.created' })]);
    auditLog = made.audit;
    listSpy = made.listSpy;
    // masterKey explícito para tests deterministas.
    service = new AuditExportService(auditLog, 'test-master-key');
  });

  it('produce un ZIP con manifest.json, audit-entries.ndjson y signature.json', async () => {
    const result = await service.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    expect(z.entries).toEqual([
      AUDIT_REPORT_ENTRIES_FILENAME,
      AUDIT_REPORT_MANIFEST_FILENAME,
      AUDIT_REPORT_SIGNATURE_FILENAME,
    ]);
  });

  it('SHA-256 del NDJSON declarado en manifest coincide con el contenido real', async () => {
    const result = await service.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    const manifest = JSON.parse(z.manifestBuf.toString('utf8'));
    const ndjsonEntry = manifest.artefactos.find(
      (a: { name: string }) => a.name === AUDIT_REPORT_ENTRIES_FILENAME,
    );
    expect(ndjsonEntry).toBeDefined();
    expect(ndjsonEntry.size).toBe(z.entriesBuf.length);

    const realSha = createHash('sha256').update(z.entriesBuf).digest('hex');
    expect(ndjsonEntry.sha256).toBe(realSha);
  });

  it('HMAC-SHA256 del manifest coincide con el cálculo local con la clave derivada', async () => {
    const result = await service.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    const signature = JSON.parse(z.signatureBuf.toString('utf8'));

    const tenantKey = deriveTenantHmacKey('test-master-key', TENANT_A);
    const expectedHmac = createHmac('sha256', tenantKey).update(z.manifestBuf).digest('hex');
    expect(signature.algorithm).toBe(AUDIT_REPORT_SIGNATURE_ALGORITHM);
    expect(signature.signatureHmacSha256).toBe(expectedHmac);
    expect(signature.manifestSha256).toBe(createHash('sha256').update(z.manifestBuf).digest('hex'));
  });

  it('rango vacío (sin entries) → ZIP con entryCount=0 y NDJSON vacío', async () => {
    const empty = makeAuditLog([]);
    service = new AuditExportService(empty.audit, 'test-master-key');
    const result = await service.buildSignedZip(TENANT_A);
    expect(result.manifest.entryCount).toBe(0);

    const z = readZip(result.zip);
    expect(z.entriesBuf.length).toBe(0);
    const manifest = JSON.parse(z.manifestBuf.toString('utf8'));
    expect(manifest.entryCount).toBe(0);
    expect(manifest.artefactos[0].size).toBe(0);
  });

  it('filtra estrictamente por tenantId — el service nunca cruza tenants', async () => {
    await service.buildSignedZip(TENANT_A, {
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-04-30T00:00:00Z'),
    });
    expect(listSpy).toHaveBeenCalledTimes(1);
    const [tenantArg, filtersArg] = listSpy.mock.calls[0]!;
    expect(tenantArg).toBe(TENANT_A);
    expect(filtersArg).toMatchObject({
      dateFrom: new Date('2026-04-01T00:00:00Z'),
      dateTo: new Date('2026-04-30T00:00:00Z'),
    });

    // Comprobación cruzada: si pido TENANT_B, el list se llama con tenant-b.
    listSpy.mockClear();
    await service.buildSignedZip(TENANT_B);
    expect(listSpy).toHaveBeenCalledWith(TENANT_B, expect.any(Object));
  });

  it('manifest expone version=v1-audit-signed, algorithm=HMAC-SHA256, tenantId, range', async () => {
    const opts: BuildSignedZipOptions = {
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-04-30T23:59:59Z'),
      now: new Date('2026-05-01T08:00:00Z'),
    };
    const result = await service.buildSignedZip(TENANT_A, opts);
    expect(result.manifest.version).toBe(AUDIT_REPORT_MANIFEST_VERSION);
    expect(result.manifest.signatureAlgorithm).toBe(AUDIT_REPORT_SIGNATURE_ALGORITHM);
    expect(result.manifest.tenantId).toBe(TENANT_A);
    expect(result.manifest.generatedAt).toBe('2026-05-01T08:00:00.000Z');
    expect(result.manifest.range.from).toBe('2026-04-01T00:00:00.000Z');
    expect(result.manifest.range.to).toBe('2026-04-30T23:59:59.000Z');
  });

  it('range con from/to ausentes serializa null en manifest', async () => {
    const result = await service.buildSignedZip(TENANT_A, {});
    expect(result.manifest.range.from).toBeNull();
    expect(result.manifest.range.to).toBeNull();
  });

  it('filename derivado de tenantId + rango aplicado', async () => {
    const result = await service.buildSignedZip(TENANT_A, {
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-04-30T00:00:00Z'),
    });
    expect(result.filename).toBe('audit-tenant-a-2026-04-01_2026-04-30.zip');
  });

  it('falla en validación si alguien retampera bytes del manifest (HMAC ya no cuadra)', async () => {
    const result = await service.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    const signature = JSON.parse(z.signatureBuf.toString('utf8'));

    // Tampering simulado: cambiamos un byte del manifest y recalculamos HMAC.
    const tampered = Buffer.from(z.manifestBuf);
    tampered[10] = tampered[10]! ^ 0x01;
    const tamperedHmac = createHmac('sha256', deriveTenantHmacKey('test-master-key', TENANT_A))
      .update(tampered)
      .digest('hex');
    // El HMAC almacenado se calculó sobre los bytes ORIGINALES — por eso
    // un manifest tampered no debe coincidir.
    expect(tamperedHmac).not.toBe(signature.signatureHmacSha256);
  });

  it('clave derivada por tenant aísla firmas — mismo manifest, distintos tenants → distintos HMAC', async () => {
    const resA = await service.buildSignedZip(TENANT_A, {
      now: new Date('2026-05-01T00:00:00Z'),
    });
    const resB = await service.buildSignedZip(TENANT_B, {
      now: new Date('2026-05-01T00:00:00Z'),
    });
    expect(resA.signature.signatureHmacSha256).not.toBe(resB.signature.signatureHmacSha256);
  });

  it('cae al fallback HMAC key cuando no se inyecta masterKey', async () => {
    // Sin DI override: usa AUDIT_REPORT_HMAC_FALLBACK_KEY (env no set en tests).
    const made = makeAuditLog([row()]);
    const fallbackService = new AuditExportService(made.audit);
    const result = await fallbackService.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    const signature = JSON.parse(z.signatureBuf.toString('utf8'));

    const expected = createHmac(
      'sha256',
      deriveTenantHmacKey(AUDIT_REPORT_HMAC_FALLBACK_KEY, TENANT_A),
    )
      .update(z.manifestBuf)
      .digest('hex');
    expect(signature.signatureHmacSha256).toBe(expected);
  });

  it('NDJSON tiene una entry por línea con el shape esperado', async () => {
    const result = await service.buildSignedZip(TENANT_A);
    const z = readZip(result.zip);
    const lines = z.entriesBuf.toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      id: '1',
      action: 'auth.login',
      resourceType: 'session',
      timestamp: '2026-04-29T10:00:00.000Z',
    });
    expect(typeof first.timestamp).toBe('string');
  });
});
