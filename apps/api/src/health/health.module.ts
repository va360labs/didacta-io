import { Module } from '@nestjs/common';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';

@Module({
  imports: [PrismaModule, ModulesModule],
  controllers: [HealthController],
})
export class HealthModule {}
