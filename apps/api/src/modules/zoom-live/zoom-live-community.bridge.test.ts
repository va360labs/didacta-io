/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { announcementPost, formatWhen } from './zoom-live-community.bridge';

const SESSION = {
  topic: 'Dialing in espresso',
  description: 'Bring your grinder.',
  // Jueves 19 de noviembre de 2026, 18:00 UTC = 19:00 en Madrid.
  startTime: new Date('2026-11-19T18:00:00Z'),
  timezone: 'Europe/Madrid',
  durationMinutes: 60,
};

describe('anuncio del directo en la comunidad', () => {
  it('en un aula en inglés, todo en inglés (texto, fecha y etiqueta)', () => {
    const post = announcementPost(SESSION, 's-1', 'en');
    expect(post.tag).toBe('Live classes');
    expect(post.body).toContain('Live class: **Dialing in espresso**.');
    expect(post.body).toContain('Thursday, November 19');
    // La hora es la de la clase y lleva su zona: desde Nueva York no se lee
    // como «las siete de aquí».
    expect(post.body).toMatch(/07:00 PM GMT\+1/);
    expect(post.body).toContain('Sign up here');
    expect(post.body).toContain('Bring your grinder.');
    expect(post.body).toContain('<!--didacta-clase:s-1-->');
    // Ni rastro del español de antes.
    expect(post.body).not.toMatch(/Clase en directo|Inscríbete|noviembre|jueves/i);
  });

  it('en un aula en español, en español y en la hora de la clase', () => {
    const post = announcementPost(SESSION, 's-1', 'es');
    expect(post.tag).toBe('Clases en directo');
    expect(post.body).toContain('Clase en directo: **Dialing in espresso**.');
    expect(post.body).toContain('jueves, 19 de noviembre');
    expect(post.body).toMatch(/19:00 CET/);
    expect(post.body).toContain('Inscríbete desde aquí');
    expect(post.title).toBe('Dialing in espresso');
  });

  it('una zona que Intl no conoce no tumba el anuncio', () => {
    expect(formatWhen(SESSION.startTime, 'Mars/Olympus', 'en')).toMatch(/2026/);
  });
});
