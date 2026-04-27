import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  ScormLessonTypeMismatchError,
  ScormPackageInvalidError,
  ScormPackageNotFoundError,
} from './errors.js';
import { parseScormManifest, ScormManifestError } from './scorm-parser.js';

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024; // 100 MiB descomprimido
const MAX_FILE_COUNT = 5_000;

export interface ScormPackageMetadata {
  id: string;
  lessonId: string;
  version: '1.2' | '2004';
  entryPath: string;
  storagePrefix: string;
  size: number;
  uploadedAt: string;
}

export interface ScormUploadInput {
  /** Buffer crudo del archivo .zip subido. */
  zipData: Buffer;
  /** Filename original (solo para audit log). */
  filename: string;
}

export class ScormService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  /**
   * Sube un paquete SCORM para una lección. Reemplaza el paquete previo si
   * existe (rota el storagePrefix). Idempotente: si subís el mismo zip dos
   * veces, el segundo upload sobrescribe.
   */
  async uploadPackage(
    tenantId: string,
    lessonId: string,
    actorId: string | null,
    input: ScormUploadInput,
  ): Promise<ScormPackageMetadata> {
    await this.ensureLessonIsScorm(tenantId, lessonId);

    let zip: AdmZip;
    try {
      zip = new AdmZip(input.zipData);
    } catch (err) {
      throw new ScormPackageInvalidError(`No se pudo abrir el ZIP: ${(err as Error).message}`);
    }

    const entries = zip.getEntries();
    if (entries.length === 0) {
      throw new ScormPackageInvalidError('El ZIP está vacío');
    }
    if (entries.length > MAX_FILE_COUNT) {
      throw new ScormPackageInvalidError(
        `El paquete contiene más de ${MAX_FILE_COUNT} archivos (límite anti-zip-bomb)`,
      );
    }

    const manifestEntry = entries.find(
      (e) =>
        !e.isDirectory && e.entryName.replace(/\\/g, '/').toLowerCase().endsWith('imsmanifest.xml'),
    );
    if (!manifestEntry) {
      throw new ScormPackageInvalidError('El ZIP no contiene imsmanifest.xml');
    }

    let manifest;
    try {
      manifest = parseScormManifest(manifestEntry.getData().toString('utf-8'));
    } catch (err) {
      if (err instanceof ScormManifestError) {
        throw new ScormPackageInvalidError(`${err.code}: ${err.message}`);
      }
      throw err;
    }

    const packageId = randomUUID();
    const storagePrefix = `scorm/${tenantId}/${packageId}/`;

    let totalSize = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const relPath = entry.entryName.replace(/\\/g, '/');
      const data = entry.getData();
      totalSize += data.length;
      if (totalSize > MAX_PACKAGE_BYTES) {
        throw new ScormPackageInvalidError(
          `Paquete excede ${MAX_PACKAGE_BYTES / (1024 * 1024)} MiB descomprimido`,
        );
      }
      const key = `${storagePrefix}${relPath}`;
      const contentType = guessContentType(relPath);
      await this.ctx.storage.upload(key, data, contentType);
    }

    // Si hay un paquete previo, marcamos sus assets para limpieza posterior
    // (no los borramos ahora — el GC del storage puede hacerlo en background).
    const previous = await this.prisma.modLearningScormPackage.findUnique({
      where: { lessonId },
    });

    const persisted = await this.prisma.modLearningScormPackage.upsert({
      where: { lessonId },
      update: {
        version: manifest.version,
        entryPath: manifest.entryPath,
        storagePrefix,
        manifest: { organizations: manifest.organizations } as never,
        size: totalSize,
        uploadedById: actorId,
      },
      create: {
        id: packageId,
        tenantId,
        lessonId,
        version: manifest.version,
        entryPath: manifest.entryPath,
        storagePrefix,
        manifest: { organizations: manifest.organizations } as never,
        size: totalSize,
        uploadedById: actorId,
      },
    });

    await this.ctx.auditLog.record({
      tenantId,
      actorId,
      action: 'scorm.package.uploaded',
      resourceType: 'scorm_package',
      resourceId: persisted.id,
      metadata: {
        lessonId,
        filename: input.filename,
        version: manifest.version,
        entryPath: manifest.entryPath,
        size: totalSize,
        replacedPreviousPackageId: previous?.id ?? null,
      },
    });

    return this.toMetadata(persisted);
  }

  /**
   * Devuelve metadata + signed URL del entryPath para que el player lo cargue.
   */
  async getPackage(
    tenantId: string,
    lessonId: string,
  ): Promise<ScormPackageMetadata & { entrySignedUrl: string }> {
    const pkg = await this.prisma.modLearningScormPackage.findUnique({
      where: { lessonId },
    });
    if (!pkg || pkg.tenantId !== tenantId) {
      throw new ScormPackageNotFoundError();
    }
    const entryKey = `${pkg.storagePrefix}${pkg.entryPath}`;
    const entrySignedUrl = await this.ctx.storage.getSignedUrl(entryKey, 60 * 60); // 1 h
    return { ...this.toMetadata(pkg), entrySignedUrl };
  }

  private async ensureLessonIsScorm(tenantId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.modCoursesLesson.findFirst({
      where: { tenantId, id: lessonId, deletedAt: null },
    });
    if (!lesson) {
      throw new ScormPackageInvalidError('Lección no encontrada');
    }
    if (lesson.type !== 'SCORM') {
      throw new ScormLessonTypeMismatchError();
    }
  }

  private toMetadata(row: {
    id: string;
    lessonId: string;
    version: string;
    entryPath: string;
    storagePrefix: string;
    size: number;
    uploadedAt: Date;
  }): ScormPackageMetadata {
    return {
      id: row.id,
      lessonId: row.lessonId,
      version: row.version as '1.2' | '2004',
      entryPath: row.entryPath,
      storagePrefix: row.storagePrefix,
      size: row.size,
      uploadedAt: row.uploadedAt.toISOString(),
    };
  }
}

function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'js':
      return 'application/javascript; charset=utf-8';
    case 'json':
      return 'application/json';
    case 'xml':
      return 'application/xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'pdf':
      return 'application/pdf';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}
