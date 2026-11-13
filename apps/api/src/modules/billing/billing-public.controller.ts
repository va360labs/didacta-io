/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { CourseOfferOption } from '@didacta/mod-billing';
import { extractClientContext } from '../../auth/client-context';
import { readRequestLocale } from '../../common/checkout-locale';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { assertSignupsAllowed } from '../../tenancy/signup-freeze';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PurchaseConsentService } from '../purchase-consent/purchase-consent.service';
import {
  withdrawalWaiverSchema,
  type WithdrawalWaiverDto,
} from '../purchase-consent/withdrawal-waiver';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
  withLocalCurrencyHint,
} from '../payouts/platform-checkout-gate';
import { resolvePublicHost } from '../../common/resolve-public-host';

const uuidSchema = z.string().uuid();

/**
 * Un id malformado en la ruta produciría un P2023 de Prisma (columna Uuid) que
 * el filtro de dominio no captura → 500. Mismo criterio que mod.resources: un
 * id que no es UUID es, simplemente, un curso que no existe.
 */
function ensureUuid(id: string): string {
  if (!uuidSchema.safeParse(id).success) {
    throw new NotFoundException({
      message: 'Curso no encontrado.',
      code: 'BILLING_COURSE_NOT_FOUND',
    });
  }
  return id;
}

/** Cuerpo del checkout público: opción elegida y email para precargar Stripe. */
const publicCheckoutSchema = z
  .object({
    optionId: z.string().uuid().optional(),
    /**
     * Email OPCIONAL para precargar el checkout. No es dato de confianza y no
     * se usa para nada más: la cuenta se crea con el email CONFIRMADO en el
     * propio checkout (session.customer_details.email del webhook).
     */
    email: z.string().email().max(200).optional(),
    /**
     * La casilla marcada antes de pagar: pide acceso inmediato y reconoce que
     * pierde el desistimiento de 14 días. Obligatoria (422 si falta).
     */
    withdrawalWaiver: withdrawalWaiverSchema.optional(),
    /**
     * Código del enlace de referido (`?ref=` de la página de venta). OPCIONAL y
     * opaco para la venta: viaja en la metadata de Stripe y lo interpreta
     * mod.referrals al completarse el pago. Mismo formato que en la membresía.
     */
    referralCode: z
      .string()
      .trim()
      .regex(/^[a-z0-9]{3,32}$/i)
      .optional(),
  })
  .strict()
  .optional()
  .transform((v) => v ?? {});
type PublicCheckoutDto = {
  optionId?: string;
  email?: string;
  withdrawalWaiver?: WithdrawalWaiverDto;
  referralCode?: string;
};

/** Curso del catálogo público, con lo justo para la ficha de venta. */
interface PublicCatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  /**
   * Solo con el modo plataforma encendido, cada opción lleva además
   * `localCurrencyAtCheckout` (¿la verá el alumno en su moneda al pagar?).
   * Sin él (Community), las opciones son las del módulo tal cual.
   */
  options: Array<CourseOfferOption & { localCurrencyAtCheckout?: boolean }>;
}

/**
 * Endpoints PÚBLICOS de la venta de cursos sueltos (viaje 2).
 *
 * Sin JWT: el visitante aún no tiene cuenta — el tenant se resuelve por el
 * Host del request, igual que la página de membresía (/unete) y el registro.
 * El checkout es de Stripe hosted: aquí solo se genera la URL de la session;
 * la cuenta se materializa en el webhook tras el pago (provisioning).
 *
 * El catálogo y la oferta son datos propios (no dependen de Stripe): se
 * sirven aunque el tenant no haya configurado sus credenciales todavía. Solo
 * el checkout necesita Stripe — sin credenciales (ni propias del tenant en
 * Administración → Pagos ni fallback de instancia) responde 503.
 */
