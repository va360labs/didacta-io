/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del AuditExportController — quinto piloto License SDK
 * (`feat:reports.advanced_signed`).
 *
 * Cobertura:
 *  - Sin licencia: requireCapability lanza CapabilityRequiredError (mapea 402).
 *  - Con dev bypass: GET descarga ZIP con headers correctos.
 *  - Validación rangos Zod (from > to → 400, ISO inválido → 400).
 *  - Audit log entry tras descarga (`audit.report.exported`).
 *  - Acceso restringido a super_admin / tenant_admin.
 *  - Cabeceras Content-Type y Content-Disposition.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LicenseService,
  LICENSE_CAPABILITIES,
  CapabilityRequiredError,
} from '@didacta/license-sdk';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { AuditExportController } from '../src/modules/audit-export/audit-export.controller';
import { AuditExportService } from '../src/modules/audit-export/audit-export.service';
import { auditExportRangeSchema } from '../src/modules/audit-export/audit-export.dto';
import {
  AUDIT_REPORT_ENTRIES_FILENAME,
  AUDIT_REPORT_MANIFEST_FILENAME,
  AUDIT_REPORT_SIGNATURE_FILENAME,
} from '../src/modules/audit-export/audit-export.types';
import type { SessionClaims } from '../src/auth/token.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeAuditLog = ConstructorParameters<typeof AuditExportService>[0] &
  ConstructorParameters<typeof AuditExportController>[1];

function makeAuditLog(rows: unknown[] = []): {
  audit: FakeAuditLog;
  listSpy: ReturnType<typeof vi.fn>;
  recordSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn().mockResolvedValue(rows);
  const recordSpy = vi.fn().mockResolvedValue(undefined);
  return {
    audit: { list: listSpy, record: recordSpy } as unknown as FakeAuditLog,
    listSpy,
    recordSpy,
  };
}

interface FakeReply {
  headerCalls: Array<[string, string]>;
  statusCode: number | null;
  body: unknown;
  header(name: string, value: string): FakeReply;
  status(code: number): FakeReply;
  send(body: unknown): FakeReply;
}

/**
 * Fake mínimo de FastifyReply con API chainable header().status().send().
 * Sólo registra lo que el controller llama; suficiente para asserts.
 */
