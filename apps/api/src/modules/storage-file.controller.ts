import { Controller, Get, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalDiskStorageService } from './local-disk-storage.service';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

/**
 * Sirve los ficheros del storage LOCAL (driver `local`) de forma pública para
 * que puedan cargarse en `<img src>` (los navegadores no envían el bearer en
 * imágenes). Solo aplica al storage en disco; con S3 las URLs son pre-firmadas
 * y no pasan por aquí. La key se sanea en `LocalDiskStorageService` (sin
 * traversal, dentro del root), así que solo se exponen ficheros bajo el root.
 *
 * Ruta: `GET /api/v1/storage/file/<key>` (público, sin guard).
 */
@ApiTags('Storage')
@Controller('storage/file')
export class StorageFileController {
  private readonly storage = new LocalDiskStorageService();

  @Get('*')
  @ApiOperation({ summary: 'Sirve un fichero del storage local por su key (público).' })
  async serve(@Param('*') keyPath: string): Promise<StreamableFile> {
    let buffer: Buffer;
    try {
      buffer = await this.storage.download(keyPath);
    } catch {
      throw new NotFoundException('Fichero no encontrado.');
    }
    const ext = keyPath.split('.').pop()?.toLowerCase() ?? '';
    const type = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return new StreamableFile(buffer, { type, disposition: 'inline' });
  }
}
