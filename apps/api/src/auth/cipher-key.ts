/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Carga (o genera + persiste) la clave AES-256 que cifra los secretos at-rest
 * (`tenant_setting`, `core_instance_setting`, `mod_secret`). Resolución por
 * prioridad:
 *
 *   1. `TENANT_SETTINGS_ENC_KEY` (env). Control explícito — recomendado para
 *      producción seria. Si se setea, se usa tal cual y no se toca el disco.
 *
 *   2. `TENANT_SETTINGS_ENC_KEY_FILE` (env): ruta exacta del fichero. Decisión
 *      del operador: ni se migra ni se mueve nada.
 *
 *   3. Fichero `.didacta-secret-key` en el DIRECTORIO DE SECRETOS:
 *      `SECRETS_DIR` si está definido; si no, `secrets/` al lado de la raíz
 *      del storage (con `STORAGE_ROOT=/app/data/storage` → `/app/data/secrets`).
 *      La primera vez se genera y se persiste con permisos 0600.
 *
 *   4. Clave efímera en memoria (último recurso, solo si el fichero no se
 *      puede leer ni crear). SOLO fuera de producción: con
 *      `NODE_ENV=production` no se arranca.
 *
 * ── Por qué la clave ya NO vive dentro de `STORAGE_ROOT` ────────────────────
 *
 * Hasta ahora el fichero estaba en `${STORAGE_ROOT}/.didacta-secret-key`, y la
 * raíz del storage es justo lo que `GET /api/v1/storage/file/*` servía sin
 * sesión: la clave maestra se podía descargar por URL. Con ella y un volcado
 * de la base se descifran las credenciales de Stripe, SMTP, OIDC, SCIM y Zoom
 * de todas las aulas.
 *
 * Se arregla por dos lados. El controlador ya solo sirve una lista blanca de
 * prefijos y el adaptador de disco rechaza cualquier segmento oculto. Y la
 * clave sale del árbol que se sirve: al arrancar, si está en la ubicación
 * antigua y no en la nueva, se MUEVE (copia verificada + borrado del original)
 * y se deja una marca de «rotación pendiente» que se repite en el log en cada
 * arranque hasta que la clave se rote (`maintenance/rotate-cipher-key`): una
 * clave que estuvo publicada no deja de estar comprometida por cambiarla de
 * carpeta.
 *
 * ── El caso del volumen montado EXACTAMENTE en `STORAGE_ROOT` ───────────────
 *
 * Hay despliegues (PaaS con un solo mount) donde el volumen persistente es la
 * propia raíz del storage y todo lo de fuera muere en cada redeploy; por eso la
 * clave se había metido ahí dentro. Mover la clave al directorio hermano en
 * esos despliegues la perdería en el siguiente despliegue, y con ella todo lo
 * cifrado. Así que el directorio hermano solo se usa si está en el MISMO
 * dispositivo que el storage (mismo volumen). Si no lo está y nadie ha definido
 * `SECRETS_DIR`, la clave se queda donde estaba —ya no se sirve por URL— y se
 * avisa en cada arranque de que hay que darle un sitio persistente fuera.
 *
 * Razón de NO guardar la clave en BD: anularía el cifrado at-rest. Cualquier
 * dump de Postgres revelaría tanto los secretos cifrados como la clave que
 * los descifra.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolvePersistentDataRoot } from '../modules/persistent-data-root';

const KEY_LENGTH_HEX = 64;
export const CIPHER_KEY_FILE_NAME = '.didacta-secret-key';
/** Junto al fichero de la clave: la clave estuvo expuesta y hay que rotarla. */
export const ROTATION_REQUIRED_SUFFIX = '.rotation-required';
/** Junto a una clave que vive en el storage pero NACIÓ después del arreglo. */
const NEVER_SERVED_SUFFIX = '.never-served';

