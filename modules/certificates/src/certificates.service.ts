/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import { renderCertificatePdf } from './pdf-renderer.js';
import {
  CertificateNotFoundError,
  TemplateInUseError,
  TemplateIsDefaultError,
  TemplateNameTakenError,
  TemplateNotFoundError,
} from './errors.js';

export interface IssueCertificateInput {
  tenantId: string;
  enrollmentId: string;
  userId: string;
  courseId: string;
}

export interface TemplateInput {
  name: string;
  body: string;
  primaryColor?: string;
  logoUrl?: string | null;
  signerName?: string | null;
  signerTitle?: string | null;
  isDefault?: boolean;
}

export interface TemplateUpdateInput extends Partial<TemplateInput> {}

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

    const [user, course, tenant] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: input.userId } }),
      this.prisma.modCoursesCourse.findFirst({
        where: { tenantId: input.tenantId, id: input.courseId },
      }),
      this.prisma.tenant.findUnique({ where: { id: input.tenantId } }),
    ]);

    if (!user || !course || !tenant) {
      throw new CertificateNotFoundError();
    }

    const template = await this.getEffectiveTemplate(input.tenantId, course.certificateTemplateId);

    const number = await this.allocateNumber(input.tenantId);
    const issuedAt = new Date();

    const logoData = template?.logoUrl ? await this.fetchLogo(template.logoUrl) : undefined;

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
      logoData,
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

  // -----------------------------------------------------------------------
  // HU-FOR-004 — CRUD de plantillas de certificado por tenant.
  // -----------------------------------------------------------------------

  async listTemplates(tenantId: string) {
    return this.prisma.modCertificatesTemplate.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async getTemplate(tenantId: string, templateId: string) {
    const t = await this.prisma.modCertificatesTemplate.findFirst({
      where: { tenantId, id: templateId },
    });
    if (!t) throw new TemplateNotFoundError();
    return t;
  }

  async createTemplate(tenantId: string, dto: TemplateInput) {
    const dup = await this.prisma.modCertificatesTemplate.findFirst({
      where: { tenantId, name: dto.name },
    });
    if (dup) throw new TemplateNameTakenError(dto.name);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.modCertificatesTemplate.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.modCertificatesTemplate.create({
        data: {
          tenantId,
          name: dto.name,
          body: dto.body,
          primaryColor: dto.primaryColor ?? '#0f172a',
          logoUrl: dto.logoUrl ?? null,
          signerName: dto.signerName ?? null,
          signerTitle: dto.signerTitle ?? null,
          isDefault: dto.isDefault ?? false,
        },
      });
    });
  }

  async updateTemplate(tenantId: string, templateId: string, dto: TemplateUpdateInput) {
    await this.getTemplate(tenantId, templateId);

    if (dto.name) {
      const dup = await this.prisma.modCertificatesTemplate.findFirst({
        where: { tenantId, name: dto.name, id: { not: templateId } },
      });
      if (dup) throw new TemplateNameTakenError(dto.name);
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.modCertificatesTemplate.updateMany({
          where: { tenantId, isDefault: true, id: { not: templateId } },
          data: { isDefault: false },
        });
      }
      return tx.modCertificatesTemplate.update({
        where: { id: templateId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.body !== undefined ? { body: dto.body } : {}),
          ...(dto.primaryColor !== undefined ? { primaryColor: dto.primaryColor } : {}),
          ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
          ...(dto.signerName !== undefined ? { signerName: dto.signerName } : {}),
          ...(dto.signerTitle !== undefined ? { signerTitle: dto.signerTitle } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        },
      });
    });
  }

  async setDefaultTemplate(tenantId: string, templateId: string) {
    await this.getTemplate(tenantId, templateId);
    return this.prisma.$transaction(async (tx) => {
      await tx.modCertificatesTemplate.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.modCertificatesTemplate.update({
        where: { id: templateId },
        data: { isDefault: true },
      });
    });
  }

  /**
   * Renderiza un PDF dummy con los datos provistos en el draft, sin
   * persistir nada. Útil para que el formador vea un preview antes de
   * guardar la plantilla.
   */
  async renderTemplatePreview(tenantId: string, draft: TemplateInput): Promise<Buffer> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const logoData = draft.logoUrl ? await this.fetchLogo(draft.logoUrl) : undefined;
    return renderCertificatePdf({
      number: 'PREVIEW',
      studentName: 'Alumna de Ejemplo',
      courseTitle: 'Curso de Ejemplo',
      issuedAt: new Date(),
      body: draft.body,
      primaryColor: draft.primaryColor,
      signerName: draft.signerName ?? null,
      signerTitle: draft.signerTitle ?? null,
      tenantName: tenant?.name,
      logoData,
    });
  }

  async deleteTemplate(tenantId: string, templateId: string) {
    const t = await this.getTemplate(tenantId, templateId);
    if (t.isDefault) throw new TemplateIsDefaultError();

    const inUse = await this.prisma.modCoursesCourse.count({
      where: { tenantId, certificateTemplateId: templateId },
    });
    if (inUse > 0) throw new TemplateInUseError(inUse);

    await this.prisma.modCertificatesTemplate.delete({ where: { id: templateId } });
  }

  /**
   * Devuelve la plantilla efectiva para emitir un certificado.
   * Jerarquía: si el curso tiene `certificateTemplateId` asignado y el
   * template existe en el mismo tenant → ése. Si no, la `isDefault` del
   * tenant. Si no hay default → null (el renderer cae al hardcoded).
   */
  async getEffectiveTemplate(tenantId: string, courseTemplateId: string | null) {
    if (courseTemplateId) {
      const t = await this.prisma.modCertificatesTemplate.findFirst({
        where: { tenantId, id: courseTemplateId },
      });
      if (t) return t;
    }
    return this.prisma.modCertificatesTemplate.findFirst({
      where: { tenantId, isDefault: true },
    });
  }

  /**
   * Descarga el logo del tenant con timeout corto. Si falla por cualquier
   * motivo (404, timeout, formato no aceptado), devuelve undefined y el
   * certificado se emite sin logo. La emisión NO debe fallar por un asset
   * de branding caído.
   */
  private async fetchLogo(url: string): Promise<Buffer | undefined> {
    const TIMEOUT_MS = 5_000;
    const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return undefined;
        const contentLength = Number(res.headers.get('content-length') ?? '0');
        if (contentLength > MAX_BYTES) return undefined;
        const arrayBuf = await res.arrayBuffer();
        if (arrayBuf.byteLength > MAX_BYTES) return undefined;
        return Buffer.from(arrayBuf);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.ctx.logger.warn('mod.certificates: fallo al descargar logo del tenant', {
        url,
        error: (err as Error).message,
      });
      return undefined;
    }
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
