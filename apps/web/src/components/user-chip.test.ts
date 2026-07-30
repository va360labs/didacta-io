import { describe, expect, it } from 'vitest';
import { displayNameOf, initialsOf } from './user-chip';

/**
 * Estos dos helpers sustituyen a cuatro implementaciones de `initials()`
 * copiadas por el repo y a siete fallbacks distintos para el mismo caso
 * ('Anónimo', 'Miembro', 'Usuario', 'Alumno', 'Sin nombre', el email crudo y
 * `userId.slice(0, 8)`). Los tests fijan la cascada para que no vuelva a
 * divergir.
 */

describe('displayNameOf', () => {
  it('prefiere el nombre', () => {
    expect(displayNameOf('Ana Pérez', 'ana@x.com')).toBe('Ana Pérez');
  });

  it('cae al email si no hay nombre', () => {
    expect(displayNameOf(null, 'ana@x.com')).toBe('ana@x.com');
  });

  it('cae al genérico si no hay ni nombre ni email', () => {
    expect(displayNameOf(null, null)).toBe('Miembro');
  });

  it('respeta el genérico que le pasen', () => {
    expect(displayNameOf(null, null, 'Anónimo')).toBe('Anónimo');
    expect(displayNameOf(undefined, undefined, 'Alumno')).toBe('Alumno');
  });

  it('trata un nombre en blanco como si no hubiera', () => {
    expect(displayNameOf('   ', 'ana@x.com')).toBe('ana@x.com');
  });

  it('trata un email en blanco como si no hubiera', () => {
    expect(displayNameOf(null, '   ')).toBe('Miembro');
  });

  it('recorta los espacios del nombre', () => {
    expect(displayNameOf('  Ana Pérez  ')).toBe('Ana Pérez');
  });

  it('nunca devuelve un identificador: un UUID en pantalla no dice nada', () => {
    // Antes, la lista de miembros de un grupo pintaba `userId.slice(0, 8)`.
    expect(displayNameOf(null, null)).not.toMatch(/^[0-9a-f]{8}/);
  });
});

describe('initialsOf', () => {
  it('toma la inicial de nombre y apellido', () => {
    expect(initialsOf('Ana Pérez')).toBe('AP');
  });

  it('se queda en dos letras aunque haya más palabras', () => {
    expect(initialsOf('Ana María Pérez Gómez')).toBe('AM');
  });

  it('con una sola palabra devuelve una letra', () => {
    expect(initialsOf('Ana')).toBe('A');
  });

  it('aguanta espacios de más', () => {
    expect(initialsOf('  Ana   Pérez  ')).toBe('AP');
  });

  it('usa el fallback si no hay nombre', () => {
    expect(initialsOf(null)).toBe('A');
    expect(initialsOf(undefined, 'M')).toBe('M');
    expect(initialsOf('', 'M')).toBe('M');
  });

  it('siempre en mayúsculas', () => {
    expect(initialsOf('ana pérez')).toBe('AP');
  });

  it('funciona sobre un email cuando es lo único que hay', () => {
    expect(initialsOf(displayNameOf(null, 'ana@x.com'))).toBe('A');
  });
});
