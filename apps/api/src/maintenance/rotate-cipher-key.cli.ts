/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@didacta/database';
import {
  currentKeyLocation,
  installRotatedKey,
  RotationAbortedError,
  rotateCipherKey,
  type RotationReport,
} from './rotate-cipher-key';

const HELP = `
Rotación de la clave maestra de cifrado de Didacta.

Recifra con una clave NUEVA todos los secretos guardados en la base
(tenant_setting, core_instance_setting, mod_secret) en una sola transacción, y
verifica que todo descifra con la nueva antes de confirmar.

  node apps/api/dist/maintenance/rotate-cipher-key.cli.js [opciones]

Por defecto es un ENSAYO: hace todo —incluida la verificación— y deshace la
transacción. Para escribir de verdad hay que pasar --apply.

Opciones
  --new-key-file <ruta>  Fichero con la clave nueva (64 caracteres hex).
  --generate             Si --new-key-file no existe, lo crea con una clave
                         aleatoria (permisos 600).
  --old-key-file <ruta>  Fichero con la clave ACTUAL. Por defecto se usa la que
                         usa la aplicación (TENANT_SETTINGS_ENC_KEY o su fichero).
  --apply                Confirma la rotación en la base.
  --install              Con --apply: después de confirmar, escribe la clave
                         nueva en el fichero del que la lee la aplicación y
                         retira el aviso de «rotación pendiente». No aplica si
                         la aplicación lee la clave de TENANT_SETTINGS_ENC_KEY.
  --skip-unreadable      No abortar si hay filas que no descifran con ninguna
                         de las dos claves: se dejan como están.
  --help                 Esta ayuda.

Las claves también se pueden pasar por entorno (ROTATE_OLD_KEY, ROTATE_NEW_KEY)
en vez de por fichero. Nunca por argumento: quedarían en el historial y en la
lista de procesos.

Base de datos: ADMIN_DATABASE_URL o, si no está, DATABASE_URL. Sirve el usuario
administrador o el de la aplicación (asume el rol didacta_super para ver las
filas de todas las aulas).

PROCEDIMIENTO
  1. Ensayo, con la aplicación en marcha (no cambia nada):
       ... rotate-cipher-key.cli.js --new-key-file /ruta/segura/nueva.key --generate
  2. PARA la aplicación. Mientras rota no debe haber nadie escribiendo secretos,
     y una API arrancada con la clave vieja no descifra lo ya rotado.
  3. Copia de seguridad de la base.
  4. Rotación:
       ... rotate-cipher-key.cli.js --new-key-file /ruta/segura/nueva.key --apply --install
     Si la aplicación lee la clave de TENANT_SETTINGS_ENC_KEY, quita --install y
     pon en esa variable el contenido de nueva.key.
  5. Arranca la aplicación y comprueba que una integración cifrada (p. ej. el
     botón «Probar conexión» de Stripe o de SMTP) sigue funcionando.
  6. Borra nueva.key de donde la dejaste y destruye las copias de la clave vieja.

Si la clave vieja estuvo expuesta, rotarla impide descifrar copias FUTURAS de la
base, pero quien se llevara la clave y una copia de la base ya tiene los
secretos de entonces: rota también esas credenciales en su proveedor.
`;

interface Args {
  newKeyFile?: string;
  oldKeyFile?: string;
  generate: boolean;
  apply: boolean;
  install: boolean;
  skipUnreadable: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    generate: false,
    apply: false,
    install: false,
    skipUnreadable: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} necesita una ruta.`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--new-key-file':
        args.newKeyFile = value();
        break;
      case '--old-key-file':
        args.oldKeyFile = value();
        break;
      case '--generate':
        args.generate = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--install':
        args.install = true;
        break;
      case '--skip-unreadable':
        args.skipUnreadable = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Opción desconocida: ${a}. Usa --help.`);
    }
  }
  return args;
}

function readKeyFile(path: string, what: string): string {
  const key = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(`${what}: ${path} no contiene 64 caracteres hexadecimales.`);
  }
  return key;
}

