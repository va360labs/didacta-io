/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PLATFORM_PRICE_CURRENCIES,
  PayoutsAccountNotFoundError,
  PayoutsCountryUnsupportedError,
  settlementCurrencyOf,
  type DisconnectResult,
  type PayoutsAccountView,
} from '@didacta/mod-payouts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PayoutsRuntime } from './payouts-runtime.service';

/**
 * Lo puede tocar el administrador del aula. `super_admin` también, porque en
 * Didacta es un administrador de SU tenant con más poderes, igual que en el
 * resto de pantallas de Ingresos (`billing-admin.controller.ts`).
 */
const ADMIN_ROLES = ['tenant_admin', 'super_admin'] as const;

export const connectSchema = z.object({
  /** ISO 3166-1 alfa-2. La lista de admitidos la aplica el dominio (422). */
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Código de país ISO de dos letras'),
  /** «particular/autónomo» (`individual`) o «empresa» (`company`). */
  entityType: z.enum(['individual', 'company']),
});
type ConnectDto = z.infer<typeof connectSchema>;

/** Respuesta de `GET /modules/payouts/status`. Contrato con la web. */
export interface PayoutsStatusResponse {
  /** Siempre `true`: sin modo plataforma esta ruta no existe. */
  readonly platform: true;
  /** Nombre del operador en los textos (`PAYMENTS_PLATFORM_DISPLAY_NAME`). */
  readonly operatorName: string;
  /** Cómo cobra HOY el aula: `platform`, `own` (claves propias heredadas) o `none`. */
  readonly mode: 'platform' | 'own' | 'none';
  /** ¿Puede vender ya? */
  readonly ready: boolean;
  /** Si no puede vender en modo plataforma, por qué. */
  readonly reason: string | null;
  readonly account: PayoutsAccountView | null;
  readonly supportedCountries: readonly string[];
  /** Comisión del operador vigente para este aula, en puntos básicos. */
  readonly feeBps: number;
  /**
   * Moneda en la que Stripe le liquida al creador (la de su cuenta o la de su
   * país): la de sus precios por defecto. `null` sin cuenta.
   */
  readonly settlementCurrency: string | null;
  /** Monedas en las que puede poner precio en modo plataforma (plan §9). */
  readonly priceCurrencies: readonly string[];
}

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role))) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol tenant_admin.',
      code: 'PAYOUTS_ADMIN_ROLE_REQUIRED',
    });
  }
  return user;
}

/**
 * Una sesión de soporte (U8) puede MIRAR el estado, pero no conectar cobros
 * ni abrir el panel de pagos del creador: el alta lleva los datos de quien la
 * hace y el panel enseña su dinero.
 */
function forbidSupportSession(user: SessionClaims): void {
  if (user.sup) {
    throw new ForbiddenException({
      message: 'Una sesión de soporte no puede conectar los cobros ni abrir el panel de pagos.',
      code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN',
    });
  }
}

/**
 * Cobros de plataforma del aula: estado, alta alojada de Stripe y panel.
 *
 * El tenant sale SIEMPRE del token (`claims.tenantId`), nunca del cuerpo ni de
 * la URL: no hay forma de nombrar otra aula desde estas rutas.
 */
