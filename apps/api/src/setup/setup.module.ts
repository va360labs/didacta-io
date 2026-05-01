import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/**
 * Bootstrap del primer arranque. Endpoints públicos:
 *
 *   GET  /setup/status  → ¿hay al menos un tenant?
 *   POST /setup/init    → crea tenant + super_admin (idempotente, 409 si ya existe).
 *
 * Importa AuthModule porque reusa PasswordService + TokenService +
 * PrismaAuditLogService. No expone providers — solo controladores HTTP.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
