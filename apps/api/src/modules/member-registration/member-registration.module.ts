/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { EmailVerificationService } from './email-verification.service';
import { MemberDecisionService } from './member-decision.service';
import { MemberPaymentFlagService } from './member-payment-flag.service';
import { MemberPurgeWorker } from './member-purge.worker';
import { MemberRegistrationAdminController } from './member-registration-admin.controller';
import { MemberRegistrationEventsService } from './member-registration-events.service';
import { MemberRegistrationPublicController } from './member-registration-public.controller';
import { MemberRegistrationSettingsService } from './member-registration-settings.service';
import { MemberRegistrationService } from './member-registration.service';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';
import { PaymentFlagController } from './payment-flag.controller';
import { TelegramService } from './telegram.service';

/**
 * Host NestJS de `mod.member-registration` (módulo first-party built-in,
 * ADR-011/015): inscripción de miembros con verificadores componibles por
 * tenant (Telegram y/u OTP por email, o registro libre) + validación manual.
 *
 * La lógica portable (tickets firmados, DTOs, verificador Telegram, settings,
 * plantillas de catálogo) vive en `modules/member-registration/`; aquí queda
 * el wiring del host: controllers (rutas /modules/member-registration como
 * ÚNICAS — las legacy /inscripcion/* se retiraron en F3), services Prisma,
 * emisor de eventos y worker de purga GDPR.
 *
 * Importa:
 * - AuthModule → PasswordService, PrismaAuditLogService, SmtpAdapterService,
 *   TenantSmtpResolverService, PrismaTenantConfigService, JwtAuthGuard (todos
 *   exportados por AuthModule).
 * - ModulesModule → ModuleRegistryService (mod.payment-connections),
 *   AccessGroupsService (grupo por defecto al aprobar) y ModuleContextFactory
 *   (outbox para los eventos declarados en el manifest).
 *
 * TenantResolverService y PrismaService se inyectan desde sus módulos globales,
 * así que NO se redeclaran aquí (evita instancias duplicadas / providers globales).
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [
    MemberRegistrationPublicController,
    MemberRegistrationAdminController,
    PaymentFlagController,
  ],
  providers: [
    TelegramService,
    EmailVerificationService,
    MemberRegistrationSettingsService,
    MemberRegistrationEventsService,
    MemberRegistrationService,
    MemberDecisionService,
    MemberPaymentFlagService,
    MemberSubscriptionLookupService,
    MemberPurgeWorker,
  ],
})
export class MemberRegistrationModule {}
