/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { SaleEmailsController } from '../sale-emails/sale-emails.controller';
import { SaleEmailsService } from '../sale-emails/sale-emails.service';
import { PurchaseConsentController } from './purchase-consent.controller';
import { PurchaseConsentService } from './purchase-consent.service';

/**
 * Consentimiento del comprador antes de pagar contenido digital (renuncia al
 * desistimiento) y su confirmación por correo. Global: lo usan los
 * controladores de compra de billing y de suscripciones y los tres webhooks de
 * Stripe, sin que ninguno de esos módulos sepa de los otros.
 *
 * Aquí viven también los correos de VENTA al comprador (`SaleEmailsService`):
 * el recibo de cada compra —que es esa confirmación—, el de cada renovación y
 * el aviso de cobro fallido, y su edición desde el panel.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [PurchaseConsentController, SaleEmailsController],
  providers: [PurchaseConsentService, SaleEmailsService],
  exports: [PurchaseConsentService, SaleEmailsService],
})
export class PurchaseConsentModule {}
