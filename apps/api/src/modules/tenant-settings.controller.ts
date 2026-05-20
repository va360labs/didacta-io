import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { ModuleContextFactory } from './module-context.factory';
import { PrismaService } from '../prisma/prisma.service';
import { mergeSecretFields, redactSensitiveFields } from './redact-sensitive-fields';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const ScopeKeyParamSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9._-]+$/i, 'Solo letras, números, ".", "_", "-"');

const SetSettingBodySchema = z.object({
  value: z.unknown(),
  isSecret: z.boolean().default(false),
});

function requireAdmin(user: SessionClaims | undefined) {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
  if (!isAdmin) {
    throw new ForbiddenException('Solo super_admin o tenant_admin pueden gestionar settings');
  }
  return user;
}

function validateParam(name: string, value: string) {
  const r = ScopeKeyParamSchema.safeParse(value);
  if (!r.success) {
    throw new NotFoundException(`Parámetro ${name} inválido`);
  }
  return r.data;
}


@ApiTags('Tenant Settings')
@ApiBearerAuth()
@Controller('tenant-settings')
@UseGuards(JwtAuthGuard)
export class TenantSettingsController {
  private readonly logger = new Logger(TenantSettingsController.name);

  constructor(
    private readonly modules: ModuleContextFactory,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Llama a `svc.get(...)` con un guard contra fallos de descifrado. Si el
   * ciphertext en DB fue cifrado con una clave que ya no está disponible
   * (key rotada, ephemeral perdida, env var cambiada), AES-GCM tira
   * "Unsupported state or unable to authenticate data". Atrapamos eso y
   * tratamos como "valor inexistente" para que el endpoint no devuelva 500.
   * El admin puede recuperarse re-tipeando el setting completo (lo nuevo
   * se cifra con la clave actual y desbloquea el path). Ver alpha.70.
   */
  private async safeGetDecrypted(
    tenantId: string,
    scope: string,
    key: string,
  ): Promise<{ value: unknown; decryptFailed: boolean }> {
    const svc = this.modules.getTenantConfig();
    try {
      const value = await svc.get(tenantId, scope, key);
      return { value, decryptFailed: false };
    } catch (err) {
      this.logger.warn(
        `[tenant-settings] decrypt falló para ${scope}/${key} en tenant ${tenantId}: ${(err as Error).message}. ` +
          'Probable causa: la clave que cifró el valor ya no coincide con la actual (ver INFRA-FIX-02). ' +
          'Se devuelve null para permitir recuperación re-tipeando el setting.',
      );
      return { value: null, decryptFailed: true };
    }
  }

  @Get()
  @ApiOperation({
    summary: 'Listar todos los settings del tenant del usuario (metadata sin valores secretos)',
  })
  async listAll(@CurrentUser() user: SessionClaims | undefined) {
    const claims = requireAdmin(user);
    const svc = this.modules.getTenantConfig();
    return svc.list(claims.tenantId);
  }

  @Get(':scope')
  @ApiOperation({ summary: 'Listar settings de un scope (módulo) específico' })
  async listScope(@CurrentUser() user: SessionClaims | undefined, @Param('scope') scope: string) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const svc = this.modules.getTenantConfig();
    return svc.list(claims.tenantId, validScope);
  }

  @Get(':scope/:key')
  @ApiOperation({
    summary:
      'Leer un setting. Para secretos devuelve los campos no sensibles del JSON (host, user, etc.) con los campos credenciales (password, apiKey, token...) redactados como null.',
  })
  async getOne(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();
    const list = await svc.list(claims.tenantId, validScope);
    const meta = list.find((m) => m.key === validKey);
    if (!meta) throw new NotFoundException();
    const { value, decryptFailed } = await this.safeGetDecrypted(
      claims.tenantId,
      validScope,
      validKey,
    );
    if (meta.isSecret) {
      // Para secretos: descifrar y devolver con campos sensibles redactados.
      // Eso permite al frontend hidratar el form mostrando lo que está guardado
      // (host, user, from...) sin exponer credenciales. Ver UI-FIX-02.
      // Si decryptFailed=true, devolvemos value:null para que el form muestre
      // estado limpio (el admin puede re-tipear y reciclar el setting con
      // la clave actual).
      if (!value || typeof value !== 'object') {
        return { ...meta, value: null, decryptFailed };
      }
      return {
        ...meta,
        value: redactSensitiveFields(value as Record<string, unknown>),
        decryptFailed,
      };
    }
    return { ...meta, value: value ?? null };
  }

