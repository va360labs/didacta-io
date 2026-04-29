import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiGatewayService } from './ai-gateway.service';
import { ApiKeyCipher } from './api-key-cipher';
import { AiConfigResolver } from './config-resolver';
import { ProviderRegistry } from './provider-registry';

/**
 * Módulo NestJS del AI Gateway multi-provider (LMS-90.B).
 *
 * Exporta `AiGatewayService` (entry point para módulos consumidores) y
 * `ApiKeyCipher` (para que el panel admin de configs IA por tenant pueda
 * cifrar las nuevas claves al guardarlas).
 */
@Module({
  imports: [PrismaModule],
  providers: [ProviderRegistry, ApiKeyCipher, AiConfigResolver, AiGatewayService],
  exports: [AiGatewayService, ProviderRegistry, ApiKeyCipher],
})
export class AiModule {}
