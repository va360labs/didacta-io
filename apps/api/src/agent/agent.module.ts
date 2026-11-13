/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { AgentKeyGuard } from './agent-key.guard';
import { AgentKeysController } from './agent-keys.controller';
import { AgentRateLimiter } from './agent-rate-limiter';
import { AgentService } from './agent.service';
import { McpController } from './mcp.controller';

/**
 * Puerta de agentes del aula: servidor MCP (`POST /api/v1/mcp`) y la
 * creación de su clave desde el panel (`POST /api/v1/agent/keys`).
 *
 * Infraestructura del host, como `SimpleModeModule`: no añade lógica de
 * negocio, orquesta los servicios públicos de los módulos (cursos, directos,
 * comunidad) a través de `ModuleRegistryService`.
 */
@Module({
  imports: [PrismaModule, AuthModule, ModulesModule, ModerationModule, RateLimitModule],
  controllers: [McpController, AgentKeysController],
  providers: [AgentService, AgentKeyGuard, AgentRateLimiter],
})
export class AgentModule {}
