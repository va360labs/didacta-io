/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { ModuleContextFactory } from './module-context.factory';
import { detectRasterContentType, optimizeImage, swapExtension } from './image-optimizer';

const UPLOAD_ROLES = new Set(['super_admin', 'tenant_admin', 'formador', 'alumno']);

/** Reoptimizar imágenes existentes es una acción de gestión: no la abre a alumnos. */
const OPTIMIZE_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

/** Marcador de las URLs que sirve el storage local (`StorageFileController`). */
const LOCAL_FILE_MARKER = '/api/v1/storage/file/';

/**
 * Extrae la storage key de una URL servida por el storage local. Devuelve null
 * si la URL no apunta a nuestro storage (p.ej. un CDN externo o una imagen que
 * el usuario pegó a mano) — en ese caso no podemos reprocesarla. Solo leemos de
 * nuestro propio adapter, así que no hay riesgo de SSRF.
 */
function extractLocalStorageKey(url: string): string | null {
  const idx = url.indexOf(LOCAL_FILE_MARKER);
  if (idx === -1) return null;
  let key = url.slice(idx + LOCAL_FILE_MARKER.length);
  key = key.split('?')[0]!.split('#')[0]!;
  try {
    key = decodeURIComponent(key);
  } catch {
    // Si el decode falla dejamos la key tal cual; el adapter la saneará.
  }
  return key || null;
}

/**
 * Tipos MIME admitidos para subir: imágenes + documentos ofimáticos (Word, Excel,
 * PowerPoint) + PDF + texto + comprimidos ZIP. Fuente ÚNICA para el Set de validación
 * y el enum de Zod (antes estaban duplicados y se desincronizaban). Incluye las dos
 * variantes de ZIP porque Windows reporta `application/x-zip-compressed`.
 */
const UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.ms-powerpoint', // ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/zip',
  'application/x-zip-compressed', // zip (Windows)
  'text/plain',
  'text/csv',
  'application/json', // workflows exportados (n8n, Make…) — mod.resources
] as const;

const ALLOWED_MIME = new Set<string>(UPLOAD_MIME_TYPES);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_BASE64_BYTES = Math.ceil(MAX_BYTES * 1.4); // ~14 MiB en base64

/**
 * Ajustes de optimización de imágenes. Las imágenes raster se optimizan por
 * defecto (se recomprimen a WebP y se redimensionan) salvo `enabled: false`.
 * Documentos y SVG nunca se tocan.
 */
const optimizeOptsSchema = z.object({
  enabled: z.boolean().optional(),
  maxWidth: z.number().int().min(64).max(4096).optional(),
  quality: z.number().int().min(40).max(95).optional(),
});

const uploadSchema = z.object({
  /** Archivo codificado en base64 (sin el prefijo `data:...,`). */
  data: z.string().min(1).max(MAX_BASE64_BYTES),
  filename: z.string().trim().min(1).max(200),
  contentType: z.enum(UPLOAD_MIME_TYPES),
  optimize: optimizeOptsSchema.optional(),
});

type UploadDto = z.infer<typeof uploadSchema>;

/** Reoptimiza una imagen ya subida (identificada por su URL de storage). */
const optimizeExistingSchema = z.object({
  url: z.string().url(),
  maxWidth: z.number().int().min(64).max(4096).optional(),
  quality: z.number().int().min(40).max(95).optional(),
});

type OptimizeExistingDto = z.infer<typeof optimizeExistingSchema>;

/**
 * Endpoint genérico de upload de archivos (imágenes y documentos).
 * Lo usa el editor Tiptap para imágenes inline y el compositor de posts
 * de comunidad para adjuntar imágenes y documentos.
 * Devuelve una URL servida por el reverse-proxy (storage local) o
 * pre-firmada (S3) para usar en `<img src>` o como enlace de descarga.
 *
 * Permisos: cualquier usuario autenticado con rol válido (alumno incluido).
 */
