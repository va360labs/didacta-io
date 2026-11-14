/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * País del banco DECLARADO por el creador en el alta de Didacta Cloud
 * (`payoutsCountry` → `tenant_setting payouts/declared_country`). Dato
 * declarado, no verificado: solo orienta la tarjeta de cobros.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DECLARED_COUNTRY_OTHER,
  PAYOUTS_DECLARED_COUNTRY_SETTING,
  normalizeDeclaredCountry,
  readDeclaredCountry,
  writeDeclaredCountry,
} from '../src/modules/payouts/declared-country';

describe('normalizeDeclaredCountry', () => {
  it('dos letras (cualquier país) en mayúsculas, u OTHER', () => {
    expect(normalizeDeclaredCountry('BR')).toBe('BR');
    expect(normalizeDeclaredCountry('mx')).toBe('MX');
    expect(normalizeDeclaredCountry(' es ')).toBe('ES');
    expect(normalizeDeclaredCountry('OTHER')).toBe(DECLARED_COUNTRY_OTHER);
    expect(normalizeDeclaredCountry('other')).toBe('OTHER');
  });

  it('lo demás no vale', () => {
    for (const bad of ['ESP', 'XX1', 'E', '', 'OTRO', 'B R', null, undefined, 76, { c: 'ES' }]) {
      expect(normalizeDeclaredCountry(bad), String(bad)).toBeNull();
    }
  });
});

describe('ajuste del aula payouts/declared_country', () => {
  const TENANT = 'tenant-1';
  const where = {
    tenantId_moduleName_key: {
      tenantId: TENANT,
      moduleName: PAYOUTS_DECLARED_COUNTRY_SETTING.moduleName,
      key: PAYOUTS_DECLARED_COUNTRY_SETTING.key,
    },
  };

  it('se escribe con upsert (repetir el alta no duplica) y sin marcarlo secreto', async () => {
    const upsert = vi.fn(async () => ({}));
    await writeDeclaredCountry({ tenantSetting: { upsert } }, TENANT, 'BR', 'admin-1');
    expect(upsert).toHaveBeenCalledWith({
      where,
      create: {
        ...where.tenantId_moduleName_key,
        valueJson: 'BR',
        isSecret: false,
        updatedById: 'admin-1',
      },
      update: { valueJson: 'BR', updatedById: 'admin-1' },
    });
  });

  it('se lee normalizado; sin ajuste, con un valor raro o si la lectura falla → null', async () => {
    const read = (value: unknown, fail = false) =>
      readDeclaredCountry(
        {
          tenantSetting: {
            findUnique: vi.fn(async () => {
              if (fail) throw new Error('caída');
              return value === undefined ? null : { valueJson: value };
            }),
          },
        },
        TENANT,
      );
    expect(await read('BR')).toBe('BR');
    expect(await read('OTHER')).toBe('OTHER');
    expect(await read(undefined)).toBeNull();
    expect(await read({ country: 'BR' })).toBeNull();
    expect(await read('BR', true)).toBeNull();
  });
});
