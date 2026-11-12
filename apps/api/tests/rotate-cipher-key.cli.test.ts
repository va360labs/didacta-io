import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCipherKey } from '../src/auth/cipher-key';
import { currentKeyLocation, installRotatedKey } from '../src/maintenance/rotate-cipher-key';
import { parseArgs } from '../src/maintenance/rotate-cipher-key.cli';

/**
 * La parte de la rotación que no toca la base: de dónde sale la clave actual y
 * dónde se deja la nueva. La parte de la base tiene su test de integración
 * contra Postgres real (`integration/rotate-cipher-key.integration.test.ts`).
 */

const ENV_KEYS = [
  'TENANT_SETTINGS_ENC_KEY',
  'TENANT_SETTINGS_ENC_KEY_FILE',
  'SECRETS_DIR',
  'STORAGE_ROOT',
  'NODE_ENV',
];
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

describe('rotación · dónde vive la clave', () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'didacta-rotacion-'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('con la clave en TENANT_SETTINGS_ENC_KEY no hay fichero que cambiar', () => {
    process.env['TENANT_SETTINGS_ENC_KEY'] = OLD;
    expect(currentKeyLocation()).toEqual({ key: OLD, file: null });
  });

  it('instalación migrada: rota, instala y deja de pedir la rotación', () => {
    // Instalación antigua: la clave dentro del storage (la que estuvo expuesta).
    const storageRoot = join(tmp, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    writeFileSync(join(storageRoot, '.didacta-secret-key'), OLD, 'utf8');

    // Primer arranque con el arreglo: se mueve y queda marcada.
    const migrada = loadCipherKey();
    const keyFile = resolve(tmp, 'data', 'secrets', '.didacta-secret-key');
    expect(migrada.filePath).toBe(keyFile);
    expect(migrada.rotationRequired).toBe(true);

    // La herramienta lee la clave actual de ese mismo sitio…
    expect(currentKeyLocation()).toEqual({ key: OLD, file: keyFile });

    // …y tras recifrar la base instala la nueva.
    installRotatedKey(keyFile, NEW);

    expect(readFileSync(keyFile, 'utf8')).toBe(NEW);
    expect(existsSync(`${keyFile}.rotation-required`)).toBe(false);
    // El siguiente arranque carga la nueva y ya no avisa.
    expect(loadCipherKey()).toEqual({ key: NEW, source: 'file', filePath: keyFile });
  });

  it('clave que se queda dentro del storage (volumen montado ahí): tras rotar tampoco se vuelve a pedir', () => {
    const storageRoot = join(tmp, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    // Un SECRETS_DIR dentro del storage fuerza el modo de reserva.
    process.env['SECRETS_DIR'] = join(storageRoot, 'x');
    const keyFile = join(storageRoot, '.didacta-secret-key');
    writeFileSync(keyFile, OLD, 'utf8');
    expect(loadCipherKey().rotationRequired).toBe(true);

    installRotatedKey(keyFile, NEW);

    const despues = loadCipherKey();
    expect(despues.key).toBe(NEW);
    expect(despues.rotationRequired).toBeUndefined();
  });

  it('no instala algo que no sea una clave', () => {
    const keyFile = join(tmp, 'secrets', '.didacta-secret-key');
    expect(() => installRotatedKey(keyFile, 'no-es-hex')).toThrow(/64 caracteres/);
    expect(existsSync(keyFile)).toBe(false);
  });
});

describe('rotación · argumentos', () => {
  it('por defecto es un ensayo: sin --apply no se escribe', () => {
    expect(parseArgs(['--new-key-file', 'k'])).toMatchObject({
      apply: false,
      install: false,
      generate: false,
      skipUnreadable: false,
      newKeyFile: 'k',
    });
  });

  it('reconoce todas las opciones', () => {
    expect(
      parseArgs([
        '--new-key-file',
        'n',
        '--old-key-file',
        'o',
        '--generate',
        '--apply',
        '--install',
        '--skip-unreadable',
      ]),
    ).toEqual({
      newKeyFile: 'n',
      oldKeyFile: 'o',
      generate: true,
      apply: true,
      install: true,
      skipUnreadable: true,
      help: false,
    });
  });

  it('una opción desconocida o una ruta que falta se rechazan (nada de adivinar)', () => {
    expect(() => parseArgs(['--aplicar'])).toThrow(/desconocida/);
    expect(() => parseArgs(['--new-key-file'])).toThrow(/necesita una ruta/);
    expect(() => parseArgs(['--new-key-file', '--apply'])).toThrow(/necesita una ruta/);
  });
});
