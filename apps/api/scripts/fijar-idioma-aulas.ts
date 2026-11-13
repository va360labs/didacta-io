/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Fija el IDIOMA DEL AULA (`tenant_setting academy/locale`) a las aulas que ya
 * existían antes de que existiera el ajuste, con la deducción que se usaba
 * hasta ahora: el idioma del alta en 3 preguntas del modo sencillo y, si no lo
 * hay, el del perfil de la primera persona que administra el aula (si
 * tampoco, español). Las aulas nuevas ya nacen con él (alta sencilla o
 * aprovisionamiento) o lo eligen en Ajustes.
 *
 * ── Cómo se usa ─────────────────────────────────────────────────────────────
 *   # 1. Ver qué idioma pondría a cada aula, sin tocar nada (por defecto):
 *   pnpm --filter @didacta/api exec tsx scripts/fijar-idioma-aulas.ts
 *   # 2. Aplicar de verdad:
 *   pnpm --filter @didacta/api exec tsx scripts/fijar-idioma-aulas.ts --apply
 *   # Opcional: --tenant <uuid> para una sola.
 *
 * Solo INSERTA el ajuste en las aulas que no lo tienen (`skipDuplicates`): un
 * aula que ya lo tiene se informa y no se toca, aunque alguien lo haya fijado
 * mientras corría el script. No cambia nada más: ni perfiles, ni espacios, ni
 * textos ya escritos. Como el idioma que se fija es el mismo que el aula ya
 * usaba por deducción, nada cambia de idioma al aplicarlo: solo deja de
 * depender del perfil de quien administra.
 *
 * `tenant_setting` y `user` tienen RLS forzada: se lee y se escribe aula por
 * aula con `withTenantContext`.
 *
 * Exit codes: 0 bien (también en dry-run) · 1 falló alguna escritura · 2 argumentos.
 */
import { PrismaClient, withTenantContext } from '@didacta/database';
import {
  ACADEMY_LOCALE_SETTING,
  deducedAcademyLocale,
  explicitAcademyLocale,
  type AcademyDefaultsPrisma,
  type AcademyLocale,
  type AcademyLocaleSource,
} from '../src/common/academy-defaults';

export interface AulaRevisada {
  id: string;
  slug: string;
  /** El ajuste que ya tiene, si lo tiene. */
  actual: AcademyLocale | null;
  /** Lo que daría la deducción de siempre, y de dónde sale. */
  deducido: AcademyLocale;
  origen: Exclude<AcademyLocaleSource, 'setting'>;
}

export type Accion = 'fijar' | 'ya-tiene';

/** Decisión pura (testeable): qué hacer con cada aula y con qué idioma. */
export function decidir(aula: AulaRevisada): { accion: Accion; locale: AcademyLocale } {
  if (aula.actual) return { accion: 'ya-tiene', locale: aula.actual };
  return { accion: 'fijar', locale: aula.deducido };
}

const ORIGEN: Record<AulaRevisada['origen'], string> = {
  'simple-mode': 'alta en 3 preguntas',
  admin: 'perfil de quien administra',
  default: 'sin datos: español por defecto',
};

/** Una línea del listado: qué haría, el aula, el idioma y de dónde sale. */
export function linea(aula: AulaRevisada): string {
  const { accion, locale } = decidir(aula);
  const por = accion === 'ya-tiene' ? 'ya fijado' : ORIGEN[aula.origen];
  return `  ${accion.padEnd(9)} ${locale}  ${aula.slug} (${aula.id}) — ${por}`;
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
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  const out: AulaRevisada[] = [];
  for (const t of tenants) {
    const fila = await withTenantContext(prisma, t.id, async (tx) => {
      const p = tx as unknown as AcademyDefaultsPrisma;
      const actual = await explicitAcademyLocale(p, t.id);
      const { locale, source } = await deducedAcademyLocale(p, t.id);
      return { actual, deducido: locale, origen: source };
    });
    out.push({ ...t, ...fila });
  }
  return out;
}

/**
 * Inserta el ajuste en las aulas que no lo tienen. Nunca sobrescribe: si
 * alguien lo fijó entre la revisión y la escritura, gana lo suyo.
 * Devuelve cuántas filas escribió y los fallos.
 */
export async function aplicar(
  prisma: PrismaClient,
  aulas: AulaRevisada[],
  log: (msg: string) => void = console.info,
): Promise<{ escritas: number; fallos: number }> {
  let escritas = 0;
  let fallos = 0;
  for (const a of aulas) {
    const { accion, locale } = decidir(a);
    if (accion !== 'fijar') continue;
    try {
      const r = await withTenantContext(prisma, a.id, (tx) =>
        tx.tenantSetting.createMany({
          data: [
            {
              tenantId: a.id,
              moduleName: ACADEMY_LOCALE_SETTING.moduleName,
              key: ACADEMY_LOCALE_SETTING.key,
              valueJson: locale,
              isSecret: false,
            },
          ],
          skipDuplicates: true,
        }),
      );
      escritas += r.count;
      log(r.count ? `  fijado ${locale} en ${a.slug}` : `  ${a.slug}: ya lo tenía, no se toca`);
    } catch (err) {
      fallos += 1;
      console.error(`  FALLO ${a.slug}: ${(err as Error).message}`);
    }
  }
  return { escritas, fallos };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const aulas = await revisar(prisma, opts.tenantId);
    const fijar = aulas.filter((a) => decidir(a).accion === 'fijar');
    console.info(`Aulas revisadas: ${aulas.length}`);
    for (const a of aulas) console.info(linea(a));
    console.info(
      `\nSe fijaría el idioma en ${fijar.length} (en: ${
        fijar.filter((a) => a.deducido === 'en').length
      }, es: ${fijar.filter((a) => a.deducido === 'es').length}).`,
    );
    if (!opts.apply) {
      console.info('Modo prueba: no se ha cambiado nada. Usa --apply para aplicarlo.');
      return;
    }
    const { fallos } = await aplicar(prisma, aulas);
    if (fallos > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.includes('fijar-idioma-aulas')) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
