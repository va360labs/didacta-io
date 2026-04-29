/**
 * Health-check post-deploy: corre tras `prisma migrate deploy` y verifica
 * que las migraciones críticas del último sprint quedaron aplicadas en la
 * base de datos real.
 *
 * Diseñado para detectar fallos silenciosos de migración (la deploy "ok"
 * pero la tabla no existe) ANTES de que un usuario pegue intentando usar
 * un feature que depende de una tabla nueva.
 *
 * Uso:
 *   pnpm --filter @didacta/api exec tsx scripts/post-deploy-check.ts
 *
 * Exit codes:
 *   0 — todas las verificaciones pasan
 *   1 — al menos una verificación falla
 *   2 — error de conexión / bootstrap (DATABASE_URL inválida, etc.)
 */
import { PrismaClient } from '@prisma/client';

type CheckResult = { name: string; ok: boolean; detail?: string };

interface TableCheck {
  table: string;
  columns: string[];
  feature: string;
}

interface EnumCheck {
  name: string;
  values: string[];
  feature: string;
}

const TABLE_CHECKS: TableCheck[] = [
  {
    table: 'mod_community_tag',
    columns: ['id', 'tenant_id', 'name', 'color', 'icon', 'created_at', 'updated_at'],
    feature: 'Com-3 / A2 — tags curados de comunidad',
  },
  {
    table: 'mod_learning_lesson_comment',
    columns: [
      'id',
      'tenant_id',
      'lesson_id',
      'course_id',
      'author_id',
      'body',
      'status',
      'reviewed_by_id',
      'reviewed_at',
      'rejection_reason',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    feature: 'B2 / FU-3 — comentarios con aprobación',
  },
  {
    table: 'mod_courses_category',
    columns: ['id', 'tenant_id', 'name', 'color', 'icon', 'created_at', 'updated_at'],
    feature: 'E2 / FU-1 — categorías curadas',
  },
];

const COLUMN_CHECKS: { table: string; column: string; feature: string }[] = [
  {
    table: 'mod_community_post',
    column: 'pinned_at',
    feature: 'Com-2 — pin de mensajes',
  },
  {
    table: 'mod_community_post',
    column: 'pinned_by_id',
    feature: 'Com-2 — pin de mensajes',
  },
];

const ENUM_CHECKS: EnumCheck[] = [
  {
    name: 'LessonCommentStatus',
    values: ['PENDING', 'APPROVED', 'REJECTED'],
    feature: 'B2 / FU-3 — workflow de aprobación',
  },
];

async function tableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

async function tableColumns(prisma: PrismaClient, table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map((r) => r.column_name);
}

async function enumValues(prisma: PrismaClient, name: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = ${name}
    ORDER BY e.enumsortorder
  `;
  return rows.map((r) => r.enumlabel);
}

async function runChecks(prisma: PrismaClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of TABLE_CHECKS) {
    const exists = await tableExists(prisma, check.table);
    if (!exists) {
      results.push({
        name: `table ${check.table}`,
        ok: false,
        detail: `tabla ausente — bloquea ${check.feature}`,
      });
      continue;
    }
    const columns = await tableColumns(prisma, check.table);
    const missing = check.columns.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      results.push({
        name: `table ${check.table}`,
        ok: false,
        detail: `faltan columnas [${missing.join(', ')}] — bloquea ${check.feature}`,
      });
    } else {
      results.push({ name: `table ${check.table}`, ok: true, detail: check.feature });
    }
  }

  for (const check of COLUMN_CHECKS) {
    const columns = await tableColumns(prisma, check.table);
    const ok = columns.includes(check.column);
    results.push({
      name: `column ${check.table}.${check.column}`,
      ok,
      detail: ok ? check.feature : `columna ausente — bloquea ${check.feature}`,
    });
  }

  for (const check of ENUM_CHECKS) {
    const values = await enumValues(prisma, check.name);
    if (values.length === 0) {
      results.push({
        name: `enum ${check.name}`,
        ok: false,
        detail: `enum ausente — bloquea ${check.feature}`,
      });
      continue;
    }
    const missing = check.values.filter((v) => !values.includes(v));
    if (missing.length > 0) {
      results.push({
        name: `enum ${check.name}`,
        ok: false,
        detail: `faltan valores [${missing.join(', ')}] — bloquea ${check.feature}`,
      });
    } else {
      results.push({ name: `enum ${check.name}`, ok: true, detail: check.feature });
    }
  }

  return results;
}

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('[post-deploy-check] DATABASE_URL no está definida.');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (err) {
    console.error('[post-deploy-check] No se pudo conectar a la base de datos:', err);
    process.exit(2);
  }

  let results: CheckResult[];
  try {
    results = await runChecks(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);

  console.log(`\n[post-deploy-check] ${passed.length}/${results.length} checks OK\n`);
  for (const r of results) {
    const tag = r.ok ? 'OK ' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }

  if (failed.length > 0) {
    console.error(
      `\n[post-deploy-check] ${failed.length} check(s) fallaron. Revisar migraciones antes de servir tráfico.`,
    );
    process.exit(1);
  }
  console.log('\n[post-deploy-check] Todas las verificaciones pasaron.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[post-deploy-check] Error inesperado:', err);
  process.exit(2);
});
