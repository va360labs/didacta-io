/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import { landingPath, resolveHomeLanding, startHerePending } from './home-landing';

const pasos = (hechos: boolean[]) =>
  hechos.map((done, i) => ({
    id: ['academy', 'course', 'price', 'payments', 'publish', 'invite'][i] as 'academy',
    done,
  }));

describe('landingPath', () => {
  it('admin de aula sencilla con pasos pendientes → Empieza aquí', () => {
    expect(landingPath({ administra: true, sencillo: true, pasosPendientes: true })).toBe('/start');
  });

  it('todo lo demás → la comunidad, como siempre', () => {
    // Ya terminó sus pasos: sin bucle de vuelta a «Empieza aquí».
    expect(landingPath({ administra: true, sencillo: true, pasosPendientes: false })).toBe(
      '/community',
    );
    // Modo completo.
    expect(landingPath({ administra: true, sencillo: false, pasosPendientes: true })).toBe(
      '/community',
    );
    // Alumnos y formadores.
    expect(landingPath({ administra: false, sencillo: true, pasosPendientes: true })).toBe(
      '/community',
    );
  });
});

describe('startHerePending', () => {
  it('cuenta los pasos sin hacer, como la pestaña «3 de 6»', () => {
    expect(startHerePending({ steps: pasos([true, true, true, false, false, false]) })).toBe(true);
    expect(startHerePending({ steps: pasos([true, true, true, true, true, false]) })).toBe(true);
    expect(startHerePending({ steps: pasos([true, true, true, true, true, true]) })).toBe(false);
  });
});

describe('resolveHomeLanding', () => {
  const pendiente = async () => ({ steps: pasos([true, true, true, false, false, false]) });
  const hecho = async () => ({ steps: pasos([true, true, true, true, true, true]) });

  it('admin de aula sencilla con pasos pendientes → /start', async () => {
    await expect(
      resolveHomeLanding({
        roles: ['tenant_admin'],
        simpleMode: async () => true,
        startHere: pendiente,
      }),
    ).resolves.toBe('/start');
  });

  it('un alumno no pregunta nada al servidor', async () => {
    const simpleMode = vi.fn(async () => true);
    const startHere = vi.fn(pendiente);
    await expect(resolveHomeLanding({ roles: ['alumno'], simpleMode, startHere })).resolves.toBe(
      '/community',
    );
    expect(simpleMode).not.toHaveBeenCalled();
    expect(startHere).not.toHaveBeenCalled();
  });

  it('modo completo: no consulta «Empieza aquí»', async () => {
    const startHere = vi.fn(pendiente);
    await expect(
      resolveHomeLanding({ roles: ['super_admin'], simpleMode: async () => false, startHere }),
    ).resolves.toBe('/community');
    expect(startHere).not.toHaveBeenCalled();
  });

  it('pasos terminados → la comunidad', async () => {
    await expect(
      resolveHomeLanding({
        roles: ['tenant_admin'],
        simpleMode: async () => true,
        startHere: hecho,
      }),
    ).resolves.toBe('/community');
  });

  it('si la API falla, la comunidad de siempre', async () => {
    await expect(
      resolveHomeLanding({
        roles: ['tenant_admin'],
        simpleMode: async () => true,
        startHere: async () => {
          throw new Error('503');
        },
      }),
    ).resolves.toBe('/community');
  });
});
