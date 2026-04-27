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
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // Marco
      doc
        .lineWidth(3)
        .strokeColor(color)
        .rect(40, 40, pageWidth - 80, pageHeight - 80)
        .stroke();
      doc
        .lineWidth(1)
        .rect(50, 50, pageWidth - 100, pageHeight - 100)
        .stroke();

      // Logo (si el tenant lo provee).
      if (input.logoData && input.logoData.length > 0) {
        try {
          // Centrado horizontal, alto fijo de 60px, ancho proporcional auto.
          const logoHeight = 60;
          const x = (pageWidth - 120) / 2;
          doc.image(input.logoData, x, 70, { fit: [120, logoHeight], align: 'center' });
        } catch {
          // Buffer corrupto / formato no soportado por pdfkit: ignoramos sin
          // romper la emisión. El caller debería loguear el incidente si
          // quiere visibilidad.
        }
      }

      // Título
      const titleY = input.logoData && input.logoData.length > 0 ? 145 : 90;
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(48)
        .text('Certificado', 0, titleY, { align: 'center' });

      doc.moveDown(0.3);
      doc
        .font('Helvetica')
        .fontSize(14)
        .fillColor('#525252')
        .text('de finalización', { align: 'center' });

      // Cuerpo: alumno
      doc.moveDown(2);
      doc
        .font('Helvetica')
        .fontSize(14)
        .fillColor('#404040')
        .text('Se otorga a', { align: 'center' });
      doc.moveDown(0.4);
      doc
        .font('Helvetica-Bold')
        .fontSize(28)
        .fillColor(color)
        .text(input.studentName, { align: 'center' });

      // Cuerpo: descripción
      doc.moveDown(1.2);
      doc
        .font('Helvetica')
        .fontSize(13)
        .fillColor('#404040')
        .text(input.body ?? DEFAULT_BODY, 120, doc.y, {
          align: 'center',
          width: pageWidth - 240,
        });

      // Curso
      doc.moveDown(1.2);
      doc.font('Helvetica').fontSize(13).fillColor('#525252').text('Curso', { align: 'center' });
      doc.moveDown(0.3);
      doc
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor('#0a0a0a')
        .text(input.courseTitle, { align: 'center' });

      // Footer: fecha + número + firma
      const footerY = pageHeight - 130;
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor('#525252')
        .text(`Fecha: ${input.issuedAt.toLocaleDateString('es-ES')}`, 100, footerY);
      doc.text(`Nº ${input.number}`, 100, footerY + 16);

      if (input.signerName) {
        const signX = pageWidth - 280;
        doc.text('________________________', signX, footerY - 4);
        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor('#0a0a0a')
          .text(input.signerName, signX, footerY + 14);
        if (input.signerTitle) {
          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#737373')
            .text(input.signerTitle, signX, footerY + 30);
        }
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
