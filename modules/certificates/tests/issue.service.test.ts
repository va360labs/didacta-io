/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Emisión y descarga de certificados. No había ni un test sobre este camino:
 * por eso sobrevivieron la numeración por `count()+1` (dos emisiones a la vez
 * calculaban el mismo número y una se perdía, o peor, dejaban una fila
 * apuntando al PDF de otro alumno) y la descarga que re-renderizaba un
 * documento distinto del emitido bajo un sello de "verificable".
 */
import { describe, expect, it, vi } from 'vitest';
import { CertificatesService } from '../src/certificates.service';

interface CertRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  enrollmentId: string;
  templateId: string | null;
  number: string;
  hash: string;
  storageKey: string;
  size: number;
  snapshot: Record<string, unknown>;
  issuedAt: Date;
  revokedAt: Date | null;
}

/** Error P2002 de Prisma con el `meta.target` del índice que se violó. */
function p2002(target: string[]) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
}

function makeFake(opts: { numerosOcupados?: string[] } = {}) {
  const certs = new Map<string, CertRow>();
  const ocupados = new Set(opts.numerosOcupados ?? []);
  const subidas: { key: string; data: Buffer }[] = [];

  const prisma = {
    modCertificatesIssued: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { tenantId_enrollmentId?: { tenantId: string; enrollmentId: string } };
        }) => {
          const k = where.tenantId_enrollmentId;
          if (!k) return null;
          return (
            [...certs.values()].find(
              (c) => c.tenantId === k.tenantId && c.enrollmentId === k.enrollmentId,
            ) ?? null
          );
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { tenantId: string; id: string } }) =>
          [...certs.values()].find((c) => c.tenantId === where.tenantId && c.id === where.id) ??
          null,
      ),
      count: vi.fn(
        async ({ where }: { where: { tenantId: string } }) =>
          [...certs.values()].filter((c) => c.tenantId === where.tenantId).length + ocupados.size,
      ),
      create: vi.fn(async ({ data }: { data: CertRow }) => {
        if (
          ocupados.has(data.number) ||
          [...certs.values()].some((c) => c.number === data.number)
        ) {
          throw p2002(['tenant_id', 'number']);
        }
        const row: CertRow = { ...data, issuedAt: new Date(), revokedAt: null };
        certs.set(row.id, row);
        return row;
      }),
    },
    modCertificatesTemplate: {
      findFirst: vi.fn(async () => null),
    },
    user: { findUnique: vi.fn(async () => ({ id: 'u1', name: 'Ada Lovelace', email: 'a@b.c' })) },
    modCoursesCourse: {
      findFirst: vi.fn(async () => ({ id: 'c1', title: 'Curso 1', certificateTemplateId: null })),
    },
    tenant: { findUnique: vi.fn(async () => ({ id: 't1', name: 'Aula' })) },
  };

  const storage = {
    upload: vi.fn(async (key: string, data: Buffer) => {
      subidas.push({ key, data });
      return { key };
    }),
    download: vi.fn(async (key: string) => {
      const s = [...subidas].reverse().find((u) => u.key === key);
      if (!s) throw new Error('no such key');
      return s.data;
    }),
    delete: vi.fn(),
    getSignedUrl: vi.fn(),
    uploadImage: vi.fn(),
  };

  const ctx = {
    storage,
    evidenceVault: { store: vi.fn() },
    auditLog: { record: vi.fn() },
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    hookRegistry: { register: vi.fn(), run: vi.fn() },
    notificationHub: { send: vi.fn() },
    i18n: { t: (k: string) => k },
    config: { get: vi.fn(), set: vi.fn() },
  };

  return { prisma, ctx, storage, certs, subidas };
}

const input = { tenantId: 't1', enrollmentId: 'en-1', userId: 'u1', courseId: 'c1' };

describe('CertificatesService.issueCertificateForEnrollment', () => {
  it('emite y guarda el PDF bajo una clave propia del certificado, no del número', async () => {
    const fake = makeFake();
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);

    const cert = await svc.issueCertificateForEnrollment(input);

    expect(cert.number).toMatch(/^LS-\d{4}-000001$/);
    // La clave lleva el id del certificado: dos emisiones nunca comparten objeto.
    expect(cert.storageKey).toContain(cert.id);
    expect(cert.storageKey).not.toContain(cert.number);
    expect(fake.subidas).toHaveLength(1);
  });

  it('si el número ya está pillado, reintenta con otro en vez de perder el certificado (C2)', async () => {
    // El primer count()+1 da LS-<año>-000001, que otro worker acaba de crear.
    const year = new Date().getFullYear();
    const fake = makeFake({ numerosOcupados: [`LS-${year}-000001`] });
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);

    const cert = await svc.issueCertificateForEnrollment(input);

    expect(cert.number).toBe(`LS-${year}-000002`);
    expect(fake.certs.size).toBe(1);
  });

  it('si otro worker ya emitió ESTE certificado, devuelve el suyo (idempotente)', async () => {
    const fake = makeFake();
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);

    const primero = await svc.issueCertificateForEnrollment(input);
    const segundo = await svc.issueCertificateForEnrollment(input);

    expect(segundo.id).toBe(primero.id);
    expect(fake.certs.size).toBe(1);
  });

  it('el snapshot congela todo lo necesario para volver a dibujar el PDF (H4)', async () => {
    const fake = makeFake();
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);

    const cert = await svc.issueCertificateForEnrollment(input);
    const snap = cert.snapshot as Record<string, unknown>;

    for (const campo of [
      'studentName',
      'courseTitle',
      'issuedAt',
      'body',
      'primaryColor',
      'signerName',
      'signerTitle',
      'tenantName',
      'logoUrl',
    ]) {
      expect(snap).toHaveProperty(campo);
    }
  });
});

describe('CertificatesService.renderCertificatePdf (descarga)', () => {
  it('entrega EL PDF emitido, el que casa con el hash de la fila (H4)', async () => {
    const fake = makeFake();
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);
    const cert = await svc.issueCertificateForEnrollment(input);

    const descargado = await svc.renderCertificatePdf('t1', cert.id);

    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(descargado).digest('hex')).toBe(cert.hash);
    expect(descargado.equals(fake.subidas[0]!.data)).toBe(true);
  });

  it('si el objeto desapareció del storage, re-renderiza desde el snapshot sin reventar', async () => {
    const fake = makeFake();
    const svc = new CertificatesService(fake.prisma as never, fake.ctx as never);
    const cert = await svc.issueCertificateForEnrollment(input);
    fake.storage.download = vi.fn(async () => {
      throw new Error('objeto borrado');
    });

    const pdf = await svc.renderCertificatePdf('t1', cert.id);

    expect(pdf.length).toBeGreaterThan(0);
    expect(fake.ctx.logger.warn).toHaveBeenCalled();
  });
});
