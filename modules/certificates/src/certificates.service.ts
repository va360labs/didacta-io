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
  CertificateNumberExhaustedError,
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

export type TemplateUpdateInput = Partial<TemplateInput>;

/**
 * Que unique violo un P2002 de Prisma. `meta.target` llega unas veces como
 * lista de columnas y otras como nombre del indice, asi que se mira el texto.
 * Devuelve null si el error no es una violacion de unicidad.
 */
function uniqueViolationTarget(err: unknown): 'number' | 'enrollment' | 'otro' | null {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== 'P2002') return null;
  const target = JSON.stringify(e.meta?.target ?? '');
  if (target.includes('enrollment')) return 'enrollment';
  if (target.includes('number')) return 'number';
  return 'otro';
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

    const issuedAt = new Date();
    const logoData = template?.logoUrl ? await this.fetchLogo(template.logoUrl) : undefined;
    const studentName = user.name ?? user.email;

    // La clave de storage cuelga del ID del certificado, NO de su numero. Con
    // la clave por numero, dos emisiones simultaneas calculaban el mismo
    // numero, subian al mismo objeto, y segun el entrelazado la fila
    // superviviente (con su hash SHA-256) acababa apuntando al PDF de OTRO
    // alumno. Con la clave por id, dos emisiones no se pisan jamas.
    const certId = randomUUID();
    const storageKey = `certificates/${input.tenantId}/${certId}.pdf`;

    // El numero se asigna con `count()+1`, que no es atomico: dos emisiones a
    // la vez calculan el mismo y la segunda choca contra
    // @@unique([tenantId, number]). Antes la colision escapaba hacia arriba,
    // el handler del modulo la tragaba, y como `completedAt` ya estaba sellado
    // el evento no volvia a dispararse: ese alumno se quedaba SIN certificado
    // para siempre. Ahora la colision se reintenta aqui con un numero fresco.
    const MAX_INTENTOS = 5;
    let created: Awaited<ReturnType<typeof this.prisma.modCertificatesIssued.create>> | null = null;
    let number = '';
    let hash = '';
    let pdf: Buffer = Buffer.alloc(0);

    for (let intento = 0; intento < MAX_INTENTOS; intento++) {
      number = await this.allocateNumber(input.tenantId);
      pdf = await renderCertificatePdf({
        number,
        studentName,
        courseTitle: course.title,
        issuedAt,
        body: template?.body,
        primaryColor: template?.primaryColor,
        signerName: template?.signerName,
        signerTitle: template?.signerTitle,
        tenantName: tenant.name,
        logoData,
      });
      hash = createHash('sha256').update(pdf).digest('hex');
      await this.ctx.storage.upload(storageKey, pdf, 'application/pdf');

      try {
        created = await this.prisma.modCertificatesIssued.create({
          data: {
            id: certId,
            tenantId: input.tenantId,
            userId: input.userId,
            courseId: input.courseId,
            enrollmentId: input.enrollmentId,
            templateId: template?.id ?? null,
            number,
            hash,
            storageKey,
            size: pdf.length,
            // El snapshot congela TODO lo que hizo falta para dibujar el PDF,
            // no solo cuatro campos. Con los cuatro, la descarga re-renderizaba
            // un certificado sin plantilla, sin logo y sin firmante: distinto
            // byte a byte (y a la vista) del que se emitio y se hasheo.
            snapshot: {
              studentName,
              courseTitle: course.title,
              issuedAt: issuedAt.toISOString(),
              body: template?.body ?? null,
              primaryColor: template?.primaryColor ?? null,
              signerName: template?.signerName ?? null,
              signerTitle: template?.signerTitle ?? null,
              tenantName: tenant.name,
              logoUrl: template?.logoUrl ?? null,
            } as never,
          },
        });
        break;
      } catch (err) {
        const choque = uniqueViolationTarget(err);
        if (choque === 'enrollment') {
          // Otro worker emitio ESTE mismo certificado mientras renderizabamos.
          // Es el camino idempotente, no un error.
          const ya = await this.prisma.modCertificatesIssued.findUnique({
            where: {
              tenantId_enrollmentId: {
                tenantId: input.tenantId,
                enrollmentId: input.enrollmentId,
              },
            },
          });
          if (ya) return ya;
        }
        if (choque === 'number' && intento < MAX_INTENTOS - 1) continue;
        throw err;
      }
    }

    if (!created) {
      throw new CertificateNumberExhaustedError(MAX_INTENTOS);
    }

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
   *
   * Sirve EL PDF EMITIDO, el que esta en storage y cuyo SHA-256 vive en la
   * fila. Antes se re-renderizaba siempre desde un snapshot de cuatro campos
   * —sin plantilla, sin logo, sin firmante—, asi que cada descarga entregaba un
   * documento con el estilo por defecto que no coincidia ni visualmente ni byte
   * a byte con el original hasheado, debajo de un sello que dice "certificado
   * verificable". Si el objeto ya no esta en storage se re-renderiza desde el
   * snapshot completo, que hoy si guarda todo lo que hizo falta para dibujarlo.
   */
  async renderCertificatePdf(tenantId: string, certId: string): Promise<Buffer> {
    const cert = await this.getById(tenantId, certId);

    if (cert.storageKey) {
      try {
        const guardado = await this.ctx.storage.download(cert.storageKey);
        if (guardado?.length) return guardado;
      } catch (err) {
        this.ctx.logger.warn('mod.certificates: PDF ausente en storage, se re-renderiza', {
          certId,
          storageKey: cert.storageKey,
          error: (err as Error).message,
        });
      }
    }

    const snapshot = (cert.snapshot ?? {}) as {
      studentName?: string;
      courseTitle?: string;
      issuedAt?: string;
      body?: string | null;
      primaryColor?: string | null;
      signerName?: string | null;
      signerTitle?: string | null;
      tenantName?: string | null;
      logoUrl?: string | null;
    };
    const logoData = snapshot.logoUrl ? await this.fetchLogo(snapshot.logoUrl) : undefined;
    return renderCertificatePdf({
      number: cert.number,
      studentName: snapshot.studentName ?? 'Alumno',
      courseTitle: snapshot.courseTitle ?? 'Curso',
      issuedAt: snapshot.issuedAt ? new Date(snapshot.issuedAt) : cert.issuedAt,
      body: snapshot.body ?? undefined,
      primaryColor: snapshot.primaryColor ?? undefined,
      signerName: snapshot.signerName ?? undefined,
      signerTitle: snapshot.signerTitle ?? undefined,
      tenantName: snapshot.tenantName ?? undefined,
      logoData,
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
