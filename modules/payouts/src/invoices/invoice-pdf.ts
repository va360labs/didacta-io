/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import PDFDocument from 'pdfkit';
import { STRIPE_ZERO_DECIMAL_CURRENCIES } from '../currencies.js';
import type { TaxAddress } from '../tax/tax-profile.service.js';
import type { VatRegime } from './vat.js';

/**
 * PDF de una factura de la comisión (RD 1619/2012, art. 6 y, en las
 * rectificativas, art. 15). Lleva:
 *
 *  - número y serie, fecha de expedición y periodo de las operaciones;
 *  - emisor y destinatario: nombre o razón social, NIF (y NIF-IVA si lo hay) y
 *    domicilio;
 *  - descripción, una línea por venta (fecha, concepto, importe de la venta y
 *    comisión), y los totales: base imponible, tipo, cuota y total;
 *  - la mención legal del régimen (inversión del sujeto pasivo, no sujeción…);
 *  - en una rectificativa: la factura que rectifica, su fecha y el motivo.
 *
 * Etiquetas en español; si el destinatario no está en España, también en su
 * segunda lengua (la ley admite cualquier idioma; el español es el de
 * referencia): portugués para los países de lengua portuguesa (Brasil,
 * Portugal…) e inglés para el resto (`invoiceSecondLang`). La mención legal
 * del régimen de IVA se queda en español: cita la ley española.
 * Las fuentes estándar del PDF solo cubren Windows-1252: lo que se sale (p.
 * ej. «Ł») se translitera en vez de pintar un carácter roto.
 */

export interface InvoicePdfParty {
  readonly name: string;
  readonly taxId: string | null;
  readonly vatId: string | null;
  readonly address: TaxAddress | null;
  readonly country: string;
}

export interface InvoicePdfItem {
  readonly date: Date;
  /** Lo que se vendió; sin descripción, el PDF pone «Venta» en sus idiomas. */
  readonly description: string | null;
  /** Devolución de una comisión ya facturada: el PDF la rotula como tal. */
  readonly commissionRefund?: boolean;
  readonly saleGross: number | null;
  /** IVA incluido, con signo. */
  readonly amount: number;
  /** En una rectificativa por devoluciones: la factura que cobró la comisión. */
  readonly originalInvoice?: string | null;
}

export interface InvoicePdfInput {
  readonly kind: 'ORDINARY' | 'RECTIFYING';
  readonly fullNumber: string;
  readonly issueDate: Date;
  readonly periodFirstDay: Date;
  readonly periodLastDay: Date;
  readonly currency: string;
  readonly regime: VatRegime;
  readonly vatRateBps: number;
  readonly total: number;
  readonly taxBase: number;
  readonly vatAmount: number;
  readonly issuer: InvoicePdfParty & { readonly email?: string | null };
  readonly recipient: InvoicePdfParty & { readonly complete: boolean };
  /** Nombre comercial del servicio («Didacta Cloud»). */
  readonly serviceName: string;
  readonly items: readonly InvoicePdfItem[];
  readonly rectifies: ReadonlyArray<{ readonly fullNumber: string; readonly issueDate: string }>;
  readonly rectificationReason: string | null;
  readonly mention: string | null;
  /** `false`: modo prueba, sin validez fiscal (se marca en grande). */
  readonly livemode: boolean;
}

const COUNTRY_NAMES_ES: Readonly<Record<string, string>> = {
  ES: 'España',
  PT: 'Portugal',
  FR: 'Francia',
  DE: 'Alemania',
  IT: 'Italia',
  NL: 'Países Bajos',
  BE: 'Bélgica',
  IE: 'Irlanda',
  AT: 'Austria',
  GB: 'Reino Unido',
  CH: 'Suiza',
  US: 'Estados Unidos',
  CA: 'Canadá',
  BR: 'Brasil',
};

/** Países de lengua portuguesa (ISO 3166-1 alfa-2). */
const PORTUGUESE_SPEAKING = new Set(['BR', 'PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL']);

/** Segunda lengua de la factura según el país del destinatario (`null`: solo español). */
export function invoiceSecondLang(country: string): 'en' | 'pt' | null {
  const code = country.trim().toUpperCase();
  if (code === 'ES') return null;
  return PORTUGUESE_SPEAKING.has(code) ? 'pt' : 'en';
}

/** Caracteres que pintan bien las fuentes estándar (Windows-1252). */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

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

/** «1.234,56 EUR». Código ISO en vez de símbolo: vale para cualquier moneda. */
export function formatInvoiceAmount(amount: number, currency: string): string {
  const zero = STRIPE_ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
  const value = zero ? amount : amount / 100;
  const formatted = new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: zero ? 0 : 2,
    maximumFractionDigits: zero ? 0 : 2,
    useGrouping: true,
  }).format(value);
  // Espacios finos o duros de Intl → espacio normal (las fuentes del PDF no los tienen).
  return `${formatted.replace(/\s/g, ' ')} ${currency.toUpperCase()}`;
}

