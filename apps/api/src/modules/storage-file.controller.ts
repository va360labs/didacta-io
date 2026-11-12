/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalDiskStorageService } from './local-disk-storage.service';
import { isPublicStorageKey } from './public-storage-keys';

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
 * y no pasan por aquí.
 *
 * ⚠️ Público NO es «todo lo que haya bajo el root». Solo se sirve lo que está
 * en la lista blanca de `public-storage-keys.ts`; el resto responde 404 exista
 * o no. Antes bastaba con que la key no hiciera traversal, y bajo el root vivía
 * la clave maestra de cifrado: `GET /storage/file/.didacta-secret-key` la
 * devolvía. La lista se comprueba ANTES de tocar el disco, y el adaptador
 * rechaza por su cuenta cualquier segmento oculto.
 *
 * Ruta: `GET /api/v1/storage/file/<key>` (público, sin guard).
 */
@ApiTags('Storage')
@Controller('storage/file')
export class StorageFileController {
  private readonly storage = new LocalDiskStorageService();

  @Get('*')
  // `sandbox` sin permisos: si alguien navega directamente a un fichero subido
  // (p.ej. un SVG con <script>), el documento no puede ejecutar JS ni tocar el
  // origen — mata el XSS almacenado same-origin. No afecta a `<img src>` ni a
  // las descargas; solo a abrir el fichero como página.
  @Header('Content-Security-Policy', 'sandbox')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Sirve un fichero del storage local por su key (público).' })
  async serve(@Param('*') keyPath: string): Promise<StreamableFile> {
    // Mismo 404 para «no existe» y para «no se sirve»: no se confirma a nadie
    // qué hay en el disco.
    if (!isPublicStorageKey(keyPath)) {
      throw new NotFoundException({
        message: 'Fichero no encontrado.',
        code: 'STORAGE_FILE_NOT_FOUND',
      });
    }
    let buffer: Buffer;
    try {
      buffer = await this.storage.download(keyPath);
    } catch {
      throw new NotFoundException({
        message: 'Fichero no encontrado.',
        code: 'STORAGE_FILE_NOT_FOUND',
      });
    }
    const ext = keyPath.split('.').pop()?.toLowerCase() ?? '';
    const type = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return new StreamableFile(buffer, { type, disposition: 'inline' });
  }
}
