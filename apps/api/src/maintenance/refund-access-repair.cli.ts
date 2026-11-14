/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PrismaClient } from '@didacta/database';
import { describeRow, repairRefundedPurchases } from './refund-access-repair';

const HELP = `
Retira el acceso que se quedó vivo tras un reembolso hecho ANTES del arreglo.

Antes, el reembolso de un curso que el alumno ya había terminado no cancelaba
su matrícula ni revocaba su certificado. Este script recorre las órdenes
REEMBOLSADAS y aplica a cada una el mismo criterio que hoy aplica el reembolso:

  - otra compra cobrada del mismo curso, o un grupo (membresía) que lo sigue
    dando → no se le quita el curso;
  - si no → matrícula de compra cancelada (también las «completadas») y sus
    certificados de ese curso revocados (no se borran; la verificación pública
    dice que no son válidos).

  node apps/api/dist/maintenance/refund-access-repair.cli.js [opciones]

Por defecto es un ENSAYO (--dry-run): hace todo dentro de una transacción y la
deshace; solo informa. Para escribir de verdad hay que pasar --apply.
Idempotente: repetirlo no cambia nada más.

Opciones
  --tenant-slug <slug>  Solo esa aula (p. ej. aula-pruebas).
  --tenant <uuid>       Solo esa aula.
  --order <uuid>        Solo esa orden.
  --dry-run             Ensayo (por defecto).
  --apply               Confirma los cambios.
  --help                Esta ayuda.

Base de datos: ADMIN_DATABASE_URL o, si no está, DATABASE_URL. Cada orden se
procesa con su aula fijada (RLS), así que sirve el usuario de la aplicación.

Los avisos «learning.enrollment.cancelled» quedan en el outbox pendientes y los
entrega la API en marcha en su siguiente barrido.

Salida: 0 bien (también el ensayo) · 1 alguna orden falló · 2 argumentos.
`;

interface Args {
  apply: boolean;
  tenantId: string | null;
  tenantSlug: string | null;
  orderId: string | null;
  help: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { apply: false, tenantId: null, tenantSlug: null, orderId: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--tenant') args.tenantId = argv[++i] ?? '';
    else if (a === '--tenant-slug') args.tenantSlug = argv[++i] ?? '';
    else if (a === '--order') args.orderId = argv[++i] ?? '';
    else return `Argumento desconocido: ${a}`;
  }
  if (args.tenantId !== null && !UUID.test(args.tenantId)) return '--tenant tiene que ser un uuid';
  if (args.orderId !== null && !UUID.test(args.orderId)) return '--order tiene que ser un uuid';
  if (args.tenantSlug !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(args.tenantSlug)) {
    return '--tenant-slug no es un slug válido';
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(args);
    console.error('Usa --help para ver las opciones.');
    return 2;
  }
  if (args.help) {
    console.info(HELP);
    return 0;
  }
  const url = process.env['ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    console.error('Falta ADMIN_DATABASE_URL o DATABASE_URL.');
    return 2;
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const report = await repairRefundedPurchases(prisma, args);
    console.info(
      report.apply
        ? 'APLICANDO: los cambios quedan escritos.'
        : 'ENSAYO (--dry-run): no se escribe nada. Para aplicar, repite con --apply.',
    );
    if (report.rows.length === 0) {
      console.info('No hay órdenes reembolsadas en el alcance pedido.');
    }
    const ordered = [...report.rows].sort((a, b) => Number(b.changes) - Number(a.changes));
    for (const row of ordered) console.info(describeRow(row, report.apply));
    console.info(
      `\nÓrdenes reembolsadas revisadas: ${report.rows.length} · ${
        report.apply ? 'cambiadas' : 'cambiarían'
      }: ${report.changed} · errores: ${report.errors}`,
    );
    return report.errors > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Solo al ejecutarse como script (los tests importan `parseArgs`).
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    },
  );
}
