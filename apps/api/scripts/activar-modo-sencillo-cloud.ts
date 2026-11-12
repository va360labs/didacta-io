/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Pasa al MODO SENCILLO las aulas que creó Didacta Cloud (plano de control con
 * credencial de provisioning). Las aulas nuevas ya nacen así; esto es para las
 * que existían antes de que existiera el ajuste.
 *
 * ── Cómo se usa ─────────────────────────────────────────────────────────────
 *   # 1. Ver qué aulas cambiarían, sin tocar nada (por defecto):
 *   pnpm --filter @didacta/api exec tsx scripts/activar-modo-sencillo-cloud.ts
 *   # 2. Aplicar de verdad:
 *   pnpm --filter @didacta/api exec tsx scripts/activar-modo-sencillo-cloud.ts --apply
 *   # Opcional: --tenant <uuid> para una sola.
 *
 * ── Cómo sabe qué aulas son de Cloud ────────────────────────────────────────
 * El alta de un aula deja en `audit_log` la acción `admin.tenant.created`; si
 * la hizo el plano de control, con `metadata.actorKind = 'provisioning'`
 * (`auditActorTrace`). Un aula creada a mano por un super_admin, o por el
 * asistente /setup de una instalación propia, NO lleva esa marca y no se toca.
 * `audit_log` tiene RLS forzada: se lee aula por aula con `withTenantContext`.
 *
 * Idempotente: un aula ya en modo sencillo se informa y no se vuelve a escribir.
 * No borra ni cambia nada más: el resto del aula queda igual (el modo completo
 * sigue a un clic en «Más» y en Ajustes).
 *
 * Exit codes: 0 bien (también en dry-run) · 1 falló alguna escritura · 2 argumentos.
 */
import { PrismaClient, withTenantContext } from '@didacta/database';

export interface AulaRevisada {
  id: string;
  slug: string;
  simpleMode: boolean;
  /** Tiene la marca de alta por el plano de control (Cloud). */
  creadaPorCloud: boolean;
}

export type Accion = 'activar' | 'ya-sencilla' | 'no-es-de-cloud';

/** Decisión pura (testeable): qué hacer con cada aula. */
export function decidir(aula: AulaRevisada): Accion {
  if (!aula.creadaPorCloud) return 'no-es-de-cloud';
  return aula.simpleMode ? 'ya-sencilla' : 'activar';
}

function parseArgs(argv: string[]): { apply: boolean; tenantId: string | null } {
  const opts = { apply: false, tenantId: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--tenant') opts.tenantId = argv[++i] ?? null;
    else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(2);
    }
  }
  if (opts.tenantId !== null && !/^[0-9a-f-]{36}$/i.test(opts.tenantId)) {
    console.error('--tenant tiene que ser un uuid');
    process.exit(2);
  }
  return opts;
}

export async function revisar(
  prisma: PrismaClient,
  tenantId: string | null,
): Promise<AulaRevisada[]> {
  // `tenant` no tiene RLS: se listan todas.
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, ...(tenantId ? { id: tenantId } : {}) },
    select: { id: true, slug: true, simpleMode: true },
    orderBy: { createdAt: 'asc' },
  });
  const out: AulaRevisada[] = [];
  for (const t of tenants) {
    const marca = await withTenantContext(prisma, t.id, (tx) =>
      tx.auditLog.findFirst({
        where: {
          tenantId: t.id,
          action: 'admin.tenant.created',
          metadata: { path: ['actorKind'], equals: 'provisioning' },
        },
        select: { id: true },
      }),
    );
    out.push({ ...t, creadaPorCloud: marca !== null });
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  let fallos = 0;
  try {
    const aulas = await revisar(prisma, opts.tenantId);
    const activar = aulas.filter((a) => decidir(a) === 'activar');
    console.info(`Aulas revisadas: ${aulas.length}`);
    for (const a of aulas) console.info(`  ${decidir(a).padEnd(15)} ${a.slug} (${a.id})`);
    console.info(`\nPasarían a modo sencillo: ${activar.length}`);
    if (!opts.apply) {
      console.info('Modo prueba: no se ha cambiado nada. Usa --apply para aplicarlo.');
      return;
    }
    for (const a of activar) {
      try {
        await prisma.tenant.update({ where: { id: a.id }, data: { simpleMode: true } });
        console.info(`  activada ${a.slug}`);
      } catch (err) {
        fallos += 1;
        console.error(`  FALLO ${a.slug}: ${(err as Error).message}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  if (fallos > 0) process.exit(1);
}

if (process.argv[1]?.includes('activar-modo-sencillo-cloud')) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
