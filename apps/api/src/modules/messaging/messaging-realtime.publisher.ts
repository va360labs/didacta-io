/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import IORedis, { type Redis } from 'ioredis';
import { messagingChannelFor, type MessagingRealtimeEvent } from './messaging-realtime.types';

/**
 * Publica eventos realtime de mensajería en Redis pub/sub, un canal por
 * (tenant, user). Best-effort FAILSAFE: la BD ya persistió el mensaje antes
 * de llegar aquí; si Redis falla se loguea (rate-limited) y NUNCA se propaga
 * — el cliente degrada a refetch. Cliente Redis dedicado de publish (no se
 * comparte con el subscriber ni con BullMQ).
 */
@Injectable()
export class MessagingRealtimePublisher implements OnModuleInit, OnApplicationShutdown {
  private client: Redis | null = null;
  private lastWarnAt = 0;

  constructor(@Optional() private readonly logger?: PinoLogger) {}

  onModuleInit(): void {
    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      const client = new IORedis(url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      client.on('error', () => {
        /* swallow — best-effort */
      });
      this.client = client;
    }
  }

  async publishToUsers(
    tenantId: string,
    userIds: string[],
    event: MessagingRealtimeEvent,
  ): Promise<void> {
    if (!this.client || userIds.length === 0) return;
    const payload = JSON.stringify(event);
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          await this.client?.publish(messagingChannelFor(tenantId, userId), payload);
        } catch (err) {
          this.warnOnce(err);
        }
      }),
    );
  }

  private warnOnce(err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    const message = err instanceof Error ? err.message : String(err);
    if (this.logger) this.logger.warn({ err: message }, 'messaging realtime publish falló');
    // eslint-disable-next-line no-console
    else console.warn(`[MessagingRealtimePublisher] publish falló: ${message}`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* el proceso ya está bajando */
      }
      this.client = null;
    }
  }
}
