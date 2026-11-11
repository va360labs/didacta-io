/**
 * Protección de vídeo contra un Postgres REAL, conectando como el runtime
 * post-flip: rol `didacta_app` (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Los tests unitarios mockean Prisma, así que no pueden probar las dos cosas
 * que aquí importan:
 *
 *  1. Que las consultas CRUDAS de la protección de vídeo (buscar un GUID dentro
 *     del `content` jsonb de las lecciones, listar las librerías de Bunny de un
 *     tenant) son SQL válido y encuentran lo que deben.
 *  2. Que ven SOLO lo del tenant que pregunta. La extensión de RLS envuelve las
 *     operaciones de modelo, no un `$queryRaw` suelto: por eso van en un
 *     `$transaction` por lotes. Si alguien lo «simplifica» a un `$queryRaw`
 *     directo, con RLS forzada no vería ni una fila y TODOS los alumnos
 *     recibirían un 403 — y este test se cae.
 *
 * El escenario de aislamiento es el peor posible a propósito: las dos academias
 * tienen el mismo vídeo de Bunny en una lección, y el servicio de matrículas
 * (stub) contesta «matriculado» a todo. Lo único que puede negar el acceso al
 * alumno de la otra academia es que la base de datos no le deje ver la lección.
 *
 * REQUISITOS (igual que `rls-isolation-didacta-app.integration.test.ts`):
 * Postgres en un contenedor Docker alcanzable por nombre, `DATABASE_URL` con un
 * rol ADMIN y el schema aplicado. SKIP sin `DATABASE_URL`.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { VideoAccessService } from '../../src/video/video-access.service';
import {
  BUNNY_KEYS_SETTING,
  VIDEO_PROTECTION_SCOPE,
  VideoProtectionConfigService,
} from '../../src/video/video-protection-config.service';

const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Librerías y vídeos inventados: no son de ninguna cuenta real de Bunny. */
const LIB_A = '700101';
const LIB_B = '700202';
const LIB_FEATURED = '700303';
const GUID_SHARED = randomUUID();
const GUID_ONLY_B = randomUUID();
const GUID_HTML_A = randomUUID();
const GUID_FEATURED_A = randomUUID();
const GUID_DRAFT_A = randomUUID();
const TOKEN_KEY = `clave-de-firma-${randomBytes(6).toString('hex')}`;

const embed = (lib: string, guid: string) =>
  `https://iframe.mediadelivery.net/embed/${lib}/${guid}`;

function applySqlFileViaPsql(relPath: string): void {
  const sql = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      PG_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { input: sql, stdio: ['pipe', 'pipe', 'inherit'] },
  );
}

function buildDidactaAppUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = 'didacta_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

