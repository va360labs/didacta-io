/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Backfill del HTML guardado ANTES del parche de saneado (v0.1.0-beta.8).
 *
 * ── Qué arregla ─────────────────────────────────────────────────────────────
 *
 * Hasta la beta.8, el HTML de las lecciones y las descripciones de curso se
 * guardaban tal cual llegaban del editor: un `<img onerror=...>` almacenado por
 * quien pudiera editar contenido se ejecutaba en el navegador de cada alumno que
 * abriera la lección. El parche cerró la puerta de entrada —ahora se sanea en el
 * servidor al guardar— pero **no tocó lo que ya estaba en la base**. Esas filas
 * siguen crudas.
 *
 * Hoy lo tapa el saneado del cliente al pintar, que es la segunda capa del
 * doble saneado deliberado (ver `packages/core-kernel/src/html/sanitize.ts`).
 * Este script quita la dependencia de esa segunda capa: mientras el dato
 * almacenado siga sucio, cualquier consumidor que NO sea `apps/web` —un export,
 * un PDF, un módulo del marketplace, un correo— lo recibe crudo.
 *
 * ── Cómo se usa ─────────────────────────────────────────────────────────────
 *
 *   # 1. Ver qué cambiaría, sin tocar nada (por defecto):
 *   pnpm --filter @didacta/api exec tsx scripts/backfill-sanitize-html.ts
 *
 *   # 2. Aplicar de verdad:
 *   pnpm --filter @didacta/api exec tsx scripts/backfill-sanitize-html.ts --apply
 *
 *   # Opcionales:
 *   --tenant <uuid>   Solo ese tenant (por defecto: todos).
 *   --batch <n>       Filas por lote (por defecto 200).
 *   --verbose         Lista cada fila que cambiaría, no solo el recuento.
 *
 * **No escribe nada sin `--apply`.** El defecto es el modo seguro a propósito:
 * esto reescribe contenido que el cliente ve, y un backfill que se ejecuta solo
 * por haberlo lanzado sin argumentos es la clase de herramienta que acaba
 * corriendo en la base equivocada.
 *
 * ── Por qué va tenant por tenant ────────────────────────────────────────────
 *
 * `rls.sql` pone `FORCE ROW LEVEL SECURITY`, que aplica **también al dueño de la
 * tabla**: sin `app.current_tenant_id` seteado, una consulta no ve ni una fila y
 * el script informaría alegremente de que no hay nada que hacer. Por eso todo
 * pasa por `withTenantContext`, que es la implementación canónica del scope.
 *
 * ── Idempotente ─────────────────────────────────────────────────────────────
 *
 * `sanitizeLessonContent` y `sanitizeRichText` lo son, así que volver a correrlo
 * no degrada nada y la segunda pasada informa de 0 cambios. Esa es, de hecho, la
 * forma de comprobar que la primera funcionó.
 *
 * Exit codes:
 *   0 — terminó bien (en dry-run, aunque haya filas pendientes)
 *   1 — falló alguna escritura
 *   2 — error de conexión / argumentos inválidos
 */
import { PrismaClient, withTenantContext } from '@didacta/database';
import { sanitizeLessonContent, sanitizeRichText } from '@didacta/core-kernel';

interface Opciones {
  apply: boolean;
  tenantId: string | null;
  batch: number;
  verbose: boolean;
}

interface Resumen {
  leccionesRevisadas: number;
  leccionesCambiadas: number;
  cursosRevisados: number;
  cursosCambiados: number;
}

function parseArgs(argv: string[]): Opciones {
  const opts: Opciones = { apply: false, tenantId: null, batch: 200, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--tenant') opts.tenantId = argv[++i] ?? null;
    else if (a === '--batch') opts.batch = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.info(
        'uso: backfill-sanitize-html.ts [--apply] [--tenant <uuid>] [--batch <n>] [--verbose]',
      );
      process.exit(0);
    } else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.batch) || opts.batch < 1 || opts.batch > 5000) {
    console.error('--batch tiene que ser un entero entre 1 y 5000');
    process.exit(2);
  }
  if (opts.tenantId !== null && !/^[0-9a-f-]{36}$/i.test(opts.tenantId)) {
    console.error('--tenant tiene que ser un uuid');
    process.exit(2);
  }
  return opts;
}

/**
 * Comparación por JSON canónico. `sanitizeLessonContent` reconstruye el objeto
 * clave a clave, así que la identidad de referencia no sirve: hay que comparar
 * el valor. El orden de claves se conserva (`Object.entries` + reinserción), de
 * modo que un `JSON.stringify` de los dos lados es comparable.
 */
