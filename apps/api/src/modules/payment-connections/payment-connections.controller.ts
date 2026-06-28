import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { AdminUsersService, type AssignableRole } from '../../admin/admin-users.service';
import { ModuleRegistryService } from '../module-registry.service';

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

@ApiTags('Payment Connections · Admin')
@Controller('modules/payment-connections')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaymentConnectionsController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly adminUsers: AdminUsersService,
  ) {}

  private assertSuperAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.includes('super_admin')) {
      throw new ForbiddenException('Solo super_admin puede gestionar conexiones de pago.');
    }
    return user;
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
    await this.registry.getPaymentTiersService().deleteTier(user.tenantId, id);
    return { ok: true };
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

    for (const c of conns) {
      if (c.status !== 'VERIFIED') continue;
      try {
        const rec = await connectionsSvc.reconcile(user.tenantId, c.id);
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
      } catch (err) {
        errors.push({ connectionId: c.id, message: (err as Error).message });
      }
    }

    const { updated, tiersCreated } = await this.registry
      .getPaymentTiersService()
      .applyDerivedTiers(user.tenantId, entries);
    return { updated, tiersCreated, connections: conns.length, matched: entries.length, errors };
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
