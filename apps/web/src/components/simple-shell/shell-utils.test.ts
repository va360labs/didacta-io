/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { avatarInitials } from './shell-utils';

describe('avatarInitials', () => {
  it('dos iniciales del nombre', () => {
    expect(avatarInitials('Marta Ríos', 'm@x.test')).toBe('MR');
    expect(avatarInitials('  ana  ', 'a@x.test')).toBe('A');
    expect(avatarInitials('Íñigo Ñúñez Soto', null)).toBe('ÍÑ');
  });

  it('sin nombre, la inicial del correo (no la del dominio)', () => {
    expect(avatarInitials(null, 'creadora@aula.test')).toBe('C');
    expect(avatarInitials('   ', 'zoe@aula.test')).toBe('Z');
  });

  it('sin nada usable, cadena vacía: el avatar pone un icono', () => {
    expect(avatarInitials(null, null)).toBe('');
    expect(avatarInitials('', '+foo@x.test')).toBe('');
  });
});
