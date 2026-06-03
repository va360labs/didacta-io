/**
 * Carga (o genera + persiste) la clave AES-256 que cifra los secretos at-rest
 * en `tenant_setting`. Resolución por prioridad:
 *
 *   1. `TENANT_SETTINGS_ENC_KEY` (env). Control explícito — recomendado para
 *      producción seria. Si se setea, se usa tal cual.
 *
 *   2. Archivo persistente en disco (default `${STORAGE_ROOT}/.didacta-secret-key`,
 *      o `${TENANT_SETTINGS_ENC_KEY_FILE}` si está set). La primera vez la app
 *      arranca sin env, generamos random 32 bytes hex y los persistimos con
 *      permisos 0600. En reinicios siguientes se lee del mismo archivo —
 *      la clave SOBREVIVE redeploys mientras el volumen persista.
 *
 *   3. Random in-memory fallback (último recurso, solo si el archivo no se
 *      puede crear — disco lleno o RO). Imprime WARN — se perderá al reiniciar.
 *
 * Razón de NO guardar la clave en BD: anularía el cifrado at-rest. Cualquier
 * dump de Postgres revelaría tanto los secretos cifrados como la clave que
 * los descifra. La separación BD ↔ clave es lo que protege contra backups
 * filtrados / réplicas mal configuradas / atacantes con acceso de lectura.
 *
 * El archivo de la clave vive DENTRO de `STORAGE_ROOT` (mismo volumen Docker
 * que el local-disk-storage). Esto garantiza que en cualquier setup con un
 * solo volumen montado (Easypanel, single-host docker-compose, k8s con un
 * PVC), la clave persiste entre redeploys. El operador puede separar key
 * y storage en distintos volúmenes vía `TENANT_SETTINGS_ENC_KEY_FILE`
 * apuntando a otro path absoluto.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolvePersistentDataRoot } from '../modules/persistent-data-root';

const KEY_LENGTH_HEX = 64;

export interface ResolvedCipherKey {
  /** Clave en hex (64 chars). */
  key: string;
  /** Origen: env / file / file-new (recién creado) / ephemeral (in-memory fallback). */
  source: 'env' | 'file' | 'file-new' | 'ephemeral';
  /** Path del archivo si source es file/file-new. */
  filePath?: string;
}

/**
 * Resuelve la clave siguiendo la prioridad documentada arriba.
 */
export function loadCipherKey(): ResolvedCipherKey {
  const envKey = process.env['TENANT_SETTINGS_ENC_KEY'];
  if (envKey && envKey.trim().length > 0) {
    return { key: envKey.trim(), source: 'env' };
  }

  const filePath = resolveKeyFilePath();
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8').trim();
      if (raw.length === KEY_LENGTH_HEX && /^[0-9a-f]+$/i.test(raw)) {
        return { key: raw, source: 'file', filePath };
      }
      // Archivo corrupto o longitud inesperada — lo regeneramos. Cualquier
      // dato cifrado con el contenido viejo se vuelve ilegible (mismo riesgo
      // que rotar la env), pero es mejor que cargar una clave inválida que
      // produzca errores cripto en cada operación.
    }

    // Backwards-compat: instalaciones pre-fix tenían la clave en el parent
    // dir de STORAGE_ROOT (ej. /app/data en vez de /app/data/storage). Si
    // existe ahí Y el path nuevo no, la migramos para preservar los datos
    // cifrados con la key vieja. Si ambos paths existen, gana el nuevo
    // (operador ya hizo el move manualmente).
    const legacyPath = resolveLegacyKeyFilePath();
    if (legacyPath && legacyPath !== filePath && existsSync(legacyPath)) {
      const legacyRaw = readFileSync(legacyPath, 'utf8').trim();
      if (legacyRaw.length === KEY_LENGTH_HEX && /^[0-9a-f]+$/i.test(legacyRaw)) {
        mkdirSync(dirname(filePath), { recursive: true });
        try {
          renameSync(legacyPath, filePath);
        } catch {
          // Si rename falla cross-filesystem, hacemos copy+unlink mediante
          // writeFile (preservamos el contenido al menos).
          writeFileSync(filePath, legacyRaw, { encoding: 'utf8', mode: 0o600 });
        }
        try {
          chmodSync(filePath, 0o600);
        } catch {
          /* chmod best-effort */
        }
        return { key: legacyRaw, source: 'file', filePath };
      }
    }

    const generated = randomBytes(32).toString('hex');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, generated, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // chmod puede fallar en Windows — no es crítico, el contenedor Linux
      // sí aplica la máscara correctamente.
    }
    return { key: generated, source: 'file-new', filePath };
  } catch {
    // Disco lleno, RO, permisos rotos — caemos al fallback in-memory.
    return { key: randomBytes(32).toString('hex'), source: 'ephemeral' };
  }
}

function resolveKeyFilePath(): string {
  const explicit = process.env['TENANT_SETTINGS_ENC_KEY_FILE'];
  if (explicit && explicit.trim().length > 0) {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }
  // Reusamos el resolver compartido para que cipher-key y local-disk-storage
  // siempre apunten al mismo volumen persistente. Ver persistent-data-root.ts.
  return resolve(resolvePersistentDataRoot(), '.didacta-secret-key');
}

/**
 * Path donde vivía la key en versiones < alpha.67. Usado solo para migración
 * one-time: si existe un archivo válido ahí, lo movemos al path nuevo. Si
 * no, devuelve null y no se intenta nada.
 */
function resolveLegacyKeyFilePath(): string | null {
  // No migrar si el operador usa path explícito — su decisión es absoluta.
  if (process.env['TENANT_SETTINGS_ENC_KEY_FILE']) return null;
  const storageRoot = process.env['STORAGE_ROOT'];
  if (!storageRoot || storageRoot.trim().length === 0) return null;
  return resolve(storageRoot, '..', '.didacta-secret-key');
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
  const storageRoot = process.env['STORAGE_ROOT'] ?? '(unset)';
  const cwd = process.cwd();
  const envFooter = `          env: TENANT_SETTINGS_ENC_KEY=${env}, TENANT_SETTINGS_ENC_KEY_FILE=${fileEnv}, STORAGE_ROOT=${storageRoot}, cwd=${cwd}`;
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