  @Put(':scope/:key')
  @ApiOperation({ summary: 'Crear o actualizar un setting (cifrado si isSecret=true)' })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(SetSettingBodySchema))
    body: z.infer<typeof SetSettingBodySchema>,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();

    // Para settings cifrados (`isSecret`), aplicamos merge contra el valor
    // previo: campos sensibles vacíos en el body conservan los del previo.
    // Esto permite al admin guardar cambios en host/user/from sin tener que
    // re-tipear la password en cada save. Ver UI-FIX-02 (alpha.69).
    //
    // Si el previo no se puede descifrar (clave rotada), el merge no aplica
    // — guardamos el body tal cual. Esto desbloquea recuperación: el admin
    // re-tipea todo, el backend lo guarda cifrado con la clave actual, y
    // los próximos saves vuelven a funcionar con merge normal. Ver alpha.70.
    let finalValue = body.value;
    if (
      body.isSecret &&
      body.value &&
      typeof body.value === 'object' &&
      !Array.isArray(body.value)
    ) {
      const { value: previous, decryptFailed } = await this.safeGetDecrypted(
        claims.tenantId,
        validScope,
        validKey,
      );
      if (
        !decryptFailed &&
        previous &&
        typeof previous === 'object' &&
        !Array.isArray(previous)
      ) {
        finalValue = mergeSecretFields(
          previous as Record<string, unknown>,
          body.value as Record<string, unknown>,
        );
      }
    }

    await svc.set(claims.tenantId, validScope, validKey, finalValue, {
      isSecret: body.isSecret,
      actorId: claims.sub,
    });
    // Invalida el cache de adapters cacheados por tenant cuya config
    // depende del setting recién modificado. Por ahora sólo storage.
    if (validScope === 'storage') {
      this.modules.invalidateTenantStorage(claims.tenantId);
    }
    return { ok: true };
  }

  @Delete(':scope/:key')
  @ApiOperation({ summary: 'Eliminar un setting' })
  async remove(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('scope') scope: string,
    @Param('key') key: string,
  ) {
    const claims = requireAdmin(user);
    const validScope = validateParam('scope', scope);
    const validKey = validateParam('key', key);
    const svc = this.modules.getTenantConfig();
    await svc.delete(claims.tenantId, validScope, validKey, { actorId: claims.sub });
    if (validScope === 'storage') {
      this.modules.invalidateTenantStorage(claims.tenantId);
    }
    return { ok: true };
  }

  @Post('notifications/smtp/test')
  @ApiOperation({
    summary:
      'Envía un email de prueba al admin actual con la config SMTP guardada del tenant. Útil para validar credenciales antes de poner el sistema a enviar de verdad.',
  })
  async testSmtp(@CurrentUser() user: SessionClaims | undefined) {
    const claims = requireAdmin(user);
    const config = this.modules.getTenantConfig();
    const smtp = this.modules.getSmtpAdapter();

    const raw = await config.get(claims.tenantId, 'notifications', 'smtp');
    if (!raw) {
      throw new BadRequestException('SMTP no configurado para este tenant');
    }

    let parsed;
    try {
      parsed = smtp.parseConfig(raw);
    } catch (err) {
      throw new BadRequestException(
        `Config SMTP inválida: ${(err as Error).message.slice(0, 200)}`,
      );
    }

    const me = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { email: true, tenantId: true },
    });
    if (!me || me.tenantId !== claims.tenantId) {
      throw new BadRequestException('No se pudo resolver tu email del tenant');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: claims.tenantId },
      select: { slug: true },
    });

    const result = await smtp.send(parsed, {
      to: me.email,
      subject: 'Prueba de SMTP — Didacta',
      text: `Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: ${tenant?.slug ?? '(desconocido)'}\nFecha: ${new Date().toISOString()}`,
    });

    if (!result.ok) {
      throw new BadRequestException(`SMTP falló: ${result.error ?? 'sin detalle'}`);
    }
    return { ok: true, sentTo: me.email, messageId: result.messageId };
  }
}
