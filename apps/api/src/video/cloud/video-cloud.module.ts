/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { type DynamicModule, Module } from '@nestjs/common';
import { AdminModule } from '../../admin/admin.module';
import { AdminTenantsService } from '../../admin/admin-tenants.service';
import { AuthModule } from '../../auth/auth.module';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { SmtpAdapterService } from '../../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../../modules/tenant-smtp-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { FetchBunnyStreamClient, type BunnyStreamClient } from './bunny-stream.client';
import { FetchGoogleDriveClient, type GoogleDriveClient } from './google-drive.client';
import {
  AdminTenantsVideoController,
  VideoBunnyWebhookController,
  VideoUploadsController,
} from './video-cloud.controllers';
import {
  getVideoCloudConfig,
  type VideoCloudConfig,
  type VideoCloudEnabled,
} from './video-cloud.config';
import {
  BUNNY_STREAM_CLIENT,
  GOOGLE_DRIVE_CLIENT,
  VIDEO_CLOUD_CONFIG,
  VIDEO_CLOUD_SERVICE,
  VIDEO_INACTIVITY_SERVICE,
} from './video-cloud.di';
import { VideoCloudService } from './video-cloud.service';
import { VIDEO_CLOUD_LIBRARY } from './video-cloud.tokens';
import { VideoCloudWorker } from './video-cloud.worker';
import { VideoInactivityEmailNotifier } from './video-inactivity-notifier';
import {
  VideoInactivityService,
  type TenantArchiver,
  type VideoInactivityNotifier,
} from './video-inactivity.service';

/**
 * Subida de vídeo a Bunny Stream de Didacta Cloud.
 *
 * `register()` decide al cargar el grafo de Nest, igual que `PayoutsModule`:
 *
 *  - APAGADO (sin `BUNNY_STREAM_API_KEY`, toda Community): módulo vacío. Ni
 *    rutas, ni worker, ni clientes. La lección admite solo enlaces y la
 *    reproducción es exactamente la de antes.
 *  - ENCENDIDO: las rutas del creador (`/video/uploads/*`), el webhook de
 *    Bunny, las dos del operador (`/admin/tenants/:id/video*`) y los
 *    barridos. Es GLOBAL y exporta `VIDEO_CLOUD_LIBRARY`, que la reproducción
 *    de siempre (`VideoPlaybackService`) recibe con `@Optional()` para firmar
 *    los vídeos de la biblioteca de Cloud.
 */
@Module({})
export class VideoCloudModule {
  /**
   * @param overrides Solo tests: dobles en memoria de Bunny, Drive, correo y
   *   archivado. En producción nadie los pasa.
   */
  static register(
    config: VideoCloudConfig = getVideoCloudConfig(),
    overrides: {
      readonly bunny?: BunnyStreamClient;
      readonly drive?: GoogleDriveClient | null;
      readonly notifier?: VideoInactivityNotifier;
      readonly archiver?: TenantArchiver;
    } = {},
  ): DynamicModule {
    if (!config.enabled) return { module: VideoCloudModule };
    return {
      module: VideoCloudModule,
      global: true,
      imports: [AuthModule, AdminModule],
      controllers: [
        VideoUploadsController,
        VideoBunnyWebhookController,
        AdminTenantsVideoController,
      ],
      providers: [
        { provide: VIDEO_CLOUD_CONFIG, useValue: config },
        {
          provide: BUNNY_STREAM_CLIENT,
          useFactory: (): BunnyStreamClient =>
            overrides.bunny ??
            new FetchBunnyStreamClient({
              apiKey: config.apiKey,
              libraryId: config.libraryId,
              baseUrl: config.apiBaseUrl,
            }),
        },
        {
          provide: GOOGLE_DRIVE_CLIENT,
          useFactory: (): GoogleDriveClient | null => {
            if (overrides.drive !== undefined) return overrides.drive;
            return config.drive
              ? new FetchGoogleDriveClient({ serviceAccount: config.drive.serviceAccount })
              : null;
          },
        },
        {
          provide: VIDEO_CLOUD_SERVICE,
          inject: [VIDEO_CLOUD_CONFIG, PrismaService, BUNNY_STREAM_CLIENT, PrismaAuditLogService],
          useFactory: (
            cfg: VideoCloudEnabled,
            prisma: PrismaService,
            bunny: BunnyStreamClient,
            audit: PrismaAuditLogService,
          ) => new VideoCloudService(cfg, prisma, bunny, audit),
        },
        { provide: VIDEO_CLOUD_LIBRARY, useExisting: VIDEO_CLOUD_SERVICE },
        {
          provide: VIDEO_INACTIVITY_SERVICE,
          inject: [
            VIDEO_CLOUD_CONFIG,
            PrismaService,
            VIDEO_CLOUD_SERVICE,
            GOOGLE_DRIVE_CLIENT,
            TenantSmtpResolverService,
            SmtpAdapterService,
            TenantResolverService,
            AdminTenantsService,
          ],
          useFactory: (
            cfg: VideoCloudEnabled,
            prisma: PrismaService,
            cloud: VideoCloudService,
            drive: GoogleDriveClient | null,
            smtpResolver: TenantSmtpResolverService,
            smtp: SmtpAdapterService,
            tenantResolver: TenantResolverService,
            adminTenants: AdminTenantsService,
          ) =>
            new VideoInactivityService(
              cfg,
              prisma,
              cloud,
              drive,
              overrides.notifier ??
                new VideoInactivityEmailNotifier({
                  prisma,
                  smtpResolver,
                  smtp,
                  tenantResolver,
                  operatorAlertEmail: cfg.operatorAlertEmail,
                }),
              overrides.archiver ?? {
                archive: async (tenantId, metadata) => {
                  await adminTenants.archiveBySystem(tenantId, 'video-inactivity', metadata);
                },
              },
            ),
        },
        VideoCloudWorker,
      ],
      exports: [VIDEO_CLOUD_LIBRARY, VIDEO_CLOUD_SERVICE],
    };
  }
}