function resolveNewKey(args: Args): string {
  if (args.newKeyFile) {
    const path = resolve(args.newKeyFile);
    if (!existsSync(path)) {
      if (!args.generate) {
        throw new Error(
          `No existe ${path}. Pásalo con --generate para crearlo con una clave aleatoria.`,
        );
      }
      writeFileSync(path, randomBytes(32).toString('hex'), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      console.info(`Clave nueva generada en ${path} (permisos 600).`);
    }
    return readKeyFile(path, 'Clave nueva');
  }
  const fromEnv = process.env['ROTATE_NEW_KEY']?.trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv))
      throw new Error('ROTATE_NEW_KEY no son 64 caracteres hex.');
    return fromEnv;
  }
  throw new Error(
    'Falta la clave nueva: --new-key-file <ruta> (con --generate para crearla) o ROTATE_NEW_KEY.',
  );
}

function printReport(report: RotationReport): void {
  console.info(`Rol de base de datos: ${report.dbRole}`);
  for (const [table, c] of Object.entries(report.tables)) {
    console.info(
      `  ${table.padEnd(24)} cifradas=${c.total}  recifradas=${c.reencrypted}  ya rotadas=${c.alreadyRotated}  ilegibles=${c.unreadable}`,
    );
  }
  for (const u of report.unreadable) {
    console.info(`  ILEGIBLE  ${u.table}  ${u.ref}  (id ${u.id})`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.info(HELP);
    return 0;
  }
  if (args.install && !args.apply) throw new Error('--install solo tiene sentido con --apply.');

  const url = process.env['ADMIN_DATABASE_URL']?.trim() || process.env['DATABASE_URL']?.trim();
  if (!url) throw new Error('Define ADMIN_DATABASE_URL o DATABASE_URL.');

  const current = currentKeyLocation();
  const oldKey = args.oldKeyFile
    ? readKeyFile(resolve(args.oldKeyFile), 'Clave actual')
    : process.env['ROTATE_OLD_KEY']?.trim() || current.key;
  const newKey = resolveNewKey(args);

  if (args.install) {
    if (!current.file) {
      throw new Error(
        'La aplicación lee la clave de TENANT_SETTINGS_ENC_KEY: no hay fichero en el que instalarla. ' +
          'Quita --install y, tras la rotación, pon la clave nueva en esa variable.',
      );
    }
    // Se comprueba ANTES de tocar la base: confirmar la rotación y no poder
    // dejar la clave nueva en su sitio dejaría la aplicación sin poder leer.
    accessSync(dirname(current.file), constants.W_OK);
  }

  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
  try {
    console.info(
      args.apply ? 'ROTACIÓN (se escribirá en la base)…' : 'ENSAYO (no se escribe nada)…',
    );
    const report = await rotateCipherKey(prisma, {
      oldKey,
      newKey,
      dryRun: !args.apply,
      skipUnreadable: args.skipUnreadable,
    });
    printReport(report);

    if (!report.committed) {
      console.info(
        'Ensayo correcto: todo descifra con la clave nueva. NO se ha cambiado nada (falta --apply).',
      );
      return 0;
    }
    console.info('Rotación CONFIRMADA: todo lo cifrado descifra ya con la clave nueva.');

    if (args.install && current.file) {
      try {
        installRotatedKey(current.file, newKey);
        console.info(`Clave nueva instalada en ${current.file}. Ya puedes arrancar la aplicación.`);
      } catch (err) {
        console.error(
          `¡ATENCIÓN! La base YA está recifrada pero no se pudo escribir ${current.file} ` +
            `(${err instanceof Error ? err.message : String(err)}). NO arranques la aplicación hasta copiar a mano ` +
            'la clave nueva a ese fichero (o a TENANT_SETTINGS_ENC_KEY).',
        );
        return 2;
      }
    } else if (current.file) {
      console.info(
        `AHORA: escribe la clave nueva en ${current.file} antes de arrancar la aplicación (o repite con --install).`,
      );
    } else {
      console.info(
        'AHORA: pon la clave nueva en TENANT_SETTINGS_ENC_KEY antes de arrancar la aplicación.',
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof RotationAbortedError) {
      printReport(err.report);
      console.error(`ABORTADO: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