export interface ResolvedCipherKey {
  /** Clave en hex (64 chars). */
  key: string;
  /** Origen: env / file / file-new (recién creado) / ephemeral (in-memory fallback). */
  source: 'env' | 'file' | 'file-new' | 'ephemeral';
  /** Path del archivo si source es file/file-new. */
  filePath?: string;
  /**
   * La clave estuvo en una ubicación servible por URL pública. Sigue siendo la
   * que descifra los datos, pero hay que darla por comprometida y rotarla.
   */
  rotationRequired?: boolean;
  /** La clave se acaba de mover desde la ubicación antigua en este arranque. */
  migratedFrom?: string;
  /** Avisos de seguridad de esta resolución. También salen por `console.error`. */
  securityNotices?: string[];
}

/** Dónde vive la clave cuando el operador no ha fijado ni la clave ni el fichero. */
export interface CipherKeyLocations {
  /** Ubicación ANTIGUA: dentro de la raíz del storage. */
  insideStorage: string;
  /** Directorio de secretos (el definido en `SECRETS_DIR` o el hermano del storage). */
  secretsDir: string;
  /** `SECRETS_DIR` viene del entorno. */
  secretsDirExplicit: boolean;
  /**
   * El directorio de secretos es de fiar para guardar algo que tiene que
   * sobrevivir a un redeploy: lo eligió el operador, o está en el mismo
   * dispositivo que el storage.
   */
  secretsDirTrusted: boolean;
  /** Por qué no es de fiar, si no lo es. */
  untrustedReason: 'other-device' | 'inside-storage' | null;
  /** Donde se lee y se escribe la clave en este despliegue. */
  effective: string;
}

/**
 * Resuelve la clave siguiendo la prioridad documentada arriba.
 */
export function loadCipherKey(probe: DeviceProbe = deviceOf): ResolvedCipherKey {
  const envKey = process.env['TENANT_SETTINGS_ENC_KEY'];
  if (envKey && envKey.trim().length > 0) {
    return { key: envKey.trim(), source: 'env' };
  }

  const explicitFile = process.env['TENANT_SETTINGS_ENC_KEY_FILE'];
  const explicitPath =
    explicitFile && explicitFile.trim().length > 0
      ? isAbsolute(explicitFile)
        ? explicitFile
        : resolve(explicitFile)
      : null;
  const locations = explicitPath ? null : resolveCipherKeyLocations(probe);
  const filePath = explicitPath ?? locations!.effective;

  try {
    const resolved = explicitPath ? loadFromExplicitFile(explicitPath) : loadFromDisk(locations!);
    for (const notice of resolved.securityNotices ?? []) reportSecurityNotice(notice);
    return resolved;
  } catch (err) {
    // Disco lleno, RO, permisos rotos: no hay clave que sobreviva al proceso.
    //
    // En producción NO se arranca. Con una clave efímera todo lo que se cifre
    // (Stripe, SMTP por tenant, OIDC, SCIM, Zoom) deja de poder leerse en el
    // siguiente reinicio, y ni siquiera hace falta reiniciar: esta función se
    // llama desde varios módulos y cada llamada devolvería una clave DISTINTA,
    // así que lo que cifra uno no lo descifra otro. Antes eso solo dejaba un
    // WARN en el log de arranque y el fallo aparecía días después como «la
    // integración se ha desconfigurado sola». Que no arranque, diciendo por
    // qué, es el único aviso que no se puede pasar por alto.
    //
    // Tampoco se pierde nada al fallar: una instalación que llega aquí ya
    // estaba perdiendo sus secretos en cada reinicio.
    if (process.env['NODE_ENV'] === 'production') {
      const causa = err instanceof Error ? err.message : String(err);
      throw new Error(
        `TENANT_SETTINGS_ENC_KEY: no se pudo leer ni crear ${filePath} (${causa}). ` +
          'En producción no se arranca con una clave de cifrado efímera: los secretos cifrados se perderían al reiniciar. ' +
          'Monta un volumen escribible en esa ruta (o apunta SECRETS_DIR o TENANT_SETTINGS_ENC_KEY_FILE a una que lo sea), ' +
          'o define TENANT_SETTINGS_ENC_KEY con 64 caracteres hexadecimales (openssl rand -hex 32). ' +
          'Si esta instalación ya tenía una clave en ese fichero, recupera el acceso a él o copia su contenido a TENANT_SETTINGS_ENC_KEY: una clave nueva no descifra lo ya guardado.',
        { cause: err },
      );
    }
    // Fuera de producción caemos al fallback in-memory.
    return { key: randomBytes(32).toString('hex'), source: 'ephemeral' };
  }
}

