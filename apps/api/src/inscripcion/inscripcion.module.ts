import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { EmailVerificationService } from './email-verification.service';
import { InscripcionController } from './inscripcion.controller';
import { MemberDecisionService } from './member-decision.service';
import { MemberPaymentFlagService } from './member-payment-flag.service';
import { MemberPurgeWorker } from './member-purge.worker';
import { MemberRegistrationService } from './member-registration.service';
import { PaymentFlagController } from './payment-flag.controller';
import { TelegramService } from './telegram.service';

/**
 * Inscripción de miembros (gate Telegram + OTP por email + validación manual).
 *
 * Infra CORE del host (NO un módulo de marketplace): conecta el gate de Telegram,
 * la verificación por email y la validación manual con el alta de usuario.
 *
 * Importa:
 * - AuthModule → PasswordService, PrismaAuditLogService, SmtpAdapterService,
 *   TenantSmtpResolverService, JwtAuthGuard (todos exportados por AuthModule).
 * - ModulesModule → ModuleRegistryService (acceso a mod.learning / mod.courses).
 *
 * TenantResolverService y PrismaService se inyectan desde sus módulos globales,
 * así que NO se redeclaran aquí (evita instancias duplicadas / providers globales).
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [InscripcionController, PaymentFlagController],
  providers: [
    TelegramService,
    EmailVerificationService,
    MemberRegistrationService,
    MemberDecisionService,
    MemberPaymentFlagService,
    MemberPurgeWorker,
  ],
})
export class InscripcionModule {}