describeWithDb('Protección de vídeo — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  /** El PrismaService de la app: extensión de RLS + `$transaction` con GUC. */
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let access: VideoAccessService;
  let config: VideoProtectionConfigService;
  let tenantA: string;
  let tenantB: string;
  let lessonSharedA: string;
  const alumnoA = () => ({ tenantId: tenantA, userId: randomUUID(), roles: ['alumno'] });
  const alumnoB = () => ({ tenantId: tenantB, userId: randomUUID(), roles: ['alumno'] });

  async function seedCourse(
    tenantId: string,
    opts: {
      status?: 'DRAFT' | 'PUBLISHED';
      featuredVideoUrl?: string;
      lessons: Array<{ type: 'VIDEO' | 'HTML'; content: Record<string, unknown> }>;
    },
  ): Promise<string[]> {
    const courseId = randomUUID();
    const moduleId = randomUUID();
    await admin.modCoursesCourse.create({
      data: {
        id: courseId,
        tenantId,
        slug: `curso-${courseId.slice(0, 8)}`,
        title: 'Curso de prueba',
        status: opts.status ?? 'PUBLISHED',
        featuredVideoUrl: opts.featuredVideoUrl ?? null,
      },
    });
    await admin.modCoursesModule.create({
      data: { id: moduleId, tenantId, courseId, title: 'Módulo', position: 0 },
    });
    const ids: string[] = [];
    for (const [position, lesson] of opts.lessons.entries()) {
      const id = randomUUID();
      ids.push(id);
      await admin.modCoursesLesson.create({
        data: {
          id,
          tenantId,
          moduleId,
          type: lesson.type,
          title: `Lección ${position + 1}`,
          position,
          content: lesson.content as never,
        },
      });
    }
    return ids;
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();
    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(
      `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
    );

    // PrismaService lee DATABASE_URL al construirse: se le da la de didacta_app
    // solo durante el arranque del módulo y se restaura después.
    const previousUrl = process.env['DATABASE_URL'];
    const previousMode = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = buildDidactaAppUrl(ADMIN_DATABASE_URL!);
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousMode;
    }

    const stamp = Date.now();
    tenantA = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `video-a-${stamp}`, name: 'Academia A (vídeo)' },
      })
    ).id;
    tenantB = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `video-b-${stamp}`, name: 'Academia B (vídeo)' },
      })
    ).id;

    // Academia A: un curso publicado con el vídeo compartido en una lección de
    // vídeo y otro incrustado a mano en una lección HTML; un curso con vídeo
    // destacado; y un curso en borrador.
    const lessonsA = await seedCourse(tenantA, {
      lessons: [
        { type: 'VIDEO', content: { videoUrl: embed(LIB_A, GUID_SHARED) } },
        {
          type: 'HTML',
          content: {
            // El GUID en MAYÚSCULAS a propósito: la búsqueda no distingue.
            html: `<p>Mira</p><iframe src="${embed(LIB_A, GUID_HTML_A.toUpperCase())}?autoplay=false"></iframe>`,
          },
        },
      ],
    });
    lessonSharedA = lessonsA[0]!;
    await seedCourse(tenantA, {
      featuredVideoUrl: embed(LIB_FEATURED, GUID_FEATURED_A),
      lessons: [],
    });
    await seedCourse(tenantA, {
      status: 'DRAFT',
      lessons: [{ type: 'VIDEO', content: { videoUrl: embed(LIB_A, GUID_DRAFT_A) } }],
    });
    // Academia B: el MISMO vídeo compartido y otro que solo tiene ella.
    await seedCourse(tenantB, {
      lessons: [
        { type: 'VIDEO', content: { videoUrl: embed(LIB_A, GUID_SHARED) } },
        { type: 'VIDEO', content: { videoUrl: embed(LIB_B, GUID_ONLY_B) } },
      ],
    });

    // El servicio de matrículas contesta «matriculado, sin drip» a TODO: así
    // lo único que puede negar un vídeo es que la lección no se encuentre.
    const learning = {
      hasActiveEnrollment: async () => true,
      getCourseAvailability: async () => ({ drip: false, lessons: {} }),
    };
    access = new VideoAccessService(prisma, { getLearningService: () => learning } as never);
    const tenantConfig = new PrismaTenantConfigService(
      prisma,
      new SecretCipherService(randomBytes(32).toString('hex')),
      new PrismaAuditLogService(prisma),
    );
    config = new VideoProtectionConfigService(tenantConfig, prisma);
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      if (!tenantId) continue;
      await admin.modCoursesLesson.deleteMany({ where: { tenantId } });
      await admin.modCoursesModule.deleteMany({ where: { tenantId } });
      await admin.modCoursesCourse.deleteMany({ where: { tenantId } });
      await admin.tenantSetting.deleteMany({ where: { tenantId } });
      await admin.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ─────────────────────────── acceso por vídeo ───────────────────────────

  it('el alumno de la academia ve el vídeo de su lección (la consulta cruda encuentra el GUID en el jsonb)', async () => {
    const viewer = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(viewer, GUID_SHARED))).toBe(true);
  });

  it('encuentra un vídeo incrustado a mano en una lección HTML, sin distinguir mayúsculas', async () => {
    const viewer = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(viewer, GUID_HTML_A))).toBe(true);
  });

  it('el vídeo destacado de un curso publicado se sirve a cualquiera de la academia', async () => {
    const viewer = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(viewer, GUID_FEATURED_A))).toBe(true);
  });

  it('un curso en borrador no da acceso a su vídeo', async () => {
    const viewer = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(viewer, GUID_DRAFT_A))).toBe(false);
  });

  it('un GUID que no está en ninguna lección → no', async () => {
    const viewer = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(viewer, randomUUID()))).toBe(false);
  });

  it('AISLAMIENTO: el alumno de A no ve un vídeo que solo está en una lección de B', async () => {
    const a = alumnoA();
    expect(await runAsTenant(tenantA, () => access.canPlay(a, GUID_ONLY_B))).toBe(false);
    // CONTROL: el dato existe y la misma consulta lo encuentra desde B.
    const b = alumnoB();
    expect(await runAsTenant(tenantB, () => access.canPlay(b, GUID_ONLY_B))).toBe(true);
  });

  it('AISLAMIENTO: el vídeo destacado de A no es escaparate para la academia B', async () => {
    const b = alumnoB();
    expect(await runAsTenant(tenantB, () => access.canPlay(b, GUID_FEATURED_A))).toBe(false);
  });

  it('AISLAMIENTO: pedir en nombre de otro tenant desde un contexto ajeno no encuentra nada', async () => {
    // Contexto de la academia A, pero el viewer dice ser de B: el filtro por
    // tenant_id pide las filas de B y RLS (contexto A) no las deja pasar.
    const b = alumnoB();
    expect(await runAsTenant(tenantA, () => access.canPlay(b, GUID_ONLY_B))).toBe(false);
  });

  it('CONTROL de RLS: sin contexto de tenant esta conexión no ve ni una lección', async () => {
    // Si esta conexión se saltase RLS (un superusuario), los tests de
    // aislamiento de arriba pasarían solo por el `WHERE tenant_id`. Aquí se ve
    // que no: sin `app.current_tenant_id` no sale nada, ni pidiéndolo por id.
    const viewer = alumnoA();
    expect(await access.canPlay(viewer, GUID_SHARED)).toBe(false);
    expect(await prisma.modCoursesLesson.findMany({ where: { id: lessonSharedA } })).toHaveLength(
      0,
    );
    const seen = await runAsTenant(tenantA, () =>
      prisma.modCoursesLesson.findMany({ where: { id: lessonSharedA } }),
    );
    expect(seen).toHaveLength(1);
  });

  // ─────────────────────── configuración por tenant ───────────────────────

  it('lista las librerías de Bunny de CADA academia, solo las suyas', async () => {
    const a = await runAsTenant(tenantA, () => config.status(tenantA));
    expect(a.libraries.map((l) => l.libraryId)).toEqual([LIB_A, LIB_FEATURED]);
    expect(a.libraries.every((l) => l.inUse && !l.configured)).toBe(true);
    expect(a.active).toBe(false);

    const b = await runAsTenant(tenantB, () => config.status(tenantB));
    expect(b.libraries.map((l) => l.libraryId)).toEqual([LIB_A, LIB_B]);
  });

  it('el vídeo de muestra para comprobar la firma sale de la propia academia', async () => {
    expect(await runAsTenant(tenantB, () => config.findSampleVideo(tenantB, LIB_B))).toBe(
      GUID_ONLY_B,
    );
    expect(await runAsTenant(tenantA, () => config.findSampleVideo(tenantA, LIB_FEATURED))).toBe(
      GUID_FEATURED_A,
    );
    // La librería LIB_B solo la usa B: A no tiene con qué probarla.
    expect(await runAsTenant(tenantA, () => config.findSampleVideo(tenantA, LIB_B))).toBeNull();
  });

  it('la clave se guarda CIFRADA y solo existe para la academia que la guardó', async () => {
    const adminA = randomUUID();
    await runAsTenant(tenantA, () => config.setTokenKey(tenantA, adminA, LIB_A, TOKEN_KEY));

    const a = await runAsTenant(tenantA, () => config.resolveLibrary(tenantA, LIB_A));
    expect(a).toMatchObject({ active: true, tokenKey: TOKEN_KEY });

    // B usa la MISMA librería en sus lecciones y aun así no hereda la clave.
    const b = await runAsTenant(tenantB, () => config.resolveLibrary(tenantB, LIB_A));
    expect(b).toMatchObject({ active: false, tokenKey: null });
    const statusB = await runAsTenant(tenantB, () => config.status(tenantB));
    expect(statusB.libraries.find((l) => l.libraryId === LIB_A)?.configured).toBe(false);

    // En disco: una sola fila, de A, cifrada y sin la clave en claro.
    const rows = await admin.tenantSetting.findMany({
      where: { moduleName: VIDEO_PROTECTION_SCOPE, key: BUNNY_KEYS_SETTING },
    });
    const own = rows.filter((r) => r.tenantId === tenantA || r.tenantId === tenantB);
    expect(own).toHaveLength(1);
    expect(own[0]!.tenantId).toBe(tenantA);
    expect(own[0]!.isSecret).toBe(true);
    expect(own[0]!.valueJson).toBeNull();
    expect(Buffer.from(own[0]!.valueCipher!).includes(Buffer.from(TOKEN_KEY))).toBe(false);
  });

  it('AISLAMIENTO: desde el contexto de B no se puede leer la fila de la clave de A', async () => {
    const seenByB = await runAsTenant(tenantB, () =>
      prisma.tenantSetting.findMany({
        where: { tenantId: tenantA, moduleName: VIDEO_PROTECTION_SCOPE },
      }),
    );
    expect(seenByB).toHaveLength(0);
    // CONTROL: desde A sí está.
    const seenByA = await runAsTenant(tenantA, () =>
      prisma.tenantSetting.findMany({
        where: { tenantId: tenantA, moduleName: VIDEO_PROTECTION_SCOPE, key: BUNNY_KEYS_SETTING },
      }),
    );
    expect(seenByA).toHaveLength(1);
  });
});
