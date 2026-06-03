import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
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
import { ModuleContextFactory } from '../modules/module-context.factory';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Body del PUT /admin/tenant-settings/smtp. `password` opcional: si no se
 * envía o viene vacío, se conserva el password actual del tenant. `secure`
 * opcional: si se omite, nodemailer infiere (port 465 → true, resto → false).
 *
 * `fromName` opcional — se concatena con `fromEmail` como "Name <email>" si
 * está presente. El schema interno del SmtpAdapter sólo guarda el email,
 * así que el name viaja en un campo `fromName` paralelo en el setting.
 */
const SmtpUpsertSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(255),
  password: z.string().max(2048).optional(),
  fromEmail: z.string().email().max(255),
  fromName: z.string().max(255).optional(),
});

const SmtpTestSchema = z.object({
  toEmail: z.string().email(),
});

interface SmtpResponseDto {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  /** True si el tenant tiene config propia; false si solo hereda el fallback global. */
  hasTenantConfig: boolean;
  /** True si el despliegue tiene env globales que sirven de fallback. */
  hasGlobalFallback: boolean;
}

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
  if (!isAdmin) {
    throw new ForbiddenException('Solo super_admin o tenant_admin pueden gestionar SMTP');
  }
  return user;
}

/**
 * Endpoints admin para gestionar SMTP per-tenant. Wrappea el almacenamiento
 * genérico de `tenant_setting` con un contrato dedicado: el frontend trabaja
 * con un DTO plano (host/port/username/...) en lugar de tener que entender
 * el modelo `{moduleName, key, value, isSecret}`.
 *
 * Almacenamiento:
 * - Credenciales: `tenant_setting` scope=`notifications`, key=`smtp`, isSecret=true.
 *   Cifrado AES-256-GCM por `SecretCipherService`.
 * - Metadata de verificación: `tenant_setting` scope=`notifications`,
 *   key=`smtp_meta`, isSecret=false. Sólo guarda `{verifiedAt, verifiedByUserId}`.
 *
 * Por qué dos rows: separa secreto (rotable) de metadata (auditable sin
 * descifrar). Si en el futuro se rota la clave de cifrado, la metadata
 * sigue legible.
 */
@ApiTags('Admin SMTP')
@ApiBearerAuth()
@Controller('admin/tenant-settings/smtp')
@UseGuards(JwtAuthGuard)
export class AdminSmtpController {
  private readonly logger = new Logger(AdminSmtpController.name);

