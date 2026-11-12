/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PurchaseConsentController } from './purchase-consent.controller';
import { PurchaseConsentService } from './purchase-consent.service';

/**
 * Consentimiento del comprador antes de pagar contenido digital (renuncia al
 * desistimiento) y su confirmación por correo. Global: lo usan los
 * controladores de compra de billing y de suscripciones y los tres webhooks de
 * Stripe, sin que ninguno de esos módulos sepa de los otros.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [PurchaseConsentController],
  providers: [PurchaseConsentService],
  exports: [PurchaseConsentService],
})
export class PurchaseConsentModule {}
