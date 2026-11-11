/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module, type FactoryProvider, type OnApplicationShutdown } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { VideoAccessService } from './video-access.service';
import { VideoController } from './video.controller';
import { VideoPlaybackService } from './video-playback.service';
import {
  VIDEO_PLAY_REDIS_TOKEN,
  VideoPlayLimiter,
  type VideoPlayRedisClient,
} from './video-play-limiter';
import { VideoProtectionAdminController } from './video-protection-admin.controller';
import { VideoProtectionConfigService } from './video-protection-config.service';

/** Cierra la conexión Redis del tope al apagar la app. */
class VideoPlayRedisLifecycle implements OnApplicationShutdown {
  constructor(private readonly client: Redis | null) {}
  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      // ignore — el proceso ya está bajando.
    }
  }
}

/**
 * Conexión Redis dedicada al tope de vídeos (mismo patrón que RateLimitModule).
 * Sin REDIS_URL, o en test, null: el limitador usa memoria del proceso.
 */
const videoPlayRedisProvider: FactoryProvider<VideoPlayRedisClient | null> = {
  provide: VIDEO_PLAY_REDIS_TOKEN,
  useFactory: (): VideoPlayRedisClient | null => {
    const url = process.env['REDIS_URL'];
    if (!url || process.env['NODE_ENV'] === 'test') return null;
    const client = new IORedis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true });
    client.on('error', () => {
      /* swallow — el limitador captura el error y cae a memoria */
    });
    return client as unknown as VideoPlayRedisClient;
  },
};

/**
 * Protección de vídeo (infra CORE del host, no un módulo de marketplace):
 * URLs de Bunny Stream firmadas y con caducidad, autorización por vídeo, tope
 * de vídeos distintos por cuenta y marca de agua. Todo configurable por tenant
 * desde Administración → Seguridad, y apagado mientras el tenant no guarde su
 * clave de firma.
 *
 * - AuthModule → JwtAuthGuard, PrismaAuditLogService, PrismaTenantConfigService.
 * - ModulesModule → ModuleRegistryService (mod.learning decide el acceso).
 * - PrismaService y TenantResolverService llegan de módulos globales.
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [VideoController, VideoProtectionAdminController],
  providers: [
    videoPlayRedisProvider,
    {
      provide: VideoPlayRedisLifecycle,
      useFactory: (client: VideoPlayRedisClient | null) =>
        new VideoPlayRedisLifecycle(client as unknown as Redis | null),
      inject: [VIDEO_PLAY_REDIS_TOKEN],
    },
    VideoPlayLimiter,
    VideoProtectionConfigService,
    VideoAccessService,
    VideoPlaybackService,
  ],
})
export class VideoModule {}
