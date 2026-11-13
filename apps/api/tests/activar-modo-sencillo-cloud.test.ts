/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { decidir } from '../scripts/activar-modo-sencillo-cloud';

describe('activar-modo-sencillo-cloud: qué aulas cambia', () => {
  const base = { id: '00000000-0000-4000-8000-000000000001', slug: 'x' };
  it('un aula creada por Cloud en modo completo se activa', () => {
    expect(decidir({ ...base, simpleMode: false, creadaPorCloud: true })).toBe('activar');
  });
  it('idempotente: si ya está en modo sencillo no se vuelve a escribir', () => {
    expect(decidir({ ...base, simpleMode: true, creadaPorCloud: true })).toBe('ya-sencilla');
  });
  it('control: un aula de instalación propia o creada a mano NUNCA se toca', () => {
    expect(decidir({ ...base, simpleMode: false, creadaPorCloud: false })).toBe('no-es-de-cloud');
  });
});
