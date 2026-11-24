/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Dirección de tu academia»: las reglas puras (qué etiqueta vale, qué sufijo
 * enciende la función, el límite de cambios) y la lista de reservados, que es
 * una COPIA de la del plano de control y por eso se congela aquí.
 */

import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CHANGE_WINDOW_DAYS,
  MAX_ADDRESS_CHANGES,
  changeAllowance,
  checkLabel,
  hostnameFor,
  labelOf,
  normalizeLabel,
  resolveSubdomainSuffix,
} from '../src/admin/academy-address/academy-address.rules';
import {
  RESERVED_SUBDOMAINS,
  isReservedSubdomain,
} from '../src/admin/academy-address/reserved-subdomains';

const DAY = 24 * 60 * 60 * 1000;

describe('reservados (copia de `RESERVED_SLUGS` de didacta-cloud)', () => {
  /**
   * Congela la lista. Si este test falla es que alguien la ha tocado aquí o
   * hay que traer un cambio de `didacta-cloud/apps/cloud-api/src/provisioning/
   * slug.ts`: las dos listas tienen que ser la misma, o un aula podría
   * cambiarse a un nombre que Cloud nunca concede.
   */
  it('es exactamente la lista de Cloud', () => {
    expect([...RESERVED_SUBDOMAINS].sort()).toEqual([
      'account',
      'accounts',
      'admin',
      'api',
      'app',
      'assets',
      'auth',
      'autoconfig',
      'autodiscover',
      'billing',
      'blog',
      'canary',
      'cdn',
      'checkout',
      'cloud',
      'console',
      'dashboard',
      'demo',
      'dev',
      'dkim',
      'dmarc',
      'docs',
      'download',
      'downloads',
      'files',
      'grafana',
      'help',
      'id',
      'imap',
      'legal',
      'localhost',
      'login',
      'mail',
      'media',
      'metrics',
      'mta-sts',
      'mx',
      'ns',
      'ns1',
      'ns2',
      'ns3',
      'panel',
      'pay',
      'pop',
      'preview',
      'privacy',
      'registry',
      'root',
      'security',
      'signin',
      'signup',
      'smtp',
      'spf',
      'sso',
      'staging',
      'static',
      'status',
      'support',
      'terms',
      'test',
      'webmail',
      'www',
    ]);
    expect(RESERVED_SUBDOMAINS.size).toBe(62);
  });

  it('compara en minúsculas y sin espacios', () => {
    expect(isReservedSubdomain(' Support ')).toBe(true);
    expect(isReservedSubdomain('soporte')).toBe(false);
  });
});

describe('TENANT_SUBDOMAIN_SUFFIX', () => {
  it('sin la variable la función no existe', () => {
    expect(resolveSubdomainSuffix({})).toBeNull();
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: '   ' })).toBeNull();
  });

  it('se normaliza: minúsculas y sin puntos de sobra', () => {
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: ' .Didacta.IO. ' })).toBe(
      'didacta.io',
    );
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: 'localhost' })).toBe('localhost');
  });

  it('un valor que no es un nombre DNS la apaga en vez de ofrecer direcciones rotas', () => {
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: 'https://didacta.io' })).toBeNull();
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: '*.didacta.io' })).toBeNull();
    expect(resolveSubdomainSuffix({ TENANT_SUBDOMAIN_SUFFIX: 'didacta io' })).toBeNull();
  });
});

describe('qué etiqueta vale', () => {
  it.each([
    ['mi-academia', 'ok'],
    ['abc', 'ok'],
    ['a1b', 'ok'],
    ['x'.repeat(63), 'ok'],
    ['ab', 'invalid'],
    ['x'.repeat(64), 'invalid'],
    ['-academia', 'invalid'],
    ['academia-', 'invalid'],
    ['mi_academia', 'invalid'],
    ['mi.academia', 'invalid'],
    ['academía', 'invalid'],
    ['Academia', 'invalid'],
    ['xn--80ak6aa92e', 'invalid'],
    ['www', 'reserved'],
    ['support', 'reserved'],
  ])('%s → %s', (label, expected) => {
    expect(checkLabel(label)).toBe(expected);
  });

  it('lo escrito se compara en minúsculas y sin espacios', () => {
    expect(normalizeLabel('  Mi-Academia ')).toBe('mi-academia');
  });
});

describe('etiqueta ↔ dirección', () => {
  it('compone y descompone con el sufijo', () => {
    expect(hostnameFor('joaquin', 'didacta.io')).toBe('joaquin.didacta.io');
    expect(labelOf('joaquin.didacta.io', 'didacta.io')).toBe('joaquin');
  });

  it('un dominio propio, un nivel de más o el propio sufijo no son direcciones del sufijo', () => {
    expect(labelOf('aula.academia.com', 'didacta.io')).toBeNull();
    expect(labelOf('a.b.didacta.io', 'didacta.io')).toBeNull();
    expect(labelOf('didacta.io', 'didacta.io')).toBeNull();
    expect(labelOf('localhost', 'localhost')).toBeNull();
    expect(labelOf(null, 'didacta.io')).toBeNull();
    // Que termine igual no basta: tiene que colgar del sufijo.
    expect(labelOf('nodidacta.io', 'didacta.io')).toBeNull();
  });
});

describe(`límite: ${MAX_ADDRESS_CHANGES} cambios cada ${ADDRESS_CHANGE_WINDOW_DAYS} días`, () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  it('sin cambios recientes quedan todos', () => {
    expect(changeAllowance([], now)).toEqual({ used: 0, left: 3, nextChangeAt: null });
  });

  it('los de fuera de la ventana no cuentan', () => {
    expect(changeAllowance([ago(31), ago(45), ago(2)], now)).toMatchObject({ used: 1, left: 2 });
  });

  it('agotado: vuelve a quedar uno cuando sale de la ventana el más antiguo que cuenta', () => {
    const r = changeAllowance([ago(1), ago(10), ago(20)], now);
    expect(r.left).toBe(0);
    expect(r.nextChangeAt?.toISOString()).toBe(
      new Date(ago(20).getTime() + 30 * DAY).toISOString(),
    );
  });

  it('con más de los permitidos (carrera antigua), cuenta desde el que deja pasar uno', () => {
    const r = changeAllowance([ago(1), ago(5), ago(10), ago(20)], now);
    expect(r).toMatchObject({ used: 4, left: 0 });
    // Hace falta que salgan DOS: el de hace 20 y el de hace 10.
    expect(r.nextChangeAt?.toISOString()).toBe(
      new Date(ago(10).getTime() + 30 * DAY).toISOString(),
    );
  });
});
