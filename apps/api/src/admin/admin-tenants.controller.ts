/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import { resolveWebBaseUrl } from '../common/resolve-web-base-url';
import { auditActorId, auditActorTrace, type AdminActor } from '../auth/admin-actor';
import { extractClientContext } from '../auth/client-context';
import { AllowProvisioning, CurrentUser } from '../auth/decorators';
import { JwtOrProvisioningGuard } from '../auth/jwt-or-provisioning.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PayoutsRuntime } from '../modules/payouts/payouts-runtime.service';
import { SUBSCRIPTION_GATE_STATES } from '../tenancy/subscription-gate';
import { runAsTenant, runGlobalWithoutTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { AdminTenantsService, type TenantUsageItem } from './admin-tenants.service';
import { SupportAccessService } from './support-access.service';

// Los schemas de las rutas de la lista blanca se exportan para que
// `tests/contract/admin-tenants.contract.test.ts` fije la forma de la petición
// —nombres de campo incluidos— sin duplicarla a mano. Míralo antes de
// tocarlos: son contrato con `didacta-cloud`.
export const createTenantSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  adminEmail: z.string().email().max(200),
  adminName: z.string().min(1).max(120).optional(),
  primaryHostname: z.string().min(1).max(253),
});
type CreateTenantDto = z.infer<typeof createTenantSchema>;

export const setStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
});
type SetStatusDto = z.infer<typeof setStatusSchema>;

const renameSchema = z.object({
  name: z.string().min(1).max(120),
});
type RenameDto = z.infer<typeof renameSchema>;

export const domainSchema = z.object({
  hostname: z.string().min(1).max(253),
});
type DomainDto = z.infer<typeof domainSchema>;

export const signupsSchema = z.object({
  frozen: z.boolean(),
  /** Se le ensena al visitante que se queda fuera, asi que se pide siempre. */
  reason: z.string().min(5).max(280),
});
type SignupsDto = z.infer<typeof signupsSchema>;

export const supportAccessSchema = z.object({
  /**
   * Obligatorio y con cuerpo: es lo que lee el cliente en SU audit log cuando
   * quiera saber por que entro alguien de soporte en su aula. «test» no vale.
   */
  reason: z.string().min(10).max(280),
  /**
   * Ventana pedida. Opcional; el techo de 15 min lo impone `clampTtlSeconds()`
   * y no depende de que el llamante lo respete.
   */
  ttlSeconds: z.number().int().positive().optional(),
});
type SupportAccessDto = z.infer<typeof supportAccessSchema>;

/**
 * Campos de la puerta de suscripción. Se exportan por separado de las reglas
 * cruzadas para que el test de contrato pueda fijar sus nombres.
 */
export const subscriptionGateFields = z.object({
  state: z.enum(SUBSCRIPTION_GATE_STATES),
  /** ISO-8601. Obligatorio en TRIAL; opcional en LOCKED; se ignora en OPEN. */
  trialEndsAt: z.string().datetime({ offset: true }).nullish(),
  /** Adónde lleva «Elegir plan». https obligatorio en TRIAL y LOCKED; se ignora en OPEN. */
  actionUrl: z.string().max(2048).url().nullish(),
});

export const subscriptionGateSchema = subscriptionGateFields.superRefine((dto, ctx) => {
  if (dto.state === 'TRIAL' && !dto.trialEndsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['trialEndsAt'],
      message: 'Obligatorio cuando el estado es TRIAL.',
    });
  }
  if (dto.state !== 'OPEN') {
    if (!dto.actionUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionUrl'],
        message: 'Obligatorio cuando el estado es TRIAL o LOCKED.',
      });
    } else if (!dto.actionUrl.startsWith('https://')) {
      // El enlace lleva un token de pago y se abre desde el aula del cliente:
      // por http viajaría en claro.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionUrl'],
        message: 'Tiene que ser https.',
      });
    }
  }
});
type SubscriptionGateDto = z.infer<typeof subscriptionGateSchema>;

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol super_admin.',
      code: 'ADMIN_FORBIDDEN_SUPER_ADMIN_REQUIRED',
    });
  }
  return user;
}

/**
 * Resuelve quién está actuando: la máquina si la petición trajo credencial de
 * provisioning, y si no, la persona —a la que se le sigue exigiendo
 * super_admin—.
 *
 * `req.provisioningActor` solo puede estar puesto si `JwtOrProvisioningGuard`
 * validó la credencial Y el handler lleva `@AllowProvisioning()`; la lista
 * blanca no se re-comprueba aquí a propósito, para que exista un solo sitio
 * donde ampliarla.
 */