@ApiTags('Payouts · Cobros')
@Controller('modules/payouts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PayoutsController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly tenantResolver: TenantResolverService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Estado de los cobros del aula. Con `?sync=1` consulta antes la cuenta en Stripe (vuelta del alta).',
  })
  async status(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('sync') sync?: string,
  ): Promise<PayoutsStatusResponse> {
    const u = requireAdmin(user);
    const tenantId = u.tenantId;
    return runAsTenant(tenantId, async () => {
      if (sync === '1' || sync === 'true') {
        try {
          await this.runtime.accounts.syncAccount(tenantId);
        } catch (err) {
          if (!(err instanceof PayoutsAccountNotFoundError)) throw err;
        }
      }
      const [mode, account, settings] = await Promise.all([
        this.runtime.mode.resolve(tenantId),
        this.runtime.accounts.getAccount(tenantId),
        this.runtime.settings.get(tenantId),
      ]);
      return {
        platform: true,
        operatorName: this.runtime.config.displayName,
        // Solo el NOMBRE del modo: `own` trae las credenciales y no salen de aquí.
        mode: mode.mode,
        ready: mode.mode === 'platform' ? mode.ready : mode.mode === 'own',
        reason: mode.mode === 'platform' && !mode.ready ? mode.reason : null,
        account,
        supportedCountries: this.runtime.accounts.supportedCountries,
        feeBps: settings.feeBps,
        settlementCurrency: settlementCurrencyOf(account),
        priceCurrencies: PLATFORM_PRICE_CURRENCIES,
      };
    });
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Conectar cobros: crea (o reutiliza) la cuenta conectada del aula y devuelve el enlace del alta alojada de Stripe. País no admitido → 422 PAYOUTS_COUNTRY_UNSUPPORTED.',
  })
  async connect(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(connectSchema)) dto: ConnectDto,
  ): Promise<{ account: PayoutsAccountView; onboardingUrl: string | null }> {
    const u = requireAdmin(user);
    forbidSupportSession(u);
    const tenantId = u.tenantId;
    const country = dto.country.toUpperCase();
    // País no admitido: 422 ANTES de leer nada del aula ni llamar a Stripe.
    if (!this.runtime.accounts.isCountrySupported(country)) {
      throw new PayoutsCountryUnsupportedError(country);
    }
    const [prefill, urls] = await Promise.all([
      this.prefill(tenantId, u.sub),
      this.urls(tenantId, req),
    ]);
    return runAsTenant(tenantId, () =>
      this.runtime.accounts.startOnboarding({
        tenantId,
        country,
        entityType: dto.entityType,
        prefill,
        urls,
      }),
    );
  }

  @Post('connect/link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Enlace nuevo del alta alojada («Completar», o el anterior caducó).',
  })
  async connectLink(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<{ url: string }> {
    const u = requireAdmin(user);
    forbidSupportSession(u);
    const urls = await this.urls(u.tenantId, req);
    return runAsTenant(u.tenantId, () => this.runtime.accounts.refreshLink(u.tenantId, urls));
  }

  @Get('dashboard-link')
  @ApiOperation({ summary: 'Enlace de un solo uso al panel Express del creador en Stripe.' })
  async dashboardLink(@CurrentUser() user: SessionClaims | undefined): Promise<{ url: string }> {
    const u = requireAdmin(user);
    forbidSupportSession(u);
    return runAsTenant(u.tenantId, () => this.runtime.accounts.dashboardLink(u.tenantId));
  }

  @Post('disconnect')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Desconectar cobros: el aula deja de vender (checkout cerrado) y sus suscripciones vivas se cancelan a final de periodo. La cuenta de Stripe NO se cierra (lo pendiente se sigue pagando). Conectar de nuevo la reactiva.',
  })
  async disconnect(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
  ): Promise<DisconnectResult> {
    const u = requireAdmin(user);
    forbidSupportSession(u);
    const result = await runAsTenant(u.tenantId, () =>
      this.runtime.offboarding.disconnect(u.tenantId, { reason: 'creator' }),
    );
    const client = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'payouts.account.disconnected',
      resourceType: 'payouts_account',
      resourceId: result.account?.stripeAccountId ?? u.tenantId,
      metadata: {
        changed: result.changed,
        subscriptionsScheduled: result.subscriptionsScheduled,
        subscriptionsFailed: result.subscriptionsFailed,
      },
      ip: client.ip ?? undefined,
      userAgent: client.userAgent ?? undefined,
    });
    return result;
  }

  /** Datos con los que se prerrellena el alta: correo de quien conecta, nombre y dominio del aula. */
  private async prefill(tenantId: string, userId: string) {
    const prisma = this.runtime.prisma;
    const [tenant, admin, hostname] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      runAsTenant(tenantId, () =>
        prisma.user.findFirst({
          where: { id: userId, tenantId },
          select: { email: true, locale: true },
        }),
      ),
      this.tenantResolver.resolvePrimaryDomain(tenantId),
    ]);
    if (!tenant || !admin) throw new UnauthorizedException();
    return {
      email: admin.email,
      displayName: tenant.name,
      hostname,
      locale: admin.locale,
    };
  }

  /** Vuelta y renovación del alta: la pantalla de Cobros del aula, en su dominio. */
  private async urls(tenantId: string, req: FastifyRequest) {
    const base = (await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req)).replace(
      /\/+$/,
      '',
    );
    return {
      returnUrl: `${base}/admin/payments?vuelta=1`,
      refreshUrl: `${base}/admin/payments?renovar=1`,
    };
  }
}
