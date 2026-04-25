import { createHash, randomUUID } from 'node:crypto';
import type { ModuleContext } from '@learnship/core-kernel';
import type { PrismaClient } from '@learnship/database';
import { renderCertificatePdf } from './pdf-renderer.js';
import { CertificateNotFoundError } from './errors.js';

export interface IssueCertificateInput {
  tenantId: string;
  enrollmentId: string;
  userId: string;
  courseId: string;
}

export class CertificatesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  /**
   * Idempotente: si ya existe certificado para (tenantId, enrollmentId), lo devuelve.
   * Si no, genera el PDF, lo guarda en storage y persiste el registro.
   */
  async issueCertificateForEnrollment(input: IssueCertificateInput) {
    const existing = await this.prisma.modCertificatesIssued.findUnique({
      where: {
        tenantId_enrollmentId: {
          tenantId: input.tenantId,
          enrollmentId: input.enrollmentId,
        },
      },
    });
    if (existing) return existing;

    const [user, course, tenant, template] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: input.userId } }),
      this.prisma.modCoursesCourse.findFirst({
        where: { tenantId: input.tenantId, id: input.courseId },
      }),
      this.prisma.tenant.findUnique({ where: { id: input.tenantId } }),
      this.prisma.modCertificatesTemplate.findFirst({
        where: { tenantId: input.tenantId, isDefault: true },
      }),
    ]);

    if (!user || !course || !tenant) {
      throw new CertificateNotFoundError();
    }

    const number = await this.allocateNumber(input.tenantId);
    const issuedAt = new Date();

    const pdf = await renderCertificatePdf({
      number,
      studentName: user.name ?? user.email,
      courseTitle: course.title,
      issuedAt,
      body: template?.body,
      primaryColor: template?.primaryColor,
      signerName: template?.signerName,
      signerTitle: template?.signerTitle,
      tenantName: tenant.name,
    });

    const hash = createHash('sha256').update(pdf).digest('hex');
    const storageKey = `certificates/${input.tenantId}/${number}.pdf`;
    await this.ctx.storage.upload(storageKey, pdf, 'application/pdf');

    const created = await this.prisma.modCertificatesIssued.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        courseId: input.courseId,
        enrollmentId: input.enrollmentId,
        templateId: template?.id ?? null,
        number,
        hash,
        storageKey,
        size: pdf.length,
        snapshot: {
          studentName: user.name ?? user.email,
          courseTitle: course.title,
          issuedAt: issuedAt.toISOString(),
        } as never,
      },
    });

    // Vault: el PDF inmutable queda con su hash referenciado en evidence_vault_entry.
    // Si el snapshot del cert se corrompe en el futuro, el original se reconstruye
    // desde el vault.
    await this.ctx.evidenceVault.store({
      tenantId: input.tenantId,
      resourceType: 'certificate',
      resourceId: created.id,
      data: pdf,
      contentType: 'application/pdf',
    });

    await this.ctx.auditLog.record({
      tenantId: input.tenantId,
      actorId: input.userId,
      action: 'certificate.issued',
      resourceType: 'certificate',
      resourceId: created.id,
      metadata: {
        number,
        courseId: input.courseId,
        enrollmentId: input.enrollmentId,
        hash,
      },
    });

    await this.publish(input.tenantId, input.userId, 'certificates.issued', {
      certificateId: created.id,
      enrollmentId: input.enrollmentId,
      userId: input.userId,
      courseId: input.courseId,
      number,
    });

    return created;
  }

  async listMyCertificates(tenantId: string, userId: string) {
    return this.prisma.modCertificatesIssued.findMany({
      where: { tenantId, userId, revokedAt: null },
      orderBy: { issuedAt: 'desc' },
    });
  }

  async getById(tenantId: string, certId: string) {
    const cert = await this.prisma.modCertificatesIssued.findFirst({
      where: { tenantId, id: certId },
    });
    if (!cert) throw new CertificateNotFoundError();
    return cert;
  }

  /**
   * Devuelve el PDF bruto. El caller decide si servir como Buffer o stream.
   * Por simplicidad regeneramos el PDF on-demand desde el snapshot.
   * Cuando tengamos storage real, podemos servir desde ahí en vez de regenerar.
   */
  async renderCertificatePdf(tenantId: string, certId: string): Promise<Buffer> {
    const cert = await this.getById(tenantId, certId);
    const snapshot = (cert.snapshot ?? {}) as {
      studentName?: string;
      courseTitle?: string;
      issuedAt?: string;
    };
    return renderCertificatePdf({
      number: cert.number,
      studentName: snapshot.studentName ?? 'Alumno',
      courseTitle: snapshot.courseTitle ?? 'Curso',
      issuedAt: snapshot.issuedAt ? new Date(snapshot.issuedAt) : cert.issuedAt,
    });
  }

  private async allocateNumber(tenantId: string): Promise<string> {
    const count = await this.prisma.modCertificatesIssued.count({ where: { tenantId } });
    const padded = String(count + 1).padStart(6, '0');
    const year = new Date().getFullYear();
    return `LS-${year}-${padded}`;
  }

  private async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    data: Record<string, unknown>,
  ) {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        userId: actorId ?? undefined,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}
