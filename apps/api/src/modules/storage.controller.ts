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
import {
  detectRasterContentType,
  isOptimizableImage,
  optimizeImage,
  swapExtension,
} from './image-optimizer';

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
      throw new ForbiddenException(
        'Necesitas estar autenticado con un rol válido para subir archivos.',
      );
    }
    if (!ALLOWED_MIME.has(dto.contentType)) {
      throw new ForbiddenException('Tipo MIME no permitido.');
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(dto.data, 'base64');
    } catch {
      throw new ForbiddenException('Base64 inválido.');
    }
    if (buffer.length === 0 || buffer.length > MAX_BYTES) {
      throw new ForbiddenException(`El archivo debe pesar entre 1 byte y ${MAX_BYTES} bytes.`);
    }

    // Normalizamos el filename para evitar traversal y caracteres
    // raros, conservando solo el sufijo de extensión.
    let safeName = dto.filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

    // Auto-optimización de imágenes raster: se recomprimen a WebP y se
    // redimensionan para servirlas ligeras. Activada por defecto; el caller
    // puede afinar el ancho/calidad o desactivarla con `optimize.enabled=false`.
    // Documentos y SVG no son optimizables → pasan intactos.
    let outBuffer = buffer;
    let outContentType: string = dto.contentType;
    if (dto.optimize?.enabled !== false && isOptimizableImage(dto.contentType)) {
      const optimized = await optimizeImage(buffer, dto.contentType, {
        maxWidth: dto.optimize?.maxWidth,
        quality: dto.optimize?.quality,
      });
      if (optimized.optimized) {
        outBuffer = optimized.buffer;
        outContentType = optimized.contentType;
        safeName = swapExtension(safeName || 'image', optimized.extension);
      }
    }

    const key = `tenants/${user.tenantId}/uploads/${Date.now()}-${safeName || 'image'}`;

    // Adapter per-tenant: si el tenant configuró storage S3 propio en
    // /admin/configuracion, usamos su bucket. Si no, fallback al adapter
    // global (env STORAGE_DRIVER) — compat con tenants que no migraron.
    const storage = await this.factory.getStorageForTenant(user.tenantId);
    await storage.upload(key, outBuffer, outContentType);
    const url = await storage.getSignedUrl(key);

    return { key, url, contentType: outContentType, size: outBuffer.length };
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
      throw new ForbiddenException('No tienes permiso para optimizar imágenes.');
    }

    const key = extractLocalStorageKey(dto.url);
    if (!key) {
      throw new BadRequestException(
        'La imagen no está alojada en el storage de Didacta; no se puede optimizar.',
      );
    }
    // Aislamiento de tenant: solo se puede reprocesar lo que vive bajo el
    // prefijo del propio tenant.
    if (!key.startsWith(`tenants/${user.tenantId}/`)) {
      throw new ForbiddenException('La imagen pertenece a otro tenant.');
    }

    const storage = await this.factory.getStorageForTenant(user.tenantId);
    let original: Buffer;
    try {
      original = await storage.download(key);
    } catch {
      throw new NotFoundException('No pudimos leer la imagen original.');
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

    const optimized = await optimizeImage(original, contentType, {
      maxWidth: dto.maxWidth,
      quality: dto.quality,
    });
    if (!optimized.optimized) {
      // Ya estaba óptima: no reescribimos nada.
      return {
        url: dto.url,
        contentType,
        size: original.length,
        previousSize: original.length,
        optimized: false,
      };
    }

    // Subimos bajo una key nueva. NO borramos la original: sigue referenciada
    // por el recurso (curso) hasta que el caller persista la nueva URL; borrarla
    // aquí dejaría la imagen rota si el guardado posterior falla.
    const base = key.split('/').pop() ?? 'image';
    const safeBase = swapExtension(
      base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'image',
      optimized.extension,
    );
    const newKey = `tenants/${user.tenantId}/uploads/${Date.now()}-${safeBase}`;
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
