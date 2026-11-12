import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCipherKey, resolveCipherKeyLocations } from '../src/auth/cipher-key';

// NODE_ENV entra en la lista porque decide el comportamiento: se borra antes de
// cada test (como el resto) y solo los casos de producción lo ponen.
const ENV_KEYS = [
  'TENANT_SETTINGS_ENC_KEY',
  'TENANT_SETTINGS_ENC_KEY_FILE',
  'SECRETS_DIR',
  'STORAGE_ROOT',
  'NODE_ENV',
];

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
    // Los avisos de seguridad salen por console.error: se silencian aquí y los
    // tests que los comprueban miran el resultado (`securityNotices`).
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  // ── Prioridad 3: fichero en el directorio de secretos, FUERA del storage ──

  it('default: persiste la key en `secrets/`, al lado de STORAGE_ROOT y nunca dentro', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.filePath).toBe(resolve(tmpRoot, 'secrets', '.didacta-secret-key'));
    expect(result.key).toMatch(/^[a-f0-9]{64}$/i);
    // Una clave recién nacida fuera del storage no ha estado expuesta.
    expect(result.rotationRequired).toBeUndefined();
    expect(result.securityNotices).toBeUndefined();

    // Dentro del árbol que se sirve por URL no queda NADA.
    expect(existsSync(join(storageRoot, '.didacta-secret-key'))).toBe(false);

    // El archivo persistido tiene el mismo contenido.
    const persisted = readFileSync(result.filePath!, 'utf8').trim();
    expect(persisted).toBe(result.key);
  });

  it('SECRETS_DIR manda sobre el directorio hermano', () => {
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    process.env['SECRETS_DIR'] = join(tmpRoot, 'otro-volumen', 'secretos');

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.filePath).toBe(
      resolve(tmpRoot, 'otro-volumen', 'secretos', '.didacta-secret-key'),
    );
    expect(existsSync(join(tmpRoot, 'secrets'))).toBe(false);
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

  it('migra key desde el path legacy (parent de STORAGE_ROOT) al directorio de secretos, sin pedir rotación', () => {
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    // Simulamos instalación pre-alpha.67: key en el parent dir. Ese directorio
    // nunca se sirvió por URL, así que la clave no estuvo expuesta.
    const legacyKey = 'b'.repeat(64);
    const legacyPath = join(tmpRoot, 'data', '.didacta-secret-key');
    writeFileSync(legacyPath, legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file');
    expect(result.filePath).toBe(resolve(tmpRoot, 'data', 'secrets', '.didacta-secret-key'));
    expect(result.key).toBe(legacyKey);
    expect(result.rotationRequired).toBeUndefined();

    // El archivo viejo ya no existe (migrado, no copiado).
    expect(existsSync(legacyPath)).toBe(false);
    // El archivo nuevo tiene la key migrada.
    expect(readFileSync(result.filePath!, 'utf8').trim()).toBe(legacyKey);
  });

  it('si hay clave en el storage Y en el path legacy, gana la del storage (la vigente) y la legacy no se toca', () => {
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const vigente = 'c'.repeat(64);
    writeFileSync(join(storageRoot, '.didacta-secret-key'), vigente, 'utf8');
    const legacyKey = 'd'.repeat(64);
    const legacyPath = join(tmpRoot, 'data', '.didacta-secret-key');
    writeFileSync(legacyPath, legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file');
    expect(result.key).toBe(vigente);
    expect(result.filePath).toBe(resolve(tmpRoot, 'data', 'secrets', '.didacta-secret-key'));
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

  it('sin STORAGE_ROOT cae al default ./data/secrets/.didacta-secret-key (dev local, sin paths Docker presentes)', () => {
    // No seteamos STORAGE_ROOT ni env. CWD del test es el repo root del api.
    // Como /app/data/storage NO existe (corremos fuera de container Docker),
    // el código cae al CWD-relative ./data/storage (consistente con el
    // helper compartido resolvePersistentDataRoot — alpha.72).
    const result = loadCipherKey();

    expect(result.source).toMatch(/file|file-new/);
    expect(result.filePath).toBe(resolve('./data/secrets', '.didacta-secret-key'));
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
    const filePath = join(tmpRoot, 'secrets', '.didacta-secret-key');
    mkdirSync(join(tmpRoot, 'secrets'), { recursive: true });
    writeFileSync(filePath, 'not-a-valid-hex-key', 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file-new');
    expect(result.key).toMatch(/^[a-f0-9]{64}$/i);
    expect(result.key).not.toBe('not-a-valid-hex-key');
    expect(readFileSync(filePath, 'utf8').trim()).toBe(result.key);
  });

  // ── Clave efímera: nunca en producción ──
  //
  // Antes, si no se podía leer ni crear el fichero, se arrancaba con una clave
  // aleatoria en memoria y un WARN. Todo lo cifrado con ella (Stripe, SMTP por
  // tenant, OIDC, SCIM, Zoom) dejaba de leerse en el siguiente reinicio.

  /** Ruta de fichero imposible de crear: su directorio padre es un fichero. */
  function unwritableKeyFile(): string {
    const blocker = join(tmpRoot, 'no-es-un-directorio');
    writeFileSync(blocker, 'x', 'utf8');
    return join(blocker, '.didacta-secret-key');
  }

  it('fuera de producción, si no puede crear el archivo usa una clave efímera (como antes)', () => {
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = unwritableKeyFile();

    const result = loadCipherKey();

    expect(result.source).toBe('ephemeral');
    expect(result.key).toMatch(/^[a-f0-9]{64}$/i);
  });

  it('por qué importa: dos llamadas con clave efímera dan claves DISTINTAS', () => {
    // `loadCipherKey()` se llama desde varios módulos (auth, marketplace,
    // instance-settings, module-context). Con la clave efímera, lo que cifra
    // uno no lo descifra otro ni dentro del mismo proceso.
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = unwritableKeyFile();

    expect(loadCipherKey().key).not.toBe(loadCipherKey().key);
  });

  it('en producción, si no puede crear el archivo NO arranca, y dice qué hacer', () => {
    process.env['NODE_ENV'] = 'production';
    const filePath = unwritableKeyFile();
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = filePath;

    let thrown: Error | undefined;
    try {
      loadCipherKey();
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Dice qué fichero, que es producción, y las dos salidas.
    expect(thrown!.message).toContain(filePath);
    expect(thrown!.message).toContain(
      'En producción no se arranca con una clave de cifrado efímera',
    );
    expect(thrown!.message).toContain('TENANT_SETTINGS_ENC_KEY_FILE');
    expect(thrown!.message).toContain('openssl rand -hex 32');
    // Y conserva el error original del sistema, que es el que dice POR QUÉ.
    expect(thrown!.cause).toBeInstanceOf(Error);
  });

  it('en producción, un fichero de clave que EXISTE pero no se puede leer tampoco se sustituye por una efímera', () => {
    // Una instalación que ya tenía su clave y pierde el acceso al fichero
    // (permisos tras cambiar de usuario, volumen mal montado). Arrancar con
    // otra clave dejaría sus secretos ilegibles sin avisar. Un directorio en
    // el sitio del fichero reproduce «existe y no se puede leer» en cualquier
    // sistema operativo.
    process.env['NODE_ENV'] = 'production';
    const filePath = join(tmpRoot, 'volumen', '.didacta-secret-key');
    mkdirSync(filePath, { recursive: true });
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = filePath;

    expect(() => loadCipherKey()).toThrow(/no se pudo leer ni crear/);
    expect(() => loadCipherKey()).toThrow(/ya tenía una clave en ese fichero/);
    // No se ha tocado lo que había.
    expect(existsSync(filePath)).toBe(true);
  });

  it('en producción, con la clave en env arranca igual que antes (aunque el disco no sea escribible)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = unwritableKeyFile();
    process.env['TENANT_SETTINGS_ENC_KEY'] = 'b'.repeat(64);

    expect(loadCipherKey()).toEqual({ key: 'b'.repeat(64), source: 'env' });
  });

  it('en producción, con el archivo persistente arranca igual que antes', () => {
    process.env['NODE_ENV'] = 'production';
    const filePath = join(tmpRoot, 'persistente', '.didacta-secret-key');
    mkdirSync(join(tmpRoot, 'persistente'), { recursive: true });
    writeFileSync(filePath, 'c'.repeat(64), 'utf8');
    process.env['TENANT_SETTINGS_ENC_KEY_FILE'] = filePath;

    expect(loadCipherKey()).toEqual({ key: 'c'.repeat(64), source: 'file', filePath });
  });

  it('en producción, una instalación nueva con volumen escribible genera y persiste su clave', () => {
    process.env['NODE_ENV'] = 'production';
    const storageRoot = join(tmpRoot, 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;

    const first = loadCipherKey();
    const second = loadCipherKey();

    expect(first.source).toBe('file-new');
    expect(second).toEqual({ key: first.key, source: 'file', filePath: first.filePath });
  });

  it('en producción, la migración desde la ruta legacy sigue funcionando', () => {
    process.env['NODE_ENV'] = 'production';
    const storageRoot = join(tmpRoot, 'data', 'storage');
    mkdirSync(storageRoot, { recursive: true });
    process.env['STORAGE_ROOT'] = storageRoot;
    const legacyKey = 'f'.repeat(64);
    writeFileSync(join(tmpRoot, 'data', '.didacta-secret-key'), legacyKey, 'utf8');

    const result = loadCipherKey();

    expect(result.source).toBe('file');
    expect(result.key).toBe(legacyKey);
    expect(result.filePath).toBe(resolve(tmpRoot, 'data', 'secrets', '.didacta-secret-key'));
  });

  /**
   * La clave vivía en `${STORAGE_ROOT}/.didacta-secret-key`, y la raíz del
   * storage es lo que `GET /api/v1/storage/file/*` servía sin sesión: se podía
   * descargar por URL. Al arrancar se saca de ahí.
   */
  describe('migración desde la ubicación expuesta (dentro del storage)', () => {
    function instalacionAntigua(key = 'e'.repeat(64)) {
      const storageRoot = join(tmpRoot, 'data', 'storage');
      mkdirSync(storageRoot, { recursive: true });
      process.env['STORAGE_ROOT'] = storageRoot;
      const viejo = join(storageRoot, '.didacta-secret-key');
      writeFileSync(viejo, key, 'utf8');
      const nuevo = resolve(tmpRoot, 'data', 'secrets', '.didacta-secret-key');
      return { storageRoot, viejo, nuevo, key };
    }

    it('mueve la clave fuera del storage, conserva su valor y marca que hay que rotarla', () => {
      const { viejo, nuevo, key } = instalacionAntigua();

      const result = loadCipherKey();

      // Misma clave: lo ya cifrado se sigue descifrando.
      expect(result.key).toBe(key);
      expect(result.source).toBe('file');
      expect(result.filePath).toBe(nuevo);
      expect(result.migratedFrom).toBe(viejo);
      expect(readFileSync(nuevo, 'utf8').trim()).toBe(key);
      // En el árbol servido ya no queda.
      expect(existsSync(viejo)).toBe(false);
      // Estuvo publicada: hay que rotarla, y se dice.
      expect(result.rotationRequired).toBe(true);
      expect(existsSync(`${nuevo}.rotation-required`)).toBe(true);
      const avisos = (result.securityNotices ?? []).join(' ');
      expect(avisos).toContain('ESTUVO EXPUESTA');
      expect(avisos).toContain('ROTARLA');
      expect(console.error).toHaveBeenCalled();
    });

    it('los arranques siguientes leen del sitio nuevo y SIGUEN avisando de la rotación pendiente', () => {
      const { nuevo, key } = instalacionAntigua();
      loadCipherKey();

      const segundo = loadCipherKey();

      expect(segundo.key).toBe(key);
      expect(segundo.filePath).toBe(nuevo);
      expect(segundo.migratedFrom).toBeUndefined();
      expect(segundo.rotationRequired).toBe(true);
      expect((segundo.securityNotices ?? []).join(' ')).toContain('ESTUVO EXPUESTA');
    });

    it('si alguien restaura la copia vieja en el storage, se vuelve a retirar', () => {
      const { viejo, key } = instalacionAntigua();
      loadCipherKey();
      writeFileSync(viejo, key, 'utf8');

      const result = loadCipherKey();

      expect(result.key).toBe(key);
      expect(existsSync(viejo)).toBe(false);
    });

    it('una clave DISTINTA en el storage no pisa a la vigente ni se borra: se avisa', () => {
      const { viejo, nuevo, key } = instalacionAntigua();
      loadCipherKey();
      writeFileSync(viejo, '9'.repeat(64), 'utf8');

      const result = loadCipherKey();

      expect(result.key).toBe(key);
      expect(result.filePath).toBe(nuevo);
      expect(existsSync(viejo)).toBe(true);
      expect((result.securityNotices ?? []).join(' ')).toContain('OTRA clave distinta');
    });

    it('si no se puede escribir en el directorio de secretos, NO se pierde la clave: se sigue con la de siempre', () => {
      const { viejo, key } = instalacionAntigua();
      // El «directorio» de secretos es un fichero: no se puede crear nada dentro.
      writeFileSync(join(tmpRoot, 'data', 'secrets'), 'x', 'utf8');

      const result = loadCipherKey();

      expect(result.key).toBe(key);
      expect(result.filePath).toBe(viejo);
      expect(readFileSync(viejo, 'utf8').trim()).toBe(key);
      expect(result.rotationRequired).toBe(true);
      expect((result.securityNotices ?? []).join(' ')).toContain('NO se pudo mover');
    });

    it('con TENANT_SETTINGS_ENC_KEY en env no se toca el disco (la env sigue teniendo prioridad)', () => {
      const { viejo, nuevo } = instalacionAntigua();
      process.env['TENANT_SETTINGS_ENC_KEY'] = 'a'.repeat(64);

      expect(loadCipherKey()).toEqual({ key: 'a'.repeat(64), source: 'env' });
      expect(existsSync(viejo)).toBe(true);
      expect(existsSync(nuevo)).toBe(false);
    });

    it('en producción la migración funciona igual', () => {
      process.env['NODE_ENV'] = 'production';
      const { viejo, nuevo, key } = instalacionAntigua();

      const result = loadCipherKey();

      expect(result.key).toBe(key);
      expect(result.filePath).toBe(nuevo);
      expect(existsSync(viejo)).toBe(false);
    });
  });

  /**
   * Hay despliegues donde el ÚNICO volumen persistente está montado justo en
   * `STORAGE_ROOT`; por eso la clave se había metido ahí. Llevarla al
   * directorio hermano la perdería en el siguiente despliegue, y con ella todo
   * lo cifrado. Ahí la clave no se mueve hasta que el operador diga dónde.
   */
  describe('volumen montado exactamente en STORAGE_ROOT (el hermano no es persistente)', () => {
    /** Simula que el storage está en otro dispositivo que su directorio padre. */
    function otroDispositivo(storageRoot: string) {
      return (path: string) => (resolve(path).startsWith(resolve(storageRoot)) ? 2 : 1);
    }

    it('una clave existente NO se mueve, se sigue usando y se avisa de qué definir', () => {
      const storageRoot = join(tmpRoot, 'data', 'storage');
      mkdirSync(storageRoot, { recursive: true });
      process.env['STORAGE_ROOT'] = storageRoot;
      const viejo = join(storageRoot, '.didacta-secret-key');
      writeFileSync(viejo, 'e'.repeat(64), 'utf8');

      const result = loadCipherKey(otroDispositivo(storageRoot));

      expect(result.key).toBe('e'.repeat(64));
      expect(result.filePath).toBe(viejo);
      expect(existsSync(viejo)).toBe(true);
      expect(existsSync(join(tmpRoot, 'data', 'secrets'))).toBe(false);
      expect(result.rotationRequired).toBe(true);
      const avisos = (result.securityNotices ?? []).join(' ');
      expect(avisos).toContain('SECRETS_DIR');
      expect(avisos).toContain('no está en el mismo volumen');
    });

    it('en cuanto se define SECRETS_DIR, la clave sale del storage', () => {
      const storageRoot = join(tmpRoot, 'data', 'storage');
      mkdirSync(storageRoot, { recursive: true });
      process.env['STORAGE_ROOT'] = storageRoot;
      const viejo = join(storageRoot, '.didacta-secret-key');
      writeFileSync(viejo, 'e'.repeat(64), 'utf8');
      loadCipherKey(otroDispositivo(storageRoot));

      process.env['SECRETS_DIR'] = join(tmpRoot, 'volumen-de-secretos');
      const result = loadCipherKey(otroDispositivo(storageRoot));

      expect(result.key).toBe('e'.repeat(64));
      expect(result.filePath).toBe(resolve(tmpRoot, 'volumen-de-secretos', '.didacta-secret-key'));
      expect(existsSync(viejo)).toBe(false);
      expect(result.rotationRequired).toBe(true);
    });

    it('una instalación NUEVA genera la clave en el storage (lo único persistente) y no pide rotarla', () => {
      const storageRoot = join(tmpRoot, 'data', 'storage');
      mkdirSync(storageRoot, { recursive: true });
      process.env['STORAGE_ROOT'] = storageRoot;

      const first = loadCipherKey(otroDispositivo(storageRoot));
      const second = loadCipherKey(otroDispositivo(storageRoot));

      expect(first.source).toBe('file-new');
      expect(first.filePath).toBe(join(storageRoot, '.didacta-secret-key'));
      // Nació con el servidor ya sin servir ficheros ocultos: no estuvo expuesta.
      expect(first.rotationRequired).toBeUndefined();
      expect(second.key).toBe(first.key);
      expect(second.rotationRequired).toBeUndefined();
      expect((second.securityNotices ?? []).join(' ')).toContain('SECRETS_DIR');
    });

    it('un SECRETS_DIR que apunta DENTRO del storage no cuenta: no saca la clave de ningún sitio', () => {
      const storageRoot = join(tmpRoot, 'data', 'storage');
      mkdirSync(storageRoot, { recursive: true });
      process.env['STORAGE_ROOT'] = storageRoot;
      process.env['SECRETS_DIR'] = join(storageRoot, 'secretos');

      const loc = resolveCipherKeyLocations();
      expect(loc.secretsDirTrusted).toBe(false);
      expect(loc.untrustedReason).toBe('inside-storage');

      const result = loadCipherKey();
      expect(result.filePath).toBe(join(storageRoot, '.didacta-secret-key'));
      expect((result.securityNotices ?? []).join(' ')).toContain(
        'apunta DENTRO de la raíz del storage',
      );
    });
  });
});
