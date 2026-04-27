import { describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { ScormService } from '../src/scorm.service';

interface LessonRow {
  id: string;
  tenantId: string;
  type: string;
  deletedAt: Date | null;
}

interface PackageRow {
  id: string;
  tenantId: string;
  lessonId: string;
  version: string;
  entryPath: string;
  storagePrefix: string;
  manifest: object;
  size: number;
  uploadedAt: Date;
  uploadedById: string | null;
}

const VALID_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schemaversion>1.2</schemaversion></metadata>
  <resources>
    <resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

function buildScormZip(includeManifest = true): Buffer {
  const zip = new AdmZip();
  if (includeManifest) zip.addFile('imsmanifest.xml', Buffer.from(VALID_MANIFEST, 'utf-8'));
  zip.addFile('index.html', Buffer.from('<html>SCORM content</html>', 'utf-8'));
  zip.addFile('assets/style.css', Buffer.from('body{}', 'utf-8'));
  return zip.toBuffer();
}

function setup(opts: { lessonType?: string; existingPackage?: boolean } = {}) {
  const lessons: LessonRow[] = [
    {
      id: 'lesson-1',
      tenantId: 't1',
      type: opts.lessonType ?? 'SCORM',
      deletedAt: null,
    },
  ];
  const packages: PackageRow[] = opts.existingPackage
    ? [
        {
          id: 'pkg-old',
          tenantId: 't1',
          lessonId: 'lesson-1',
          version: '1.2',
          entryPath: 'old.html',
          storagePrefix: 'scorm/t1/pkg-old/',
          manifest: {},
          size: 100,
          uploadedAt: new Date('2026-04-01'),
          uploadedById: null,
        },
      ]
    : [];

  const uploads: Array<{ key: string; size: number; contentType?: string }> = [];

  const prisma = {
    modCoursesLesson: {
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          lessons.find(
            (l) =>
              l.tenantId === where.tenantId &&
              l.id === where.id &&
              (where.deletedAt === null ? l.deletedAt === null : true),
          ) ?? null
        );
      }),
    },
    modLearningScormPackage: {
      findUnique: vi.fn(async ({ where }: any) => {
        return packages.find((p) => p.lessonId === where.lessonId) ?? null;
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const existing = packages.find((p) => p.lessonId === where.lessonId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: PackageRow = {
          ...create,
          uploadedAt: new Date(),
        };
        packages.push(row);
        return row;
      }),
    },
  } as never;

  const ctx = {
    storage: {
      upload: vi.fn(async (key: string, data: Buffer, contentType?: string) => {
        uploads.push({ key, size: data.length, contentType });
        return { key };
      }),
      download: vi.fn(),
      delete: vi.fn(),
      getSignedUrl: vi.fn(async (key: string) => `https://signed.test/${key}`),
    },
    auditLog: { record: vi.fn() },
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    evidenceVault: {},
    notificationHub: {},
    i18n: { t: (k: string) => k },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({}) },
    config: {},
    hookRegistry: { register: vi.fn(), run: vi.fn() },
  } as never;

  const service = new ScormService(prisma, ctx);
  return { service, prisma, ctx, packages, uploads, lessons };
}

describe('ScormService.uploadPackage', () => {
  it('descomprime el ZIP, parsea manifest y persiste el paquete', async () => {
    const ctx = setup();
    const zipData = buildScormZip();
    const result = await ctx.service.uploadPackage('t1', 'lesson-1', 'user-1', {
      zipData,
      filename: 'pkg.zip',
    });

    expect(result.version).toBe('1.2');
    expect(result.entryPath).toBe('index.html');
    expect(result.storagePrefix).toMatch(/^scorm\/t1\//);
    expect(ctx.packages).toHaveLength(1);

    // Sube los 3 archivos (manifest + index.html + assets/style.css).
    expect(ctx.uploads.length).toBe(3);
    expect(ctx.uploads.some((u) => u.key.endsWith('/index.html'))).toBe(true);
    expect(ctx.uploads.some((u) => u.key.endsWith('/imsmanifest.xml'))).toBe(true);
    expect(ctx.uploads.some((u) => u.key.endsWith('/assets/style.css'))).toBe(true);
  });

  it('lanza SCORM_LESSON_TYPE_MISMATCH si la lección no es SCORM', async () => {
    const ctx = setup({ lessonType: 'TEXT' });
    const zipData = buildScormZip();
    await expect(
      ctx.service.uploadPackage('t1', 'lesson-1', 'u1', { zipData, filename: 'p.zip' }),
    ).rejects.toMatchObject({ code: 'SCORM_LESSON_TYPE_MISMATCH' });
  });

  it('rechaza ZIP sin imsmanifest.xml', async () => {
    const ctx = setup();
    const zipData = buildScormZip(false);
    await expect(
      ctx.service.uploadPackage('t1', 'lesson-1', 'u1', { zipData, filename: 'p.zip' }),
    ).rejects.toMatchObject({ code: 'SCORM_PACKAGE_INVALID' });
  });

  it('rechaza ZIP corrupto', async () => {
    const ctx = setup();
    const zipData = Buffer.from('this is not a zip');
    await expect(
      ctx.service.uploadPackage('t1', 'lesson-1', 'u1', { zipData, filename: 'p.zip' }),
    ).rejects.toMatchObject({ code: 'SCORM_PACKAGE_INVALID' });
  });

  it('reemplaza el paquete previo (upsert)', async () => {
    const ctx = setup({ existingPackage: true });
    const zipData = buildScormZip();
    const result = await ctx.service.uploadPackage('t1', 'lesson-1', 'u1', {
      zipData,
      filename: 'replacement.zip',
    });
    expect(result.entryPath).toBe('index.html');
    expect(ctx.packages).toHaveLength(1);
  });
});

describe('ScormService.getPackage', () => {
  it('devuelve metadata + signed URL del entry', async () => {
    const ctx = setup({ existingPackage: true });
    const result = await ctx.service.getPackage('t1', 'lesson-1');
    expect(result.lessonId).toBe('lesson-1');
    expect(result.entrySignedUrl).toContain('https://signed.test/');
    expect(result.entrySignedUrl).toContain('old.html');
  });

  it('lanza SCORM_PACKAGE_NOT_FOUND si no hay paquete', async () => {
    const ctx = setup();
    await expect(ctx.service.getPackage('t1', 'lesson-1')).rejects.toMatchObject({
      code: 'SCORM_PACKAGE_NOT_FOUND',
    });
  });

  it('lanza SCORM_PACKAGE_NOT_FOUND si el paquete pertenece a otro tenant', async () => {
    const ctx = setup({ existingPackage: true });
    await expect(ctx.service.getPackage('other-tenant', 'lesson-1')).rejects.toMatchObject({
      code: 'SCORM_PACKAGE_NOT_FOUND',
    });
  });
});
