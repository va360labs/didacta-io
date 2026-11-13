/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import {
  clearRotationRequired,
  loadCipherKey,
  resolveCipherKeyLocations,
  writeKeyFile,
} from '../auth/cipher-key';
import { SecretCipherService } from '../modules/secret-cipher.service';

/**
 * Rotación de la clave maestra de cifrado (`TENANT_SETTINGS_ENC_KEY` o su
 * fichero): recifra con una clave nueva todo lo que la aplicación guarda
 * cifrado con `SecretCipherService`.
 *
 * Tablas (son TODAS las que usan ese cifrador; si se añade otra, va aquí):
 *
 *  - `tenant_setting`         credenciales por aula: Stripe, SMTP, OIDC, SCIM,
 *                             Zoom, storage S3 propio…
 *  - `core_instance_setting`  ajustes cifrados de la instalación.
 *  - `mod_secret`             secretos de los módulos del marketplace.
 *  - `mod_payouts_tax_profile` datos fiscales del creador (cobros de plataforma).
 *  - `mod_payouts_invoice`    destinatario y PDF de cada factura de la comisión.
 *
 * NO entra `tenant_ai_provider_config`: sus claves de API se cifran con OTRA
 * clave (`AI_CONFIG_ENCRYPTION_KEY`, que solo existe como variable de entorno).
 *
 * Garantías:
 *
 *  - Todo ocurre en UNA transacción, con las tres tablas bloqueadas contra
 *    escritura. O se recifra todo, o no cambia nada.
 *  - Antes de confirmar se vuelve a leer CADA fila, se descifra con la clave
 *    nueva y se compara con lo que había (por hash del texto en claro). Si algo
 *    no cuadra, se deshace.
 *  - El modo en seco hace exactamente lo mismo —incluida la verificación— y
 *    deshace la transacción al final. No es una simulación aparte.
 *  - Es repetible: una fila que ya descifra con la clave nueva se da por
 *    rotada y no se toca.
 *  - Una fila que no descifra con NINGUNA de las dos claves aborta la rotación
 *    (ya estaba rota antes: conviene saberlo), salvo que se pida saltarla.
 *  - Nunca se imprime ni se devuelve un secreto: solo recuentos e
 *    identificadores de fila.
 *
 * RLS: estas tablas tienen RLS forzada. La transacción necesita ver las filas
 * de todas las aulas, así que si el usuario de conexión no la salta, asume
 * `didacta_super` (que es para lo que existe ese rol) y comprueba que lo ha
 * conseguido. Sin eso recifraría «cero filas» y diría que todo ha ido bien.
 */

