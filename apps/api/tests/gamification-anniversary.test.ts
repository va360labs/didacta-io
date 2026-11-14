/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { anniversaryYears } from '../src/modules/gamification/gamification-anniversary.worker';

describe('anniversaryYears — quién cumple hoy años en la comunidad', () => {
  const today = new Date('2026-11-14T08:00:00Z');

  it('mismo día y mes, uno o más años después', () => {
    expect(anniversaryYears(new Date('2025-11-14T19:00:00Z'), today)).toBe(1);
    expect(anniversaryYears(new Date('2023-11-14T00:00:00Z'), today)).toBe(3);
  });

  it('control: ni el día de antes, ni el de después, ni quien se dio de alta este año', () => {
    expect(anniversaryYears(new Date('2025-11-13T10:00:00Z'), today)).toBeNull();
    expect(anniversaryYears(new Date('2025-11-15T10:00:00Z'), today)).toBeNull();
    expect(anniversaryYears(new Date('2026-11-14T07:00:00Z'), today)).toBeNull();
  });

  it('alta un 29 de febrero: lo celebra el 28 los años no bisiestos, y el 29 los bisiestos', () => {
    const leapJoin = new Date('2024-02-29T12:00:00Z');
    expect(anniversaryYears(leapJoin, new Date('2025-02-28T08:00:00Z'))).toBe(1);
    expect(anniversaryYears(leapJoin, new Date('2025-03-01T08:00:00Z'))).toBeNull();
    expect(anniversaryYears(leapJoin, new Date('2028-02-28T08:00:00Z'))).toBeNull();
    expect(anniversaryYears(leapJoin, new Date('2028-02-29T08:00:00Z'))).toBe(4);
  });
});
