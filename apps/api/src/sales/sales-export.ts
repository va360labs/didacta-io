/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import AdmZip from 'adm-zip';
import { STRIPE_ZERO_DECIMAL_CURRENCIES } from '@didacta/mod-payouts';
import type { AcademyLocale } from '../common/academy-defaults';
import type { SaleRow, SaleStatus } from './sales-ledger.types';

/**
 * Exportación de «Ventas»: una tabla (cabeceras + filas) que se escribe como
 * CSV o como hoja de Excel. Puro: sin base de datos ni red.
 *
 *  - Cabeceras y estados en el idioma del aula.
 *  - Cada fecha dos veces: ISO 8601 en UTC (para máquinas) y en la hora del
 *    aula (para personas).
 *  - Importes en unidades de la moneda, con su moneda en la columna de al lado:
 *    nunca se suman monedas distintas.
 *  - CSV en UTF-8 con BOM (Excel lo abre con tildes y eñes) y con el separador
 *    y los decimales que espera la hoja de cálculo del idioma: `;` y coma en
 *    español y portugués, `,` y punto en inglés.
 *  - Ninguna celda de texto puede empezar por `=`, `+`, `-`, `@`, tabulador ni
 *    retorno: un nombre como `=HYPERLINK(…)` se exporta como texto, no como
 *    fórmula (inyección de fórmulas en CSV).
 */

export type Cell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'money'; readonly minor: number; readonly currency: string }
  | { readonly kind: 'int'; readonly value: number }
  | null;

export interface ExportTable {
  readonly sheetName: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly Cell[]>;
}

export interface ExportOptions {
  readonly locale: AcademyLocale;
  /** Zona horaria del aula (IANA). */
  readonly timeZone: string;
  /** Locale de formato de fechas del aula (`es-ES`, `en-US`, `pt-BR`). */
  readonly dateLocale: string;
  /** Nombre del operador de cobros («Didacta»), para la columna de su comisión. */
  readonly operatorName: string | null;
  /** ¿Lleva las columnas del reparto de la plataforma? */
  readonly withSettlement: boolean;
}

interface Texts {
  readonly sheetSales: string;
  readonly sheetBuyers: string;
  readonly saleId: string;
  readonly dateIso: string;
  readonly dateLocal: (tz: string) => string;
  readonly name: string;
  readonly email: string;
  readonly checkoutEmail: string;
  readonly country: string;
  readonly product: string;
  readonly option: string;
  readonly type: string;
  readonly typeOrder: string;
  readonly typeMembership: string;
  readonly typeSubscription: string;
  readonly amount: string;
  readonly currency: string;
  readonly coupon: string;
  readonly referralCredit: string;
  readonly referredBy: string;
  readonly referralCommission: string;
  readonly settlementCurrency: string;
  readonly cardFee: string;
  readonly platformFee: (operator: string) => string;
  readonly net: string;
  readonly refunded: string;
  readonly status: string;
  readonly statuses: Record<SaleStatus | 'refundedPartial', string>;
  readonly deletedAccount: string;
  readonly firstPurchase: string;
  readonly lastPurchase: string;
  readonly purchases: string;
  readonly totalPaid: string;
}

