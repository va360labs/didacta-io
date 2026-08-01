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
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { BillingService, CourseOfferOption } from '@didacta/mod-billing';
import { extractClientContext } from '../../auth/client-context';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';

const uuidSchema = z.string().uuid();

/**
 * Un id malformado en la ruta produciría un P2023 de Prisma (columna Uuid) que
 * el filtro de dominio no captura → 500. Mismo criterio que mod.resources: un
 * id que no es UUID es, simplemente, un curso que no existe.
 */
function ensureUuid(id: string): string {
  if (!uuidSchema.safeParse(id).success) {
    throw new NotFoundException('Curso no encontrado.');
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
  })
  .strict()
  .optional()
  .transform((v) => v ?? {});
type PublicCheckoutDto = { optionId?: string; email?: string };

/** Curso del catálogo público, con lo justo para la ficha de venta. */
interface PublicCatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  options: CourseOfferOption[];
}

/**
 * Endpoints PÚBLICOS de la venta de cursos sueltos (viaje 2).
 *
 * Sin JWT: el visitante aún no tiene cuenta — el tenant se resuelve por el
 * Host del request, igual que la página de membresía (/unete) y el registro.
 * El checkout es de Stripe hosted: aquí solo se genera la URL de la session;
 * la cuenta se materializa en el webhook tras el pago (provisioning).
 *
 * Si mod.billing no está configurado (sin claves Stripe), el catálogo y la
 * oferta responden VACÍOS (la página pública sigue renderizando) y el checkout
 * responde 503.
 */
@ApiTags('Billing · Público')
@Controller('modules/billing/public')
export class BillingPublicController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('catalog')
  @ApiOperation({
    summary:
      'Catálogo público de cursos a la venta: cursos PUBLISHED con opciones de compra activas y precios. Tenant por Host. Sin Stripe configurado devuelve lista vacía.',
  })
  async catalog(@Req() req: FastifyRequest): Promise<{ courses: PublicCatalogCourse[] }> {
    const tenantId = await this.resolveTenantId(req);
    let billing: BillingService;
    try {
      billing = this.registry.getBillingService();
    } catch {
      return { courses: [] };
    }
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
        options: optionsByCourse.get(c.id) ?? [],
      })),
    };
  }

  @Get('offer/:courseId')
  @ApiOperation({
    summary:
      'Oferta pública de un curso: si está a la venta, sus opciones con precio y descuento. Devuelve forSale=false (200) si el curso no se vende o no está publicado.',
  })
  async offer(@Req() req: FastifyRequest, @Param('courseId') courseId: string) {
    const tenantId = await this.resolveTenantId(req);
    ensureUuid(courseId);
    // Un curso no publicado no expone su oferta a visitantes: misma respuesta
    // neutra que un curso sin precio (no filtra si el curso existe o no).
    const curso = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId, status: 'PUBLISHED', deletedAt: null },
      select: { id: true },
    });
    if (!curso) return { forSale: false, options: [] };
    try {
      return await this.registry.getBillingService().getCourseOffer(tenantId, courseId);
    } catch {
      return { forSale: false, options: [] };
    }
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

    // Guardas ANTES de mandar a nadie a pagar (mismo criterio que el checkout
    // logueado): sin esto se puede cobrar por un curso despublicado cuya
    // matriculación posterior fallaría siempre.
    const curso = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { status: true },
    });
    if (!curso) throw new NotFoundException('Curso no encontrado.');
    if (curso.status !== 'PUBLISHED') {
      throw new ConflictException('Este curso no está disponible para la compra.');
    }

    let billing: BillingService;
    try {
      billing = this.registry.getBillingService();
    } catch {
      throw new ServiceUnavailableException(
        'La pasarela de pago no está configurada en esta plataforma.',
      );
    }

    const base = resolveWebBaseUrl(req).replace(/\/$/, '');
    const result = await billing.startCheckout({
      tenantId,
      userId: null,
      userEmail: dto.email,
      courseId,
      optionId: dto.optionId,
      // Retorno a las páginas PÚBLICAS del catálogo: el comprador aún no tiene
      // sesión y las de /cursos/checkout viven tras el gate de login.
      successUrl: `${base}/catalogo/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/catalogo/checkout/cancel`,
    });
    // Client context solo para trazabilidad en logs de acceso (no se persiste aquí).
    void extractClientContext(req);
    return { url: result.url, sessionId: result.sessionId };
  }

  /** Tenant por dominio (Host / X-Forwarded-Host), como MembershipPublicController. */
  private async resolveTenantId(req: FastifyRequest): Promise<string> {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new NotFoundException('Comunidad no encontrada para este dominio.');
    }
    return tenant.id;
  }
}
