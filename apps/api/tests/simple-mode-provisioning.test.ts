/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { resolveSimpleMode } from '../src/admin/admin-tenants.service';

/**
 * El modo sencillo solo nace encendido en las aulas de Didacta Cloud. Una
 * instalación propia (super_admin humano) y cualquier aula existente siguen en
 * modo completo: es la garantía de aislamiento del producto.
 */
describe('resolveSimpleMode (alta de aula)', () => {
  const cloud = {
    kind: 'provisioning',
    credentialId: '00000000-0000-4000-8000-000000000001',
  } as const;
  const humano = { kind: 'user', userId: '00000000-0000-4000-8000-000000000002' } as const;

  it('un aula creada por el plano de control (Cloud) nace en modo sencillo', () => {
    expect(resolveSimpleMode(cloud, undefined)).toBe(true);
  });

  it('un aula creada por un super_admin de una instalación propia nace en modo completo', () => {
    expect(resolveSimpleMode(humano, undefined)).toBe(false);
  });

  it('lo pedido explícitamente manda en los dos sentidos', () => {
    expect(resolveSimpleMode(cloud, false)).toBe(false);
    expect(resolveSimpleMode(humano, true)).toBe(true);
  });
});
