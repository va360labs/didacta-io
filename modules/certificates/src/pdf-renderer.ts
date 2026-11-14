/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import PDFDocument from 'pdfkit';

/**
 * Idiomas del certificado. Es la MISMA lista cerrada que los catálogos de la
 * web y de los correos (`es`, `en`, `pt`); se redeclara aquí porque un módulo
 * no importa de `apps/*`.
 */
export const CERTIFICATE_LANGS = ['es', 'en', 'pt'] as const;
export type CertificateLang = (typeof CERTIFICATE_LANGS)[number];

/**
 * Locale (`pt-BR`, `en-US`, `es-AR`…) → idioma del certificado. Lo que no sea
 * inglés ni portugués, español: es el idioma de referencia y el de todos los
 * certificados emitidos antes de que existiera esta función.
 */
export function toCertificateLang(locale: string | null | undefined): CertificateLang {
  const base = (typeof locale === 'string' ? locale : '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'en' || base === 'pt' ? base : 'es';
}

/**
 * Textos fijos del certificado por idioma. El español es EXACTAMENTE el que
 * estaba escrito en el renderer; el cuerpo por defecto en inglés y portugués es
 * el mismo que propone el editor de plantillas de la web (`certTemplates.
 * defaultBody`). Helvetica (WinAnsi) pinta todos los acentos del portugués
 * (ã, õ, ç, ê): lo comprueba el test extrayendo el texto del PDF.
 */
export const CERTIFICATE_COPY: Readonly<
  Record<
    CertificateLang,
    {
      /** Metadato `Title` del PDF; `{n}` es el número. */
      readonly docTitle: string;
      readonly title: string;
      readonly subtitle: string;
      readonly awardedTo: string;
      readonly defaultBody: string;
      readonly course: string;
      readonly issueDate: string;
      /** Pie de verificación; `{n}` es el número. */
      readonly verifiable: string;
      /** Locale de `Intl` de la fecha de emisión. */
      readonly dateLocale: string;
      /** Datos de muestra de la vista previa de una plantilla. */
      readonly sampleStudent: string;
      readonly sampleCourse: string;
      /** Relleno si al re-renderizar falta el dato en el snapshot. */
      readonly unknownStudent: string;
      readonly unknownCourse: string;
    }
  >
> = {
  es: {
    docTitle: 'Certificado #{n}',
    title: 'CERTIFICADO',
    subtitle: 'DE FINALIZACIÓN',
    awardedTo: 'Se otorga el presente certificado a',
    defaultBody:
      'Certifica que ha completado satisfactoriamente el curso indicado, cumpliendo con los criterios de finalización establecidos.',
    course: 'CURSO',
    issueDate: 'FECHA DE EMISIÓN',
    verifiable: 'Certificado verificable · Nº {n}',
    dateLocale: 'es-ES',
    sampleStudent: 'Alumna de Ejemplo',
    sampleCourse: 'Curso de Ejemplo',
    unknownStudent: 'Alumno',
    unknownCourse: 'Curso',
  },
  en: {
    docTitle: 'Certificate #{n}',
    title: 'CERTIFICATE',
    subtitle: 'OF COMPLETION',
    awardedTo: 'This certificate is awarded to',
    defaultBody:
      'Certifies the satisfactory completion of the indicated course, meeting the established completion criteria.',
    course: 'COURSE',
    issueDate: 'ISSUE DATE',
    verifiable: 'Verifiable certificate · No. {n}',
    dateLocale: 'en-US',
    sampleStudent: 'Sample Student',
    sampleCourse: 'Sample Course',
    unknownStudent: 'Student',
    unknownCourse: 'Course',
  },
  pt: {
    docTitle: 'Certificado #{n}',
    title: 'CERTIFICADO',
    subtitle: 'DE CONCLUSÃO',
    awardedTo: 'Este certificado é concedido a',
    defaultBody:
      'Certifica que concluiu satisfatoriamente o curso indicado, cumprindo os critérios de conclusão estabelecidos.',
    course: 'CURSO',
    issueDate: 'DATA DE EMISSÃO',
    verifiable: 'Certificado verificável · Nº {n}',
    dateLocale: 'pt-BR',
    sampleStudent: 'Aluna de Exemplo',
    sampleCourse: 'Curso de Exemplo',
    unknownStudent: 'Aluno',
    unknownCourse: 'Curso',
  },
};

export interface CertificateRenderInput {
  number: string;
  studentName: string;
  courseTitle: string;
  issuedAt: Date;
  body?: string;
  primaryColor?: string;
  signerName?: string | null;
  signerTitle?: string | null;
  tenantName?: string;
  /**
   * Logo del tenant ya descargado como Buffer (PNG/JPEG). El renderer NO
   * hace HTTP — el caller (service) decide descargarlo o no según la URL
   * almacenada en la plantilla. Si está presente y pdfkit lo soporta, se
   * embebe en la cabecera del certificado.
   */
  logoData?: Buffer;
  /**
   * Idioma de los textos fijos (título, rótulos, fecha y cuerpo por defecto).
   * Sin él, español: así salen byte a byte los certificados de siempre. El
   * cuerpo de una plantilla es del aula y NO se traduce.
   */
  lang?: CertificateLang;
}

/**
 * Renderiza un certificado PDF en formato A4 horizontal.
 * No depende de archivos externos: pdfkit usa fuentes estándar embebidas (Helvetica).
 *
 * Devuelve un Buffer con el PDF listo para guardar/servir.
 */
export async function renderCertificatePdf(input: CertificateRenderInput): Promise<Buffer> {
  const copy = CERTIFICATE_COPY[input.lang ?? 'es'] ?? CERTIFICATE_COPY.es;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        info: {
          Title: copy.docTitle.replace('{n}', input.number),
          Author: input.tenantName ?? 'Didacta',
          Subject: input.courseTitle,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const color = input.primaryColor ?? '#0f172a';
      const ink = '#171717';
      const muted = '#6b7280';
      const faint = '#9ca3af';
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const cx = pageWidth / 2;
      const contentX = 90;
      const contentW = pageWidth - contentX * 2;
      const centered = { align: 'center' as const, width: contentW };

      // ── Marco elegante: banda de acento arriba + doble filete fino ──────────
      // Banda superior de color (identidad de marca).
      doc.rect(0, 0, pageWidth, 10).fill(color);
      // Filete exterior fino y filete interior aún más fino (marco doble sutil).
      doc
        .lineWidth(1.5)
        .strokeColor(color)
        .rect(28, 28, pageWidth - 56, pageHeight - 56)
        .stroke();
      doc
        .lineWidth(0.5)
        .strokeColor(color)
        .rect(36, 36, pageWidth - 72, pageHeight - 72)
        .stroke();

      // ── Cabecera: logo del tenant o wordmark del nombre ─────────────────────
      let cursorY = 66;
      if (input.logoData && input.logoData.length > 0) {
        try {
          const logoHeight = 54;
          const logoW = 160;
          doc.image(input.logoData, cx - logoW / 2, cursorY, {
            fit: [logoW, logoHeight],
            align: 'center',
          });
          cursorY += logoHeight + 18;
        } catch {
          // Buffer corrupto / formato no soportado por pdfkit: ignoramos sin
          // romper la emisión.
          cursorY += 8;
        }
      } else if (input.tenantName) {
        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .fillColor(muted)
          .text(input.tenantName.toUpperCase(), 0, cursorY, {
            align: 'center',
            characterSpacing: 2,
          });
        cursorY += 30;
      } else {
        cursorY += 8;
      }

      // ── Título ──────────────────────────────────────────────────────────────
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(44)
        .text(copy.title, 0, cursorY, { align: 'center', characterSpacing: 6 });
      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(faint)
        .text(copy.subtitle, { align: 'center', characterSpacing: 4 });

      // ── Alumno ──────────────────────────────────────────────────────────────
      doc.moveDown(1.6);
      doc.font('Helvetica').fontSize(12).fillColor(muted).text(copy.awardedTo, { align: 'center' });
      doc.moveDown(0.5);
      doc
        .font('Helvetica-Bold')
        .fontSize(30)
        .fillColor(ink)
        .text(input.studentName, { align: 'center' });

      // Filete decorativo corto bajo el nombre.
      const ruleY = doc.y + 6;
      doc
        .lineWidth(1)
        .strokeColor(color)
        .moveTo(cx - 60, ruleY)
        .lineTo(cx + 60, ruleY)
        .stroke();

      // ── Cuerpo ──────────────────────────────────────────────────────────────
      doc.y = ruleY + 16;
      doc
        .font('Helvetica')
        .fontSize(12.5)
        .fillColor('#374151')
        .text(input.body ?? copy.defaultBody, contentX, doc.y, { ...centered, lineGap: 2 });

      // ── Curso ───────────────────────────────────────────────────────────────
      doc.moveDown(1.1);
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor(faint)
        .text(copy.course, { align: 'center', characterSpacing: 3 });
      doc.moveDown(0.25);
      doc
        .font('Helvetica-Bold')
        .fontSize(19)
        .fillColor(color)
        .text(input.courseTitle, contentX, doc.y, centered);

      // ── Footer: fecha + verificación (izq) · firma (der) ────────────────────
      const footerY = pageHeight - 118;
      doc
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .fillColor(ink)
        .text(copy.issueDate, contentX, footerY, { characterSpacing: 1 });
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor(muted)
        .text(
          input.issuedAt.toLocaleDateString(copy.dateLocale, {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }),
          contentX,
          footerY + 15,
        );
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(faint)
        .text(copy.verifiable.replace('{n}', input.number), contentX, footerY + 33);

      if (input.signerName) {
        const signW = 220;
        const signX = pageWidth - contentX - signW;
        doc
          .lineWidth(0.75)
          .strokeColor('#d1d5db')
          .moveTo(signX, footerY + 6)
          .lineTo(signX + signW, footerY + 6)
          .stroke();
        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(ink)
          .text(input.signerName, signX, footerY + 12, { width: signW, align: 'center' });
        if (input.signerTitle) {
          doc
            .font('Helvetica')
            .fontSize(9.5)
            .fillColor(faint)
            .text(input.signerTitle, signX, footerY + 28, { width: signW, align: 'center' });
        }
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
