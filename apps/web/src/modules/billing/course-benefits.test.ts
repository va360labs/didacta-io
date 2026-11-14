/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { courseBenefits } from './course-benefits';

describe('courseBenefits: el panel de venta solo promete lo que es verdad', () => {
  it('curso suelto en un aula sin certificados ni comunidad: solo pago único y a tu ritmo', () => {
    expect(
      courseBenefits({ oneTimePurchase: true, activeModules: new Set(['mod.courses']) }),
    ).toEqual(['lifetime', 'pace']);
  });

  it('con certificados y comunidad activos, los dos aparecen', () => {
    expect(
      courseBenefits({
        oneTimePurchase: true,
        activeModules: new Set(['mod.certificates', 'mod.community']),
      }),
    ).toEqual(['lifetime', 'certificate', 'pace', 'community']);
  });

  it('solo dentro de la membresía: no se promete acceso de por vida', () => {
    expect(
      courseBenefits({ oneTimePurchase: false, activeModules: new Set(['mod.community']) }),
    ).toEqual(['pace', 'community']);
  });

  it('mientras no se saben los módulos, nada que dependa de ellos', () => {
    expect(courseBenefits({ oneTimePurchase: true, activeModules: null })).toEqual([
      'lifetime',
      'pace',
    ]);
  });
});
