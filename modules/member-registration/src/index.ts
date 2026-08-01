/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Punto de entrada del módulo mod.member-registration.
 *
 * Exporta:
 *   - manifest declarativo (parseado).
 *   - Lógica portable del flujo: tickets firmados, DTOs Zod, verificador de
 *     Telegram y resolutor de settings por tenant (con puertos que implementa
 *     el host).
 *   - Plantillas de email del módulo (el catálogo del core las agrega).
 *   - Factory `buildMemberRegistrationModule()` para registrar contra el
 *     ModuleRegistry del CORE.
 *
 * La orquestación NestJS (controllers, services Prisma, worker de purga) vive
 * en el host: apps/api/src/modules/member-registration/ (ADR-011/015).
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };

export { signTicket, verifyTicket } from './signed-ticket.js';

export {
  membershipFromBoolean,
  membershipToBoolean,
  otpRequestSchema,
  otpVerifySchema,
  paymentFlagImportSchema,
  paymentFlagUpsertSchema,
  registerSchema,
  telegramAuthSchema,
} from './dto.js';
export type {
  OtpRequestDto,
  OtpRequestResponse,
  OtpVerifyDto,
  OtpVerifyResponse,
  PaymentFlagImportDto,
  PaymentFlagUpsertDto,
  RegisterDto,
  RegisterResponse,
  TelegramAuthDto,
  TelegramMembership,
  TelegramTicketClaims,
  TelegramVerifyResponse,
  VerificationTokenClaims,
} from './dto.js';

export {
  APPROVAL_SETTING_KEY,
  MEMBER_REGISTRATION_SCOPE,
  MEMBER_VERIFIERS,
  MemberRegistrationSettings,
  TELEGRAM_SETTING_KEY,
  VERIFICATION_SETTING_KEY,
} from './settings.js';
export type {
  EffectiveRegistrationPolicy,
  MemberVerifier,
  RegistrationPolicy,
  SettingsLogger,
  TelegramGateConfig,
  TenantConfigPort,
} from './settings.js';

export { TelegramVerifier } from './telegram-verifier.js';
export type { TelegramVerifierLogger } from './telegram-verifier.js';

export { MEMBER_REGISTRATION_EMAIL_TEMPLATES } from './email-catalog.js';
export type { ModuleEmailTemplateDef, ModuleEmailTemplateVariable } from './email-catalog.js';

export function buildMemberRegistrationModule(): DidactaModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.member-registration: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.member-registration: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.member-registration: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.member-registration: onUninstall', { tenantId });
    },
  };
}
