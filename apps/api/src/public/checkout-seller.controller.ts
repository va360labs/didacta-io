/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { resolvePublicHost } from '../common/resolve-public-host';
import { ModuleContextFactory } from '../modules/module-context.factory';
import {
  SENDER_SETTING_KEY,
  SENDER_SETTING_MODULE,
  sanitizeReplyTo,
  type TenantSenderSetting,
} from '../modules/smtp-sender-identity';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { AcademyHomeService } from './academy-home.service';

/** Quién vende, para las señales de confianza de la página de pago. */
export interface CheckoutSellerView {
  /** Nombre del aula (quien vende). */
  name: string;
  /** Quien la lleva: nombre público y foto (nunca su correo). */
  creator: { name: string; avatarUrl: string | null } | null;
  /**
   * El «correo para respuestas» que el aula configuró (Ajustes → Correo), o
   * `null`. Es el mismo al que llegan las respuestas a sus correos; si no lo
   * configuró NO se cae al correo de su administrador: ese no se publica.
   */
  contactEmail: string | null;
}

/**
 * Quién vende en esta aula, SIN sesión: lo que la página de pago enseña junto
 * al formulario («Vende», «Contacto») para que quien paga sepa con quién trata.
 *
 * El aula sale del dominio de la petición, como el resto de la superficie
 * pública; no hay parámetro que elija otra. Solo datos publicables: el nombre
 * del aula, el nombre público y la foto de quien la lleva (la misma regla que
 * la portada) y el correo de contacto que el aula eligió.
 */
@ApiTags('Sitio público')
@Controller('public')
export class CheckoutSellerController {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly home: AcademyHomeService,
    private readonly modules: ModuleContextFactory,
  ) {}

  @Get('checkout-seller')
  @ApiOperation({
    summary:
      'Quién vende en el aula del dominio de la petición: nombre del aula, quien la lleva y el correo de contacto que el aula configuró. Sin sesión.',
  })
  @ApiResponse({ status: 404, description: 'El dominio no es de ningún aula activa.' })
  async seller(@Req() req: FastifyRequest): Promise<CheckoutSellerView> {
    const tenant = await this.tenantResolver.resolveByHost(resolvePublicHost(req));
    if (!tenant) {
      throw new NotFoundException({
        message: 'Academia no encontrada para este dominio.',
        code: 'CHECKOUT_SELLER_NOT_FOUND',
      });
    }
    return runAsTenant(
      tenant.id,
      async () => {
        const [creator, contactEmail] = await Promise.all([
          this.home.creator(tenant.id).catch(() => null),
          this.contactEmail(tenant.id),
        ]);
        return { name: tenant.name, creator, contactEmail };
      },
      { traceLabel: 'checkout-seller' },
    );
  }

  private async contactEmail(tenantId: string): Promise<string | null> {
    try {
      const raw = (await this.modules
        .getTenantConfig()
        .get(tenantId, SENDER_SETTING_MODULE, SENDER_SETTING_KEY)) as
        | Partial<TenantSenderSetting>
        | undefined;
      return sanitizeReplyTo(raw?.replyToEmail);
    } catch {
      return null;
    }
  }
}
