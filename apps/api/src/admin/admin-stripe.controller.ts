/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import {
  StripeCredentialsSchema,
  TenantStripeResolverService,
  type StripeCredentials,
} from '../modules/tenant-stripe-resolver.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Body del PUT /admin/tenant-settings/stripe. Los 3 campos son opcionales
 * porque el merge-on-omit conserva lo ya guardado (mismo criterio que la
 * `password` de SMTP): sólo hace falta re-tipear lo que se quiere rotar.
 */
const StripeUpsertSchema = z.object({
  secretKey: z.string().max(500).optional(),
  webhookSecret: z.string().max(500).optional(),
  subscriptionsWebhookSecret: z.string().max(500).optional(),
});

interface StripeResponseDto {
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  hasSubscriptionsWebhookSecret: boolean;
  /** 'test'/'live' derivado del prefijo `sk_test_`/`sk_live_`, o null si no hay clave. */
  mode: 'test' | 'live' | null;
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
    throw new ForbiddenException('Solo super_admin o tenant_admin pueden gestionar Stripe');
  }
  return user;
}

function deriveMode(secretKey: string | undefined): 'test' | 'live' | null {
  if (!secretKey) return null;
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  return null;
}

/**
 * Endpoints admin para gestionar Stripe per-tenant (Administración → Pagos).
 * Wrappea el almacenamiento genérico de `tenant_setting` con un contrato
 * dedicado, mismo patrón que `AdminSmtpController`.
 *
 * Almacenamiento:
 * - Credenciales: `tenant_setting` scope=`billing`, key=`stripe`, isSecret=true.
 *   Cifrado AES-256-GCM por `SecretCipherService`. Un único par de credenciales
 *   compartido por mod.billing y mod.subscriptions (ver TenantStripeResolverService).
 * - Metadata de verificación: `tenant_setting` scope=`billing`, key=`stripe_meta`,
 *   isSecret=false. Sólo guarda `{verifiedAt, verifiedByUserId}`.
 */
@ApiTags('Admin Stripe')
@ApiBearerAuth()
@Controller('admin/tenant-settings/stripe')
@UseGuards(JwtAuthGuard)
export class AdminStripeController {
  private readonly logger = new Logger(AdminStripeController.name);

