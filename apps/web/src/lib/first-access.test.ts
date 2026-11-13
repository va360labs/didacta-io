/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  administra,
  afterProfilePath,
  firstAccessDoor,
  isCreatorProfile,
  type FirstAccessState,
} from './first-access';

function estado(over: Partial<FirstAccessState>): FirstAccessState {
  return {
    administra: false,
    sencillo: false,
    perfilHecho: false,
    academiaHecha: false,
    ...over,
  };
}

describe('firstAccessDoor', () => {
  it('modo sencillo: quien lleva la academia empieza por su perfil, antes del alta', () => {
    expect(firstAccessDoor(estado({ administra: true, sencillo: true }))).toBe('/onboarding');
  });

  it('modo sencillo: con el perfil hecho, sigue al alta en 3 preguntas', () => {
    expect(firstAccessDoor(estado({ administra: true, sencillo: true, perfilHecho: true }))).toBe(
      '/welcome',
    );
  });

  it('modo sencillo: con los dos hechos, no queda ninguna puerta', () => {
    expect(
      firstAccessDoor(
        estado({ administra: true, sencillo: true, perfilHecho: true, academiaHecha: true }),
      ),
    ).toBeNull();
  });

  it('modo sencillo: aula ya adoptada pero perfil pendiente → perfil', () => {
    expect(firstAccessDoor(estado({ administra: true, sencillo: true, academiaHecha: true }))).toBe(
      '/onboarding',
    );
  });

  it('modo completo: el orden de siempre, primero la academia (la foto es obligatoria)', () => {
    expect(firstAccessDoor(estado({ administra: true }))).toBe('/welcome');
    expect(firstAccessDoor(estado({ administra: true, academiaHecha: true }))).toBe('/onboarding');
    expect(
      firstAccessDoor(estado({ administra: true, academiaHecha: true, perfilHecho: true })),
    ).toBeNull();
  });

  it('alumno: solo el perfil, en cualquier modo; la academia no le toca', () => {
    expect(firstAccessDoor(estado({ sencillo: true }))).toBe('/onboarding');
    expect(firstAccessDoor(estado({}))).toBe('/onboarding');
    expect(firstAccessDoor(estado({ sencillo: true, perfilHecho: true }))).toBeNull();
    expect(firstAccessDoor(estado({ perfilHecho: true }))).toBeNull();
  });
});

describe('isCreatorProfile', () => {
  it('admin del aula en modo sencillo → textos de creador', () => {
    expect(isCreatorProfile(['tenant_admin'], true)).toBe(true);
    expect(isCreatorProfile(['student', 'super_admin'], true)).toBe(true);
  });

  it('control: alumno en modo sencillo, admin en modo completo o modo aún sin saber → no', () => {
    expect(isCreatorProfile(['student'], true)).toBe(false);
    expect(isCreatorProfile(['tenant_admin'], false)).toBe(false);
    expect(isCreatorProfile(['tenant_admin'], null)).toBe(false);
    expect(isCreatorProfile(undefined, true)).toBe(false);
  });
});

describe('administra', () => {
  it('reconoce los dos roles de administración y nada más', () => {
    expect(administra(['tenant_admin'])).toBe(true);
    expect(administra(['super_admin'])).toBe(true);
    expect(administra(['instructor', 'student'])).toBe(false);
    expect(administra(null)).toBe(false);
  });
});

describe('afterProfilePath', () => {
  it('el creador sigue hacia su academia; el resto, a /home', () => {
    expect(afterProfilePath(true)).toBe('/start');
    expect(afterProfilePath(false)).toBe('/home');
  });
});
