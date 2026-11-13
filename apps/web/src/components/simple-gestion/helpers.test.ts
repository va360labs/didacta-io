/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  buildStartIso,
  isHttpsUrl,
  onlyStudents,
  shareUrl,
  upcoming,
  wantsFullSettings,
} from './helpers';

describe('directos sencillos', () => {
  it('solo acepta enlaces https con dominio', () => {
    expect(isHttpsUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(isHttpsUrl(' https://zoom.us/j/123 ')).toBe(true);
    expect(isHttpsUrl('http://zoom.us/j/123')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('https://localhost')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });

  it('arma la hora de inicio en la zona del creador', () => {
    expect(buildStartIso('2026-11-20', '19:00', 'Europe/Madrid')).toBe('2026-11-20T18:00:00.000Z');
    expect(buildStartIso('2026-07-20', '19:00', 'Europe/Madrid')).toBe('2026-07-20T17:00:00.000Z');
    expect(buildStartIso('2026-11-20', '19:00', 'America/Mexico_City')).toBe(
      '2026-11-21T01:00:00.000Z',
    );
    expect(buildStartIso('', '19:00', 'Europe/Madrid')).toBeNull();
    expect(buildStartIso('2026-11-20', '7pm', 'Europe/Madrid')).toBeNull();
  });

  it('próximas: sin canceladas ni terminadas, la más cercana primero', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const lista = [
      { id: 'b', status: 'SCHEDULED', startTime: '2026-11-20T18:00:00Z', durationMinutes: 60 },
      { id: 'a', status: 'SCHEDULED', startTime: '2026-11-13T18:00:00Z', durationMinutes: 60 },
      { id: 'c', status: 'CANCELLED', startTime: '2026-11-14T18:00:00Z', durationMinutes: 60 },
      { id: 'd', status: 'SCHEDULED', startTime: '2026-11-10T18:00:00Z', durationMinutes: 60 },
      { id: 'e', status: 'STARTED', startTime: '2026-11-12T11:30:00Z', durationMinutes: 60 },
    ];
    expect(upcoming(lista, now).map((s) => s.id)).toEqual(['e', 'a', 'b']);
  });
});

describe('alumnos y ajustes sencillos', () => {
  it('el enlace para compartir solo existe tras publicar', () => {
    expect(shareUrl('https://academia.didacta.io/', '/catalog/curso')).toBe(
      'https://academia.didacta.io/catalog/curso',
    );
    expect(shareUrl('https://academia.didacta.io', null)).toBeNull();
  });

  it('alumnos: fuera el equipo', () => {
    const users = [
      { id: '1', roles: ['alumno'] },
      { id: '2', roles: ['tenant_admin'] },
      { id: '3', roles: [] },
      { id: '4', roles: ['formador', 'alumno'] },
    ];
    expect(onlyStudents(users).map((u) => u.id)).toEqual(['1', '3']);
  });

  it('la vista completa de Ajustes se fuerza con ?full=1 o con ?tab=', () => {
    const p = (q: string) => new URLSearchParams(q);
    expect(wantsFullSettings(p('full=1'))).toBe(true);
    // El nombre de antes, de enlaces ya enviados.
    expect(wantsFullSettings(p('completo=1'))).toBe(true);
    expect(wantsFullSettings(p('full=0'))).toBe(false);
    expect(wantsFullSettings(p('tab=pagos'))).toBe(true);
    expect(wantsFullSettings(p(''))).toBe(false);
    expect(wantsFullSettings(null)).toBe(false);
  });
});