  constructor(
    private readonly modules: ModuleContextFactory,
    private readonly resolver: TenantStripeResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Devuelve el estado de la config Stripe del tenant (nunca las credenciales). hasSecretKey/hasWebhookSecret indican si hay algo guardado.',
  })
  async getCurrent(@CurrentUser() user: SessionClaims | undefined): Promise<StripeResponseDto> {
    const claims = requireAdmin(user);
    return this.readDto(claims.tenantId);
  }

  @Put()
  @ApiOperation({
    summary:
      'Crea o actualiza las credenciales Stripe del tenant. Reset `verifiedAt`. Campos omitidos o vacíos conservan el valor guardado.',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(StripeUpsertSchema))
    body: z.infer<typeof StripeUpsertSchema>,
  ): Promise<StripeResponseDto> {
    const claims = requireAdmin(user);
    const config = this.modules.getTenantConfig();

    let existing: Partial<StripeCredentials> | undefined;
    try {
      existing = (await config.get(claims.tenantId, 'billing', 'stripe')) as
        | Partial<StripeCredentials>
        | undefined;
    } catch (err) {
      this.logger.warn(
        `[admin-stripe] no se pudo descifrar Stripe previo del tenant ${claims.tenantId}: ` +
          `${(err as Error).message.slice(0, 200)}. Si el body no trae credenciales completas se rechaza el update.`,
      );
    }

    const merged = {
      secretKey: nonEmpty(body.secretKey) ?? existing?.secretKey,
      webhookSecret: nonEmpty(body.webhookSecret) ?? existing?.webhookSecret,
      subscriptionsWebhookSecret:
        nonEmpty(body.subscriptionsWebhookSecret) ?? existing?.subscriptionsWebhookSecret,
    };
    const parsed = StripeCredentialsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new BadRequestException(
        'Faltan credenciales: secretKey y webhookSecret son obligatorios (no hay valores previos guardados para completar lo que falta en el body).',
      );
    }

    await config.set(claims.tenantId, 'billing', 'stripe', parsed.data, {
      isSecret: true,
      actorId: claims.sub,
    });
    // Cualquier cambio de credenciales invalida la verificación anterior —
    // el admin debe volver a probar la conexión.
    await config.set(
      claims.tenantId,
      'billing',
      'stripe_meta',
      { verifiedAt: null, verifiedByUserId: null },
      { isSecret: false, actorId: claims.sub },
    );

    return this.readDto(claims.tenantId);
  }

  @Post('test')
  @ApiOperation({
    summary:
      'Verifica las credenciales guardadas contra la API de Stripe (balance.retrieve, solo lectura). Si éxito, marca verifiedAt.',
  })
  async test(
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<{ ok: true; mode: 'test' | 'live'; verifiedAt: string }> {
    const claims = requireAdmin(user);
    const resolved = await this.resolver.resolveTenantOnly(claims.tenantId);
    if (!resolved) {
      throw new BadRequestException(
        'Stripe no configurado para este tenant — guarda credenciales antes de probar.',
      );
    }

    // Carga perezosa del SDK — evita romper en NODE_ENV=test si no está
    // instalado (vitest unit no lo necesita).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require('stripe').default ?? require('stripe');
    const client = new StripeCtor(resolved.credentials.secretKey, {
      apiVersion: '2024-12-18.acacia',
      timeout: 8_000,
      maxNetworkRetries: 0,
    });

    let balance: { livemode: boolean };
    try {
      balance = await client.balance.retrieve();
    } catch (err) {
      // El error real de Stripe (clave inválida, revocada, etc.) viaja en
      // la respuesta para que el admin pueda diagnosticar — no es secreto.
      throw new BadRequestException(`Stripe rechazó la clave: ${(err as Error).message}`);
    }

    const verifiedAt = new Date().toISOString();
    const config = this.modules.getTenantConfig();
    await config.set(
      claims.tenantId,
      'billing',
      'stripe_meta',
      { verifiedAt, verifiedByUserId: claims.sub },
      { isSecret: false, actorId: claims.sub },
    );

    return { ok: true, mode: balance.livemode ? 'live' : 'test', verifiedAt };
  }

  private async readDto(tenantId: string): Promise<StripeResponseDto> {
    const config = this.modules.getTenantConfig();
    let secret: Partial<StripeCredentials> | undefined;
    try {
      secret = (await config.get(tenantId, 'billing', 'stripe')) as
        | Partial<StripeCredentials>
        | undefined;
    } catch (err) {
      this.logger.warn(
        `[admin-stripe] decrypt falló leyendo Stripe del tenant ${tenantId}: ${(err as Error).message.slice(0, 200)}`,
      );
      secret = undefined;
    }
    const meta =
      ((await config.get(tenantId, 'billing', 'stripe_meta').catch(() => undefined)) as
        | { verifiedAt?: string | null; verifiedByUserId?: string | null }
        | undefined) ?? {};

    const globalResolved = await this.resolver.resolve(tenantId);
    const hasGlobalFallback = globalResolved?.source === 'global';

    return {
      hasSecretKey: Boolean(secret?.secretKey),
      hasWebhookSecret: Boolean(secret?.webhookSecret),
      hasSubscriptionsWebhookSecret: Boolean(secret?.subscriptionsWebhookSecret),
      mode: deriveMode(secret?.secretKey),
      verifiedAt: meta.verifiedAt ?? null,
      verifiedByUserId: meta.verifiedByUserId ?? null,
      hasTenantConfig: Boolean(secret),
      hasGlobalFallback,
    };
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
