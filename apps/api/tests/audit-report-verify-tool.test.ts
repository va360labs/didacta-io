/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del validador offline `tools/audit-report-verify.mjs` (quinto piloto
 * License SDK · feat:reports.advanced_signed).
 *
 * Cobertura mínima:
 *   - ZIP válido recién generado por el service → exit 0.
 *   - ZIP modificado a posteriori (manifest tampered) → exit 1.
 *   - ZIP con NDJSON tampered (SHA-256 ya no cuadra) → exit 1.
 *   - ZIP sin alguno de los 3 archivos → exit 1.
 *   - Path inexistente → exit 2.
 *
 * Estrategia: generamos el ZIP en disk en un tmp dir, ejecutamos el script
 * con `node` y comprobamos exit code + stdout/stderr. Pasamos `--key` con la
 * misma masterKey que usa el service para que el HMAC verifique.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { AuditExportService } from '../src/modules/audit-export/audit-export.service';
import {
  AUDIT_REPORT_ENTRIES_FILENAME,
  AUDIT_REPORT_MANIFEST_FILENAME,
  AUDIT_REPORT_SIGNATURE_FILENAME,
} from '../src/modules/audit-export/audit-export.types';

const TENANT = 'tenant-a';
const MASTER_KEY = 'verify-tool-test-key';

// Ruta al tool desde apps/api/ → repo root.
const TOOL_PATH = resolve(__dirname, '../../../tools/audit-report-verify.mjs');

function makeService(): AuditExportService {
  const auditLog = {
    list: vi.fn().mockResolvedValue([
      {
        id: '1',
        actorId: 'user-1',
        action: 'auth.login',
        resourceType: 'session',
        resourceId: 'sess-1',
        metadata: { foo: 'bar' },
        ip: '127.0.0.1',
        userAgent: 'vitest',
        timestamp: new Date('2026-04-29T10:00:00Z'),
      },
    ]),
  } as unknown as ConstructorParameters<typeof AuditExportService>[0];
  return new AuditExportService(auditLog, MASTER_KEY);
}

async function writeZip(targetPath: string, mutate?: (zip: AdmZip) => void): Promise<void> {
  const service = makeService();
  const result = await service.buildSignedZip(TENANT);
  if (!mutate) {
    writeFileSync(targetPath, result.zip);
    return;
  }
  // Permitir mutaciones para casos de tampering / archivo faltante.
  const zip = new AdmZip(result.zip);
  mutate(zip);
  writeFileSync(targetPath, zip.toBuffer());
}

function runVerify(zipPath: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [TOOL_PATH, zipPath, '--key', MASTER_KEY], {
    encoding: 'utf8',
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('tools/audit-report-verify.mjs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'audit-verify-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ZIP válido recién generado → exit 0', async () => {
    const zipPath = join(tmp, 'ok.zip');
    await writeZip(zipPath);
    const r = runVerify(zipPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('VERIFY-OK');
    expect(r.stdout).toContain(`tenant=${TENANT}`);
  });

  it('ZIP con manifest.json tampered (cambio de un byte) → exit 1', async () => {
    const zipPath = join(tmp, 'tampered-manifest.zip');
    await writeZip(zipPath, (zip) => {
      const buf = zip.readFile(AUDIT_REPORT_MANIFEST_FILENAME)!;
      // Mutamos el campo `tenantId` en el manifest. Cambiamos un char dentro
      // del JSON sin romper la estructura: reemplazamos "tenant-a" → "tenant-b".
      const text = buf.toString('utf8').replace('tenant-a', 'tenant-b');
      const tampered = Buffer.from(text, 'utf8');
      zip.deleteFile(AUDIT_REPORT_MANIFEST_FILENAME);
      zip.addFile(AUDIT_REPORT_MANIFEST_FILENAME, tampered);
    });
    const r = runVerify(zipPath);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('FAIL');
  });

  it('ZIP con audit-entries.ndjson tampered → SHA-256 mismatch → exit 1', async () => {
    const zipPath = join(tmp, 'tampered-entries.zip');
    await writeZip(zipPath, (zip) => {
      const buf = zip.readFile(AUDIT_REPORT_ENTRIES_FILENAME)!;
      // Cambiar un byte del NDJSON sin actualizar el manifest → el SHA-256
      // declarado ya no cuadra con el contenido.
      const tampered = Buffer.from(buf);
      tampered[0] = tampered[0]! ^ 0x01;
      zip.deleteFile(AUDIT_REPORT_ENTRIES_FILENAME);
      zip.addFile(AUDIT_REPORT_ENTRIES_FILENAME, tampered);
    });
    const r = runVerify(zipPath);
    expect(r.code).toBe(1);
    expect(r.stderr.toLowerCase()).toMatch(/sha-256|mismatch/);
  });

  it('ZIP sin signature.json → exit 1 (archivo requerido ausente)', async () => {
    const zipPath = join(tmp, 'missing-signature.zip');
    await writeZip(zipPath, (zip) => {
      zip.deleteFile(AUDIT_REPORT_SIGNATURE_FILENAME);
    });
    const r = runVerify(zipPath);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(AUDIT_REPORT_SIGNATURE_FILENAME);
  });

  it('path inexistente → exit 2', () => {
    const r = runVerify(join(tmp, 'no-existe.zip'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('No existe');
  });

  it('ZIP válido pero verificado con masterKey rogue → exit 1 (HMAC distinto)', async () => {
    const zipPath = join(tmp, 'ok-but-wrong-key.zip');
    await writeZip(zipPath);
    const r = spawnSync('node', [TOOL_PATH, zipPath, '--key', 'rogue-key-distinta'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('hmac');
  });

  it('ZIP válido + verificación → tamaño NDJSON coincide con líneas (sanity check)', async () => {
    const zipPath = join(tmp, 'ok2.zip');
    await writeZip(zipPath);
    const buf = readFileSync(zipPath);
    const zip = new AdmZip(buf);
    const ndjson = zip.readFile(AUDIT_REPORT_ENTRIES_FILENAME)!.toString('utf8');
    const lines = ndjson.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const r = runVerify(zipPath);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('entries=1');
  });
});