@ApiTags('Billing · Público')
@Controller('modules/billing/public')
export class BillingPublicController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
    private readonly prisma: PrismaService,
    /** Renuncia al desistimiento: prueba antes de pagar y confirmación después. */
    private readonly consents: PurchaseConsentService,
    /**
     * Solo con el modo plataforma encendido: si el aula cobra por la plataforma
     * y su cuenta aún no puede vender, nada está a la venta.
     */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  @Get('catalog')
  @ApiOperation({
    summary:
      'Catálogo público de cursos a la venta: cursos PUBLISHED con opciones de compra activas y precios. Tenant por Host.',
  })
  async catalog(@Req() req: FastifyRequest): Promise<{ courses: PublicCatalogCourse[] }> {
    const tenantId = await this.resolveTenantId(req);
    // RLS F2: ruta pública sin middleware de tenant — el cuerpo corre bajo el
    // ALS del tenant resuelto por Host para que cada query quede escopada.
    return runAsTenant(tenantId, async () => {
      // Cobros de plataforma sin terminar de conectar: no se ofrece nada.
      const checkoutInfo = await this.payoutsGate?.publicCheckoutInfo(tenantId);
      if (checkoutInfo?.blockedReason) return { courses: [] };
      const billing = this.registry.getBillingService();
      const ofertas = await billing.getCatalog(tenantId);
      if (ofertas.length === 0) return { courses: [] };

      // Cruce con mod.courses en el HOST (lectura first-party con tenant_id;
      // el paquete de billing no toca tablas de otros módulos). Solo cursos
      // publicados y no borrados llegan al catálogo público.
      const optionsByCourse = new Map(ofertas.map((o) => [o.courseId, o.options]));
      const cursos = await this.prisma.modCoursesCourse.findMany({
        where: {
          id: { in: [...optionsByCourse.keys()] },
          tenantId,
          status: 'PUBLISHED',
          deletedAt: null,
        },
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          thumbnailUrl: true,
          category: true,
          estimatedMinutes: true,
        },
      });
      return {
        courses: cursos.map((c) => ({
          id: c.id,
          slug: c.slug,
          title: c.title,
          description: c.description,
          thumbnailUrl: c.thumbnailUrl,
          category: c.category,
          estimatedMinutes: c.estimatedMinutes,
          options: checkoutInfo
            ? withLocalCurrencyHint(optionsByCourse.get(c.id) ?? [], checkoutInfo)
            : (optionsByCourse.get(c.id) ?? []),
        })),
      };
    });
  }

  @Get('offer/:courseId')
  @ApiOperation({
    summary:
      'Oferta pública de un curso: si está a la venta, sus opciones con precio y descuento. Devuelve forSale=false (200) si el curso no se vende o no está publicado.',
  })
  async offer(@Req() req: FastifyRequest, @Param('courseId') courseId: string) {
    const tenantId = await this.resolveTenantId(req);
    ensureUuid(courseId);
    return runAsTenant(tenantId, async () => {
      // Un curso no publicado no expone su oferta a visitantes: misma respuesta
      // neutra que un curso sin precio (no filtra si el curso existe o no).
      const curso = await this.prisma.modCoursesCourse.findFirst({
        where: { id: courseId, tenantId, status: 'PUBLISHED', deletedAt: null },
        select: { id: true },
      });
      if (!curso) return { forSale: false, options: [] };
      // El aula cobra por la plataforma y su cuenta aún no puede vender.
      const checkoutInfo = await this.payoutsGate?.publicCheckoutInfo(tenantId);
      if (checkoutInfo?.blockedReason) {
        return { forSale: false, options: [], reason: PAYOUTS_NOT_READY_OFFER_REASON };
      }
      const offer = await this.registry.getBillingService().getCourseOffer(tenantId, courseId);
      // Sin modo plataforma la oferta sale tal cual (Community no cambia).
      return checkoutInfo
        ? { ...offer, options: withLocalCurrencyHint(offer.options, checkoutInfo) }
        : offer;
    });
  }

  @Post('checkout/:courseId')
  @ApiOperation({
    summary:
      'Inicia el checkout ANÓNIMO de un curso: crea la Checkout Session de Stripe y devuelve su URL. La cuenta del comprador se crea tras el pago con el email confirmado en Stripe.',
  })
  async checkout(
    @Req() req: FastifyRequest,
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(publicCheckoutSchema)) dto: PublicCheckoutDto,
  ) {
    const tenantId = await this.resolveTenantId(req);
    ensureUuid(courseId);
    return runAsTenant(tenantId, async () => {
      // U7: puerta 4 de 4. Antes que ninguna otra guarda: cobrarle a alguien
      // que despues no va a poder entrar es el peor orden posible.
      await assertSignupsAllowed(this.prisma, tenantId);
      // Guardas ANTES de mandar a nadie a pagar (mismo criterio que el checkout
      // logueado): sin esto se puede cobrar por un curso despublicado cuya
      // matriculación posterior fallaría siempre.
      const curso = await this.prisma.modCoursesCourse.findFirst({
        where: { id: courseId, tenantId, deletedAt: null },
        select: { status: true, title: true },
      });
      if (!curso)
        throw new NotFoundException({
          message: 'Curso no encontrado.',
          code: 'BILLING_COURSE_NOT_FOUND',
        });
      if (curso.status !== 'PUBLISHED') {
        throw new ConflictException({
          message: 'Este curso no está disponible para la compra.',
          code: 'BILLING_COURSE_NOT_PURCHASABLE',
        });
      }

      const billing = this.registry.getBillingService();
      // Modo plataforma: 409 PAYOUTS_NOT_READY si la cuenta no puede vender
      // (antes de crear la orden), y precios del curso en la cuenta del operador.
      await this.payoutsGate?.prepareCheckout(tenantId, courseId, billing);

      // La casilla de la renuncia al desistimiento, con el texto vigente: sin
      // ella no se crea la orden ni la sesión de pago (422/409).
      const consentId = await this.consents.accept({
        req,
        tenantId,
        purchaseKind: 'course',
        itemRef: courseId,
        itemName: curso.title,
        userId: null,
        buyerEmail: dto.email ?? null,
        waiver: dto.withdrawalWaiver,
      });

      const base = (await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req)).replace(
        /\/$/,
        '',
      );
      const result = await billing.startCheckout({
        tenantId,
        userId: null,
        userEmail: dto.email,
        courseId,
        optionId: dto.optionId,
        // Idioma con el que el comprador está navegando AHORA. Viaja en la
        // metadata de Stripe porque su fila de `user` no existe todavía: se
        // crea en el webhook, después del salto a la pasarela.
        locale: readRequestLocale(req.headers),
        // Enlace de referido: opaco aquí; lo valida mod.referrals (código del
        // aula, sin autorreferidos) cuando el pago se completa.
        ...(dto.referralCode ? { referralCode: dto.referralCode.toLowerCase() } : {}),
        // Retorno a las páginas PÚBLICAS del catálogo: el comprador aún no tiene
        // sesión y las de /cursos/checkout viven tras el gate de login.
        successUrl: `${base}/catalogo/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/catalogo/checkout/cancel`,
      });
      await this.consents.attachSession(tenantId, consentId, {
        sessionId: result.sessionId,
        orderId: result.orderId,
      });
      // Client context solo para trazabilidad en logs de acceso (no se persiste aquí).
      void extractClientContext(req);
      return { url: result.url, sessionId: result.sessionId };
    });
  }

  /** Tenant por dominio (Host / X-Forwarded-Host), como MembershipPublicController. */
  private async resolveTenantId(req: FastifyRequest): Promise<string> {
    const hostStr = resolvePublicHost(req);
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new NotFoundException({
        message: 'Comunidad no encontrada para este dominio.',
        code: 'BILLING_TENANT_NOT_FOUND',
      });
    }
    return tenant.id;
  }
}
