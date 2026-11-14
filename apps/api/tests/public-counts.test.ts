/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La regla única de cuándo un aula enseña sus cifras en público (login y
 * portada). Si cambia el umbral, cambia aquí y en las dos pantallas a la vez.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_STUDENTS_FOR_PUBLIC_COUNTS,
  STAFF_ROLES,
  showsPublicCounts,
} from '../src/public/public-counts';

describe('showsPublicCounts', () => {
  it('el umbral es de 10 alumnos', () => {
    expect(MIN_STUDENTS_FOR_PUBLIC_COUNTS).toBe(10);
  });

  it('por debajo del umbral, ninguna cifra', () => {
    for (const n of [0, 1, 2, 9]) expect(showsPublicCounts(n), `${n}`).toBe(false);
  });

  it('desde el umbral, las cifras', () => {
    for (const n of [10, 11, 250]) expect(showsPublicCounts(n), `${n}`).toBe(true);
  });

  it('el equipo no son alumnos', () => {
    expect([...STAFF_ROLES].sort()).toEqual(['formador', 'super_admin', 'tenant_admin']);
  });
});