export function requireAdminActor(
  user: SessionClaims | undefined,
  req: FastifyRequest,
): AdminActor {
  const machine = req.provisioningActor;
  if (machine) return { kind: 'provisioning', credentialId: machine.credentialId };
  return { kind: 'user', userId: requireSuperAdmin(user).sub };
}

@ApiTags('Admin · Tenants')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(JwtOrProvisioningGuard)
export class AdminTenantsController {
  constructor(
    private readonly service: AdminTenantsService,
    private readonly supportAccess: SupportAccessService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get()
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Listar todos los tenants. Solo super_admin o credencial de provisioning.',
  })
  async list(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    requireAdminActor(user, req);
    return this.service.list();
  }

  @Get('capacity')
  @ApiOperation({
    summary:
      '11º piloto License SDK — informa cuántos tenants hay y si la licencia EE permite crear más (feat:multi_tenant.real). Solo super_admin.',
  })
  async capacity(@CurrentUser() user: SessionClaims | undefined) {
    requireSuperAdmin(user);
    return this.service.getCapacityInfo();
  }

  // OJO: `usage` va ANTES de `:id`, igual que `capacity`. Al revés, Fastify
  // resolvería `/admin/tenants/usage` con el handler de `:id` e intentaría
  // buscar un tenant llamado "usage".
  @Get('usage')
  @AllowProvisioning()
  @ApiOperation({
    summary:
      'Miembros activos por tenant a una fecha de corte. Solo super_admin o credencial de provisioning.',
    description: [
      'Fuente de verdad del consumo por tenant. **La definición es contractual**: es la',
      'misma que aparece en la página de precios de Didacta Cloud, y sobre ella se',
      'calcula el tramo que paga cada cliente.',
      '',
      '**Cuenta**: usuario con acceso al aula, activo y no borrado.',
      '',
      '**No cuenta**: administradores del tenant (`tenant_admin`, `super_admin`),',
      'invitaciones nunca aceptadas (`PENDING`), suspendidos (`SUSPENDED`), bajas',
      '(`DEACTIVATED`) y borrados lógicos.',
      '',
      'Formadores, auditores y gestores de empresa **sí** cuentan: consumen la',
      'plataforma igual que un alumno.',
      '',
      '`asOf` es una fecha ISO-8601 opcional; por defecto, ahora. Una fecha futura',
      'devuelve 400 — no se factura sobre un consumo que aún no ha ocurrido.',
    ].join('\n'),
  })
  async usage(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Query('asOf') asOf?: string,
  ): Promise<TenantUsageItem[]> {
    requireAdminActor(user, req);
    let cutoff: Date | undefined;
    if (asOf !== undefined && asOf !== '') {
      cutoff = new Date(asOf);
      if (Number.isNaN(cutoff.getTime())) {
        throw new BadRequestException({
          message: 'El parámetro asOf no es una fecha ISO-8601 válida.',
          code: 'ADMIN_TENANT_USAGE_ASOF_INVALID',
        });
      }
    }
    return this.service.getUsage(cutoff);
  }

  @Get(':id')
  @AllowProvisioning()
  @ApiOperation({ summary: 'Detalle de un tenant. Solo super_admin o credencial de provisioning.' })
  async getOne(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    requireAdminActor(user, req);
    return this.service.getDetail(id);
  }

  @Post()
  @AllowProvisioning()
  @ApiOperation({
    summary:
      'Crear tenant + primer tenant_admin + dominio primario. Envía email de bienvenida con link de definir contraseña.',
  })
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantDto,
  ) {
    const actor = requireAdminActor(user, req);
    // Sin escalón TenantDomain: el tenant que se está creando aún no tiene
    // fila en esa tabla (se crea DENTRO de service.create). Cascada normal:
    // env → Host del request → localhost.
    const webBaseUrl = resolveWebBaseUrl(req);
    return this.service.create(actor, dto, webBaseUrl, extractClientContext(req));
  }

  @Patch(':id/status')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Cambiar estado del tenant. SUSPENDED/ARCHIVED invalidan sessions de todos los users.',
  })
  async setStatus(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setStatusSchema)) dto: SetStatusDto,
  ) {
    const actor = requireAdminActor(user, req);
    return this.service.setStatus(actor, id, dto.status, extractClientContext(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Renombrar tenant (`tenant.name`). Afecta firma de emails ("Equipo {name}") y sidebar. Solo super_admin.',
  })
  async rename(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(renameSchema)) dto: RenameDto,
  ) {
    // Sin `@AllowProvisioning()` a propósito: renombrar un tenant es una
    // decisión de negocio del operador humano, no una operación de
    // aprovisionamiento. Cada ruta que no está en la lista blanca es una
    // puerta que la credencial de máquina no abre.
    const u = requireSuperAdmin(user);
    return this.service.rename(
      { kind: 'user', userId: u.sub },
      id,
      dto.name,
      extractClientContext(req),
    );
  }

  @Patch(':id/signups')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Congelar o descongelar las altas nuevas del tenant.',
    description: [
      'Con las altas congeladas, las cuatro puertas de entrada de un miembro nuevo',
      '—invitación individual, alta masiva por CSV, registro público y checkout de',
      'alumno— devuelven **409 `TENANT_SIGNUPS_FROZEN`** con el motivo. Los miembros',
      'que ya están dentro no se ven afectados en nada.',
      '',
      '**Es un interruptor explícito, no un tope.** El núcleo no cuenta miembros, no',
      'mira la licencia y no lo enciende solo: una instalación se queda admitiendo',
      'altas para siempre mientras nadie lo cambie a mano. Un self-hoster lo tiene',
      'para cerrar el grifo cuando su cohorte está llena.',
    ].join('\n'),
  })
  async setSignups(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(signupsSchema)) dto: SignupsDto,
  ) {
    const actor = requireAdminActor(user, req);
    return this.service.setSignupsFrozen(
      actor,
      id,
      dto.frozen,
      dto.reason,
      extractClientContext(req),
    );
  }

  @Put(':id/subscription-gate')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Abrir, poner en prueba o cerrar la puerta de suscripción del aula.',
    description: [
      'Una dimensión **aparte** del estado del tenant: el aula sigue `ACTIVE` para que su',
      'administrador pueda entrar y pagar.',
      '',
      '- `OPEN`: todo como siempre. Borra `trialEndsAt` y `actionUrl`. Es el estado de un',
      '  tenant que nunca recibió esta llamada (Community autoalojada no cambia nada).',
      '- `TRIAL`: el aula funciona y sus administradores ven una franja con los días que',
      '  quedan y el botón «Elegir plan» → `actionUrl`. `trialEndsAt` es obligatorio.',
      '- `LOCKED`: pantalla de pausa para todos y **402 `SUBSCRIPTION_LOCKED`** en la API',
      '  salvo para entrar, saber quién eres, pintar la marca y leer este estado.',
      '',
      'Con `TRIAL` y `trialEndsAt` ya pasado, el aula se comporta como `LOCKED` aunque esta',
      'llamada no se haya repetido. `actionUrl` tiene que ser https en `TRIAL` y `LOCKED`.',
      '',
      'Idempotente: repetir la misma petición no cambia `updatedAt` ni deja otra fila en el',
      'audit log.',
    ].join('\n'),
  })
  async setSubscriptionGate(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(subscriptionGateSchema)) dto: SubscriptionGateDto,
  ) {
    const actor = requireAdminActor(user, req);
    return this.service.setSubscriptionGate(
      actor,
      id,
      {
        state: dto.state,
        trialEndsAt: dto.trialEndsAt ?? null,
        actionUrl: dto.actionUrl ?? null,
      },
      extractClientContext(req),
    );
  }

  @Post(':id/support-access')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Abrir una ventana de acceso de soporte al aula del tenant. Motivo obligatorio.',
    description: [
      'Devuelve un token de **un solo uso** con caducidad de **15 minutos como máximo**',
      '(`ttlSeconds` puede pedir menos, nunca más) y el enlace para canjearlo.',
      '',
      'El canje abre sesión como un **usuario de soporte propio del tenant**, visible en',
      'su lista de miembros — nunca como una persona real: si soporte entrara con la',
      'identidad del cliente, el audit log dejaría de valer como prueba de nada.',
      '',
      'Quedan dos filas en el audit log **del tenant**: la concesión (con el motivo y',
      'quién la abrió) y el canje. El cliente las lee sin pedirle permiso a nadie.',
      '',
      'Mientras la sesión vive, el aula muestra un aviso permanente que no se puede',
      'cerrar. `DELETE` sobre la concesión la corta antes de tiempo y cierra la sesión.',
    ].join('\n'),
  })
  async grantSupportAccess(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(supportAccessSchema)) dto: SupportAccessDto,
  ) {
    const actor = requireAdminActor(user, req);
    // El enlace lleva un token: se resuelve con la variante endurecida, que
    // prefiere el dominio primario verificado del tenant y NUNCA se fía del
    // header Host sin allowlist.
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrlForAuthRedirect(id, req);
    return this.supportAccess.grant(
      actor,
      id,
      {
        reason: dto.reason,
        ...(dto.ttlSeconds !== undefined ? { ttlSeconds: dto.ttlSeconds } : {}),
      },
      webBaseUrl,
      extractClientContext(req),
    );
  }

  @Delete(':id/support-access/:grantId')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Cerrar un acceso de soporte antes de que caduque. Cierra también su sesión.',
    description: [
      'Es la otra mitad de la capacidad de abrirlo. Sin ella, la única forma de',
      'terminar un acceso sería esperar — y esperar no es algo que un operador pueda',
      'hacer cuando se da cuenta de que se ha equivocado de tenant.',
      '',
      'Idempotente: revocar dos veces devuelve `revoked: false` la segunda.',
    ].join('\n'),
  })
  async revokeSupportAccess(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    const actor = requireAdminActor(user, req);
    return this.supportAccess.revoke(actor, id, grantId, extractClientContext(req));
  }

  @Post(':id/domains')
  @AllowProvisioning()
  @ApiOperation({ summary: 'Añadir dominio adicional al tenant.' })
  async addDomain(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(domainSchema)) dto: DomainDto,
  ) {
    const actor = requireAdminActor(user, req);
    return this.service.addDomain(actor, id, dto.hostname, extractClientContext(req));
  }

  @Delete(':id/domains/:hostname')
  @AllowProvisioning()
  @ApiOperation({ summary: 'Quitar dominio del tenant. No permite quitar el primario.' })
  async removeDomain(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Param('hostname') hostname: string,
  ) {
    const actor = requireAdminActor(user, req);
    return this.service.removeDomain(actor, id, hostname, extractClientContext(req));
  }
}

