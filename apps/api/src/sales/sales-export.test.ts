/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  buyersTable,
  columnName,
  csvDialect,
  safeText,
  salesTable,
  toCsv,
  toXlsx,
  type ExportOptions,
} from './sales-export';
import type { SaleRow } from './sales-ledger.types';

function sale(over: Partial<SaleRow> = {}): SaleRow {
  return {
    id: 'order:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
    kind: 'order',
    at: '2026-11-14T12:05:00.000Z',
    buyer: {
      userId: 'u-1',
      name: 'Ana Pérez',
      email: 'ana@example.com',
      checkoutEmail: null,
      country: 'ES',
      deleted: false,
    },
    product: {
      kind: 'course',
      ref: 'course:c1',
      title: 'Torno para principiantes',
      option: null,
      intervalMonths: null,
    },
    amount: 4900,
    currency: 'eur',
    coupon: null,
    referralCredit: null,
    referral: null,
    settlement: {
      currency: 'eur',
      gross: 4900,
      cardFee: 179,
      platformFee: 245,
      net: 4476,
      debtNetted: 0,
      refunded: 0,
    },
    status: 'transferred',
    refundState: 'none',
    payoutSaleId: 'p-1',
    ...over,
  };
}

const ES: ExportOptions = {
  locale: 'es',
  timeZone: 'Europe/Madrid',
  dateLocale: 'es-ES',
  operatorName: 'Didacta',
  withSettlement: true,
};

