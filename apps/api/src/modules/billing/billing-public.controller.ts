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
import { sanitizeRichText } from '@didacta/core-kernel';
import { toCheckoutLocale, type CourseOfferOption } from '@didacta/mod-billing';
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
import {
  checkoutSessionNotFound,
  checkoutUiModeSchema,
  ensureCheckoutSessionId,
  type PublicCheckoutResponse,
} from '../checkout-ui';
import { listCoursesForSale, type CoursesForSaleDb } from './public-catalog';

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
    /**
     * El precio que el comprador tiene delante (unidad mínima + moneda de la
     * opción). Si ya no es el de ahora: 409 BILLING_PRICE_CHANGED, sin cobrar
     * otro importe (la página de venta abierta enseñaba 29 € y se cobró 1 €).
     */
    expectedPrice: z
      .object({
        unitAmount: z.number().int().nonnegative(),
        currency: z.string().trim().length(3),
      })
      .strict()
      .optional(),
    /**
     * `embedded`: la ficha quiere pintar el pago dentro de la página del aula.
     * Se concede si hay clave publicable para la cuenta que cobra; si no, la
     * respuesta es el redirect de siempre (`mode: 'hosted'`).
     */
    uiMode: checkoutUiModeSchema,
  })
  .strict()
  .optional()
  .transform((v) => v ?? {});
type PublicCheckoutDto = {
  optionId?: string;
  email?: string;
  withdrawalWaiver?: WithdrawalWaiverDto;
  referralCode?: string;
  expectedPrice?: { unitAmount: number; currency: string };
  uiMode?: 'embedded' | 'hosted';
};

/**
 * Lo que la vuelta del pago (la pantalla de gracias) puede saber de él: si se
 * pagó, qué se compró, cuánto y cuándo. Nunca el id de la sesión de Stripe
 * (ya lo trae la URL, y no le sirve de nada al comprador).
 */
interface PublicCheckoutSessionView {
  status: 'open' | 'complete' | 'expired' | null;
  paid: boolean;
  amount: number | null;
  currency: string | null;
  at: string | null;
  course: { title: string; slug: string; thumbnailUrl: string | null } | null;
}

