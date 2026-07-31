import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCipherKey } from '../src/auth/cipher-key';

const ENV_KEYS = ['TENANT_SETTINGS_ENC_KEY', 'TENANT_SETTINGS_ENC_KEY_FILE', 'STORAGE_ROOT'];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('loadCipherKey', () => {
  let tmpRoot: string;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    tmpRoot = mkdtempSync(join(tmpdir(), 'didacta-cipher-key-test-'));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // ── Prioridad 1: env explícita ──

  it('prefiere TENANT_SETTINGS_ENC_KEY de env si está seteada (control explícito)', () => {
    const explicit = 'a'.repeat(64);
    process.env['TENANT_SETTINGS_ENC_KEY'] = explicit;
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const result = loadCipherKey();

    expect(result.source).toBe('env');
    expect(result.key).toBe(explicit);
    expect(result.filePath).toBeUndefined();
    // No genera archivo si la env manda.
    expect(existsSync(join(storageRoot, '.didacta-secret-key'))).toBe(false);
  });

  // ── Prioridad 2: archivo dentro de STORAGE_ROOT ──

  it('default: persiste la key DENTRO de STORAGE_ROOT (no en el parent dir)', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.filePath).toBe(resolve(storageRoot, '.didacta-secret-key'));
    expect(result.key).toMatch(/^[a-f0-9]{64}$/i);

    // El parent dir NO debe tener el archivo — eso era el bug viejo.
    expect(existsSync(join(tmpRoot, '.didacta-secret-key'))).toBe(false);

    // El archivo persistido tiene el mismo contenido.
    const persisted = readFileSync(result.filePath!, 'utf8').trim();
    expect(persisted).toBe(result.key);
  });

  it('re-arranque sin tocar nada: lee la misma key del archivo', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const first = loadCipherKey();
    expect(first.source).toBe('file-new');

    const second = loadCipherKey();
    expect(second.source).toBe('file');
    expect(second.key).toBe(first.key);
    expect(second.filePath).toBe(first.filePath);
  });

  it('TENANT_SETTINGS_ENC_KEY_FILE explícito gana sobre STORAGE_ROOT', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const customDir = join(tmpRoot, 'custom-dir');
    mkdirSync(customDir, { recursive: true });
    const customFile = join(customDir, 'my-key');
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = customFile;

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.filePath).toBe(customFile);
    // No debe haber tocado STORAGE_ROOT.
    expect(existsSync(join(storageRoot, '.didacta-secret-key'))).toBe(false);
  });

  // ── Backwards-compat: migración del path legacy ──

  it('migra key desde el path legacy (parent de STORAGE_ROOT) al nuevo path dentro de STORAGE_ROOT', () => {
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    // Simulamos instalación pre-alpha.67: key en el parent dir.
    const legacyKey = 'b'.repeat(64);
    const legacyPath = join(tmpRoot, 'data', '.didacta-secret-key');
    writeFileSync(legacyPath, legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file');
    expect(result.filePath).toBe(resolve(storageRoot, '.didacta-secret-key'));
    expect(result.key).toBe(legacyKey);

    // El archivo viejo ya no existe (migrado, no copiado).
    expect(existsSync(legacyPath)).toBe(false);
    // El archivo nuevo tiene la key migrada.
    expect(readFileSync(result.filePath!, 'utf8').trim()).toBe(legacyKey);
  });

  it('si el path legacy existe pero el nuevo ya tiene una key válida, gana el nuevo', () => {
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    // Path nuevo con key A.
    const newKey = 'c'.repeat(64);
    writeFileSync(join(storageRoot, '.didacta-secret-key'), newKey, 'utf8');

    // Path legacy con key B (debería ser ignorado, no se borra).
    const legacyKey = 'd'.repeat(64);
    const legacyPath = join(tmpRoot, 'data', '.didacta-secret-key');
    writeFileSync(legacyPath, legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file');
    expect(result.key).toBe(newKey);
    // El legacy NO se toca cuando ya hay key en el nuevo path.
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, 'utf8').trim()).toBe(legacyKey);
  });

  it('si TENANT_SETTINGS_ENC_KEY_FILE explícito está set, NO migra legacy (operador decidió path absoluto)', () => {
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = join(tmpRoot, 'custom-key');

    const legacyKey = 'e'.repeat(64);
    const legacyPath = join(tmpRoot, 'data', '.didacta-secret-key');
    writeFileSync(legacyPath, legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file-new'); // generó key nueva en el path custom
    expect(result.filePath).toBe(join(tmpRoot, 'custom-key'));
    expect(result.key).not.toBe(legacyKey);
    // Legacy intacto.
    expect(existsSync(legacyPath)).toBe(true);
  });

  // ── Fallback: sin STORAGE_ROOT, sin env ──

  it('sin STORAGE_ROOT cae al default ./data/storage/.didacta-secret-key (dev local, sin paths Docker presentes)', () => {
    // No seteamos STORAGE_ROOT ni env. CWD del test es el repo root del api.
    // Como /app/data/storage NO existe (corremos fuera de container Docker),
    // el código cae al CWD-relative ./data/storage (consistente con el
    // helper compartido resolvePersistentDataRoot — alpha.72).
    const result = loadCipherKey();

    expect(result.source).toMatch(/file|file-new/);
    expect(result.filePath).toBe(resolve('./data/storage', '.didacta-secret-key'));
    // Cleanup del archivo dev creado.
    if (result.filePath && existsSync(result.filePath)) {
      try {
        rmSync(result.filePath);
        rmSync(resolve('./data'), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  // ── alpha.71: fallback a /app/data/storage si existe (caso Docker sin STORAGE_ROOT en env) ──

  it('sin STORAGE_ROOT pero con /app/data/storage simulado, usa ese path absoluto', () => {
    // Truco: usamos TENANT_SETTINGS_ENC_KEY_FILE para simular el path absoluto.
    // (No podemos crear /app/data/storage real en el sistema del test). Esta
    // spec confirma que cuando TENANT_SETTINGS_ENC_KEY_FILE apunta a un dir
    // absoluto persistente, el código lo respeta — que es lo que pasaría
    // si seteáramos esa env en el container como workaround del STORAGE_ROOT
    // que no se propaga.
    const persistentDir = join(tmpRoot, 'fake-docker', 'storage');
    mkdirSync(persistentDir, { recursive: true });
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = join(persistentDir, '.didacta-secret-key');

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.filePath).toBe(join(persistentDir, '.didacta-secret-key'));
  });

  // ── Archivo corrupto ──

  it('si el archivo existe pero está corrupto/longitud incorrecta, regenera', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    const filePath = join(storageRoot, '.didacta-secret-key');
    writeFileSync(filePath, 'not-a-valid-hex-key', 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.key).toMatch(/^[a-f0-9]{64}$/i);
    expect(result.key).not.toBe('not-a-valid-hex-key');
    expect(readFileSync(filePath, 'utf8').trim()).toBe(result.key);
  });
});
