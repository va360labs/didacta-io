/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  RetentionUnknownVariableError,
  RetentionVariableNotAvailableError,
} from '../src/errors.js';
import {
  anniversaryOccurrences,
  daysAfterJoinOccurrences,
  inactiveOccurrences,
  welcomeOccurrences,
} from '../src/occurrences.js';
import type { RetentionMember } from '../src/ports.js';
import {
  addYears,
  fullYearsBetween,
  isWithinWindow,
  localClock,
  localDayKey,
  nextDayWindowStart,
  nextWindowStart,
} from '../src/schedule.js';
import { RETENTION_TEMPLATES } from '../src/templates.js';
import {
  assertVariables,
  findVariables,
  firstNameOf,
  renderText,
  RETENTION_LOCALES,
} from '../src/variables.js';

const DAY = 24 * 60 * 60 * 1000;
const W = { startHour: 9, endHour: 21 };

function member(over: Partial<RetentionMember> & { id: string }): RetentionMember {
  return {
    name: 'Ana López',
    email: `${over.id}@example.com`,
    avatarUrl: null,
    timezone: 'Europe/Madrid',
    joinedAt: new Date('2026-11-01T10:00:00Z'),
    lastActiveAt: null,
    isStaff: false,
    imported: false,
    ...over,
  };
}