/**
 * Las rutas que intervienen cuando la clave se guarda en disco sin ruta
 * explícita. La usan `loadCipherKey` y la herramienta de rotación, para que las
 * dos escriban la clave en el mismo sitio.
 */
export function resolveCipherKeyLocations(probe: DeviceProbe = deviceOf): CipherKeyLocations {
  const storageRoot = resolvePersistentDataRoot();
  const insideStorage = resolve(storageRoot, CIPHER_KEY_FILE_NAME);
  const fromEnv = process.env['SECRETS_DIR'];
  const secretsDirExplicit = Boolean(fromEnv && fromEnv.trim().length > 0);
  const secretsDir = secretsDirExplicit
    ? resolve(fromEnv!.trim())
    : resolve(storageRoot, '..', 'secrets');
  // Un `SECRETS_DIR` que apunte DENTRO del storage no saca la clave de ningún
  // sitio: se trata como si no estuviera.
  const untrustedReason = isInside(storageRoot, secretsDir)
    ? ('inside-storage' as const)
    : secretsDirExplicit || probe(dirname(secretsDir)) === probe(storageRoot)
      ? null
      : ('other-device' as const);
  const secretsDirTrusted = untrustedReason === null;
  return {
    insideStorage,
    secretsDir,
    secretsDirExplicit,
    secretsDirTrusted,
    untrustedReason,
    effective: secretsDirTrusted ? resolve(secretsDir, CIPHER_KEY_FILE_NAME) : insideStorage,
  };
}

function loadFromExplicitFile(filePath: string): ResolvedCipherKey {
  const existing = readValidKey(filePath);
  const notices: string[] = [];
  if (isInside(resolvePersistentDataRoot(), filePath)) {
    notices.push(
      `TENANT_SETTINGS_ENC_KEY_FILE apunta DENTRO de la raíz del storage (${filePath}). ` +
        'El servidor ya no sirve ficheros de fuera de sus prefijos públicos, pero la clave maestra no debe vivir en el árbol del storage: muévela a otra ruta.',
    );
  }
  if (existing) {
    return withNotices({ key: existing, source: 'file', filePath }, notices);
  }
  // No existe, o está corrupto: se (re)genera. Cualquier dato cifrado con un
  // contenido viejo corrupto ya era ilegible.
  const generated = writeNewKey(filePath);
  return withNotices({ key: generated, source: 'file-new', filePath }, notices);
}

function loadFromDisk(loc: CipherKeyLocations): ResolvedCipherKey {
  return loc.secretsDirTrusted ? loadFromSecretsDir(loc) : loadFromInsideStorage(loc);
}