  constructor(
    private readonly modules: ModuleContextFactory,
    private readonly prisma: PrismaService,
    private readonly resolver: TenantSmtpResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Devuelve la config SMTP del tenant (sin password). `hasPassword` indica si hay secret guardado.',
  })
  async getCurrent(@CurrentUser() user: SessionClaims | undefined): Promise<SmtpResponseDto> {
    const claims = requireAdmin(user);
    const dto = await this.readDto(claims.tenantId);
    return dto;
  }

  @Put()
  @ApiOperation({
    summary:
      'Crea o actualiza la config SMTP del tenant. Reset `verifiedAt`. Si `password` viene vacío, conserva el actual.',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SmtpUpsertSchema))
    body: z.infer<typeof SmtpUpsertSchema>,
  ): Promise<SmtpResponseDto> {
    const claims = requireAdmin(user);
    const config = this.modules.getTenantConfig();

    // Para conservar password cuando el form lo deja vacío, leemos el
    // previo, hacemos merge, y guardamos. Si descifrar falla (clave rotada)
    // y el body no trae password, exigimos uno nuevo — sin él no podríamos
    // reconstruir credenciales válidas.
    let existingPassword: string | undefined;
    try {
      const previous = (await config.get(claims.tenantId, 'notifications', 'smtp')) as
        | { password?: string }
        | undefined;
      existingPassword = previous?.password;
    } catch (err) {
      this.logger.warn(
        `[admin-smtp] no se pudo descifrar SMTP previo del tenant ${claims.tenantId}: ` +
          `${(err as Error).message.slice(0, 200)}. Si el body no trae password se rechaza el update.`,
      );
    }

    const finalPassword =
      body.password && body.password.length > 0 ? body.password : existingPassword;
    if (!finalPassword) {
      throw new BadRequestException(
        'Falta password: no hay password previo guardado o no se pudo descifrar. Envía uno nuevo en el body.',
      );
    }

    const secret = {
      host: body.host,
      port: body.port,
      user: body.username,
      password: finalPassword,
      from: body.fromEmail,
      ...(body.secure !== undefined ? { secure: body.secure } : {}),
    };

    await config.set(claims.tenantId, 'notifications', 'smtp', secret, {
      isSecret: true,
      actorId: claims.sub,
    });

    // Metadata pública (no-secret) — incluye `fromName` (que no viaja en el
    // schema cifrado) + reset de `verifiedAt`. Cualquier change → re-verify.
    await config.set(
      claims.tenantId,
      'notifications',
      'smtp_meta',
      {
        fromName: body.fromName ?? null,
        verifiedAt: null,
        verifiedByUserId: null,
      },
      { isSecret: false, actorId: claims.sub },
    );

    return this.readDto(claims.tenantId);
  }

  @Post('test')
  @ApiOperation({
    summary:
      'Envía un email de prueba a `toEmail` usando la config SMTP del tenant. Si éxito, marca `verifiedAt`.',
  })
  async test(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SmtpTestSchema))
    body: z.infer<typeof SmtpTestSchema>,
  ): Promise<{ ok: true; sentTo: string; messageId?: string; verifiedAt: string }> {
    const claims = requireAdmin(user);
    const smtp = this.modules.getSmtpAdapter();

    const resolved = await this.resolver.resolveTenantOnly(claims.tenantId);
    if (!resolved) {
      throw new BadRequestException(
        'SMTP no configurado para este tenant — guarda credenciales antes de probar.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: claims.tenantId },
      select: { slug: true, name: true },
    });

    const result = await smtp.send(resolved.config, {
      to: body.toEmail,
      subject: 'Prueba de SMTP — Didacta',
      text:
        `Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\n` +
        `Tenant: ${tenant?.slug ?? '(desconocido)'} (${tenant?.name ?? ''})\n` +
        `Fecha: ${new Date().toISOString()}`,
    });

    if (!result.ok) {
      // El error real del MTA (auth failed, host inválido, etc.) viaja en
      // la respuesta para que el admin pueda diagnosticar — no es secreto.
      throw new BadRequestException(`SMTP falló: ${result.error ?? 'sin detalle'}`);
    }

    // Marca verificado: actualiza meta sin tocar las credenciales.
    const config = this.modules.getTenantConfig();
    const prevMeta = (await config
      .get(claims.tenantId, 'notifications', 'smtp_meta')
      .catch(() => undefined)) as { fromName?: string | null } | undefined;
    const verifiedAt = new Date().toISOString();
    await config.set(
      claims.tenantId,
      'notifications',
      'smtp_meta',
      {
        fromName: prevMeta?.fromName ?? null,
        verifiedAt,
        verifiedByUserId: claims.sub,
      },
      { isSecret: false, actorId: claims.sub },
    );

    return { ok: true, sentTo: body.toEmail, messageId: result.messageId, verifiedAt };
  }

  private async readDto(tenantId: string): Promise<SmtpResponseDto> {
    const config = this.modules.getTenantConfig();
    let secret:
      | {
          host?: string;
          port?: number;
          user?: string;
          password?: string;
          from?: string;
          secure?: boolean;
        }
      | undefined;
    try {
      secret = (await config.get(tenantId, 'notifications', 'smtp')) as typeof secret;
    } catch (err) {
      this.logger.warn(
        `[admin-smtp] decrypt falló leyendo SMTP del tenant ${tenantId}: ${(err as Error).message.slice(0, 200)}`,
      );
      secret = undefined;
    }
    const meta =
      ((await config.get(tenantId, 'notifications', 'smtp_meta').catch(() => undefined)) as
        | { fromName?: string | null; verifiedAt?: string | null; verifiedByUserId?: string | null }
        | undefined) ?? {};

    const globalResolved = await this.resolver.resolve(tenantId);
    const hasGlobalFallback = globalResolved?.source === 'global';

    return {
      host: secret?.host ?? null,
      port: secret?.port ?? null,
      secure: secret?.secure ?? null,
      username: secret?.user ?? null,
      hasPassword: Boolean(secret?.password),
      fromEmail: secret?.from ?? null,
      fromName: meta.fromName ?? null,
      verifiedAt: meta.verifiedAt ?? null,
      verifiedByUserId: meta.verifiedByUserId ?? null,
      hasTenantConfig: Boolean(secret),
      hasGlobalFallback,
    };
  }
}