function mismoContenido(antes: unknown, despues: unknown): boolean {
  return JSON.stringify(antes) === JSON.stringify(despues);
}

async function procesarTenant(
  prisma: PrismaClient,
  tenantId: string,
  opts: Opciones,
  resumen: Resumen,
): Promise<void> {
  // Paginación por cursor sobre el id: estable aunque el lote se reescriba a
  // mitad de recorrido, cosa que un OFFSET no garantiza.
  let cursor: string | null = null;
  for (;;) {
    const lecciones: Array<{ id: string; content: unknown }> = await withTenantContext(
      prisma,
      tenantId,
      (tx) =>
        tx.modCoursesLesson.findMany({
          where: { tenantId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, content: true },
          orderBy: { id: 'asc' },
          take: opts.batch,
        }),
    );
    if (lecciones.length === 0) break;
    cursor = lecciones[lecciones.length - 1]!.id;

    for (const leccion of lecciones) {
      resumen.leccionesRevisadas += 1;
      const saneado = sanitizeLessonContent(leccion.content);
      if (mismoContenido(leccion.content, saneado)) continue;

      resumen.leccionesCambiadas += 1;
      if (opts.verbose) console.info(`  · lección ${leccion.id}`);
      if (opts.apply) {
        await withTenantContext(prisma, tenantId, (tx) =>
          tx.modCoursesLesson.update({
            where: { id: leccion.id },
            data: { content: saneado as never },
          }),
        );
      }
    }
  }

  cursor = null;
  for (;;) {
    const cursos: Array<{ id: string; description: string | null }> = await withTenantContext(
      prisma,
      tenantId,
      (tx) =>
        tx.modCoursesCourse.findMany({
          where: { tenantId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, description: true },
          orderBy: { id: 'asc' },
          take: opts.batch,
        }),
    );
    if (cursos.length === 0) break;
    cursor = cursos[cursos.length - 1]!.id;

    for (const curso of cursos) {
      resumen.cursosRevisados += 1;
      if (curso.description === null) continue;
      const saneado = sanitizeRichText(curso.description);
      if (saneado === curso.description) continue;

      resumen.cursosCambiados += 1;
      if (opts.verbose) console.info(`  · curso ${curso.id}`);
      if (opts.apply) {
        await withTenantContext(prisma, tenantId, (tx) =>
          tx.modCoursesCourse.update({
            where: { id: curso.id },
            data: { description: saneado },
          }),
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
  } catch (err) {
    console.error('No se pudo conectar a la base. ¿DATABASE_URL apunta a donde crees?');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  console.info(
    opts.apply
      ? '▸ Modo APLICAR: se van a reescribir filas.'
      : '▸ Modo simulación (sin --apply): no se escribe nada.',
  );

  const resumen: Resumen = {
    leccionesRevisadas: 0,
    leccionesCambiadas: 0,
    cursosRevisados: 0,
    cursosCambiados: 0,
  };
  let fallos = 0;

  try {
    // `tenant` no tiene columna `tenant_id`, así que queda fuera de la política
    // de aislamiento y se puede listar sin contexto.
    const tenants = await prisma.tenant.findMany({
      where: { deletedAt: null, ...(opts.tenantId ? { id: opts.tenantId } : {}) },
      select: { id: true, slug: true },
      orderBy: { id: 'asc' },
    });
    if (tenants.length === 0) {
      console.warn('No hay tenants que procesar.');
      return;
    }

    for (const tenant of tenants) {
      console.info(`▸ ${tenant.slug} (${tenant.id})`);
      try {
        await procesarTenant(prisma, tenant.id, opts, resumen);
      } catch (err) {
        // Un tenant que falla no aborta el resto: en una instalación con muchos,
        // parar en el primero dejaría el trabajo a medias y sin saber dónde.
        fallos += 1;
        console.error(
          `  ✗ ${tenant.slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.info('');
  console.info(`Lecciones revisadas: ${resumen.leccionesRevisadas}`);
  console.info(`Lecciones a sanear:  ${resumen.leccionesCambiadas}`);
  console.info(`Cursos revisados:    ${resumen.cursosRevisados}`);
  console.info(`Cursos a sanear:     ${resumen.cursosCambiados}`);

  if (fallos > 0) {
    console.error(`\n✗ ${fallos} tenant(s) fallaron.`);
    process.exit(1);
  }
  if (!opts.apply && resumen.leccionesCambiadas + resumen.cursosCambiados > 0) {
    console.info('\nVuelve a lanzarlo con --apply para escribir los cambios.');
  }
}

void main();
