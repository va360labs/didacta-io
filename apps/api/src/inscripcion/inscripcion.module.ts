/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { EmailVerificationService } from './email-verification.service';
import { InscripcionAdminController } from './inscripcion-admin.controller';
import { InscripcionController } from './inscripcion.controller';
import { MemberDecisionService } from './member-decision.service';
import { MemberPaymentFlagService } from './member-payment-flag.service';
import { MemberPurgeWorker } from './member-purge.worker';
import { MemberRegistrationSettingsService } from './member-registration-settings.service';
import { MemberRegistrationService } from './member-registration.service';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';
import { PaymentFlagController } from './payment-flag.controller';
import { TelegramService } from './telegram.service';

/**
 * Inscripción de miembros con verificadores componibles por tenant (Telegram
 * y/u OTP por email, o registro libre) + validación manual.
 *
 * Infra CORE del host (NO un módulo de marketplace): conecta los verificadores,
 * la política del tenant y la validación manual con el alta de usuario.
 *
 * Importa:
 * - AuthModule → PasswordService, PrismaAuditLogService, SmtpAdapterService,
 *   TenantSmtpResolverService, PrismaTenantConfigService, JwtAuthGuard (todos
 *   exportados por AuthModule).
 * - ModulesModule → ModuleRegistryService (acceso a mod.learning / mod.courses).
 *
 * TenantResolverService y PrismaService se inyectan desde sus módulos globales,
 * así que NO se redeclaran aquí (evita instancias duplicadas / providers globales).
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [InscripcionController, InscripcionAdminController, PaymentFlagController],
  providers: [
    TelegramService,
    EmailVerificationService,
    MemberRegistrationSettingsService,
    MemberRegistrationService,
    MemberDecisionService,
    MemberPaymentFlagService,
    MemberSubscriptionLookupService,
    MemberPurgeWorker,
  ],
})
export class InscripcionModule {}
