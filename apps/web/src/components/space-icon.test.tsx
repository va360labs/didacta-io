/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpaceIcon } from './space-icon';

/**
 * El selector de espacio del compositor pintaba `{s.icon}` tal cual: los
 * espacios del alta sencilla («megaphone», «help») salían con su NOMBRE de
 * icono como texto. `SpaceIcon` pinta el icono; un emoji sigue siendo emoji.
 */
describe('SpaceIcon', () => {
  it('un nombre de icono se pinta como icono, no como texto', () => {
    for (const name of ['megaphone', 'help', 'hash']) {
      const html = renderToStaticMarkup(<SpaceIcon icon={name} />);
      expect(html).toContain('<svg');
      expect(html).not.toContain(`>${name}<`);
    }
  });

  it('«#» (el de «General») es el icono de almohadilla', () => {
    const html = renderToStaticMarkup(<SpaceIcon icon="#" />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('>#<');
  });

  it('un emoji se respeta', () => {
    const html = renderToStaticMarkup(<SpaceIcon icon="📣" />);
    expect(html).not.toContain('<svg');
    expect(html).toContain('📣');
  });
});