export function formatInvoiceDate(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getUTCFullYear()}`;
}

function formatAddress(address: TaxAddress | null, country: string): string[] {
  const countryName = COUNTRY_NAMES_ES[country] ?? country;
  if (!address) return [countryName];
  const line2 = [address.postalCode, address.city].filter(Boolean).join(' ');
  return [
    address.line1,
    address.line2 ?? '',
    [line2, address.region].filter(Boolean).join(', '),
    countryName,
  ].filter((line) => line && line.trim());
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const second = invoiceSecondLang(input.recipient.country);
  const L = (es: string, en: string, pt: string) =>
    second ? `${es} / ${second === 'pt' ? pt : en}` : es;
  const money = (amount: number) => formatInvoiceAmount(amount, input.currency);
  const rectifying = input.kind === 'RECTIFYING';

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: pdfSafe(`${rectifying ? 'Factura rectificativa' : 'Factura'} ${input.fullNumber}`),
          Author: pdfSafe(input.issuer.name),
          Subject: pdfSafe(`Comisión de ${input.serviceName}`),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 50;
      const width = doc.page.width - 100;
      const text = (value: string) => pdfSafe(value);

      if (!input.livemode) {
        doc
          .save()
          .rect(left, 30, width, 18)
          .fill('#fde68a')
          .restore()
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor('#92400e')
          .text(
            text(
              L(
                'MODO PRUEBA — SIN VALIDEZ FISCAL',
                'TEST MODE — NOT A VALID INVOICE',
                'MODO DE TESTE — SEM VALIDADE FISCAL',
              ),
            ),
            left,
            35,
            {
              width,
              align: 'center',
            },
          );
      }

      // Cabecera: tipo, número y fechas.
      doc
        .fillColor('#0f172a')
        .font('Helvetica-Bold')
        .fontSize(18)
        .text(
          text(
            rectifying
              ? L('Factura rectificativa', 'Corrective invoice', 'Fatura retificadora')
              : L('Factura', 'Invoice', 'Fatura'),
          ),
          left,
          60,
        );
      doc.font('Helvetica').fontSize(10).fillColor('#334155');
      doc.text(text(`${L('Número', 'Number', 'Número')}: ${input.fullNumber}`));
      doc.text(
        text(
          `${L('Fecha de expedición', 'Issue date', 'Data de emissão')}: ${formatInvoiceDate(input.issueDate)}`,
        ),
      );
      doc.text(
        text(
          `${L('Periodo de las operaciones', 'Service period', 'Período das operações')}: ${formatInvoiceDate(input.periodFirstDay)} – ${formatInvoiceDate(input.periodLastDay)}`,
        ),
      );
      doc.moveDown(1);

      // Emisor y destinatario, en dos columnas.
      const top = doc.y;
      const colWidth = (width - 20) / 2;
      const party = (title: string, p: InvoicePdfParty, x: number, extra: string[] = []) => {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor('#64748b')
          .text(text(title.toUpperCase()), x, top, {
            width: colWidth,
          });
        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor('#0f172a')
          .text(text(p.name), x, doc.y + 2, {
            width: colWidth,
          });
        doc.font('Helvetica').fontSize(9.5).fillColor('#334155');
        const lines = [
          p.taxId ? `NIF: ${p.taxId}` : null,
          p.vatId ? `${L('NIF-IVA', 'VAT ID', 'NIF-IVA')}: ${p.vatId}` : null,
          ...formatAddress(p.address, p.country),
          ...extra,
        ].filter((line): line is string => Boolean(line));
        for (const line of lines) doc.text(text(line), x, doc.y, { width: colWidth });
        return doc.y;
      };
      const yIssuer = party(
        L('Emisor', 'Issuer', 'Emitente'),
        input.issuer,
        left,
        input.issuer.email ? [input.issuer.email] : [],
      );
      const yRecipient = party(
        L('Destinatario', 'Customer', 'Destinatário'),
        input.recipient,
        left + colWidth + 20,
        input.recipient.complete
          ? []
          : [
              L(
                'Datos del destinatario pendientes de completar',
                'Customer details pending',
                'Dados do destinatário pendentes',
              ),
            ],
      );
      doc.y = Math.max(yIssuer, yRecipient) + 16;
      doc.x = left;

      if (rectifying) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
        doc.text(
          text(
            `${L('Rectifica', 'Corrects', 'Retifica')}: ${input.rectifies
              .map(
                (r) =>
                  `${r.fullNumber} (${formatInvoiceDate(new Date(`${r.issueDate}T00:00:00Z`))})`,
              )
              .join(', ')}`,
          ),
          left,
          doc.y,
          { width },
        );
        if (input.rectificationReason) {
          doc.font('Helvetica').fontSize(10).fillColor('#334155');
          doc.text(text(`${L('Motivo', 'Reason', 'Motivo')}: ${input.rectificationReason}`), {
            width,
          });
        }
        doc.moveDown(0.8);
      }

      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
      doc.text(
        text(
          L(
            `Concepto: comisión de ${input.serviceName} por la gestión del cobro de tus ventas (impuestos incluidos).`,
            `Description: ${input.serviceName} fee for collecting your sales (taxes included).`,
            `Descrição: comissão de ${input.serviceName} pela gestão do recebimento das suas vendas (impostos incluídos).`,
          ),
        ),
        left,
        doc.y,
        { width },
      );
      doc.moveDown(0.6);

      // Tabla de líneas.
      const cols = [
        { label: L('Fecha', 'Date', 'Data'), w: 70, align: 'left' as const },
        { label: L('Venta', 'Sale', 'Venda'), w: width - 70 - 90 - 100, align: 'left' as const },
        {
          label: L('Importe venta', 'Sale amount', 'Valor da venda'),
          w: 90,
          align: 'right' as const,
        },
        { label: L('Comisión', 'Fee', 'Comissão'), w: 100, align: 'right' as const },
      ];
      const row = (values: string[], bold: boolean) => {
        const y = doc.y;
        let x = left;
        let maxY = y;
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5)
          .fillColor(bold ? '#0f172a' : '#334155');
        values.forEach((value, i) => {
          doc.text(text(value), x, y, { width: cols[i]!.w - 6, align: cols[i]!.align });
          maxY = Math.max(maxY, doc.y);
          x += cols[i]!.w;
        });
        doc.y = maxY + 3;
        if (doc.y > doc.page.height - 120) {
          doc.addPage();
          doc.y = 50;
        }
      };
      row(
        cols.map((c) => c.label),
        true,
      );
      doc
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .moveTo(left, doc.y)
        .lineTo(left + width, doc.y)
        .stroke();
      doc.y += 4;
      for (const item of input.items) {
        const sold = item.description ?? L('Venta', 'Sale', 'Venda');
        const concept = item.commissionRefund
          ? `${L('Devolución de comisión', 'Commission refund', 'Devolução de comissão')}: ${sold}`
          : sold;
        const description = item.originalInvoice
          ? `${concept} (${L('factura', 'invoice', 'fatura')} ${item.originalInvoice})`
          : concept;
        row(
          [
            formatInvoiceDate(item.date),
            description,
            item.saleGross === null ? '—' : money(item.saleGross),
            money(item.amount),
          ],
          false,
        );
      }
      doc
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .moveTo(left, doc.y)
        .lineTo(left + width, doc.y)
        .stroke();
      doc.moveDown(0.8);

      // Totales.
      const rate = `${(input.vatRateBps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
      const totals: Array<[string, string, boolean]> = [
        [L('Base imponible', 'Tax base', 'Base de cálculo'), money(input.taxBase), false],
        [`${L('IVA', 'VAT', 'IVA')} (${rate})`, money(input.vatAmount), false],
        [L('Total', 'Total', 'Total'), money(input.total), true],
      ];
      for (const [label, value, bold] of totals) {
        const y = doc.y;
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(bold ? 11 : 10)
          .fillColor('#0f172a');
        doc.text(text(label), left + width - 300, y, { width: 180, align: 'right' });
        doc.text(text(value), left + width - 115, y, { width: 115, align: 'right' });
        doc.y = Math.max(doc.y, y + 14);
      }
      doc.moveDown(1);
      doc.x = left;

      const notes: string[] = [];
      if (input.mention) notes.push(input.mention);
      notes.push(
        input.total < 0
          ? L(
              'Importe a tu favor: te devolvimos esta parte de nuestra comisión al hacer el reembolso y ya está en tus cobros. No tienes que hacer nada.',
              'In your favour: we returned this part of our fee when the refund was made, and it is already in your payouts. Nothing to do.',
              'Valor a seu favor: devolvemos esta parte da nossa comissão quando o reembolso foi feito, e ela já está nos seus recebimentos. Você não precisa fazer nada.',
            )
          : L(
              'Importe ya cobrado: se descontó de las ventas que cobramos en tu nombre. No tienes que pagar nada.',
              'Already paid: deducted from the sales we collected on your behalf. Nothing to pay.',
              'Valor já pago: foi descontado das vendas que recebemos em seu nome. Você não precisa pagar nada.',
            ),
      );
      doc.font('Helvetica').fontSize(8.5).fillColor('#475569');
      for (const note of notes) {
        doc.text(text(note), left, doc.y, { width });
        doc.moveDown(0.3);
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
