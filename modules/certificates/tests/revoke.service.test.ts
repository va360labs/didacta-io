/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Revocar (sin borrar) los certificados de un curso reembolsado, y deshacer
 * SOLO esa revocación si la persona vuelve a comprar. La semántica contra
 * Postgres de verdad está en `refund-access.integration.test.ts` (apps/api).
 */
import { describe, expect, it, vi } from 'vitest';
import { CERTIFICATE_REVOKE_REASON_REFUND, CertificatesService } from '../src/certificates.service';

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  revokedAt: Date | null;
  revokeReason: string | null;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const actual = (row as unknown as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && 'not' in (v as object)) {
      return actual !== (v as { not: unknown }).not;
    }
    return actual === v;
  });
}

function makeService(rows: Row[]) {
  const prisma = {
    modCertificatesIssued: {
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
          let count = 0;
          for (const r of rows) {
            if (!matches(r, where)) continue;
            Object.assign(r, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
  };
  return new CertificatesService(prisma as never, {} as never);
}

const base = { tenantId: 't-1', userId: 'u-1', courseId: 'c-1' };

describe('CertificatesService — revocación por reembolso', () => {
  it('revoca el vigente del curso con motivo y fecha, sin tocar otros cursos ni otras personas', async () => {
    const rows: Row[] = [
      { id: 'a', ...base, revokedAt: null, revokeReason: null },
      { id: 'otro-curso', ...base, courseId: 'c-2', revokedAt: null, revokeReason: null },
      { id: 'otra-persona', ...base, userId: 'u-2', revokedAt: null, revokeReason: null },
    ];
    const service = makeService(rows);

    const n = await service.revokeForCourse('t-1', 'u-1', 'c-1', CERTIFICATE_REVOKE_REASON_REFUND);

    expect(n).toBe(1);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(rows[0]!.revokeReason).toBe('refund');
    expect(rows[1]!.revokedAt).toBeNull();
    expect(rows[2]!.revokedAt).toBeNull();
  });

  it('es idempotente: lo ya revocado no se vuelve a fechar', async () => {
    const when = new Date('2026-11-14T12:00:00Z');
    const rows: Row[] = [{ id: 'a', ...base, revokedAt: when, revokeReason: 'refund' }];
    const service = makeService(rows);
    expect(await service.revokeForCourse('t-1', 'u-1', 'c-1', 'refund')).toBe(0);
    expect(rows[0]!.revokedAt).toBe(when);
  });

  it('al volver a comprar, solo se deshace la revocación POR REEMBOLSO', async () => {
    const rows: Row[] = [
      { id: 'reembolso', ...base, revokedAt: new Date(), revokeReason: 'refund' },
      { id: 'a-mano', ...base, courseId: 'c-1', revokedAt: new Date(), revokeReason: 'fraude' },
    ];
    const service = makeService(rows);

    expect(await service.restoreRevokedForRefund('t-1', 'u-1', 'c-1')).toBe(1);
    expect(rows[0]).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(rows[1]!.revokedAt).toBeInstanceOf(Date);
  });
});
