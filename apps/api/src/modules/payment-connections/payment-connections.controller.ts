import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeEmail } from '@didacta/mod-payment-connections';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { renewalEmailHtml } from '../../common/renewal-email-html';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { randomUUID } from 'node:crypto';
import { AdminUsersService, type AssignableRole } from '../../admin/admin-users.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { ModuleContextFactory } from '../module-context.factory';
import { SubscriptionsDailyWorker } from './subscriptions-daily.worker';

/**
 * Endpoints admin de mod.payment-connections (todos super_admin):
 *   POST   /modules/payment-connections/connections           → conectar cuenta
 *   GET    /modules/payment-connections/connections           → listar
 *   POST   /modules/payment-connections/connections/:id/verify→ re-validar
 *   DELETE /modules/payment-connections/connections/:id       → desconectar
 *   GET    /modules/payment-connections/connections/:id/reconcile → dos listas
 *   POST   /modules/payment-connections/connections/:id/invite→ invitar (bulk)
 *
 * El panel muestra PII de pagos (emails/importes de clientes) → restringido a
 * super_admin. La validación de input va aquí con zod; la lógica, en el service
 * del módulo. Invitar se orquesta aquí reusando AdminUsersService del core.
 */

const createStripeSchema = z
  .object({
    provider: z.literal('stripe'),
    displayName: z.string().trim().min(1).max(120),
    // Restricted/secret key de Stripe: rk_live_, rk_test_, sk_live_, sk_test_.
    apiKey: z
      .string()
      .trim()
      .min(12)
      .max(255)
      .regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/, 'La clave debe ser una Stripe API key válida.'),
  })
  .strict();

const createPaypalSchema = z
  .object({
    provider: z.literal('paypal'),
    displayName: z.string().trim().min(1).max(120),
    clientId: z.string().trim().min(10).max(200),
    clientSecret: z.string().trim().min(10).max(200),
    environment: z.enum(['sandbox', 'live']).default('live'),
  })
  .strict();

const createWoocommerceSchema = z
  .object({
    provider: z.literal('woocommerce'),
    displayName: z.string().trim().min(1).max(120),
    storeUrl: z
      .string()
      .trim()
      .url()
      .startsWith('https://', 'La URL de la tienda debe ser https://'),
    consumerKey: z.string().trim().min(10).max(120),
    consumerSecret: z.string().trim().min(10).max(120),
  })
  .strict();

const createConnectionSchema = z.discriminatedUnion('provider', [
  createStripeSchema,
  createPaypalSchema,
  createWoocommerceSchema,
]);
type CreateConnectionBody = z.infer<typeof createConnectionSchema>;

const inviteSchema = z
  .object({
    emails: z.array(z.string().email().max(200)).min(1).max(200),
  })
  .strict();

const createTierSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    isFree: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const updateTierSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isFree: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const assignTierSchema = z
  .object({
    // null = quitar la asignación manual (vuelve al derivado/Desconocido).
    tierId: z.string().uuid().nullable(),
  })
  .strict();

/** Filtros + paginación del listado del dashboard de control de suscripciones. */
const subscribersQuerySchema = z
  .object({
    statusCategory: z.string().trim().max(40).optional(),
    provider: z.enum(['stripe', 'paypal', 'woocommerce']).optional(),
    connectionId: z.string().uuid().optional(),
    onlyUnmatched: z.enum(['true', 'false']).optional(),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type SubscribersQuery = z.infer<typeof subscribersQuerySchema>;

/** Plantilla / email de recordatorio de renovación (asunto + cuerpo ya resueltos). */
const renewalEmailSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();
type RenewalEmailDto = z.infer<typeof renewalEmailSchema>;

/** URL del Customer Portal de Stripe (o cadena vacía para borrarla). */
const cancelPortalSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Debe ser una URL http(s) o vacío'),
  })
  .strict();
type CancelPortalDto = z.infer<typeof cancelPortalSchema>;

