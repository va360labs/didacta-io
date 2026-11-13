/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import PDFDocument from 'pdfkit';

/**
 * Justificante en PDF de un cobro de referidos EN DINERO que el aula marcó
 * pagado. Mismo estilo y mismas precauciones que la factura de la comisión
 * de `mod.payouts` (A4, Helvetica, texto Windows-1252 transliterado):
 *
 *  - emisor (el aula, que es quien paga) y receptor con su identificador
 *    fiscal e IBAN;
 *  - número correlativo POR AULA, fecha de pago y referencia de la
 *    transferencia;
 *  - una línea por comisión incluida (y los ajustes por devolución, en
 *    negativo) y el total;
 *  - la mención de que Didacta no interviene en el pago ni practica retención.
 *
 * Etiquetas en español; si el receptor no está en España, también en inglés.
 */

export interface ReceiptLine {
  readonly date: Date;
  /** «Comisión del 30 % sobre una venta de 49,00 EUR» / «Ajuste por devolución». */
  readonly concept: string;
  /** Con signo: los ajustes por devolución van en negativo. */
  readonly amountCents: number;
}

export interface ReceiptPdfInput {
  readonly number: number;
  readonly paidAt: Date;
  readonly reference: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly issuerName: string;
  readonly payee: {
    readonly fullName: string;
    readonly country: string;
    readonly taxId: string;
    readonly iban: string;
  } | null;
  readonly lines: readonly ReceiptLine[];
}

/** «Justificante nº 0007». */
export function receiptLabel(n: number): string {
  return String(n).padStart(4, '0');
}

const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Lo que las fuentes estándar del PDF no pintan, transliterado. */
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (ch === '\n') {
      out += ch;
      continue;
    }
    const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const fallback: Record<string, string> = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', ß: 'ss', ı: 'i' };
    out +=
      fallback[ch] ??
      ([...stripped].every((c) => c.codePointAt(0)! <= 0xff) && stripped ? stripped : '?');
  }
  return out;
}

/** «1.234,56 EUR» (las monedas de Stripe sin decimales no se usan en referidos). */
export function formatReceiptAmount(cents: number, currency: string): string {
  const formatted = new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(cents / 100);
  return `${formatted.replace(/\s/g, ' ')} ${currency.toUpperCase()}`;
}

function formatDate(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getUTCFullYear()}`;
}

function groupIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  const bilingual = input.payee !== null && input.payee.country !== 'ES';
  const L = (es: string, en: string) => (bilingual ? `${es} / ${en}` : es);
  const money = (cents: number) => formatReceiptAmount(cents, input.currency);
  const label = receiptLabel(input.number);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: pdfSafe(`Justificante de pago ${label}`),
          Author: pdfSafe(input.issuerName),
          Subject: 'Comisiones por referidos',
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 50;
      const width = doc.page.width - 100;
      const t = (value: string) => pdfSafe(value);

      doc
        .font('Helvetica-Bold')
        .fontSize(18)
        .fillColor('#0f172a')
        .text(t(L('Justificante de pago', 'Payment receipt')), left, 50);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#334155')
        .text(t(L('Comisiones por referidos', 'Referral commissions')));
      doc.moveDown(0.8);
      doc
        .font('Helvetica-Bold')
        .text(t(`${L('Número', 'Number')}: ${label}`))
        .font('Helvetica')
        .text(t(`${L('Fecha de pago', 'Payment date')}: ${formatDate(input.paidAt)}`))
        .text(t(`${L('Referencia', 'Reference')}: ${input.reference}`));

      doc.moveDown(1);
      const colY = doc.y;
      const half = width / 2 - 10;
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(t(L('Paga (emisor)', 'Payer (issuer)')), left, colY, { width: half })
        .font('Helvetica')
        .text(t(input.issuerName), { width: half });
      doc
        .font('Helvetica-Bold')
        .text(t(L('Recibe', 'Payee')), left + half + 20, colY, { width: half })
        .font('Helvetica');
      if (input.payee) {
        doc
          .text(t(input.payee.fullName), { width: half })
          .text(t(`${L('NIF', 'Tax ID')}: ${input.payee.taxId}`), { width: half })
          .text(t(`IBAN: ${groupIban(input.payee.iban)}`), { width: half });
      } else {
        doc.text(t(L('Sin datos de cobro', 'No payment details')), { width: half });
      }

      doc.moveDown(2);
      const tableTop = Math.max(doc.y, colY + 70);
      const colAmount = left + width - 110;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#0f172a')
        .text(t(L('Fecha', 'Date')), left, tableTop)
        .text(t(L('Concepto', 'Description')), left + 70, tableTop)
        .text(t(L('Importe', 'Amount')), colAmount, tableTop, { width: 110, align: 'right' });
      doc
        .moveTo(left, tableTop + 14)
        .lineTo(left + width, tableTop + 14)
        .strokeColor('#cbd5e1')
        .stroke();
      let y = tableTop + 20;
      doc.font('Helvetica').fontSize(9).fillColor('#334155');
      for (const line of input.lines) {
        doc
          .text(formatDate(line.date), left, y)
          .text(t(line.concept), left + 70, y, { width: colAmount - left - 80 })
          .text(t(money(line.amountCents)), colAmount, y, { width: 110, align: 'right' });
        y = Math.max(doc.y, y + 14) + 4;
        if (y > doc.page.height - 120) {
          doc.addPage();
          y = 50;
        }
      }
      doc
        .moveTo(left, y)
        .lineTo(left + width, y)
        .strokeColor('#cbd5e1')
        .stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#0f172a')
        .text(t(L('Total pagado', 'Total paid')), left, y + 8)
        .text(t(money(input.totalCents)), colAmount, y + 8, { width: 110, align: 'right' });

      doc.moveDown(2.5);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor('#64748b')
        .text(
          t(
            L(
              `Pago realizado por ${input.issuerName} por el programa de referidos de su academia. Didacta no interviene en el pago ni practica ninguna retención.`,
              `Payment made by ${input.issuerName} under its academy's referral programme. Didacta is not involved in the payment and withholds nothing.`,
            ),
          ),
          left,
          doc.y,
          { width },
        );
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