/** Camino normal: la clave vive (o acaba viviendo) en el directorio de secretos. */
function loadFromSecretsDir(loc: CipherKeyLocations): ResolvedCipherKey {
  const target = loc.effective;
  const notices: string[] = [];

  const current = readValidKey(target);
  if (current) {
    // Ya está fuera. Si queda una copia en el storage, se retira: es la que
    // estuvo publicada.
    const leftover = readValidKeyQuiet(loc.insideStorage);
    if (leftover === current) {
      if (tryUnlink(loc.insideStorage)) {
        notices.push(`Retirada la copia antigua de la clave que quedaba en ${loc.insideStorage}.`);
      }
    } else if (leftover) {
      notices.push(
        `En ${loc.insideStorage} hay OTRA clave distinta de la que se usa (${target}). No se toca ni se usa; ` +
          'si no cifra nada vigente, bórrala a mano.',
      );
    }
    const rotationRequired = existsSync(target + ROTATION_REQUIRED_SUFFIX);
    if (rotationRequired) notices.push(rotationNotice(target));
    return withNotices(
      {
        key: current,
        source: 'file',
        filePath: target,
        ...(rotationRequired && { rotationRequired }),
      },
      notices,
    );
  }

  // No está en el sitio nuevo. ¿Está en el antiguo (dentro del storage)?
  const exposed = readValidKey(loc.insideStorage);
  if (exposed) {
    try {
      writeKeyFile(target, exposed);
      if (readValidKey(target) !== exposed) {
        throw new Error('la copia no coincide con el original');
      }
      writeMarker(target + ROTATION_REQUIRED_SUFFIX, loc.insideStorage);
    } catch (err) {
      // No se pudo dejar en el sitio nuevo: se sigue con la de siempre. Nunca
      // se pierde la clave por intentar moverla.
      tryUnlink(target);
      notices.push(
        `NO se pudo mover la clave de cifrado a ${target} (${describe(err)}). Sigue en ${loc.insideStorage}, ` +
          'que ya no se sirve por URL. Da permisos de escritura a ese directorio o define SECRETS_DIR. ' +
          rotationNotice(loc.insideStorage),
      );
      markExposedInsideStorage(loc.insideStorage);
      return {
        key: exposed,
        source: 'file',
        filePath: loc.insideStorage,
        rotationRequired: true,
        securityNotices: notices,
      };
    }
    if (!tryUnlink(loc.insideStorage)) {
      notices.push(
        `La clave ya está en ${target}, pero NO se pudo borrar el original de ${loc.insideStorage}. Bórralo a mano.`,
      );
    }
    tryUnlink(loc.insideStorage + ROTATION_REQUIRED_SUFFIX);
    tryUnlink(loc.insideStorage + NEVER_SERVED_SUFFIX);
    notices.push(
      `La clave de cifrado se ha MOVIDO de ${loc.insideStorage} a ${target} (permisos 600). ` +
        rotationNotice(target),
    );
    return {
      key: exposed,
      source: 'file',
      filePath: target,
      rotationRequired: true,
      migratedFrom: loc.insideStorage,
      securityNotices: notices,
    };
  }

  // Instalaciones anteriores a alpha.67: la clave en el directorio padre del
  // storage. Nunca estuvo en el árbol servido, así que se mueve sin marca.
  const legacyPath = resolveLegacyKeyFilePath();
  const legacy = legacyPath && legacyPath !== target ? readValidKeyQuiet(legacyPath) : null;
  if (legacy && legacyPath) {
    writeKeyFile(target, legacy);
    tryUnlink(legacyPath);
    return { key: legacy, source: 'file', filePath: target, migratedFrom: legacyPath };
  }

  const generated = writeNewKey(target);
  return { key: generated, source: 'file-new', filePath: target };
}

/**
 * Camino de reserva: el directorio de secretos por defecto NO está en el mismo
 * volumen que el storage y nadie ha definido `SECRETS_DIR`. La clave se queda
 * dentro del storage (que es lo único persistente que se conoce) y se avisa.
 */
function loadFromInsideStorage(loc: CipherKeyLocations): ResolvedCipherKey {
  const target = loc.insideStorage;
  const why =
    loc.untrustedReason === 'inside-storage'
      ? `SECRETS_DIR (${loc.secretsDir}) apunta DENTRO de la raíz del storage, que es justo de donde hay que sacar la clave, `
      : `El directorio de secretos por defecto (${loc.secretsDir}) no está en el mismo volumen que el storage, `;
  const howToFix =
    why +
    'así que la clave de cifrado se deja DENTRO de la raíz del storage para no perderla en el próximo despliegue. ' +
    'Ya no se sirve por URL, pero no debería vivir ahí: define SECRETS_DIR apuntando a un directorio persistente fuera del storage ' +
    '(o TENANT_SETTINGS_ENC_KEY con la propia clave) y reinicia; la clave se moverá sola.';

  const current = readValidKey(target);
  if (current) {
    const bornSafe = existsSync(target + NEVER_SERVED_SUFFIX);
    if (!bornSafe) markExposedInsideStorage(target);
    const notices = [howToFix];
    if (!bornSafe) notices.push(rotationNotice(target));
    return withNotices(
      {
        key: current,
        source: 'file',
        filePath: target,
        ...(!bornSafe && { rotationRequired: true }),
      },
      notices,
    );
  }

  const legacyPath = resolveLegacyKeyFilePath();
  const legacy = legacyPath && legacyPath !== target ? readValidKeyQuiet(legacyPath) : null;
  if (legacy && legacyPath) {
    writeKeyFile(target, legacy);
    writeMarker(target + NEVER_SERVED_SUFFIX, legacyPath);
    tryUnlink(legacyPath);
    return {
      key: legacy,
      source: 'file',
      filePath: target,
      migratedFrom: legacyPath,
      securityNotices: [howToFix],
    };
  }

  const generated = writeNewKey(target);
  // Nace con el servidor ya sin servir ficheros ocultos: no ha estado expuesta.
  writeMarker(target + NEVER_SERVED_SUFFIX, 'generada');
  tryUnlink(target + ROTATION_REQUIRED_SUFFIX);
  return { key: generated, source: 'file-new', filePath: target, securityNotices: [howToFix] };
}