@ApiTags('Payment Connections · Admin')
@Controller('modules/payment-connections')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaymentConnectionsController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly adminUsers: AdminUsersService,
    private readonly contextFactory: ModuleContextFactory,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly dailyWorker: SubscriptionsDailyWorker,
  ) {}

  private assertSuperAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.includes('super_admin')) {
      throw new ForbiddenException('Solo super_admin puede gestionar conexiones de pago.');
    }
    return user;
  }

  /**
   * Publica `payment_connections.user_tier.changed` para que mod.access-groups
   * reconcilie la membresía del usuario en los grupos vinculados a ese tier.
   * Best-effort: un fallo de publish no debe abortar la respuesta del sync/assign.
   */
  private async publishTierChanged(
    tenantId: string,
    actorId: string | null,
    userId: string,
    tierName: string | null,
  ): Promise<void> {
    try {
      await this.contextFactory.getEventBus().publish({
        name: 'payment_connections.user_tier.changed',
        version: 1,
        data: { userId, tierName },
        metadata: {
          tenantId,
          userId: actorId ?? undefined,
          timestamp: new Date().toISOString(),
          traceId: randomUUID(),
          idempotencyKey: `payment_connections.user_tier.changed:${userId}:${tierName ?? 'null'}:${Date.now()}`,
        },
      });
    } catch {
      // swallow — el outbox/dispatcher es la garantía; un publish puntual fallido
      // no debe romper el sync. El próximo sync vuelve a emitir.
    }
  }

  @Post('connections')
  @ApiOperation({
    summary:
      'Conecta una cuenta de pago (Stripe o PayPal) en modo solo lectura. Valida ' +
      'las credenciales, las cifra y persiste la conexión.',
  })
  async create(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createConnectionSchema))
    body: CreateConnectionBody,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    let credentials;
    if (body.provider === 'stripe') {
      credentials = { apiKey: body.apiKey };
    } else if (body.provider === 'paypal') {
      credentials = {
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        environment: body.environment,
      };
    } else {
      credentials = {
        storeUrl: body.storeUrl,
        consumerKey: body.consumerKey,
        consumerSecret: body.consumerSecret,
      };
    }
    const connection = await this.registry.getPaymentConnectionsService().addConnection({
      tenantId: user.tenantId,
      actorId: user.sub,
      provider: body.provider,
      displayName: body.displayName,
      credentials,
    });
    return { connection };
  }

  @Get('connections')
  @ApiOperation({ summary: 'Lista las conexiones de pago del tenant (sin exponer las claves).' })
  async list(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const connections = await this.registry
      .getPaymentConnectionsService()
      .listConnections(user.tenantId);
    return { connections };
  }

  @Post('connections/:id/verify')
  @ApiOperation({ summary: 'Re-valida las credenciales de una conexión y refresca su estado.' })
  async verify(@Param('id') id: string, @CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const connection = await this.registry
      .getPaymentConnectionsService()
      .verifyConnection(user.tenantId, id, user.sub);
    return { connection };
  }

  @Delete('connections/:id')
  @ApiOperation({ summary: 'Desconecta una cuenta: borra la conexión y su clave cifrada.' })
  async remove(@Param('id') id: string, @CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    await this.registry
      .getPaymentConnectionsService()
      .disconnectConnection(user.tenantId, id, user.sub);
    return { ok: true };
  }

  @Get('connections/:id/reconcile')
  @ApiOperation({
    summary:
      'Lee las suscripciones activas de la cuenta y las separa en: usuarios de ' +
      'Didacta con sub activa / suscriptores que aún no están en Didacta.',
  })
  async reconcile(@Param('id') id: string, @CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry.getPaymentConnectionsService().reconcile(user.tenantId, id);
  }

  @Post('connections/:id/invite')
  @ApiOperation({
    summary:
      'Invita a Didacta (cuenta PENDING + email de activación, rol alumno) a un ' +
      'subconjunto de los suscriptores que no están en la plataforma.',
  })
  async invite(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(inviteSchema)) body: { emails: string[] },
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Req() req: FastifyRequest,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const svc = this.registry.getPaymentConnectionsService();
    // Verifica que la conexión exista y sea del tenant antes de invitar.
    await svc.getConnection(user.tenantId, id);

    const webBaseUrl = resolveWebBaseUrl(req);
    const ctx = extractClientContext(req);
    const emails = Array.from(
      new Set(body.emails.map((e) => normalizeEmail(e)).filter((e): e is string => e !== null)),
    );

    const results: Array<{
      email: string;
      outcome: 'invited' | 'already_member' | 'error';
      userId?: string;
      message?: string;
    }> = [];

    for (const email of emails) {
      try {
        const created = await this.adminUsers.invite(
          user.tenantId,
          user.sub,
          { email, role: 'alumno' as AssignableRole },
          webBaseUrl,
          ctx,
          { sendInvite: true },
        );
        results.push({ email, outcome: 'invited', userId: created.id });
      } catch (err) {
        if (err instanceof ConflictException) {
          results.push({ email, outcome: 'already_member' });
        } else {
          results.push({ email, outcome: 'error', message: (err as Error).message });
        }
      }
    }

    return { results };
  }

  // ---------------- Tiers ----------------

  @Get('tiers/catalog')
  @ApiOperation({ summary: 'Lista el catálogo de tiers del tenant.' })
  async listTierCatalog(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const tiers = await this.registry.getPaymentTiersService().listCatalogWithCounts(user.tenantId);
    return { tiers };
  }

  @Post('tiers/catalog')
  @ApiOperation({ summary: 'Crea un tier en el catálogo del tenant.' })
  async createTier(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createTierSchema))
    body: { name: string; isFree?: boolean; sortOrder?: number },
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const tier = await this.registry.getPaymentTiersService().createTier(user.tenantId, body);
    return { tier };
  }

  @Patch('tiers/catalog/:id')
  @ApiOperation({ summary: 'Edita un tier del catálogo.' })
  async updateTier(
    @Param('id') id: string,
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(updateTierSchema))
    body: { name?: string; isFree?: boolean; sortOrder?: number },
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const tier = await this.registry.getPaymentTiersService().updateTier(user.tenantId, id, body);
    return { tier };
  }

  @Delete('tiers/catalog/:id')
  @ApiOperation({ summary: 'Borra un tier (las asignaciones manuales quedan sin tier).' })
  async deleteTier(@Param('id') id: string, @CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const tiersSvc = this.registry.getPaymentTiersService();
    const { affectedUserIds } = await tiersSvc.deleteTier(user.tenantId, id);
    // Emite el tier efectivo recalculado de cada afectado para que el bridge
    // reconcilie su membresía (un grupo vinculado por nombre al tier borrado
    // dejará de reconciliarse; estos usuarios pierden el tier).
    if (affectedUserIds.length > 0) {
      const views = await tiersSvc.getUserTiers(user.tenantId, affectedUserIds);
      const byUser = new Map(views.map((v) => [v.userId, v.effectiveLabel]));
      for (const uid of affectedUserIds) {
        await this.publishTierChanged(user.tenantId, user.sub, uid, byUser.get(uid) ?? null);
      }
    }
    return { ok: true, affected: affectedUserIds.length };
  }

  @Get('user-tiers')
  @ApiOperation({
    summary:
      'Tier efectivo (manual o derivado de pagos) de un conjunto de usuarios. ' +
      'Param `userIds` = lista separada por comas. Lo consume /admin/usuarios.',
  })
  async getUserTiers(
    @Query('userIds') userIds: string | undefined,
    @CurrentUser() rawUser: SessionClaims | undefined,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const ids = (userIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 500);
    const tiers = await this.registry.getPaymentTiersService().getUserTiers(user.tenantId, ids);
    return { tiers };
  }

  @Put('user-tiers/:userId')
  @ApiOperation({
    summary: 'Asigna (o quita con tierId=null) el tier manual de un usuario.',
  })
  async assignUserTier(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(assignTierSchema)) body: { tierId: string | null },
    @CurrentUser() rawUser: SessionClaims | undefined,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const tier = await this.registry
      .getPaymentTiersService()
      .assignManualTier(user.tenantId, userId, body.tierId, user.sub);
    await this.publishTierChanged(user.tenantId, user.sub, userId, tier.effectiveLabel);
    return { tier };
  }

  @Post('user-tiers/sync')
  @ApiOperation({
    summary:
      'Reconcilia todas las cuentas conectadas (VERIFIED) y rellena el tier ' +
      'DERIVADO (nombre del producto/plan) de cada usuario de Didacta con ' +
      'suscripción activa. No toca los tiers asignados manualmente.',
  })
  async syncUserTiers(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const connectionsSvc = this.registry.getPaymentConnectionsService();
    const conns = await connectionsSvc.listConnections(user.tenantId);
    const entries: Array<{
      userId: string;
      label: string;
      provider: string;
      connectionId: string;
      ref: string;
    }> = [];
    const errors: Array<{ connectionId: string; message: string }> = [];

    // Conexiones reconciliadas con éxito (para acotar la detección de churn).
    const reconciledConnectionIds: string[] = [];
    // Planes de suscriptores SIN usuario en Didacta (unmatched): alimentan el
    // CATÁLOGO de tiers aunque aún no se pueda asignar el tier a nadie. Sin esto,
    // el catálogo solo reflejaría los planes de los pocos usuarios ya registrados.
    const extraCatalogLabels = new Set<string>();
    for (const c of conns) {
      if (c.status !== 'VERIFIED') continue;
      try {
        const rec = await connectionsSvc.reconcile(user.tenantId, c.id);
        reconciledConnectionIds.push(c.id);
        for (const m of rec.matched) {
          const label = m.subscription.productName?.trim() || tierLabelFallback(m.subscription);
          entries.push({
            userId: m.user.id,
            label,
            provider: c.provider,
            connectionId: c.id,
            ref: m.subscription.subscriptionId,
          });
        }
        for (const sub of rec.unmatched) {
          const label = sub.productName?.trim() || tierLabelFallback(sub);
          if (label) extraCatalogLabels.add(label);
        }
      } catch (err) {
        errors.push({ connectionId: c.id, message: (err as Error).message });
      }
    }

    // Parte B (D11): añade al catálogo los planes del CATÁLOGO de Stripe que aún
    // no tienen ningún suscriptor (products.list). Best-effort.
    for (const label of await connectionsSvc.listPlanCatalogLabels(user.tenantId)) {
      extraCatalogLabels.add(label);
    }

    const tiersSvc = this.registry.getPaymentTiersService();
    const { updated, tiersCreated, clearedUserIds } = await tiersSvc.applyDerivedTiers(
      user.tenantId,
      entries,
      { reconciledConnectionIds, extraCatalogLabels: [...extraCatalogLabels] },
    );

    // Emite el tier EFECTIVO de cada usuario afectado para que mod.access-groups
    // reconcilie la membresía de los grupos vinculados. Incluye a los que ENTRARON
    // (entries) y a los que SALIERON por churn (clearedUserIds): a estos su tier
    // efectivo ahora es el manual o null → el bridge los retira del grupo.
    const affectedUserIds = [...new Set([...entries.map((e) => e.userId), ...clearedUserIds])];
    if (affectedUserIds.length > 0) {
      const views = await tiersSvc.getUserTiers(user.tenantId, affectedUserIds);
      const byUser = new Map(views.map((v) => [v.userId, v.effectiveLabel]));
      for (const uid of affectedUserIds) {
        await this.publishTierChanged(user.tenantId, user.sub, uid, byUser.get(uid) ?? null);
      }
    }

    return {
      updated,
      tiersCreated,
      cleared: clearedUserIds.length,
      connections: conns.length,
      matched: entries.length,
      errors,
    };
  }

  // ---------------- Dashboard de control de suscripciones ----------------

  @Post('subscriptions-dashboard/sync')
  @ApiOperation({
    summary:
      'Sincroniza (on-demand) los suscriptores de TODAS las cuentas VERIFIED a la tabla ' +
      'materializada del dashboard. Síncrono: puede tardar varios segundos por cuenta.',
  })
  async syncSubscribersNow(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry.getPaymentConnectionsService().syncSubscribers(user.tenantId);
  }

  @Get('subscriptions-dashboard')
  @ApiOperation({
    summary: 'Lista paginada + filtrada de suscriptores materializados (todas las cuentas).',
  })
  async listSubscribersDashboard(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Query(new ZodValidationPipe(subscribersQuerySchema)) query: SubscribersQuery,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry.getPaymentConnectionsService().listSubscribers(user.tenantId, {
      statusCategory: query.statusCategory,
      provider: query.provider,
      connectionId: query.connectionId,
      onlyUnmatched: query.onlyUnmatched === 'true',
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('subscriptions-dashboard/summary')
  @ApiOperation({
    summary: 'Contadores por estado/proveedor + frescura del último sync (cabecera del dashboard).',
  })
  async subscribersSummary(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry.getPaymentConnectionsService().subscriberSummary(user.tenantId);
  }

  @Get('subscriptions-dashboard/subscribers/:id/renewal-url')
  @ApiOperation({
    summary:
      'Resuelve (lazy) el enlace de renovación read-only del suscriptor (Stripe: factura impaga).',
  })
  async subscriberRenewalUrl(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const url = await this.registry
      .getPaymentConnectionsService()
      .resolveRenewalUrl(user.tenantId, id);
    return { url };
  }

  @Post('subscriptions-dashboard/subscribers/:id/renewal-email')
  @ApiOperation({
    summary:
      'Envía un email de recordatorio de renovación al suscriptor (asunto/cuerpo ya editados por ' +
      'el admin). Se manda al email del suscriptor vía el SMTP del tenant.',
  })
  async sendRenewalEmail(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(renewalEmailSchema)) dto: RenewalEmailDto,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    const sub = await this.registry.getPaymentConnectionsService().getSubscriber(user.tenantId, id);
    if (!sub) throw new NotFoundException('Suscriptor no encontrado.');
    const to = sub.userEmail?.trim();
    if (!to) {
      throw new BadRequestException('El suscriptor no tiene email para enviarle el recordatorio.');
    }
    const resolved = await this.smtpResolver.resolve(user.tenantId);
    if (!resolved) {
      throw new ConflictException(
        'No hay SMTP configurado (ni del tenant ni global) para enviar el recordatorio.',
      );
    }
    const result = await this.smtp.send(resolved.config, {
      to,
      subject: dto.subject,
      text: dto.body,
      html: renewalEmailHtml(dto.body),
    });
    if (!result.ok) {
      throw new ConflictException(`No se pudo enviar el email: ${result.error ?? 'error SMTP'}`);
    }
    return { ok: true, to };
  }

  @Get('subscriptions-dashboard/renewal-template')
  @ApiOperation({
    summary: 'Plantilla editable del email de renovación del tenant (o la por defecto).',
  })
  async getRenewalTemplate(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry.getPaymentConnectionsService().getRenewalTemplate(user.tenantId);
  }

  @Put('subscriptions-dashboard/renewal-template')
  @ApiOperation({ summary: 'Personaliza la plantilla del email de renovación del tenant.' })
  async putRenewalTemplate(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(renewalEmailSchema)) dto: RenewalEmailDto,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    return this.registry
      .getPaymentConnectionsService()
      .setRenewalTemplate(user.tenantId, dto, user.sub);
  }

  @Get('subscriptions-dashboard/cancel-portal-url')
  @ApiOperation({
    summary: 'URL del Customer Portal de Stripe (enlace de cancelación de los avisos).',
  })
  async getCancelPortalUrl(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.assertSuperAdmin(rawUser);
    const url = await this.registry
      .getPaymentConnectionsService()
      .getCancelPortalUrl(user.tenantId);
    return { url };
  }

  @Put('subscriptions-dashboard/cancel-portal-url')
  @ApiOperation({
    summary: 'Configura la URL del Customer Portal de Stripe (o vacío para borrar).',
  })
  async putCancelPortalUrl(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(cancelPortalSchema)) dto: CancelPortalDto,
  ) {
    const user = this.assertSuperAdmin(rawUser);
    await this.registry
      .getPaymentConnectionsService()
      .setCancelPortalUrl(user.tenantId, dto.url || null, user.sub);
    return { url: dto.url || null };
  }

  @Post('subscriptions-dashboard/daily/run-now')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dispara ahora el barrido diario (resumen admin + avisos 7 días). Solo QA/manual.',
  })
  async runDailyNow(@CurrentUser() rawUser: SessionClaims | undefined) {
    this.assertSuperAdmin(rawUser);
    await this.dailyWorker.triggerNow();
    return { ok: true };
  }
}

/** Etiqueta de tier de respaldo cuando la suscripción no tiene nombre de producto. */
function tierLabelFallback(sub: {
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
}): string {
  if (sub.unitAmount != null) {
    const amount = (sub.unitAmount / 100).toFixed(2);
    const cur = (sub.currency ?? 'eur').toUpperCase();
    return `${amount} ${cur}${sub.interval ? `/${sub.interval}` : ''}`;
  }
  return 'Suscripción';
}
