import PDFDocument from 'pdfkit';

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
}

const DEFAULT_BODY =
  'Certifica que ha completado satisfactoriamente el curso indicado, cumpliendo con los criterios de finalización establecidos.';

/**
 * Renderiza un certificado PDF en formato A4 horizontal.
 * No depende de archivos externos: pdfkit usa fuentes estándar embebidas (Helvetica).
 *
 * Devuelve un Buffer con el PDF listo para guardar/servir.
 */
export async function renderCertificatePdf(input: CertificateRenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        info: {
          Title: `Certificado #${input.number}`,
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
        .text('CERTIFICADO', 0, cursorY, { align: 'center', characterSpacing: 6 });
      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(faint)
        .text('DE FINALIZACIÓN', { align: 'center', characterSpacing: 4 });

      // ── Alumno ──────────────────────────────────────────────────────────────
      doc.moveDown(1.6);
      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(muted)
        .text('Se otorga el presente certificado a', { align: 'center' });
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
        .text(input.body ?? DEFAULT_BODY, contentX, doc.y, { ...centered, lineGap: 2 });

      // ── Curso ───────────────────────────────────────────────────────────────
      doc.moveDown(1.1);
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor(faint)
        .text('CURSO', { align: 'center', characterSpacing: 3 });
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
        .text('FECHA DE EMISIÓN', contentX, footerY, { characterSpacing: 1 });
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor(muted)
        .text(
          input.issuedAt.toLocaleDateString('es-ES', {
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
        .text(`Certificado verificable · Nº ${input.number}`, contentX, footerY + 33);

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