// ── piezas ──────────────────────────────────────────────────────────────────

/** Añade los avisos solo si hay alguno: el resultado «limpio» no lleva campos de más. */
function withNotices(resolved: ResolvedCipherKey, notices: string[]): ResolvedCipherKey {
  return notices.length > 0 ? { ...resolved, securityNotices: notices } : resolved;
}

function isValidKey(raw: string): boolean {
  return raw.length === KEY_LENGTH_HEX && /^[0-9a-f]+$/i.test(raw);
}

/**
 * Lee la clave de un fichero. `null` si no existe o su contenido no es una
 * clave (corrupto: se regenera, como siempre). Un fichero que EXISTE y no se
 * puede leer LANZA: no se sustituye a ciegas una clave que no hemos podido ver.
 */
function readValidKey(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8').trim();
  return isValidKey(raw) ? raw : null;
}

/** Como `readValidKey`, pero un fichero ilegible cuenta como ausente. */
function readValidKeyQuiet(filePath: string): string | null {
  try {
    return readValidKey(filePath);
  } catch {
    return null;
  }
}

/** Escribe la clave de forma atómica (temporal + rename) con permisos 0600. */
export function writeKeyFile(filePath: string, key: string): void {
  if (!isValidKey(key)) throw new Error('la clave debe ser de 64 caracteres hexadecimales');
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, key, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    tryUnlink(tmp);
    throw err;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod puede fallar en Windows — no es crítico, el contenedor Linux sí
    // aplica la máscara correctamente.
  }
}

function writeNewKey(filePath: string): string {
  const generated = randomBytes(32).toString('hex');
  writeKeyFile(filePath, generated);
  return generated;
}

