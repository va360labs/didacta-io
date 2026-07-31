/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del scim.mapper — séptimo piloto License SDK.
 *
 * Cobertura:
 *   - userToScim: shape SCIM válido a partir de un User interno.
 *   - userToScim: heurística givenName/familyName.
 *   - userToScim: estados ACTIVE/PENDING → active=true, SUSPENDED/DEACTIVATED → false.
 *   - scimToUserCreate: mapping de userName/emails al email canónico.
 *   - scimToUserCreate: derivación de name desde formatted/givenName+familyName/displayName.
 *   - scimToUserCreate: rechazo de userName no-email (devolviendo email='' al caller).
 */

import { describe, expect, it } from 'vitest';
import { scimToUserCreate, userLocation, userToScim } from '../src/scim/scim.mapper';
import type { ScimMappedUser } from '../src/scim/scim.mapper';
import { SCIM_SCHEMAS } from '../src/scim/scim.types';

const baseUser: ScimMappedUser = {
  id: '00000000-0000-0000-0000-0000000000aa',
  email: 'juan.perez@acme.com',
  name: 'Juan Pérez',
  status: 'ACTIVE',
  locale: 'es-ES',
  createdAt: new Date('2026-04-01T10:00:00Z'),
  updatedAt: new Date('2026-04-15T11:00:00Z'),
};

describe('userLocation', () => {
  it('genera la URL relativa SCIM esperada', () => {
    expect(userLocation('abc-123')).toBe('/scim/v2/Users/abc-123');
  });
});

describe('userToScim', () => {
  it('emite el shape SCIM 2.0 estándar', () => {
    const r = userToScim(baseUser);
    expect(r.schemas).toEqual([SCIM_SCHEMAS.USER]);
    expect(r.id).toBe(baseUser.id);
    expect(r.userName).toBe('juan.perez@acme.com');
    expect(r.active).toBe(true);
    expect(r.displayName).toBe('Juan Pérez');
    expect(r.locale).toBe('es-ES');
    expect(r.externalId).toBe(baseUser.id);
    expect(r.emails?.[0]).toEqual({
      type: 'work',
      primary: true,
      value: 'juan.perez@acme.com',
    });
    expect(r.meta).toEqual({
      resourceType: 'User',
      created: '2026-04-01T10:00:00.000Z',
      lastModified: '2026-04-15T11:00:00.000Z',
      location: `/scim/v2/Users/${baseUser.id}`,
    });
  });

  it('parte el name en givenName/familyName con heurística simple', () => {
    const r = userToScim(baseUser);
    expect(r.name).toEqual({
      givenName: 'Juan',
      familyName: 'Pérez',
      formatted: 'Juan Pérez',
    });
  });

  it('para nombres compuestos, family es la última palabra y given el resto', () => {
    const r = userToScim({ ...baseUser, name: 'Juan Carlos Pérez' });
    expect(r.name).toEqual({
      givenName: 'Juan Carlos',
      familyName: 'Pérez',
      formatted: 'Juan Carlos Pérez',
    });
  });

  it('para name de una sola palabra solo emite givenName', () => {
    const r = userToScim({ ...baseUser, name: 'Madonna' });
    expect(r.name).toEqual({ givenName: 'Madonna', formatted: 'Madonna' });
    expect(r.name?.familyName).toBeUndefined();
  });

  it('omite name cuando User.name es null', () => {
    const r = userToScim({ ...baseUser, name: null });
    expect(r.name).toBeUndefined();
    // displayName cae al email como fallback.
    expect(r.displayName).toBe(baseUser.email);
  });

  it('mapea ACTIVE/PENDING → active=true', () => {
    expect(userToScim({ ...baseUser, status: 'ACTIVE' }).active).toBe(true);
    expect(userToScim({ ...baseUser, status: 'PENDING' }).active).toBe(true);
  });

  it('mapea SUSPENDED/DEACTIVATED → active=false', () => {
    expect(userToScim({ ...baseUser, status: 'SUSPENDED' }).active).toBe(false);
    expect(userToScim({ ...baseUser, status: 'DEACTIVATED' }).active).toBe(false);
  });

  it('emite siempre un único email primario con type=work', () => {
    const r = userToScim(baseUser);
    expect(r.emails).toHaveLength(1);
    expect(r.emails?.[0]?.primary).toBe(true);
    expect(r.emails?.[0]?.type).toBe('work');
  });
});

describe('scimToUserCreate', () => {
  it('extrae el email del userName cuando es válido', () => {
    const r = scimToUserCreate({
      userName: 'a@b.com',
      active: true,
    });
    expect(r.email).toBe('a@b.com');
    expect(r.active).toBe(true);
  });

  it('normaliza el email a lowercase', () => {
    const r = scimToUserCreate({
      userName: 'JUAN.PEREZ@Acme.COM',
      active: true,
    });
    expect(r.email).toBe('juan.perez@acme.com');
  });

  it('cae a emails[primary=true] cuando userName no es email', () => {
    const r = scimToUserCreate({
      userName: 'juan-perez',
      emails: [
        { value: 'no-primario@acme.com', primary: false },
        { value: 'primario@acme.com', primary: true },
      ],
      active: true,
    });
    expect(r.email).toBe('primario@acme.com');
  });

  it('cae al primer email de la lista cuando ninguno es primario', () => {
    const r = scimToUserCreate({
      userName: 'juan-perez',
      emails: [{ value: 'cualquiera@acme.com' }, { value: 'otro@acme.com' }],
      active: true,
    });
    expect(r.email).toBe('cualquiera@acme.com');
  });

  it('devuelve email vacío cuando no hay nada parseable a email', () => {
    const r = scimToUserCreate({
      userName: 'juan-perez',
      emails: [{ value: 'tampoco-soy-email' }],
      active: true,
    });
    expect(r.email).toBe('');
  });

  it('arma el name desde givenName + familyName si ambos vienen', () => {
    const r = scimToUserCreate({
      userName: 'a@b.com',
      name: { givenName: 'Juan', familyName: 'Pérez' },
      active: true,
    });
    expect(r.name).toBe('Juan Pérez');
  });

  it('prefiere formatted sobre given/family si está presente', () => {
    const r = scimToUserCreate({
      userName: 'a@b.com',
      name: {
        givenName: 'Juan',
        familyName: 'Pérez',
        formatted: 'Juan Carlos Pérez de la Torre',
      },
      active: true,
    });
    expect(r.name).toBe('Juan Carlos Pérez de la Torre');
  });

  it('cae a displayName si no hay name estructurado', () => {
    const r = scimToUserCreate({
      userName: 'a@b.com',
      displayName: 'Juan P.',
      active: true,
    });
    expect(r.name).toBe('Juan P.');
  });

  it('default active=true cuando el IdP no lo manda (Zod default)', () => {
    // Nota: el schema de Zod inyecta default true. Este mapper recibe el DTO
    // ya validado, así que active siempre llega definido. Probamos el flag
    // explícito por si cambia la default en el futuro.
    const r = scimToUserCreate({
      userName: 'a@b.com',
      active: true,
    });
    expect(r.active).toBe(true);
  });

  it('respeta active=false (desactivado al crear, raro pero válido)', () => {
    const r = scimToUserCreate({
      userName: 'a@b.com',
      active: false,
    });
    expect(r.active).toBe(false);
  });

  it('locale: persiste si viene; null si no', () => {
    expect(scimToUserCreate({ userName: 'a@b.com', active: true, locale: 'pt-BR' }).locale).toBe(
      'pt-BR',
    );
    expect(scimToUserCreate({ userName: 'a@b.com', active: true }).locale).toBeNull();
  });
});