/** Lo mínimo que se usa del cliente transaccional de Prisma. */
export interface RotationTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Lo mínimo que se usa de `PrismaClient`. */
export interface RotationClient {
  $transaction<T>(
    fn: (tx: RotationTx) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

interface EncryptedTable {
  table: string;
  cipher: string;
  iv: string;
  tag: string;
  /** Expresión SQL que identifica la fila para un humano. Sin secretos. */
  ref: string;
}

export const ENCRYPTED_TABLES: readonly EncryptedTable[] = [
  {
    table: 'tenant_setting',
    cipher: 'value_cipher',
    iv: 'value_iv',
    tag: 'value_tag',
    ref: `tenant_id::text || '/' || module_name || '/' || key`,
  },
  {
    table: 'core_instance_setting',
    cipher: 'value_cipher',
    iv: 'value_iv',
    tag: 'value_tag',
    ref: `scope || '/' || key`,
  },
  {
    table: 'mod_secret',
    cipher: 'ciphertext',
    iv: 'iv',
    tag: 'tag',
    ref: `tenant_id::text || '/' || module_id || '/' || secret_key`,
  },
  {
    // Datos fiscales del creador (NIF, NIF-IVA, dirección, nacimiento).
    table: 'mod_payouts_tax_profile',
    cipher: 'sensitive_cipher',
    iv: 'sensitive_iv',
    tag: 'sensitive_tag',
    ref: `tenant_id::text || '/datos-fiscales'`,
  },
  {
    // Factura emitida: datos del destinatario y el PDF. El trigger de
    // inmutabilidad deja cambiar SOLO este bloque (el texto en claro no cambia,
    // y la verificación de abajo lo comprueba).
    table: 'mod_payouts_invoice',
    cipher: 'document_cipher',
    iv: 'document_iv',
    tag: 'document_tag',
    ref: `tenant_id::text || '/' || full_number`,
  },
  {
    // Datos del alumno para cobrar sus referidos en dinero (nombre, NIF, IBAN).
    table: 'mod_referrals_member',
    cipher: 'payee_cipher',
    iv: 'payee_iv',
    tag: 'payee_tag',
    ref: `tenant_id::text || '/' || user_id::text || '/datos-de-cobro'`,
  },
  {
    // Receptor congelado en el justificante de un cobro de referidos.
    table: 'mod_referrals_payout',
    cipher: 'payee_snapshot_cipher',
    iv: 'payee_snapshot_iv',
    tag: 'payee_snapshot_tag',
    ref: `tenant_id::text || '/justificante/' || coalesce(receipt_number::text, id::text)`,
  },
];

export interface TableReport {
  /** Filas con contenido cifrado. */
  total: number;
  /** Descifraban con la clave vieja y se han recifrado con la nueva. */
  reencrypted: number;
  /** Ya descifraban con la clave nueva (rotación anterior): no se tocan. */
  alreadyRotated: number;
  /** No descifran con ninguna de las dos. */
  unreadable: number;
}

export interface RotationReport {
  dryRun: boolean;
  /** `true` solo si la transacción se confirmó. */
  committed: boolean;
  tables: Record<string, TableReport>;
  /** Filas que no descifran con ninguna clave (tabla + referencia, sin secretos). */
  unreadable: Array<{ table: string; id: string; ref: string }>;
  /** Usuario de base con el que se trabajó dentro de la transacción. */
  dbRole: string;
}

export interface RotateOptions {
  oldKey: string;
  newKey: string;
  /** Hace todo y deshace la transacción al final. */
  dryRun: boolean;
  /** No abortar si hay filas ilegibles: se dejan como están. */
  skipUnreadable?: boolean;
}

export class RotationAbortedError extends Error {
  constructor(
    message: string,
    readonly report: RotationReport,
  ) {
    super(message);
    this.name = 'RotationAbortedError';
  }
}

/** Para deshacer la transacción del modo en seco llevándose el informe. */
class DryRunRollback extends Error {
  constructor(readonly report: RotationReport) {
    super('modo en seco');
  }
}

interface Row {
  id: string;
  c: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  ref: string;
}

const KEY_RE = /^[0-9a-f]{64}$/i;

export async function rotateCipherKey(
  db: RotationClient,
  opts: RotateOptions,
): Promise<RotationReport> {
  if (!KEY_RE.test(opts.oldKey))
    throw new Error('La clave ACTUAL no son 64 caracteres hexadecimales.');
  if (!KEY_RE.test(opts.newKey))
    throw new Error('La clave NUEVA no son 64 caracteres hexadecimales.');
  if (opts.oldKey.toLowerCase() === opts.newKey.toLowerCase()) {
    throw new Error('La clave nueva es igual que la actual: no hay nada que rotar.');
  }
  const oldCipher = new SecretCipherService(opts.oldKey);
  const newCipher = new SecretCipherService(opts.newKey);

  try {
    const report = await db.$transaction(
      async (tx) => {
        const dbRole = await assumeRoleThatSeesEverything(tx);
        await tx.$executeRawUnsafe(
          `LOCK TABLE ${ENCRYPTED_TABLES.map((t) => `"${t.table}"`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`,
        );

        const result: RotationReport = {
          dryRun: opts.dryRun,
          committed: false,
          tables: {},
          unreadable: [],
          dbRole,
        };
        /** Hash del texto en claro de cada fila, para la verificación final. */
        const expected = new Map<string, string>();

        for (const spec of ENCRYPTED_TABLES) {
          const counts: TableReport = {
            total: 0,
            reencrypted: 0,
            alreadyRotated: 0,
            unreadable: 0,
          };
          for (const row of await readRows(tx, spec)) {
            counts.total += 1;
            const rowKey = `${spec.table}:${row.id}`;
            const withOld = tryDecrypt(oldCipher, row);
            if (withOld !== null) {
              const enc = newCipher.encrypt(withOld);
              await tx.$executeRawUnsafe(
                `UPDATE "${spec.table}" SET "${spec.cipher}" = $1, "${spec.iv}" = $2, "${spec.tag}" = $3 WHERE id = $4::uuid`,
                enc.cipher,
                enc.iv,
                enc.tag,
                row.id,
              );
              expected.set(rowKey, sha256(withOld));
              counts.reencrypted += 1;
              continue;
            }
            const withNew = tryDecrypt(newCipher, row);
            if (withNew !== null) {
              expected.set(rowKey, sha256(withNew));
              counts.alreadyRotated += 1;
              continue;
            }
            counts.unreadable += 1;
            result.unreadable.push({ table: spec.table, id: row.id, ref: row.ref });
          }
          result.tables[spec.table] = counts;
        }

        if (result.unreadable.length > 0 && !opts.skipUnreadable) {
          throw new RotationAbortedError(
            `${result.unreadable.length} fila(s) no descifran ni con la clave actual ni con la nueva. ` +
              'No se ha cambiado nada. Ya estaban ilegibles antes de rotar (¿se cifraron con otra clave?): ' +
              'arréglalas o repite con --skip-unreadable para dejarlas como están.',
            result,
          );
        }

        // Verificación: TODO lo que hay ahora en la base tiene que descifrar con
        // la clave nueva y decir lo mismo que decía.
        const skipped = new Set(result.unreadable.map((u) => `${u.table}:${u.id}`));
        for (const spec of ENCRYPTED_TABLES) {
          const rows = await readRows(tx, spec);
          if (rows.length !== result.tables[spec.table]!.total) {
            throw new RotationAbortedError(
              `Verificación fallida en ${spec.table}: había ${result.tables[spec.table]!.total} filas cifradas y ahora hay ${rows.length}. No se ha cambiado nada.`,
              result,
            );
          }
          for (const row of rows) {
            const rowKey = `${spec.table}:${row.id}`;
            if (skipped.has(rowKey)) continue;
            const plain = tryDecrypt(newCipher, row);
            if (plain === null || sha256(plain) !== expected.get(rowKey)) {
              throw new RotationAbortedError(
                `Verificación fallida en ${spec.table} (${row.ref}): tras recifrar no descifra con la clave nueva o su contenido cambió. No se ha cambiado nada.`,
                result,
              );
            }
          }
        }

        if (opts.dryRun) throw new DryRunRollback(result);
        return result;
      },
      { maxWait: 30_000, timeout: 30 * 60_000 },
    );
    return { ...report, committed: true };
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

/**
 * Deja la transacción con un rol que ve las filas de TODAS las aulas, y
 * devuelve su nombre. Lanza si no lo consigue.
 */
async function assumeRoleThatSeesEverything(tx: RotationTx): Promise<string> {
  const seesAll = async (): Promise<{ role: string; bypass: boolean }> => {
    const rows = await tx.$queryRawUnsafe<Array<{ role: string; bypass: boolean }>>(
      `SELECT current_user::text AS role, (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0] ?? { role: '?', bypass: false };
  };
  const before = await seesAll();
  if (before.bypass) return before.role;
  try {
    await tx.$executeRawUnsafe('SET LOCAL ROLE didacta_super');
  } catch (err) {
    throw new Error(
      `El usuario de base «${before.role}» no puede saltarse RLS ni asumir el rol didacta_super ` +
        `(${err instanceof Error ? err.message : String(err)}). Conecta con el usuario administrador ` +
        '(ADMIN_DATABASE_URL) o con el de la aplicación tras aplicar grants.sql.',
      { cause: err },
    );
  }
  const after = await seesAll();
  if (!after.bypass) {
    throw new Error(
      `Tras asumir didacta_super, el rol «${after.role}» sigue sin saltarse RLS: no vería las filas de todas las aulas. No se continúa.`,
    );
  }
  return after.role;
}

async function readRows(tx: RotationTx, spec: EncryptedTable): Promise<Row[]> {
  return tx.$queryRawUnsafe<Row[]>(
    `SELECT id::text AS id, "${spec.cipher}" AS c, "${spec.iv}" AS iv, "${spec.tag}" AS tag, (${spec.ref}) AS ref ` +
      `FROM "${spec.table}" WHERE "${spec.cipher}" IS NOT NULL ORDER BY id`,
  );
}

function tryDecrypt(cipher: SecretCipherService, row: Row): string | null {
  try {
    return cipher.decrypt({
      cipher: Buffer.from(row.c),
      iv: Buffer.from(row.iv ?? []),
      tag: Buffer.from(row.tag ?? []),
    });
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Dónde lee la aplicación su clave ahora mismo. `file: null` significa que la
 * lee de `TENANT_SETTINGS_ENC_KEY`: ahí no hay fichero que cambiar, hay que
 * cambiar la variable.
 */
export function currentKeyLocation(): { key: string; file: string | null } {
  const resolved = loadCipherKey();
  if (resolved.source === 'ephemeral') {
    throw new Error('No hay clave persistida que rotar (la aplicación usaría una efímera).');
  }
  return {
    key: resolved.key,
    file: resolved.source === 'env' ? null : (resolved.filePath ?? null),
  };
}

/**
 * Instala la clave nueva en el fichero del que la lee la aplicación y retira la
 * marca de «rotación pendiente». Se llama DESPUÉS de confirmar la rotación.
 */
export function installRotatedKey(keyFile: string, newKey: string): void {
  writeKeyFile(keyFile, newKey);
  clearRotationRequired(keyFile, resolveCipherKeyLocations());
}