const TEXTS: Record<AcademyLocale, Texts> = {
  es: {
    sheetSales: 'Ventas',
    sheetBuyers: 'Compradores',
    saleId: 'ID de la venta',
    dateIso: 'Fecha (ISO 8601, UTC)',
    dateLocal: (tz) => `Fecha (hora de ${tz})`,
    name: 'Nombre',
    email: 'Correo',
    checkoutEmail: 'Correo usado al pagar',
    country: 'País',
    product: 'Producto',
    option: 'Opción de compra',
    type: 'Tipo',
    typeOrder: 'Pago único',
    typeMembership: 'Cuota de membresía',
    typeSubscription: 'Cuota de suscripción',
    amount: 'Importe pagado',
    currency: 'Moneda',
    coupon: 'Descuento por cupón',
    referralCredit: 'Saldo de referidos usado',
    referredBy: 'Referido por',
    referralCommission: 'Comisión para quien invitó',
    settlementCurrency: 'Moneda de liquidación',
    cardFee: 'Comisión de la tarjeta',
    platformFee: (op) => `Comisión de ${op}`,
    net: 'Neto para ti',
    refunded: 'Devuelto',
    status: 'Estado',
    statuses: {
      paid: 'Pagada',
      held: 'Retenida',
      transferred: 'Transferida',
      refunded: 'Reembolsada',
      refundedPartial: 'Reembolsada en parte',
      disputed: 'Disputada',
    },
    deletedAccount: 'Cuenta eliminada',
    firstPurchase: 'Primera compra',
    lastPurchase: 'Última compra',
    purchases: 'Compras',
    totalPaid: 'Total pagado',
  },
  en: {
    sheetSales: 'Sales',
    sheetBuyers: 'Buyers',
    saleId: 'Sale ID',
    dateIso: 'Date (ISO 8601, UTC)',
    dateLocal: (tz) => `Date (${tz} time)`,
    name: 'Name',
    email: 'Email',
    checkoutEmail: 'Email used at checkout',
    country: 'Country',
    product: 'Product',
    option: 'Purchase option',
    type: 'Type',
    typeOrder: 'One-time payment',
    typeMembership: 'Membership payment',
    typeSubscription: 'Subscription payment',
    amount: 'Amount paid',
    currency: 'Currency',
    coupon: 'Coupon discount',
    referralCredit: 'Referral credit used',
    referredBy: 'Referred by',
    referralCommission: 'Commission for the referrer',
    settlementCurrency: 'Settlement currency',
    cardFee: 'Card fee',
    platformFee: (op) => `${op} fee`,
    net: 'Net to you',
    refunded: 'Refunded',
    status: 'Status',
    statuses: {
      paid: 'Paid',
      held: 'Held',
      transferred: 'Transferred',
      refunded: 'Refunded',
      refundedPartial: 'Partially refunded',
      disputed: 'Disputed',
    },
    deletedAccount: 'Deleted account',
    firstPurchase: 'First purchase',
    lastPurchase: 'Last purchase',
    purchases: 'Purchases',
    totalPaid: 'Total paid',
  },
  pt: {
    sheetSales: 'Vendas',
    sheetBuyers: 'Compradores',
    saleId: 'ID da venda',
    dateIso: 'Data (ISO 8601, UTC)',
    dateLocal: (tz) => `Data (horário de ${tz})`,
    name: 'Nome',
    email: 'E-mail',
    checkoutEmail: 'E-mail usado no pagamento',
    country: 'País',
    product: 'Produto',
    option: 'Opção de compra',
    type: 'Tipo',
    typeOrder: 'Pagamento único',
    typeMembership: 'Cobrança da assinatura',
    typeSubscription: 'Cobrança recorrente',
    amount: 'Valor pago',
    currency: 'Moeda',
    coupon: 'Desconto de cupom',
    referralCredit: 'Saldo de indicações usado',
    referredBy: 'Indicado por',
    referralCommission: 'Comissão para quem indicou',
    settlementCurrency: 'Moeda de recebimento',
    cardFee: 'Taxa do cartão',
    platformFee: (op) => `Comissão da ${op}`,
    net: 'Líquido para você',
    refunded: 'Reembolsado',
    status: 'Situação',
    statuses: {
      paid: 'Paga',
      held: 'Retida',
      transferred: 'Transferida',
      refunded: 'Reembolsada',
      refundedPartial: 'Reembolsada em parte',
      disputed: 'Contestada',
    },
    deletedAccount: 'Conta excluída',
    firstPurchase: 'Primeira compra',
    lastPurchase: 'Última compra',
    purchases: 'Compras',
    totalPaid: 'Total pago',
  },
};

export function exportTexts(locale: AcademyLocale): Texts {
  return TEXTS[locale] ?? TEXTS.es;
}

const text = (value: string | null | undefined): Cell =>
  value === null || value === undefined || value === '' ? null : { kind: 'text', value };
const money = (minor: number | null | undefined, currency: string | null | undefined): Cell =>
  minor === null || minor === undefined || !currency
    ? null
    : { kind: 'money', minor, currency: currency.toLowerCase() };

