import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_UNKNOWN, channelOf } from './version';

const ROOT_PACKAGE_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'package.json',
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('versión del producto', () => {
  // Guarda del origen: si alguien mueve el package.json raíz o mete ahí algo
  // que no es un semver, el inyector de `next.config.mjs` deja de tener fuente.
  it('el package.json raíz declara un semver parseable (fuente de verdad)', () => {
    const { version } = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('usa la versión que inyecta el build y deduce su canal', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '9.9.9-beta.2');
    vi.resetModules();
    const mod = await import('./version');
    expect(mod.APP_VERSION).toBe('9.9.9-beta.2');
    expect(mod.APP_CHANNEL).toBe('beta');
  });

  // CAMINO DEGRADADO: fuera del build de Next no hay variable inyectada.
  it('sin inyección cae en la constante nombrada, no en undefined', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '');
    vi.resetModules();
    const mod = await import('./version');
    expect(mod.APP_VERSION).toBe(APP_VERSION_UNKNOWN);
    expect(mod.APP_VERSION).toBe('0.0.0-unknown');
  });

  it('deduce el canal del pre-release', () => {
    expect(channelOf('0.0.1-alpha.101')).toBe('alpha');
    expect(channelOf('0.2.0-beta.3')).toBe('beta');
    expect(channelOf('1.0.0-rc.1')).toBe('rc');
    expect(channelOf('1.0.0')).toBe('stable');
  });
});