function makeFakeReply(): FakeReply {
  const reply: FakeReply = {
    headerCalls: [],
    statusCode: null,
    body: null,
    header(name: string, value: string) {
      this.headerCalls.push([name, value]);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply;
}

const FAKE_REQ = { headers: {}, ip: '127.0.0.1' } as unknown as Parameters<
  AuditExportController['download']
>[0];

const adminUser: SessionClaims = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roles: ['tenant_admin'],
  mfaVerified: true,
};

const studentUser: SessionClaims = {
  sub: 'user-2',
  tenantId: 'tenant-1',
  roles: ['alumno'],
  mfaVerified: false,
};

const superAdmin: SessionClaims = {
  sub: 'admin-1',
  tenantId: 'tenant-1',
  roles: ['super_admin'],
  mfaVerified: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditExportController · gate feat:reports.advanced_signed', () => {
  let license: LicenseService;
  let auditLog: FakeAuditLog;
  let listSpy: ReturnType<typeof vi.fn>;
  let recordSpy: ReturnType<typeof vi.fn>;
  let service: AuditExportService;
  let controller: AuditExportController;

  beforeEach(() => {
    license = new LicenseService();
    const made = makeAuditLog([]);
    auditLog = made.audit;
    listSpy = made.listSpy;
    recordSpy = made.recordSpy;
    service = new AuditExportService(auditLog, 'controller-test-key');
    controller = new AuditExportController(service, auditLog);
  });

  // -------------------------------------------------------------------------
  // 1. Sin licencia → guard llama license.requireCapability() y lanza
  //    CapabilityRequiredError (LicenseExceptionFilter mapea a 402).
  // -------------------------------------------------------------------------
  describe('community (sin licencia EE)', () => {
    beforeEach(async () => {
      await license.load({ key: null });
    });

    it('requireCapability(REPORTS_ADVANCED_SIGNED) lanza CapabilityRequiredError', () => {
      expect(() => license.requireCapability(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED)).toThrow(
        CapabilityRequiredError,
      );
    });

    it('el error tipado lleva la capability requerida', () => {
      try {
        license.requireCapability(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityRequiredError);
        expect((e as CapabilityRequiredError).capability).toBe(
          LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Con dev bypass: GET ejecuta y manda ZIP con headers correctos.
  // -------------------------------------------------------------------------
  describe('con dev bypass (capability activa)', () => {
    beforeEach(async () => {
      await license.load({ allowDevBypass: true, key: 'dev-key' });
    });

    it('GET /audit/entries.zip → status 200, Content-Type application/zip, ZIP coherente', async () => {
      const reply = makeFakeReply();
      await controller.download(
        FAKE_REQ,
        adminUser,
        {},
        reply as unknown as Parameters<AuditExportController['download']>[3],
      );

      const headers = Object.fromEntries(reply.headerCalls);
      expect(headers['Content-Type']).toBe('application/zip');
      expect(headers['Content-Disposition']).toMatch(/^attachment; filename="audit-tenant-1-/);
      expect(headers['X-Audit-Entry-Count']).toBe('0');
      expect(typeof headers['X-Audit-Manifest-Sha256']).toBe('string');
      expect(headers['X-Audit-Manifest-Sha256']).toMatch(/^[0-9a-f]{64}$/);

      const buf = reply.body as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      const zip = new AdmZip(buf);
      const names = zip
        .getEntries()
        .map((e) => e.entryName)
        .sort();
      expect(names).toEqual([
        AUDIT_REPORT_ENTRIES_FILENAME,
        AUDIT_REPORT_MANIFEST_FILENAME,
        AUDIT_REPORT_SIGNATURE_FILENAME,
      ]);
    });

    it('registra audit log entry `audit.report.exported` tras descarga', async () => {
      const reply = makeFakeReply();
      await controller.download(
        FAKE_REQ,
        adminUser,
        {
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-30T00:00:00.000Z',
        },
        reply as unknown as Parameters<AuditExportController['download']>[3],
      );

      expect(recordSpy).toHaveBeenCalledTimes(1);
      const entry = recordSpy.mock.calls[0]![0];
      expect(entry.action).toBe('audit.report.exported');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.actorId).toBe('user-1');
      expect(entry.resourceType).toBe('audit_report');
      expect(entry.metadata).toMatchObject({
        range: {
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-30T00:00:00.000Z',
        },
        entryCount: 0,
      });
      expect(entry.metadata.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.metadata.filename).toMatch(/^audit-tenant-1-/);
    });

    it('GET con super_admin → permitido', async () => {
      const reply = makeFakeReply();
      await controller.download(
        FAKE_REQ,
        superAdmin,
        {},
        reply as unknown as Parameters<AuditExportController['download']>[3],
      );
      expect(reply.body).toBeInstanceOf(Buffer);
    });

    it('GET con rol alumno → ForbiddenException', async () => {
      const reply = makeFakeReply();
      await expect(
        controller.download(
          FAKE_REQ,
          studentUser,
          {},
          reply as unknown as Parameters<AuditExportController['download']>[3],
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('GET sin user → UnauthorizedException', async () => {
      const reply = makeFakeReply();
      await expect(
        controller.download(
          FAKE_REQ,
          undefined,
          {},
          reply as unknown as Parameters<AuditExportController['download']>[3],
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Validación Zod del DTO de rango.
// ---------------------------------------------------------------------------
describe('AuditExportController · validación Zod del rango', () => {
  it('acepta sin parámetros (rango open)', () => {
    expect(auditExportRangeSchema.safeParse({}).success).toBe(true);
  });

  it('acepta solo from o solo to', () => {
    expect(auditExportRangeSchema.safeParse({ from: '2026-04-01T00:00:00.000Z' }).success).toBe(
      true,
    );
    expect(auditExportRangeSchema.safeParse({ to: '2026-04-30T00:00:00.000Z' }).success).toBe(true);
  });

  it('rechaza ISO malformado', () => {
    expect(auditExportRangeSchema.safeParse({ from: '2026/04/01' }).success).toBe(false);
    expect(auditExportRangeSchema.safeParse({ from: 'no-es-fecha' }).success).toBe(false);
  });

  it('rechaza ISO sin timezone offset', () => {
    expect(auditExportRangeSchema.safeParse({ from: '2026-04-01T00:00:00' }).success).toBe(false);
  });

  it('rechaza from > to', () => {
    const r = auditExportRangeSchema.safeParse({
      from: '2026-04-30T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });

  it('acepta from == to (rango de un punto)', () => {
    const r = auditExportRangeSchema.safeParse({
      from: '2026-04-15T00:00:00.000Z',
      to: '2026-04-15T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });
});