// ============================================================================
// Cobros de plataforma — contrato del pool con `didacta-cloud`
// ============================================================================

/** `PUT /admin/tenants/:id/payouts-settings`. Contrato con `didacta-cloud`. */
export const payoutsSettingsSchema = z.object({
  /** Comisión del operador en puntos básicos: 500 = 5 %. */
  feeBps: z.number().int().min(0).max(3000),
});
type PayoutsSettingsDto = z.infer<typeof payoutsSettingsSchema>;

/** Respuesta de `PUT /admin/tenants/:id/payouts-settings`. */
export interface TenantPayoutsSettingsResponse {
  readonly tenantId: string;
  readonly feeBps: number;
  readonly updatedAt: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (value: string) =>
  DAY.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/** `GET /admin/tenants/payouts/volume?from&to`. Contrato con `didacta-cloud`. */
export const payoutsVolumeQuerySchema = z
  .object({
    /** Primer día (UTC), incluido. */
    from: z.string().refine(isRealDay, 'Fecha YYYY-MM-DD'),
    /** Último día (UTC), incluido. */
    to: z.string().refine(isRealDay, 'Fecha YYYY-MM-DD'),
  })
  .refine((q) => q.from <= q.to, {
    message: '`from` no puede ser posterior a `to`',
    path: ['from'],
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 365 * 86_400_000, {
    message: 'Como mucho 366 días por consulta',
    path: ['to'],
  });
type PayoutsVolumeQuery = z.infer<typeof payoutsVolumeQuerySchema>;

/** Fila de `GET /admin/tenants/payouts/volume`. Importes en unidad mínima de `currency`. */
export interface TenantPayoutsVolumeRow {
  readonly tenantId: string;
  /** `YYYY-MM-DD`, día UTC del cobro. */
  readonly day: string;
  /** Divisa de liquidación, minúsculas. */
  readonly currency: string;
  readonly gmv: number;
  readonly stripeFees: number;
  readonly platformFees: number;
  readonly refunds: number;
  readonly disputes: number;
  readonly salesCount: number;
}

/** Respuesta de `GET /admin/tenants/:id/payouts`. */
export interface TenantPayoutsResponse {
  readonly tenantId: string;
  /** `platform` | `own` (claves propias heredadas) | `none`. */
  readonly mode: 'platform' | 'own' | 'none';
  /** Estado de la cuenta conectada (`NOT_CONNECTED` si no hay). */
  readonly status: string;
  /** País de la cuenta conectada, o `null`. */
  readonly country: string | null;
  readonly feeBps: number;
  /** Deuda abierta del creador por divisa, en unidad mínima. */
  readonly debtOutstanding: ReadonlyArray<{ currency: string; amount: number }>;
}

/**
 * Las dos rutas de cobros de plataforma del contrato del pool. Viven en una
 * clase APARTE de `AdminTenantsController` porque solo existen con el modo
 * plataforma encendido: las registra `PayoutsModule.register()`, y sin
 * `PAYMENTS_PLATFORM_STRIPE_SECRET_KEY` la instalación tiene exactamente las
 * mismas rutas que antes. Mismo guard, misma regla de actor y misma marca
 * `@AllowProvisioning()` que el resto del contrato.
 */
@ApiTags('Admin · Tenants · Cobros')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(JwtOrProvisioningGuard)
export class AdminTenantsPayoutsController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  // OJO: `payouts/volume` va ANTES de las rutas con `:id`, igual que `usage`
  // en el controller de siempre.
  @Get('payouts/volume')
  @AllowProvisioning()
  @ApiOperation({
    summary:
      'Volumen cobrado por la plataforma, por aula, día (UTC del cobro) y divisa de liquidación, entre `from` y `to` (ambos incluidos, YYYY-MM-DD, máx. 366 días).',
    description:
      'Una venta cuenta cuando su reparto se conoce: conviene volver a pedir los últimos días. Nunca suma divisas distintas.',
  })
  async getPayoutsVolume(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(payoutsVolumeQuerySchema)) query: PayoutsVolumeQuery,
  ): Promise<TenantPayoutsVolumeRow[]> {
    requireAdminActor(user, req);
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const toExclusive = new Date(Date.parse(`${query.to}T00:00:00.000Z`) + 86_400_000);
    return this.runtime.reports.volume(from, toExclusive);
  }

