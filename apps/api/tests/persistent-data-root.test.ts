import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePersistentDataRoot } from '../src/modules/persistent-data-root';

const ENV_KEYS = ['STORAGE_ROOT'] as const;

function snapshotEnv() {
  return ENV_KEYS.reduce<Record<string, string | undefined>>((acc, k) => {
    acc[k] = process.env[k];
    return acc;
  }, {});
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('resolvePersistentDataRoot', () => {
  let envSnapshot: Record<string, string | undefined>;
  let tmp: string;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    tmp = mkdtempSync(join(tmpdir(), 'didacta-persistent-root-'));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv(envSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('override argument gana sobre todo lo demás', () => {
    process.env['STORAGE_ROOT'] = '/from/env';
    expect(resolvePersistentDataRoot('/from/arg')).toBe(resolve('/from/arg'));
  });

  it('STORAGE_ROOT env gana sobre paths Docker', () => {
    const custom = join(tmp, 'custom');
    process.env['STORAGE_ROOT'] = custom;
    expect(resolvePersistentDataRoot()).toBe(resolve(custom));
  });

  it('sin override ni env, cae al default ./data/storage (dev local sin paths Docker presentes)', () => {
    // /app/data/storage no existe en el sandbox del test.
    expect(resolvePersistentDataRoot()).toBe(resolve('./data/storage'));
  });

  it('strip de whitespace en STORAGE_ROOT vacío trata como ausente', () => {
    process.env['STORAGE_ROOT'] = '   ';
    expect(resolvePersistentDataRoot()).toBe(resolve('./data/storage'));
  });

  it('override vacío se ignora', () => {
    process.env['STORAGE_ROOT'] = join(tmp, 'from-env');
    expect(resolvePersistentDataRoot('   ')).toBe(resolve(join(tmp, 'from-env')));
  });
});