/** Curso del catálogo público, con lo justo para la ficha de venta. */
interface PublicCatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  /**
   * La descripción saneada por el servidor (`sanitizeRichText`, la frontera
   * autoritativa). La usa la ficha cuando se pinta en el servidor del web.
   */
  descriptionHtml: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  /**
   * Temario: las secciones del curso con los TÍTULOS de sus lecciones, en
   * orden. Solo títulos (nunca el contenido): es lo que la ficha pública enseña
   * para que quien compra sepa qué se lleva, aunque el curso no tenga
   * descripción. Sin secciones con lecciones, lista vacía.
   */
  syllabus: Array<{ title: string; lessons: string[] }>;
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
 * Host del request, igual que la página de membresía (/join) y el registro.
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
      // La regla de «qué está a la venta» es UNA (`listCoursesForSale`): la
      // misma que decide qué fichas van al sitemap del aula (`public/seo`).
      const { checkoutInfo, courses } = await listCoursesForSale(
        {
          prisma: this.prisma as unknown as CoursesForSaleDb,
          billing: this.registry.getBillingService(),
          payoutsGate: this.payoutsGate,
        },
        tenantId,
      );
      const syllabus = await this.syllabusOf(
        tenantId,
        courses.map(({ course }) => course.id),
      );
      return {
        courses: courses.map(({ course: c, options }) => ({
          id: c.id,
          slug: c.slug,
          title: c.title,
          description: c.description,
          // Saneado AQUÍ, en la frontera del servidor: la ficha se pinta en el
          // servidor del web para que su texto esté en el HTML (buscadores), y
          // allí no hay DOM para el DOMPurify del navegador.
          descriptionHtml: c.description ? sanitizeRichText(c.description) : null,
          thumbnailUrl: c.thumbnailUrl,
          category: c.category,
          estimatedMinutes: c.estimatedMinutes,
          syllabus: syllabus.get(c.id) ?? [],
          options: checkoutInfo ? withLocalCurrencyHint(options, checkoutInfo) : options,
        })),
      };
    });
  }

  /**
   * Temario de los cursos a la venta: secciones y títulos de lección, sin
   * borradas, en orden. Dos consultas de primer nivel (no un `include`) para
   * que las dos pasen por el filtro de aula de RLS.
   */
  private async syllabusOf(
    tenantId: string,
    courseIds: string[],
  ): Promise<Map<string, Array<{ title: string; lessons: string[] }>>> {
    const out = new Map<string, Array<{ title: string; lessons: string[] }>>();
    if (courseIds.length === 0) return out;
    const sections = await this.prisma.modCoursesModule.findMany({
      where: { tenantId, courseId: { in: courseIds }, deletedAt: null },
      orderBy: [{ courseId: 'asc' }, { position: 'asc' }],
      select: { id: true, courseId: true, title: true },
    });
    if (sections.length === 0) return out;
    const lessons = await this.prisma.modCoursesLesson.findMany({
      where: { tenantId, moduleId: { in: sections.map((m) => m.id) }, deletedAt: null },
      orderBy: [{ moduleId: 'asc' }, { position: 'asc' }],
      select: { moduleId: true, title: true },
    });
    const bySection = new Map<string, string[]>();
    for (const l of lessons) {
      const list = bySection.get(l.moduleId) ?? [];
      list.push(l.title);
      bySection.set(l.moduleId, list);
    }
    for (const m of sections) {
      const titles = bySection.get(m.id) ?? [];
      if (titles.length === 0) continue;
      const list = out.get(m.courseId) ?? [];
      list.push({ title: m.title, lessons: titles });
      out.set(m.courseId, list);
    }
    return out;
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
  ): Promise<PublicCheckoutResponse> {
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
      // ¿Sigue valiendo el precio que tiene delante? Antes de guardar su casilla.
      const expectedPrice = dto.expectedPrice;
      if (expectedPrice) {
        await billing.assertCurrentPrice({
          tenantId,
          courseId,
          optionId: dto.optionId,
          expectedPrice,
        });
      }

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
      // Pago dentro de la ficha si la página lo pide y hay clave publicable de
      // la cuenta que cobra (plataforma o claves propias del aula).
      const publishableKey =
        dto.uiMode === 'embedded'
          ? await this.registry.resolveCheckoutPublishableKey(tenantId)
          : null;
      const requestLocale = readRequestLocale(req.headers);
      const result = await billing.startCheckout({
        tenantId,
        userId: null,
        userEmail: dto.email,
        courseId,
        optionId: dto.optionId,
        // Idioma con el que el comprador está navegando AHORA. Viaja en la
        // metadata de Stripe porque su fila de `user` no existe todavía: se
        // crea en el webhook, después del salto a la pasarela.
        locale: requestLocale,
        // La pantalla de pago de Stripe, en el idioma en que se navega el aula.
        ...(toCheckoutLocale(requestLocale)
          ? { checkoutLocale: toCheckoutLocale(requestLocale) }
          : {}),
        // Enlace de referido: opaco aquí; lo valida mod.referrals (código del
        // aula, sin autorreferidos) cuando el pago se completa.
        ...(dto.referralCode ? { referralCode: dto.referralCode.toLowerCase() } : {}),
        ...(dto.expectedPrice ? { expectedPrice: dto.expectedPrice } : {}),
        // Retorno a las páginas PÚBLICAS del catálogo: el comprador aún no tiene
        // sesión y las de /courses/checkout viven tras el gate de login.
        successUrl: `${base}/catalog/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/catalog/checkout/cancel`,
        // Embebido: una sola vuelta, la de gracias, que PREGUNTA si se pagó
        // (Stripe vuelve aquí también si un medio con redirección falla).
        ...(publishableKey
          ? {
              uiMode: 'embedded' as const,
              returnUrl: `${base}/catalog/checkout/success?session_id={CHECKOUT_SESSION_ID}&checkout=embedded`,
            }
          : {}),
      });
      await this.consents.attachSession(tenantId, consentId, {
        sessionId: result.sessionId,
        orderId: result.orderId,
      });
      // Client context solo para trazabilidad en logs de acceso (no se persiste aquí).
      void extractClientContext(req);
      if (publishableKey && result.clientSecret) {
        return {
          mode: 'embedded',
          sessionId: result.sessionId,
          url: null,
          clientSecret: result.clientSecret,
          publishableKey,
          amountTotal: result.amountTotal,
          currency: result.currency,
        };
      }
      return { mode: 'hosted', url: result.url ?? '', sessionId: result.sessionId };
    });
  }

  @Get('checkout-session/:sessionId')
  @ApiOperation({
    summary:
      'Vuelta del pago (pantalla de gracias): si la sesión de ESTA academia está pagada, qué curso se compró, cuánto y cuándo. No concede nada (el acceso lo da el webhook). 404 si la sesión no es de una compra de esta academia.',
  })
  async checkoutSession(
    @Req() req: FastifyRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<PublicCheckoutSessionView> {
    ensureCheckoutSessionId(sessionId);
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const state = await this.registry
        .getBillingService()
        .getCheckoutSessionState(tenantId, sessionId);
      if (!state) throw checkoutSessionNotFound();
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: state.courseId, tenantId },
        select: { title: true, slug: true, thumbnailUrl: true },
      });
      return {
        status: state.status,
        paid: state.paid,
        amount: state.amount,
        currency: state.currency,
        at: state.at,
        course: course
          ? { title: course.title, slug: course.slug, thumbnailUrl: course.thumbnailUrl }
          : null,
      };
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
