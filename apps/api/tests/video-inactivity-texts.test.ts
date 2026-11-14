/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Avisos de inactividad al creador (10 y 20 días): en su idioma, con la fecha
 * del borrado formateada en ese idioma. El español no cambia por existir el
 * portugués.
 */

import { describe, expect, it } from 'vitest';
import { formatDay, inactivityTexts } from '../src/video/cloud/video-inactivity-texts';

const DELETE_ON = new Date('2026-12-04T00:00:00Z');

describe('avisos de inactividad de vídeo', () => {
  it('portugués: fecha pt-BR, «academia» y «vídeos que você enviou», sin español', () => {
    const d10 = inactivityTexts({
      lang: 'pt',
      stage: 10,
      academy: 'Escola Luz',
      deleteOn: DELETE_ON,
    });
    expect(d10.subject).toBe('Escola Luz está há 10 dias sem atividade');
    expect(d10.title).toBe('Sua academia está há 10 dias sem atividade');
    expect(d10.body).toContain('em 4 de dezembro de 2026 vamos excluir os vídeos que você enviou');
    expect(d10.cta).toBe('Entrar na minha academia');
    const d20 = inactivityTexts({
      lang: 'pt',
      stage: 20,
      academy: 'Escola Luz',
      deleteOn: DELETE_ON,
    });
    expect(d20.subject).toBe('Em 4 de dezembro de 2026 vamos excluir os vídeos de Escola Luz');
    expect(d20.body).toContain('Se ninguém entrar antes de 4 de dezembro de 2026');
    for (const espanol of ['borraremos', 'diciembre', 'lleva', 'Entrar en mi']) {
      expect(`${d10.body}\n${d20.body}\n${d20.cta}`, espanol).not.toContain(espanol);
    }
  });

  it('control: el español y el inglés salen como siempre', () => {
    const es = inactivityTexts({ lang: 'es', stage: 20, academy: 'Aula', deleteOn: DELETE_ON });
    expect(es.subject).toBe('El 4 de diciembre de 2026 borraremos los vídeos de Aula');
    expect(es.cta).toBe('Entrar en mi academia');
    expect(formatDay(DELETE_ON, 'en')).toBe('4 December 2026');
    expect(formatDay(DELETE_ON, 'pt')).toBe('4 de dezembro de 2026');
  });
});