function localDate(iso: string, opts: ExportOptions): string {
  return new Intl.DateTimeFormat(opts.dateLocale, {
    timeZone: opts.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function statusLabel(row: Pick<SaleRow, 'status' | 'refundState'>, t: Texts): string {
  if (row.status === 'refunded' && row.refundState === 'partial') return t.statuses.refundedPartial;
  return t.statuses[row.status];
}

function typeLabel(row: SaleRow, t: Texts): string {
  if (row.kind === 'order') return t.typeOrder;
  return row.product.kind === 'membership' ? t.typeMembership : t.typeSubscription;
}

/** Una fila por venta. */
export function salesTable(rows: readonly SaleRow[], opts: ExportOptions): ExportTable {
  const t = exportTexts(opts.locale);
  const headers = [
    t.dateIso,
    t.dateLocal(opts.timeZone),
    t.name,
    t.email,
    t.checkoutEmail,
    t.country,
    t.product,
    t.option,
    t.type,
    t.amount,
    t.currency,
    t.coupon,
    t.referralCredit,
    t.referredBy,
    t.referralCommission,
    ...(opts.withSettlement
      ? [t.settlementCurrency, t.cardFee, t.platformFee(opts.operatorName ?? 'Didacta'), t.net]
      : []),
    t.refunded,
    t.status,
    t.saleId,
  ];
  const out = rows.map((r): Cell[] => {
    const s = r.settlement;
    const refunded =
      s && s.refunded > 0
        ? money(s.refunded, s.currency)
        : r.refundState === 'full'
          ? money(r.amount, r.currency)
          : null;
    return [
      text(r.at),
      text(localDate(r.at, opts)),
      text(r.buyer.name ?? (r.buyer.deleted ? t.deletedAccount : null)),
      text(r.buyer.email),
      text(r.buyer.checkoutEmail),
      text(r.buyer.country),
      text(r.product.title),
      text(r.product.option),
      text(typeLabel(r, t)),
      money(r.amount, r.currency),
      text(r.currency.toUpperCase()),
      money(r.coupon, r.currency),
      money(r.referralCredit, r.currency),
      text(r.referral ? (r.referral.referrerName ?? r.referral.code) : null),
      r.referral ? money(r.referral.commission, r.referral.commissionCurrency) : null,
      ...(opts.withSettlement
        ? [
            text(s?.currency ? s.currency.toUpperCase() : null),
            money(s?.cardFee, s?.currency),
            money(s?.platformFee, s?.currency),
            money(s?.net, s?.currency),
          ]
        : []),
      refunded,
      text(statusLabel(r, t)),
      text(r.id),
    ];
  });
  return { sheetName: t.sheetSales, headers, rows: out };
}

/**
 * Una fila por comprador y moneda (nunca se suman monedas): quién compró,
 * cuándo por primera y última vez, cuántas veces y cuánto pagó. Las ventas
 * devueltas enteras no suman al total ni a las compras.
 */
export function buyersTable(rows: readonly SaleRow[], opts: ExportOptions): ExportTable {
  const t = exportTexts(opts.locale);
  interface Acc {
    name: string | null;
    email: string | null;
    country: string | null;
    first: string;
    last: string;
    count: number;
    total: number;
    currency: string;
  }
  const byKey = new Map<string, Acc>();
  for (const r of rows) {
    if (r.refundState === 'full') continue;
    const who = r.buyer.userId ?? r.buyer.email ?? r.id;
    const key = `${who}|${r.currency}`;
    const acc = byKey.get(key);
    if (!acc) {
      byKey.set(key, {
        name: r.buyer.name ?? (r.buyer.deleted ? t.deletedAccount : null),
        email: r.buyer.email,
        country: r.buyer.country,
        first: r.at,
        last: r.at,
        count: 1,
        total: r.amount,
        currency: r.currency,
      });
      continue;
    }
    acc.count += 1;
    acc.total += r.amount;
    if (r.at < acc.first) acc.first = r.at;
    if (r.at > acc.last) acc.last = r.at;
    acc.country ??= r.buyer.country;
  }
  const headers = [
    t.name,
    t.email,
    t.country,
    t.firstPurchase,
    t.lastPurchase,
    t.purchases,
    t.totalPaid,
    t.currency,
  ];
  const out = [...byKey.values()]
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((a): Cell[] => [
      text(a.name),
      text(a.email),
      text(a.country),
      text(localDate(a.first, opts)),
      text(localDate(a.last, opts)),
      { kind: 'int', value: a.count },
      money(a.total, a.currency),
      text(a.currency.toUpperCase()),
    ]);
  return { sheetName: t.sheetBuyers, headers, rows: out };
}

/** Decimales de una moneda según Stripe (no `Intl`). */
function decimals(currency: string): number {
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 0 : 2;
}

function majorUnits(minor: number, currency: string): number {
  return decimals(currency) === 0 ? minor : minor / 100;
}

/** Texto que una hoja de cálculo NO puede tomar por fórmula. */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** `;` y coma decimal en español y portugués; `,` y punto en inglés. */
export function csvDialect(locale: AcademyLocale): { separator: string; decimal: string } {
  return locale === 'en' ? { separator: ',', decimal: '.' } : { separator: ';', decimal: ',' };
}

function csvField(value: string, separator: string): string {
  return /["\r\n]/.test(value) || value.includes(separator)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** CSV en UTF-8 con BOM, CRLF entre filas. */
export function toCsv(table: ExportTable, locale: AcademyLocale): Buffer {
  const { separator, decimal } = csvDialect(locale);
  const cell = (c: Cell): string => {
    if (c === null) return '';
    if (c.kind === 'text') return csvField(safeText(c.value), separator);
    if (c.kind === 'int') return String(c.value);
    const fixed = majorUnits(c.minor, c.currency).toFixed(decimals(c.currency));
    return csvField(decimal === '.' ? fixed : fixed.replace('.', decimal), separator);
  };
  const lines = [
    table.headers.map((h) => csvField(h, separator)).join(separator),
    ...table.rows.map((r) => r.map(cell).join(separator)),
  ];
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'),
  ]);
}

// ── Excel (.xlsx) ──────────────────────────────────────────────────────────

/** ¿Admite XML 1.0 este carácter? (tabulador, saltos y el resto del rango válido). */
function xmlAllowed(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/** Fuera los caracteres que XML 1.0 no admite, y escapado. */
function xmlText(value: string): string {
  let out = '';
  for (const ch of value) {
    if (!xmlAllowed(ch.codePointAt(0)!)) continue;
    out += XML_ESCAPES[ch] ?? ch;
  }
  return out;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * Hoja de Excel mínima (Office Open XML): una hoja, cabecera en negrita y
 * fija, importes como NÚMEROS con su formato (se pueden sumar y filtrar) y
 * todo el texto en línea. Sin dependencias nuevas: el zip es `adm-zip`, que
 * ya usa la API.
 */
export function toXlsx(table: ExportTable): Buffer {
  const head = `<row r="1">${table.headers
    .map(
      (h, i) =>
        `<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlText(h)}</t></is></c>`,
    )
    .join('')}</row>`;
  const body = table.rows
    .map((row, ri) => {
      const r = ri + 2;
      const cells = row
        .map((c, ci) => {
          if (c === null) return '';
          const ref = `${columnName(ci)}${r}`;
          if (c.kind === 'text') {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(c.value)}</t></is></c>`;
          }
          if (c.kind === 'int') return `<c r="${ref}" s="3"><v>${c.value}</v></c>`;
          const style = decimals(c.currency) === 0 ? 3 : 2;
          return `<c r="${ref}" s="${style}"><v>${majorUnits(c.minor, c.currency)}</v></c>`;
        })
        .join('');
      return `<row r="${r}">${cells}</row>`;
    })
    .join('');
  const widths = table.headers
    .map((h, i) => {
      const longest = Math.max(
        h.length,
        ...table.rows.slice(0, 200).map((row) => {
          const c = row[i];
          return c && c.kind === 'text' ? c.value.length : 12;
        }),
      );
      const width = Math.min(Math.max(longest + 2, 10), 48);
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${head}${body}</sheetData><autoFilter ref="A1:${columnName(Math.max(table.headers.length - 1, 0))}${table.rows.length + 1}"/></worksheet>`;
  const sheetName = xmlText(table.sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      'utf8',
    ),
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'utf8',
    ),
  );
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(table.headers.length - 1, 0))}$${table.rows.length + 1}</definedName></definedNames></workbook>`,
      'utf8',
    ),
  );
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'utf8',
    ),
  );
  zip.addFile('xl/styles.xml', Buffer.from(XLSX_STYLES, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  return zip.toBuffer();
}
