import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AdminModule } from '../../admin/admin.module';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { PaymentConnectionsController } from './payment-connections.controller';
import { PaymentConnectionsErrorFilter } from './payment-connections-error.filter';
import { SubscribersSyncWorker } from './subscribers-sync.worker';
import { SubscriptionsDailyWorker } from './subscriptions-daily.worker';

/// Backend del módulo `mod.payment-connections`. Solo wiring genérico del host:
/// el controller admin (conectar/listar/verify/desconectar/reconciliar/invitar)
/// y el error filter. La lógica vive en `modules/payment-connections/`.
///
/// - forwardRef(ModulesModule): para inyectar ModuleRegistryService (que expone
///   el PaymentConnectionsService construido al boot con la infra del host).
/// - forwardRef(AdminModule): para reusar AdminUsersService en la acción invitar
///   (cuenta PENDING + email) sin duplicar la lógica de IAM del core.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule), forwardRef(() => AdminModule)],
  controllers: [PaymentConnectionsController],
  providers: [
    { provide: APP_FILTER, useClass: PaymentConnectionsErrorFilter },
    SubscribersSyncWorker,
    SubscriptionsDailyWorker,
  ],
})
export class PaymentConnectionsModule {}
