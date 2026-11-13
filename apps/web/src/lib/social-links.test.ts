/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
// La tabla que manda (la de la API). Solo la importa este test: el web no
// depende del paquete del módulo, pero su espejo no puede quedarse atrás.
import * as api from '../../../../modules/theming/src/social-links';
import {
  MAX_SOCIAL_LINKS,
  MAX_SOCIAL_LINK_URL_CHARS,
  SOCIAL_LINK_HOSTS,
  SOCIAL_LINK_KINDS,
  detectSocialKind,
  socialLinkName,
  socialLinkProblem,
} from './social-links';

describe('enlaces sociales en el web', () => {
  it('el espejo es la tabla de la API: redes, dominios y límites', () => {
    expect(SOCIAL_LINK_KINDS).toEqual(api.SOCIAL_LINK_KINDS);
    expect(SOCIAL_LINK_HOSTS).toEqual(api.SOCIAL_LINK_HOSTS);
    expect(MAX_SOCIAL_LINKS).toBe(api.MAX_SOCIAL_LINKS);
    expect(MAX_SOCIAL_LINK_URL_CHARS).toBe(api.MAX_SOCIAL_LINK_URL_CHARS);
  });

  it.each([
    ['https://wa.me/34600000000', 'whatsapp'],
    ['https://chat.whatsapp.com/AbC', 'whatsapp'],
    ['https://t.me/morningpour', 'telegram'],
    ['https://www.instagram.com/morningpour', 'instagram'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://www.tiktok.com/@morningpour', 'tiktok'],
    ['https://m.facebook.com/morningpour', 'facebook'],
    ['https://es.linkedin.com/company/x', 'linkedin'],
    ['https://twitter.com/morningpour', 'x'],
    ['https://morningpour.example.com', 'web'],
    // Lo que se parece pero no es: a la web (y con su globo, no con el logo).
    ['https://wa.me.evil.example.com', 'web'],
    ['https://notinstagram.com/x', 'web'],
    ['http://instagram.com/x', 'web'],
    ['', 'web'],
  ])('%s → %s', (url, kind) => {
    expect(detectSocialKind(url)).toBe(kind);
  });

  it('lo que la API rechazaría se avisa antes de guardar, con la misma razón', () => {
    const casos: Array<[string, ReturnType<typeof socialLinkProblem>]> = [
      ['https://instagram.com/ok', null],
      ['http://example.com', 'https'],
      ['javascript:alert(1)', 'https'],
      ['instagram.com/x', 'https'],
      ['https://wa.me@evil.example.com/', 'credentials'],
      ['https://localhost/x', 'host'],
      [`https://example.com/${'a'.repeat(600)}`, 'length'],
    ];
    for (const [url, why] of casos) {
      const kind = detectSocialKind(url);
      expect(socialLinkProblem(kind, url), url).toBe(why);
      expect(api.socialLinkProblem(kind, url), `API: ${url}`).toBe(why);
    }
  });

  it('nombre visible: la marca, o el dominio sin www si es una web', () => {
    expect(socialLinkName('instagram', 'https://instagram.com/', 'Website')).toBe('Instagram');
    expect(socialLinkName('web', 'https://www.morningpour.example.com/a', 'Website')).toBe(
      'morningpour.example.com',
    );
    expect(socialLinkName('web', 'no-url', 'Website')).toBe('Website');
  });
});
