import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
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

const UPLOAD_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_BASE64_BYTES = Math.ceil(MAX_BYTES * 1.4); // ~7 MiB en base64

const uploadSchema = z.object({
  /** Imagen codificada en base64 (sin el prefijo `data:...,`). */
  data: z.string().min(1).max(MAX_BASE64_BYTES),
  filename: z.string().trim().min(1).max(200),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']),
});

type UploadDto = z.infer<typeof uploadSchema>;

/**
 * Endpoint genérico de upload de imágenes. Lo usa, por ejemplo, el
 * editor enriquecido de Tiptap para insertar imágenes inline en la
 * descripción del curso. Devuelve una URL servida por el reverse-proxy
 * (storage local) o pre-firmada (S3) para el `<img src>`.
 *
 * Permisos: super_admin / tenant_admin / formador. El alumno no debería
 * subir contenido al storage del tenant directamente — sus aportes
 * (comentarios) van como texto plano.
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
      'Sube una imagen (PNG/JPG/WebP/GIF/SVG, max 5 MB) al storage del tenant y devuelve la URL.',
  })
  async upload(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(uploadSchema)) dto: UploadDto,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => UPLOAD_ROLES.has(r))) {
      throw new ForbiddenException('Solo formadores y admins pueden subir imágenes.');
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
      throw new ForbiddenException(`La imagen debe pesar entre 1 byte y ${MAX_BYTES} bytes.`);
    }

    // Normalizamos el filename para evitar traversal y caracteres
    // raros, conservando solo el sufijo de extensión.
    const safeName = dto.filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    const key = `tenants/${user.tenantId}/uploads/${Date.now()}-${safeName || 'image'}`;

    // Adapter per-tenant: si el tenant configuró storage S3 propio en
    // /admin/configuracion, usamos su bucket. Si no, fallback al adapter
    // global (env STORAGE_DRIVER) — compat con tenants que no migraron.
    const storage = await this.factory.getStorageForTenant(user.tenantId);
    await storage.upload(key, buffer, dto.contentType);
    const url = await storage.getSignedUrl(key);

    return { key, url, contentType: dto.contentType, size: buffer.length };
  }
}