function writeMarker(markerPath: string, detail: string): void {
  try {
    writeFileSync(markerPath, `${new Date().toISOString()} ${detail}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Sin marca el aviso no se repetirá en el siguiente arranque, pero la
    // clave sigue funcionando: no es motivo para no arrancar.
  }
}

function markExposedInsideStorage(keyPath: string): void {
  if (!existsSync(keyPath + ROTATION_REQUIRED_SUFFIX)) {
    writeMarker(keyPath + ROTATION_REQUIRED_SUFFIX, keyPath);
  }
}

/**
 * Deja constancia de que la clave de `keyPath` ya no necesita rotación (porque
 * se acaba de rotar). Lo llama la herramienta de rotación al instalar la nueva.
 */
export function clearRotationRequired(keyPath: string, loc: CipherKeyLocations): void {
  tryUnlink(keyPath + ROTATION_REQUIRED_SUFFIX);
  // Una clave que se queda dentro del storage pero se generó tras el arreglo
  // no ha estado expuesta: sin esta marca se volvería a pedir su rotación.
  if (resolve(keyPath) === resolve(loc.insideStorage)) {
    writeMarker(keyPath + NEVER_SERVED_SUFFIX, 'rotada');
  }
}

function rotationNotice(keyPath: string): string {
  return (
    `ESTA CLAVE ESTUVO EXPUESTA: mientras vivió dentro del storage se podía descargar sin sesión por ` +
    `GET /api/v1/storage/file/${CIPHER_KEY_FILE_NAME}. Hay que darla por comprometida y ROTARLA ` +
    `(node dist/maintenance/rotate-cipher-key.cli.js; ver su --help), y rotar además las credenciales que protegía ` +
    `(Stripe, SMTP, OIDC, SCIM, Zoom) si la base de datos pudo haberse filtrado. Este aviso se repite en cada arranque ` +
    `hasta que se rote (marca: ${keyPath}${ROTATION_REQUIRED_SUFFIX}).`
  );
}

function tryUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ¿`candidate` está dentro de `root` (o es `root`)? */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** En qué dispositivo (volumen) está una ruta. Inyectable para los tests. */
export type DeviceProbe = (path: string) => number | null;

/**
 * Dispositivo (volumen) en el que está una ruta. Si todavía no existe, el de su
 * antepasado más cercano que sí: ahí es donde se crearía.
 */
function deviceOf(path: string): number | null {
  let current = resolve(path);
  for (;;) {
    try {
      return statSync(current).dev;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Cada aviso de seguridad sale UNA vez por proceso (esto se llama desde varios módulos). */
const reported = new Set<string>();

function reportSecurityNotice(notice: string): void {
  if (reported.has(notice)) return;
  reported.add(notice);
  // `console.error` y no el logger: esto corre al construir el grafo de DI,
  // antes de que exista Pino, y tiene que verse siempre.
  console.error(`[Didacta][SEGURIDAD] ${notice}`);
}

/**
 * Path donde vivía la key en versiones < alpha.67 (el directorio padre de
 * `STORAGE_ROOT`). Solo para la migración: si hay una clave válida ahí, se
 * mueve a la ubicación vigente.
 */
function resolveLegacyKeyFilePath(): string | null {
  const storageRoot = process.env['STORAGE_ROOT'];
  if (!storageRoot || storageRoot.trim().length === 0) return null;
  return resolve(storageRoot, '..', CIPHER_KEY_FILE_NAME);
}

/**
 * Loggea un WARN bonito al boot describiendo la fuente de la clave. Llamarlo
 * una sola vez tras arrancar la app (idealmente en main.ts, después de que el
 * Pino logger esté listo — pero como auth.module.ts construye el cipher antes,
 * usamos console.warn para que el mensaje siempre aparezca).
 */
export function describeCipherKeySource(resolved: ResolvedCipherKey): string {
  const env = process.env['TENANT_SETTINGS_ENC_KEY'] ? 'set' : 'unset';
  const fileEnv = process.env['TENANT_SETTINGS_ENC_KEY_FILE'] ?? '(unset)';
  const secretsDir = process.env['SECRETS_DIR'] ?? '(unset)';
  const storageRoot = process.env['STORAGE_ROOT'] ?? '(unset)';
  const cwd = process.cwd();
  const envFooter = `          env: TENANT_SETTINGS_ENC_KEY=${env}, TENANT_SETTINGS_ENC_KEY_FILE=${fileEnv}, SECRETS_DIR=${secretsDir}, STORAGE_ROOT=${storageRoot}, cwd=${cwd}`;
  switch (resolved.source) {
    case 'env':
      return `[Didacta] TENANT_SETTINGS_ENC_KEY: leída de env (control explícito).\n${envFooter}`;
    case 'file':
      return `[Didacta] TENANT_SETTINGS_ENC_KEY: leída de ${resolved.filePath} (persistente entre reinicios).\n${envFooter}`;
    case 'file-new':
      return (
        `[Didacta] TENANT_SETTINGS_ENC_KEY: nueva clave generada y persistida en ${resolved.filePath}.\n` +
        `          Sobrevive reinicios mientras el volumen persista. Haz backup si configuras\n` +
        `          features que cifran (Stripe, OIDC, SCIM, SMTP custom, Zoom S2S).\n` +
        envFooter
      );
    case 'ephemeral':
      return (
        '[Didacta] ⚠ TENANT_SETTINGS_ENC_KEY: NO pude persistir la clave en disco — uso clave\n' +
        '          efímera en memoria. Los secretos cifrados se PERDERÁN al reiniciar.\n' +
        '          Verifica permisos del volumen o configura TENANT_SETTINGS_ENC_KEY explícitamente.\n' +
        envFooter
      );
  }
}