  @Put(':id/payouts-settings')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Fijar la comisión del operador de un aula (puntos básicos, 0–3000).',
    description:
      'Idempotente: repetir el mismo valor no escribe ni mueve `updatedAt`. Solo existe con el modo plataforma encendido.',
  })
  async setPayoutsSettings(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(payoutsSettingsSchema)) dto: PayoutsSettingsDto,
  ): Promise<TenantPayoutsSettingsResponse> {
    const actor = requireAdminActor(user, req);
    await this.requireTenant(id);
    const result = await this.runtime.settings.setFeeBps(id, dto.feeBps, auditActorId(actor));
    if (result.changed) {
      const client = extractClientContext(req);
      await runAsTenant(id, () =>
        this.auditLog.record({
          tenantId: id,
          actorId: auditActorId(actor),
          action: 'payouts.settings.fee_changed',
          resourceType: 'tenant',
          resourceId: id,
          metadata: {
            previousFeeBps: result.previousFeeBps,
            feeBps: result.feeBps,
            ...auditActorTrace(actor),
          },
          ip: client.ip ?? undefined,
          userAgent: client.userAgent ?? undefined,
        }),
      );
    }
    return { tenantId: id, feeBps: result.feeBps, updatedAt: result.updatedAt! };
  }

  @Get(':id/payouts')
  @AllowProvisioning()
  @ApiOperation({
    summary: 'Modo de cobro, estado de la cuenta conectada, comisión y deuda abierta de un aula.',
  })
  async getPayouts(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ): Promise<TenantPayoutsResponse> {
    requireAdminActor(user, req);
    await this.requireTenant(id);
    return runAsTenant(id, async () => {
      const [mode, account, settings, debtOutstanding] = await Promise.all([
        this.runtime.mode.resolve(id),
        this.runtime.accounts.getAccount(id),
        this.runtime.settings.get(id),
        this.runtime.settings.debtOutstanding(id),
      ]);
      return {
        tenantId: id,
        mode: mode.mode,
        status: account?.status ?? 'NOT_CONNECTED',
        country: account?.country ?? null,
        feeBps: settings.feeBps,
        debtOutstanding,
      };
    });
  }

  private async requireTenant(id: string): Promise<void> {
    const uuid = z.string().uuid().safeParse(id);
    const tenant = uuid.success
      ? await runGlobalWithoutTenant(() =>
          this.runtime.prisma.tenant.findFirst({
            where: { id, deletedAt: null },
            select: { id: true },
          }),
        )
      : null;
    if (!tenant) {
      throw new NotFoundException({
        message: 'Tenant no encontrado.',
        code: 'ADMIN_TENANT_NOT_FOUND',
      });
    }
  }
}
