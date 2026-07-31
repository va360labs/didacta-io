/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import PDFDocument from 'pdfkit';
import type { ActionView } from './dto.js';

/**
 * Datos necesarios para emitir una evidencia de asistencia Fundae a un
 * participante concreto. La firma textual del responsable se renderiza
 * abajo a la derecha siguiendo la misma convención que el certificado de
 * `mod.certificates`. v0.3 NO firma criptográficamente: la trazabilidad la
 * da el `mod.audit-log` (cadena de hashes) + `mod.evidence-vault`.
 */
export interface EvidenceRenderInput {
  action: ActionView;
  /** Nombre legible del centro impartidor (snapshot del tenant). */
  centerName: string;
  /** CIF del centro impartidor — opcional, viene de la acción si está set. */
  cifCentro?: string | null;
  /** Datos del participante. */
  participantName: string;
  participantEmail: string;
  participantDni: string | null;
  /**
   * Horas asistidas reportadas por el sistema (estimación basada en
   * progress%). En XML salen como `horasAsistidas`; aquí salen idénticas
   * para evitar discrepancias entre el documento firmado y el reporte.
   */
  horasAsistidas: number;
  /** Resultado de la acción para este participante. */
  resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO';
  /** Fecha de matriculación + completion (si aplica). */
  enrolledAt: Date;
  completedAt: Date | null;
  /** Responsable que firma la evidencia (admin del tenant). */
  signerName: string;
  signerTitle?: string | null;
  /** Fecha de emisión del documento. Default: now(). */
  issuedAt?: Date;
}

const RESULTADO_LABEL: Record<EvidenceRenderInput['resultado'], string> = {
  APTO: 'APTO',
  NO_APTO: 'NO APTO',
  EN_CURSO: 'EN CURSO',
};

/**
 * Genera un PDF A4 vertical con los datos de asistencia + horas + firma.
 * Es la "evidencia firmada" que Fundae requiere por participante (junto al
 * XML de la acción) cuando se presenta el expediente de bonificación.
 *
 * Devuelve un Buffer listo para guardar en object storage o servir.
 */
export async function renderEvidencePdf(input: EvidenceRenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const issuedAt = input.issuedAt ?? new Date();
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: `Evidencia Fundae · ${input.action.codigoAccion}`,
          Author: input.centerName,
          Subject: `Asistencia de ${input.participantName} a ${input.action.nombre}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;

      // Encabezado.
      doc
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor('#0f172a')
        .text('Evidencia de asistencia', { align: 'center' });
      doc.moveDown(0.2);
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor('#525252')
        .text('Fundae · Subvenciones para la formación profesional para el empleo', {
          align: 'center',
        });
      doc.moveDown(0.6);

      // Datos del centro impartidor.
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#404040')
        .text(`Centro impartidor: ${input.centerName}`);
      if (input.cifCentro) {
        doc.font('Helvetica').fontSize(10).text(`CIF: ${input.cifCentro}`);
      }
      doc.moveDown(0.6);

      // Acción formativa.
      drawSection(doc, 'Acción formativa');
      drawKv(doc, 'Código', input.action.codigoAccion);
      drawKv(doc, 'Nombre', input.action.nombre);
      drawKv(doc, 'Modalidad', input.action.modalidad);
      drawKv(doc, 'Horas totales', `${input.action.horasFormacion} h`);
      drawKv(doc, 'Período', `${input.action.fechaInicio} → ${input.action.fechaFin}`);
      if (input.action.lugar) {
        drawKv(doc, 'Lugar', input.action.lugar);
      }
      doc.moveDown(0.4);

      // Participante.
      drawSection(doc, 'Participante');
      drawKv(doc, 'Nombre', input.participantName);
      drawKv(doc, 'Email', input.participantEmail);
      drawKv(doc, 'DNI / NIE', input.participantDni ?? '— (no declarado)');
      drawKv(
        doc,
        'Matriculación',
        input.enrolledAt.toLocaleDateString('es-ES', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
        }),
      );
      if (input.completedAt) {
        drawKv(
          doc,
          'Finalización',
          input.completedAt.toLocaleDateString('es-ES', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }),
        );
      }
      doc.moveDown(0.4);

      // Resultado destacado.
      drawSection(doc, 'Resultado');
      doc.moveDown(0.2);
      doc
        .font('Helvetica-Bold')
        .fontSize(22)
        .fillColor(resultColor(input.resultado))
        .text(RESULTADO_LABEL[input.resultado], { align: 'center' });
      doc.moveDown(0.2);
      doc
        .font('Helvetica')
        .fontSize(13)
        .fillColor('#404040')
        .text(`Horas asistidas: ${input.horasAsistidas} h`, { align: 'center' });
      doc.moveDown(1.2);

      // Declaración de la entidad.
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor('#404040')
        .text(
          `${input.centerName} certifica que la persona arriba indicada ha participado en la acción formativa descrita y que los datos consignados (horas, modalidad, fechas y resultado) coinciden con los registros de asistencia y progreso de la plataforma. Esta evidencia se acompaña del expediente XML de la acción para su presentación a Fundae.`,
          {
            align: 'justify',
            width: pageWidth - 120,
          },
        );

      // Firma + fecha de emisión.
      doc.moveDown(2);
      const signY = doc.y;
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#525252')
        .text(`Emitido el ${issuedAt.toLocaleDateString('es-ES')}`, 60, signY);

      const signX = pageWidth - 260;
      doc.text('________________________', signX, signY - 4);
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#0a0a0a')
        .text(input.signerName, signX, signY + 14);
      if (input.signerTitle) {
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor('#737373')
          .text(input.signerTitle, signX, signY + 30);
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function drawSection(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text(title);
  doc
    .strokeColor('#e5e7eb')
    .lineWidth(0.5)
    .moveTo(doc.x, doc.y + 2)
    .lineTo(doc.page.width - 60, doc.y + 2)
    .stroke();
  doc.moveDown(0.3);
}

function drawKv(doc: PDFKit.PDFDocument, key: string, value: string): void {
  const startX = doc.x;
  const startY = doc.y;
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#737373')
    .text(`${key}:`, startX, startY, { continued: false, width: 110 });
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#0f172a')
    .text(value, startX + 110, startY);
}

function resultColor(resultado: EvidenceRenderInput['resultado']): string {
  switch (resultado) {
    case 'APTO':
      return '#15803d';
    case 'NO_APTO':
      return '#b91c1c';
    default:
      return '#0369a1';
  }
}