describe('variables', () => {
  it('acepta el nombre de cada variable en los tres idiomas y sin tildes', () => {
    const { known, unknown } = findVariables(
      '{nombre} {name} {nome} {Academia} {escola} {nível} {course_link} {link_curso}',
    );
    expect(unknown).toEqual([]);
    expect(known.map((k) => k.key)).toEqual([
      'name',
      'name',
      'name',
      'academy',
      'academy',
      'level',
      'courseLink',
      'courseLink',
    ]);
  });

  it('rechaza una variable que no existe (no se envía una errata a nadie)', () => {
    expect(() => assertVariables('Hola {nmbre}', 'WELCOME')).toThrow(RetentionUnknownVariableError);
    try {
      assertVariables('Hola {nmbre} y {fecha}', 'WELCOME');
    } catch (err) {
      expect((err as RetentionUnknownVariableError).detail).toBe('{nmbre}, {fecha}');
    }
  });

  it('{nivel} solo vale en «subida de nivel»', () => {
    expect(() => assertVariables('Ya eres {nivel}', 'WELCOME')).toThrow(
      RetentionVariableNotAvailableError,
    );
    expect(() => assertVariables('Ya eres {nivel}', 'LEVEL_UP')).not.toThrow();
  });

  it('no confunde llaves de texto normal con variables', () => {
    expect(findVariables('Precio: { 10 € } y {a b}').unknown).toEqual([]);
  });

  it('sustituye con texto plano y deja escrita la variable sin valor (vista previa)', () => {
    expect(renderText('Hola {nombre}, mira {curso}', { name: '<b>Ana</b>' })).toBe(
      'Hola <b>Ana</b>, mira {curso}',
    );
    expect(renderText('{curso}', { course: '' })).toBe('');
  });

  it('el saludo nunca queda vacío: sin nombre, la parte del correo', () => {
    expect(firstNameOf('  Marta  Ruiz ', 'x@y.com')).toBe('Marta');
    expect(firstNameOf(null, 'ana.garcia@example.com')).toBe('Ana');
    expect(firstNameOf('', 'zoe@example.com')).toBe('Zoe');
  });

  it('todas las plantillas usan solo variables válidas en los tres idiomas', () => {
    for (const t of RETENTION_TEMPLATES) {
      for (const l of RETENTION_LOCALES) {
        expect(() => assertVariables(t.copy[l].body, t.trigger)).not.toThrow();
        expect(() => assertVariables(t.copy[l].subject, t.trigger)).not.toThrow();
        expect(t.copy[l].body.length).toBeLessThanOrEqual(4000);
      }
    }
  });

  it('en portugués el aula es «escola», nunca «academia»', () => {
    for (const t of RETENTION_TEMPLATES) {
      const pt = `${t.copy.pt.name} ${t.copy.pt.subject} ${t.copy.pt.body}`;
      expect(pt).not.toMatch(/academia/i);
      expect(pt).not.toMatch(/\{(nombre|academia|enlace_)/);
    }
  });
});

describe('reloj del alumno', () => {
  it('la hora local sale de su zona', () => {
    const at = new Date('2026-11-14T08:30:00Z');
    expect(localClock(at, 'Europe/Madrid').hour).toBe(9);
    expect(localClock(at, 'America/Bogota').hour).toBe(3);
    expect(localDayKey(new Date('2026-11-14T02:00:00Z'), 'America/Bogota')).toBe('2026-11-13');
  });

  it('fuera de la franja espera a que abra (hoy o mañana) en SU hora', () => {
    const madrugadaBogota = new Date('2026-11-14T08:00:00Z'); // 03:00 en Bogotá
    expect(isWithinWindow(madrugadaBogota, 'America/Bogota', W)).toBe(false);
    expect(nextWindowStart(madrugadaBogota, 'America/Bogota', W).toISOString()).toBe(
      '2026-11-14T14:00:00.000Z', // 09:00 en Bogotá
    );
    const nocheMadrid = new Date('2026-11-14T21:30:00Z'); // 22:30 en Madrid
    expect(nextWindowStart(nocheMadrid, 'Europe/Madrid', W).toISOString()).toBe(
      '2026-11-15T08:00:00.000Z',
    );
    const dentro = new Date('2026-11-14T12:00:00Z');
    expect(nextWindowStart(dentro, 'Europe/Madrid', W)).toBe(dentro);
  });

  it('respeta el cambio de hora (DST) al calcular «mañana a las 9»', () => {
    // 28-mar-2026 23:00 Madrid (UTC+1); el 29 ya es UTC+2.
    const sabado = new Date('2026-03-28T22:00:00Z');
    expect(nextDayWindowStart(sabado, 'Europe/Madrid', W).toISOString()).toBe(
      '2026-03-29T07:00:00.000Z',
    );
  });

  it('el aniversario de un 29 de febrero cae el 28 en años no bisiestos', () => {
    const start = new Date('2024-02-29T10:00:00Z');
    expect(addYears(start, 1).toISOString()).toBe('2025-02-28T10:00:00.000Z');
    expect(fullYearsBetween(start, new Date('2025-02-28T10:00:01Z'))).toBe(1);
    expect(fullYearsBetween(start, new Date('2025-02-27T10:00:00Z'))).toBe(0);
  });
});

describe('ocurrencias: «desde que se activa, no hacia atrás»', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const activated = new Date('2026-11-10T00:00:00Z');

  it('bienvenida: solo altas desde la activación, ni equipo ni importados', () => {
    const occ = welcomeOccurrences(
      [
        member({ id: 'nueva', joinedAt: new Date('2026-11-13T10:00:00Z') }),
        member({ id: 'antigua', joinedAt: new Date('2026-11-01T10:00:00Z') }),
        member({ id: 'profe', joinedAt: new Date('2026-11-13T10:00:00Z'), isStaff: true }),
        member({ id: 'importada', joinedAt: new Date('2026-11-13T10:00:00Z'), imported: true }),
        // Alta tras la activación pero hace más de 3 días: el momento ya pasó.
        member({ id: 'tarde', joinedAt: new Date('2026-11-10T10:00:00Z') }),
      ],
      activated,
      now,
    );
    expect(occ.map((o) => o.userId)).toEqual(['nueva']);
    expect(occ[0]?.occurrenceKey).toBe('join');
  });

  it('«a los 30 días» no escribe en masa a los antiguos al activarlo', () => {
    const justActivated = new Date('2026-11-14T11:00:00Z');
    const members = Array.from({ length: 50 }, (_, i) =>
      member({ id: `m${i}`, joinedAt: new Date(now.getTime() - (40 + i) * DAY) }),
    );
    // Uno que cumple los 30 días justo después de activarlo.
    members.push(
      member({ id: 'cumple', joinedAt: new Date(now.getTime() - 30 * DAY + 60_000 * 30) }),
    );
    expect(daysAfterJoinOccurrences(members, 30, justActivated, now)).toEqual([]);
    const later = new Date(now.getTime() + DAY);
    expect(
      daysAfterJoinOccurrences(members, 30, justActivated, later).map((o) => o.userId),
    ).toEqual(['cumple']);
  });

  it('recuperación: a quien cruza el umbral tras activarlo; reenvío una sola vez', () => {
    const members = [
      // Lleva 15 días sin entrar: cruzó los 14 hace 1 día (tras activarlo hace 4).
      member({ id: 'cruza', lastActiveAt: new Date(now.getTime() - 15 * DAY) }),
      // Lleva 60 días: cruzó mucho antes de activarlo → nada.
      member({ id: 'dormida', lastActiveAt: new Date(now.getTime() - 60 * DAY) }),
      // Entró ayer.
      member({ id: 'activa', lastActiveAt: new Date(now.getTime() - DAY) }),
    ];
    const occ = inactiveOccurrences(members, 14, 7, activated, now, new Map());
    expect(occ.map((o) => [o.userId, o.occurrenceKey])).toEqual([
      ['cruza', `inactive:${new Date(now.getTime() - 15 * DAY).toISOString().slice(0, 10)}`],
    ]);
    const key = occ[0]!.occurrenceKey;
    // Primer envío hace 8 días y sigue sin entrar: toca el reenvío (7 días).
    const resend = inactiveOccurrences(
      members,
      14,
      7,
      activated,
      new Date(now.getTime() + 8 * DAY),
      new Map([['cruza', { occurrenceKey: key, sentAt: now }]]),
    );
    expect(resend.map((o) => o.occurrenceKey)).toContain(`${key}:resend`);
    // Sin reenvío configurado no hay segundo mensaje.
    expect(
      inactiveOccurrences(
        members,
        14,
        null,
        activated,
        new Date(now.getTime() + 8 * DAY),
        new Map([['cruza', { occurrenceKey: key, sentAt: now }]]),
      ).some((o) => o.occurrenceKey.endsWith(':resend')),
    ).toBe(false);
  });

  it('aniversario: el día que se cumplen los años de la suscripción más antigua', () => {
    const members = new Map([
      ['ana', member({ id: 'ana' })],
      ['profe', member({ id: 'profe', isStaff: true })],
    ]);
    const occ = anniversaryOccurrences(
      [
        { userId: 'ana', startedAt: new Date('2025-11-13T15:00:00Z') },
        { userId: 'ana', startedAt: new Date('2026-05-01T00:00:00Z') },
        { userId: 'profe', startedAt: new Date('2025-11-13T15:00:00Z') },
      ],
      members,
      activated,
      now,
    );
    expect(occ).toEqual([{ userId: 'ana', occurrenceKey: 'anniversary:1', context: { years: 1 } }]);
  });
});
