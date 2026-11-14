/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { fileNameFrom, mailtoBuyer, saleStatusKey, saleStatusTone, salesQuery } from './sales';

describe('salesQuery', () => {
  it('sin filtros, solo la página', () => {
    expect(salesQuery({}, { page: 2, pageSize: 25 })).toBe('?page=2&pageSize=25');
    expect(salesQuery({})).toBe('');
  });

  it('los días son locales: «hasta» incluye el día entero', () => {
    const q = new URLSearchParams(salesQuery({ from: '2026-11-01', to: '2026-11-14' }).slice(1));
    expect(q.get('from')).toBe(new Date(2026, 10, 1).toISOString());
    expect(q.get('to')).toBe(new Date(2026, 10, 15).toISOString());
  });

  it('quita lo vacío, recorta la búsqueda y pasa producto y estado', () => {
    const q = new URLSearchParams(
      salesQuery({
        q: '  ana@example.com  ',
        product: 'course:abc',
        status: 'refunded',
        from: 'x',
      }).slice(1),
    );
    expect(q.get('q')).toBe('ana@example.com');
    expect(q.get('product')).toBe('course:abc');
    expect(q.get('status')).toBe('refunded');
    expect(q.has('from')).toBe(false);
    expect(salesQuery({ q: '   ', status: '' })).toBe('');
  });
});

describe('estado de una venta', () => {
  it('reembolsada en parte tiene su propio texto; el tono sigue al estado', () => {
    expect(saleStatusKey({ status: 'refunded', refundState: 'partial' })).toBe('refundedPartial');
    expect(saleStatusKey({ status: 'refunded', refundState: 'full' })).toBe('refunded');
    expect(saleStatusTone({ status: 'transferred', refundState: 'none' })).toBe('success');
    expect(saleStatusTone({ status: 'held', refundState: 'none' })).toBe('warning');
    expect(saleStatusTone({ status: 'disputed', refundState: 'none' })).toBe('danger');
    expect(saleStatusTone({ status: 'paid', refundState: 'none' })).toBe('info');
  });
});

describe('utilidades', () => {
  it('el nombre del fichero lo propone la API', () => {
    expect(fileNameFrom('attachment; filename="ventas-2026-11-14.csv"', 'x.csv')).toBe(
      'ventas-2026-11-14.csv',
    );
    expect(fileNameFrom(null, 'sales.csv')).toBe('sales.csv');
  });

  it('escribir al comprador: el correo tal cual y el asunto codificado', () => {
    expect(mailtoBuyer('ana+cafe@example.com', 'Tu compra de Café & leche')).toBe(
      'mailto:ana%2Bcafe@example.com?subject=Tu%20compra%20de%20Caf%C3%A9%20%26%20leche',
    );
  });
});
