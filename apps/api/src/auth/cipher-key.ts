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
 * Con `/app/data/.didacta-secret-key` (volumen Docker dedicado) la separación
 * sigue valiendo: la BD vive en su propio volumen postgres_data, la clave
 * vive en didacta_data — quien tiene un volumen rara vez tiene los dos.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  // Reusamos STORAGE_ROOT (mismo volumen que el local-disk-storage si el
  // operador eligió ese driver). Default coincide con el del storage:
  // ./data dentro del CWD del contenedor (apps/api).
  const storageRoot = process.env['STORAGE_ROOT'];
  const base =
    storageRoot && storageRoot.trim().length > 0 ? resolve(storageRoot, '..') : resolve('./data');
  return resolve(base, '.didacta-secret-key');
}

/**
 * Loggea un WARN bonito al boot describiendo la fuente de la clave. Llamarlo
 * una sola vez tras arrancar la app (idealmente en main.ts, después de que el
 * Pino logger esté listo — pero como auth.module.ts construye el cipher antes,
 * usamos console.warn para que el mensaje siempre aparezca).
 */
export function describeCipherKeySource(resolved: ResolvedCipherKey): string {
  switch (resolved.source) {
    case 'env':
      return '[Didacta] TENANT_SETTINGS_ENC_KEY: leída de env (control explícito).';
    case 'file':
      return `[Didacta] TENANT_SETTINGS_ENC_KEY: leída de ${resolved.filePath} (persistente entre reinicios).`;
    case 'file-new':
      return (
        `[Didacta] TENANT_SETTINGS_ENC_KEY: nueva clave generada y persistida en ${resolved.filePath}.\n` +
        `          Sobrevive reinicios mientras el volumen persista. Hacé backup si configurás\n` +
        `          features que cifran (Stripe, OIDC, SCIM, SMTP custom, Zoom S2S).`
      );
    case 'ephemeral':
      return (
        '[Didacta] ⚠ TENANT_SETTINGS_ENC_KEY: NO pude persistir la clave en disco — uso clave\n' +
        '          efímera en memoria. Los secretos cifrados se PERDERÁN al reiniciar.\n' +
        '          Verificá permisos del volumen o seteá TENANT_SETTINGS_ENC_KEY explícitamente.'
      );
  }
}