/** Lee el CSV como lo haría una hoja de cálculo: sin BOM, por filas y separador. */
function parse(buf: Buffer, sep: string): string[][] {
  const raw = buf.toString('utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return text
    .trimEnd()
    .split('\r\n')
    .map((line) => {
      const out: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === sep) {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
}

describe('CSV de ventas', () => {
  it('UTF-8 con BOM, cabeceras en el idioma del aula y fecha en ISO y en local', () => {
    const buf = toCsv(salesTable([sale()], ES), 'es');
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [head, row] = parse(buf, ';');
    expect(head).toEqual([
      'Fecha (ISO 8601, UTC)',
      'Fecha (hora de Europe/Madrid)',
      'Nombre',
      'Correo',
      'Correo usado al pagar',
      'País',
      'Producto',
      'Opción de compra',
      'Tipo',
      'Importe pagado',
      'Moneda',
      'Descuento por cupón',
      'Saldo de referidos usado',
      'Referido por',
      'Comisión para quien invitó',
      'Moneda de liquidación',
      'Comisión de la tarjeta',
      'Comisión de Didacta',
      'Neto para ti',
      'Devuelto',
      'Estado',
      'ID de la venta',
    ]);
    const col = (name: string) => row![head!.indexOf(name)];
    expect(col('Fecha (ISO 8601, UTC)')).toBe('2026-11-14T12:05:00.000Z');
    // 12:05 UTC son las 13:05 en Madrid (horario de invierno).
    expect(col('Fecha (hora de Europe/Madrid)')).toBe('14/11/2026, 13:05');
    expect(col('Nombre')).toBe('Ana Pérez');
    expect(col('Correo')).toBe('ana@example.com');
    expect(col('Importe pagado')).toBe('49,00');
    expect(col('Moneda')).toBe('EUR');
    expect(col('Comisión de la tarjeta')).toBe('1,79');
    expect(col('Comisión de Didacta')).toBe('2,45');
    expect(col('Neto para ti')).toBe('44,76');
    expect(col('Estado')).toBe('Transferida');
    expect(col('Tipo')).toBe('Pago único');
  });

  it('en inglés: coma como separador y punto decimal; en portugués, como en español', () => {
    expect(csvDialect('en')).toEqual({ separator: ',', decimal: '.' });
    expect(csvDialect('pt')).toEqual({ separator: ';', decimal: ',' });
    const en = parse(
      toCsv(salesTable([sale()], { ...ES, locale: 'en', dateLocale: 'en-US' }), 'en'),
      ',',
    );
    expect(en[0]).toContain('Amount paid');
    expect(en[1]![en[0]!.indexOf('Amount paid')]).toBe('49.00');
    expect(en[1]![en[0]!.indexOf('Status')]).toBe('Transferred');
    const pt = parse(
      toCsv(salesTable([sale()], { ...ES, locale: 'pt', dateLocale: 'pt-BR' }), 'pt'),
      ';',
    );
    expect(pt[0]).toContain('Valor pago');
    expect(pt[0]).toContain('Comissão da Didacta');
    expect(pt[1]![pt[0]!.indexOf('Situação')]).toBe('Transferida');
  });

  it('un nombre con separador, comillas o salto de línea no rompe la fila', () => {
    const rows = parse(
      toCsv(
        salesTable([sale({ buyer: { ...sale().buyer, name: 'Ana; "la del torno"\nPérez' } })], ES),
        'es',
      ),
      ';',
    );
    // El salto de línea va dentro de comillas: se reconstruye en una sola celda.
    const text = toCsv(
      salesTable([sale({ buyer: { ...sale().buyer, name: 'Ana; "x"' } })], ES),
      'es',
    ).toString('utf8');
    expect(text).toContain('"Ana; ""x"""');
    expect(rows[0]!.length).toBeGreaterThan(10);
  });

  it('inyección de fórmulas: un nombre que empieza por «=» sale como texto', () => {
    expect(safeText('=HYPERLINK("http://x","clic")')).toBe('\'=HYPERLINK("http://x","clic")');
    expect(safeText('+34 600')).toBe("'+34 600");
    expect(safeText('-1')).toBe("'-1");
    expect(safeText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(safeText('Ana')).toBe('Ana');
    const text = toCsv(
      salesTable([sale({ buyer: { ...sale().buyer, name: '=1+1' } })], ES),
      'es',
    ).toString('utf8');
    expect(text).toContain(";'=1+1;");
  });

  it('con claves propias no hay columnas de comisiones; reembolsada en parte lo dice', () => {
    const own = salesTable(
      [sale({ settlement: null, payoutSaleId: null, status: 'refunded', refundState: 'full' })],
      { ...ES, withSettlement: false, operatorName: null },
    );
    expect(own.headers).not.toContain('Neto para ti');
    expect(own.headers).not.toContain('Comisión de la tarjeta');
    const [head, row] = parse(toCsv(own, 'es'), ';');
    expect(row![head!.indexOf('Devuelto')]).toBe('49,00');
    expect(row![head!.indexOf('Estado')]).toBe('Reembolsada');
    const partial = salesTable(
      [
        sale({
          status: 'refunded',
          refundState: 'partial',
          settlement: { ...sale().settlement!, refunded: 1000 },
        }),
      ],
      ES,
    );
    const [h2, r2] = parse(toCsv(partial, 'es'), ';');
    expect(r2![h2!.indexOf('Estado')]).toBe('Reembolsada en parte');
    expect(r2![h2!.indexOf('Devuelto')]).toBe('10,00');
  });

  it('monedas sin decimales (JPY) sin decimales; la cuota de membresía con su tipo', () => {
    const t = salesTable(
      [
        sale({
          kind: 'subscription',
          amount: 5000,
          currency: 'jpy',
          settlement: null,
          product: { ...sale().product, kind: 'membership', intervalMonths: 1 },
        }),
      ],
      { ...ES, withSettlement: false },
    );
    const [head, row] = parse(toCsv(t, 'es'), ';');
    expect(row![head!.indexOf('Importe pagado')]).toBe('5000');
    expect(row![head!.indexOf('Tipo')]).toBe('Cuota de membresía');
  });
});

describe('Compradores', () => {
  it('una fila por comprador y moneda; lo devuelto entero no cuenta', () => {
    const t = buyersTable(
      [
        sale({ at: '2026-11-10T10:00:00.000Z' }),
        sale({ id: 'order:2', at: '2026-11-12T10:00:00.000Z', amount: 1000 }),
        sale({ id: 'order:3', currency: 'usd', amount: 3000 }),
        sale({ id: 'order:4', refundState: 'full', status: 'refunded', amount: 9999 }),
        sale({
          id: 'order:5',
          buyer: { ...sale().buyer, userId: 'u-2', name: 'Bea', email: 'bea@example.com' },
        }),
      ],
      ES,
    );
    expect(t.headers).toEqual([
      'Nombre',
      'Correo',
      'País',
      'Primera compra',
      'Última compra',
      'Compras',
      'Total pagado',
      'Moneda',
    ]);
    const [head, ...rows] = parse(toCsv(t, 'es'), ';');
    expect(rows).toHaveLength(3);
    const ana = rows.find((r) => r[1] === 'ana@example.com' && r[7] === 'EUR')!;
    expect(ana[head!.indexOf('Compras')]).toBe('2');
    expect(ana[head!.indexOf('Total pagado')]).toBe('59,00');
    expect(ana[head!.indexOf('Primera compra')]).toBe('10/11/2026, 11:00');
  });
});

describe('Excel', () => {
  it('es un .xlsx válido: una hoja con cabecera, texto en línea e importes como números', () => {
    const buf = toXlsx(
      salesTable(
        [sale(), sale({ id: 'order:2', buyer: { ...sale().buyer, name: '=1+1 & <b>' } })],
        ES,
      ),
    );
    const zip = new AdmZip(buf);
    const names = zip
      .getEntries()
      .map((e) => e.entryName)
      .sort();
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<t xml:space="preserve">Nombre</t>');
    expect(sheet).toContain('<t xml:space="preserve">Ana Pérez</t>');
    // Escapado y sin fórmula: en una hoja de Excel el texto en línea nunca se evalúa.
    expect(sheet).toContain('=1+1 &amp; &lt;b&gt;');
    expect(sheet).not.toContain('<f>');
    // 49,00 € como número con formato de dos decimales.
    expect(sheet).toMatch(/<c r="J2" s="2"><v>49<\/v><\/c>/);
    expect(zip.readAsText('xl/workbook.xml')).toContain('<sheet name="Ventas"');
  });

  it('nombres de columna como Excel', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
  });
});