@ApiTags('Storage')
@ApiBearerAuth()
@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly factory: ModuleContextFactory) {}

  @Post('upload')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sube un archivo (imagen o documento, max 10 MB) al storage del tenant y devuelve la URL.',
  })
  async upload(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(uploadSchema)) dto: UploadDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => UPLOAD_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Necesitas estar autenticado con un rol válido para subir archivos.',
        code: 'STORAGE_UPLOAD_ROLE_REQUIRED',
      });
    }
    if (!ALLOWED_MIME.has(dto.contentType)) {
      throw new ForbiddenException({
        message: 'Tipo MIME no permitido.',
        code: 'STORAGE_MIME_NOT_ALLOWED',
      });
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(dto.data, 'base64');
    } catch {
      throw new ForbiddenException({
        message: 'Base64 inválido.',
        code: 'STORAGE_INVALID_BASE64',
      });
    }
    if (buffer.length === 0 || buffer.length > MAX_BYTES) {
      throw new ForbiddenException({
        message: `El archivo debe pesar entre 1 byte y ${MAX_BYTES} bytes.`,
        code: 'STORAGE_FILE_SIZE_OUT_OF_RANGE',
      });
    }

    // Normalizamos el filename para evitar traversal y caracteres
    // raros, conservando solo el sufijo de extensión.
    const safeName = dto.filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

    const requestedKey = `tenants/${user.tenantId}/uploads/${Date.now()}-${safeName || 'image'}`;

    // Adapter per-tenant: si el tenant configuró storage S3 propio en
    // /admin/configuracion, usamos su bucket. Si no, fallback al adapter
    // global (env STORAGE_DRIVER) — compat con tenants que no migraron.
    const storage = await this.factory.getStorageForTenant(user.tenantId);

    // `uploadImage` recomprime a WebP y redimensiona; documentos y SVG pasan
    // intactos porque el propio core los detecta como no optimizables. La única
    // vía para guardar una imagen raster tal cual es pedirlo explícitamente con
    // `optimize.enabled=false` (p. ej. una captura que se va a comparar píxel a
    // píxel), y entonces bajamos al `upload` crudo.
    if (dto.optimize?.enabled === false) {
      await storage.upload(requestedKey, buffer, dto.contentType);
      const rawUrl = await storage.getSignedUrl(requestedKey);
      return {
        key: requestedKey,
        url: rawUrl,
        contentType: dto.contentType,
        size: buffer.length,
        optimized: false,
      };
    }

    const stored = await storage.uploadImage(requestedKey, buffer, dto.contentType, {
      ...(dto.optimize?.maxWidth !== undefined ? { maxWidth: dto.optimize.maxWidth } : {}),
      ...(dto.optimize?.quality !== undefined ? { quality: dto.optimize.quality } : {}),
    });
    const url = await storage.getSignedUrl(stored.key);

    return {
      key: stored.key,
      url,
      contentType: stored.contentType,
      size: stored.size,
      previousSize: stored.previousSize,
      optimized: stored.optimized,
    };
  }

  @Post('optimize')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Reoptimiza una imagen ya subida (recomprime a WebP y redimensiona) y devuelve la nueva URL.',
  })
  async optimizeExisting(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(optimizeExistingSchema)) dto: OptimizeExistingDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => OPTIMIZE_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'No tienes permiso para optimizar imágenes.',
        code: 'STORAGE_OPTIMIZE_FORBIDDEN',
      });
    }

    const key = extractLocalStorageKey(dto.url);
    if (!key) {
      throw new BadRequestException({
        message: 'La imagen no está alojada en el storage de Didacta; no se puede optimizar.',
        code: 'STORAGE_NOT_DIDACTA_HOSTED',
      });
    }
    // Aislamiento de tenant: solo se puede reprocesar lo que vive bajo el
    // prefijo del propio tenant.
    if (!key.startsWith(`tenants/${user.tenantId}/`)) {
      throw new ForbiddenException({
        message: 'La imagen pertenece a otro tenant.',
        code: 'STORAGE_IMAGE_OTHER_TENANT',
      });
    }

    const storage = await this.factory.getStorageForTenant(user.tenantId);
    let original: Buffer;
    try {
      original = await storage.download(key);
    } catch {
      throw new NotFoundException({
        message: 'No pudimos leer la imagen original.',
        code: 'STORAGE_ORIGINAL_UNREADABLE',
      });
    }

    const contentType = await detectRasterContentType(original);
    if (!contentType) {
      // No es una imagen raster que sepamos optimizar (SVG, corrupta, etc.).
      return {
        url: dto.url,
        contentType: null,
        size: original.length,
        previousSize: original.length,
        optimized: false,
      };
    }

    // Aquí NO usamos `storage.uploadImage`: ese escribe siempre, y en un
    // reproceso la imagen ya puede estar óptima. Comprimimos primero y solo
    // tocamos el storage si hubo ganancia real — si no, dejaríamos un duplicado
    // huérfano por cada pasada del reoptimizador.
    const optimized = await optimizeImage(original, contentType, {
      ...(dto.maxWidth !== undefined ? { maxWidth: dto.maxWidth } : {}),
      ...(dto.quality !== undefined ? { quality: dto.quality } : {}),
    });
    if (!optimized.optimized) {
      return {
        url: dto.url,
        contentType,
        size: original.length,
        previousSize: original.length,
        optimized: false,
      };
    }

    // Subimos bajo una key nueva. NO borramos la original: sigue referenciada
    // por el recurso (curso, avatar, portada…) hasta que el caller persista la
    // nueva URL; borrarla aquí dejaría la imagen rota si el guardado falla.
    const base = (key.split('/').pop() ?? 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const newKey = swapExtension(
      `tenants/${user.tenantId}/uploads/${Date.now()}-${base || 'image'}`,
      optimized.extension,
    );
    await storage.upload(newKey, optimized.buffer, optimized.contentType);
    const url = await storage.getSignedUrl(newKey);

    return {
      url,
      contentType: optimized.contentType,
      size: optimized.buffer.length,
      previousSize: original.length,
      optimized: true,
      width: optimized.width,
      height: optimized.height,
    };
  }
}
