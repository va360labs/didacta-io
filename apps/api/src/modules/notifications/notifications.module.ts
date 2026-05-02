import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { NotificationsBridge } from './notifications.bridge';
import { NotificationsController } from './notifications.controller';
import { NotificationTemplatesController } from './notification-templates.controller';

/// Backend del módulo `mod.notifications`. Encapsula sus controllers
/// (CRUD del bell del user, CRUD de templates per-tenant) y el bridge
/// que reacciona a eventos de otros módulos para crear notifications.
///
/// NO incluye `SmtpAdapterService` ni `PrismaNotificationHubService`
/// porque ambos son **infrastructure compartida del core**: SMTP lo
/// usan auth (password reset), billing (Stripe webhook), etc., y el
/// `NotificationHub` lo consume `ModuleContext` para que cualquier
/// módulo pueda emitir notifications. Se quedan registrados en
/// `ModulesModule` (parent) — este sub-module solo añade la cara
/// visible del módulo (endpoints REST + bridge).
///
/// Convención ADR-011: `forwardRef(() => ModulesModule)` rompe el ciclo
/// `ModulesModule → NotificationsModule → ModulesModule (NotificationHub
/// vía PrismaNotificationHubService)`.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [NotificationsController, NotificationTemplatesController],
  providers: [NotificationsBridge],
  exports: [NotificationsBridge],
})
export class NotificationsModule {}
