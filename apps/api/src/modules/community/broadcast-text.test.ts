/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { broadcastBodyText } from './broadcast-text';

describe('broadcastBodyText (aviso de «avisar a todos»)', () => {
  it('va en el idioma del aula, no en español fijo', () => {
    expect(broadcastBodyText('en', 'Ana', 'Hello!')).toBe('Ana posted in the community:\n\nHello!');
    expect(broadcastBodyText('pt', 'Ana', 'Olá!')).toBe('Ana publicou na comunidade:\n\nOlá!');
    // Control: el aula española sigue como siempre.
    expect(broadcastBodyText('es', 'Ana', 'Hola')).toBe(
      'Ana ha publicado en la comunidad:\n\nHola',
    );
  });

  it('sin nombre del autor, el genérico del idioma del aula', () => {
    expect(broadcastBodyText('en', null, 'x')).toBe(
      'An administrator posted in the community:\n\nx',
    );
    expect(broadcastBodyText('pt', '  ', 'x')).toBe(
      'Um administrador publicou na comunidade:\n\nx',
    );
    expect(broadcastBodyText('es', null, 'x')).toBe(
      'Un administrador ha publicado en la comunidad:\n\nx',
    );
  });
});
