/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import IORedis, { type Redis } from 'ioredis';
import type {
  HookContext,
  HookRegistry,
  I18nService,
  Logger,
  ModuleContext,
  NotificationHubService,
} from '@didacta/core-kernel';
import { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '@didacta/core-kernel';
import { LocalDiskStorageService } from './local-disk-storage.service';
import { S3StorageService, buildS3StorageFromEnv } from './s3-storage.service';
import { withImageOptimization } from './image-optimizing-storage';
import { OutboxQueueService } from './outbox-queue.service';
import { PersistentEventBus } from './persistent-event-bus';
import { PrismaAuditLogService } from './prisma-audit-log.service';
import { PrismaEvidenceVaultService } from './prisma-evidence-vault.service';
import { NotificationRealtimePublisher } from './notifications/realtime/notification-realtime.publisher';
import { PrismaNotificationHubService } from './prisma-notification-hub.service';
import { PrismaTenantConfigService } from './prisma-tenant-config.service';
import { SecretCipherService } from './secret-cipher.service';
import { SmtpAdapterService } from './smtp-adapter.service';
import { TenantSmtpResolverService } from './tenant-smtp-resolver.service';
import { loadCipherKey } from '../auth/cipher-key';

/**
 * Selecciona el storage backend según `STORAGE_DRIVER`. `s3` requiere las
 * S3_* vars (endpoint, bucket, creds). `local` usa el disco bajo
 * `STORAGE_ROOT`. Sin var explícita: si las S3_* están completas → s3,
 * sino → local.
 *
 * El adapter elegido se envuelve SIEMPRE con `withImageOptimization`: es lo que
 * garantiza que toda imagen de la plataforma se optimice al subirla, venga de
 * donde venga (host, módulo first-party o módulo del marketplace), sin que cada
 * call site tenga que acordarse.
 */
function buildStorage(): StorageService & {
  /** Solo presente si el driver activo es S3. Permite check de health. */
  ping?: () => Promise<boolean>;
} {
  const driver = process.env['STORAGE_DRIVER'];
  if (driver === 'local') {
    return withImageOptimization(new LocalDiskStorageService());
  }
  const s3 = buildS3StorageFromEnv();
  if (s3) {
    return withImageOptimization(s3);
  }
  if (driver === 's3') {
    throw new Error(
      'STORAGE_DRIVER=s3 pero faltan S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY',
    );
  }
  return withImageOptimization(new LocalDiskStorageService());
}

type AnyHandler = (ctx: HookContext<unknown>) => Promise<void> | void;

class InMemoryHookRegistry implements HookRegistry {
  private readonly handlers = new Map<string, Set<AnyHandler>>();

  register<TInput>(name: string, handler: (ctx: HookContext<TInput>) => Promise<void> | void) {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as AnyHandler);
  }

  async run<TInput>(name: string, ctx: HookContext<TInput>): Promise<void> {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of set) {
      await handler(ctx);
    }
  }
}

/**
 * Stub del NotificationHub solo para tests / fallback. La implementación real
 * vive en PrismaNotificationHubService y se inyecta en build().
 */
const stubNotificationHub: NotificationHubService = {
  async send() {
    /* noop */
  },
};

const stubI18n: I18nService = {
  t(key: string) {
    return key;
  },
};

@Injectable()
export class ModuleContextFactory implements OnApplicationShutdown {
  private readonly hookRegistry = new InMemoryHookRegistry();
  private readonly storage = buildStorage();
  private readonly cipher = new SecretCipherService(loadCipherKey().key);
  private readonly smtp = new SmtpAdapterService();
  private tenantConfig?: PrismaTenantConfigService;
  private smtpResolver?: TenantSmtpResolverService;
  private eventBus?: PersistentEventBus;
  private realtimePublisher?: NotificationRealtimePublisher;
  /** Cliente Redis dedicado al publish realtime; null si no hay REDIS_URL. */
  private realtimeRedis: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pino: PinoLogger,
    @Inject(forwardRef(() => OutboxQueueService))
    private readonly outboxQueue: OutboxQueueService,
  ) {}

  build(): ModuleContext {
    const adaptedLogger = this.adaptLogger(this.pino);
    // El bus es un singleton lazy: los workers llaman a build() por job y los
    // bridges se suscriben en onModuleInit (que en Nest 11 puede correr ANTES
    // de que el registry construya el contexto) — todos deben compartir la
    // misma instancia o las suscripciones se pierden.
    this.eventBus ??= new PersistentEventBus(this.prisma, adaptedLogger, this.outboxQueue);
    const auditLog = new PrismaAuditLogService(this.prisma);
    const evidenceVault = new PrismaEvidenceVaultService(this.prisma, this.storage);
    this.tenantConfig = new PrismaTenantConfigService(this.prisma, this.cipher, auditLog);
    this.smtpResolver = new TenantSmtpResolverService(this.tenantConfig, this.smtp);
    const notificationHub = new PrismaNotificationHubService(
      this.prisma,
      this.pino,
      this.tenantConfig,
      this.smtp,
      this.smtpResolver,
      this.getRealtimePublisher(),
    );
    void stubNotificationHub; // se mantiene exportado para tests; producción usa Prisma.
    return {
      eventBus: this.eventBus,
      hookRegistry: this.hookRegistry,
      storage: this.storage,
      auditLog,
      evidenceVault,
      notificationHub,
      i18n: stubI18n,
      logger: adaptedLogger,
      config: this.tenantConfig,
    };
  }

  getNotificationHub(): PrismaNotificationHubService {
    // Útil para handlers internos (bridge) que necesitan el service real.
    return new PrismaNotificationHubService(
      this.prisma,
      this.pino,
      this.getTenantConfig(),
      this.smtp,
      this.getSmtpResolver(),
      this.getRealtimePublisher(),
    );
  }

  /**
   * Publisher realtime de notificaciones (Redis pub/sub). Lazy + singleton:
   * construye un cliente Redis dedicado al `PUBLISH` si hay `REDIS_URL` (y no
   * estamos en test) — mismo patrón que RateLimitModule. Sin REDIS_URL el
   * publisher entra en modo no-op (failsafe interno).
   */
  getRealtimePublisher(): NotificationRealtimePublisher {
    if (this.realtimePublisher) return this.realtimePublisher;

    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      const client = new IORedis(url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      client.on('error', () => {
        /* swallow — el publisher captura los errores del PUBLISH en el call site */
      });
      this.realtimeRedis = client;
    }
    this.realtimePublisher = new NotificationRealtimePublisher(this.realtimeRedis, this.pino);
    return this.realtimePublisher;
  }

  getSmtpAdapter(): SmtpAdapterService {
    return this.smtp;
  }

  /**
   * Resolver de SMTP per-tenant con fallback a env globales. Compartido
   * por NotificationHub, AdminSmtpController y password reset.
   */
  getSmtpResolver(): TenantSmtpResolverService {
    if (!this.smtpResolver) {
      this.smtpResolver = new TenantSmtpResolverService(this.getTenantConfig(), this.smtp);
    }
    return this.smtpResolver;
  }

  /** Devuelve el storage activo. Si es S3 expone también `ping()` para health. */
  getStorage(): StorageService & { ping?: () => Promise<boolean> } {
    return this.storage;
  }

  /**
   * Cache de adapters S3 por tenant. La config se persiste cifrada en
   * `tenant_setting` (scope=`storage`, keys `config` + `secret`); el primer
   * acceso construye el adapter, los siguientes lo reutilizan. Si el admin
   * cambia la config, llama a `invalidateTenantStorage(tenantId)` desde el
   * upsert para limpiar el cache.
   */
  private readonly tenantStorageCache = new Map<
    string,
    StorageService & { ping?: () => Promise<boolean> }
  >();

  /**
   * Devuelve el adapter de storage que aplica al tenant. Si el tenant
   * tiene `storage.config` con driver=`s3` + bucket + accessKey en
   * `tenant_setting`, construye un S3StorageService con esas credenciales.
   * Si no, cae al adapter global (env STORAGE_DRIVER) — preserva el
   * comportamiento previo para tenants que no migraron config aún.
   */
  async getStorageForTenant(
    tenantId: string,
  ): Promise<StorageService & { ping?: () => Promise<boolean> }> {
    const cached = this.tenantStorageCache.get(tenantId);
    if (cached) return cached;

    const config = this.getTenantConfig();
    type StorageConfig = {
      driver?: string;
      s3Bucket?: string;
      s3Region?: string;
      s3Endpoint?: string;
      s3AccessKeyId?: string;
    };
    type StorageSecret = { s3SecretAccessKey?: string };

    const cfg = await config
      .get<StorageConfig>(tenantId, 'storage', 'config')
      .catch(() => undefined);
    if (!cfg || cfg.driver !== 's3' || !cfg.s3Bucket || !cfg.s3AccessKeyId) {
      // Sin override válido → adapter global (env STORAGE_DRIVER).
      this.tenantStorageCache.set(tenantId, this.storage);
      return this.storage;
    }
    const sec = await config
      .get<StorageSecret>(tenantId, 'storage', 'secret')
      .catch(() => undefined);
    if (!sec?.s3SecretAccessKey) {
      // Falta el secret: tampoco podemos construir el adapter — fallback.
      this.tenantStorageCache.set(tenantId, this.storage);
      return this.storage;
    }
    const region = cfg.s3Region ?? 'eu-central-1';
    // AWS S3 nativo no necesita endpoint (lo infiere de la región); para
    // compat con S3-compatible (Hetzner/MinIO/Backblaze) sí. Si el admin
    // no lo proveyó, generamos el URL canónico de AWS.
    const endpoint = cfg.s3Endpoint?.trim() || `https://s3.${region}.amazonaws.com`;
    // Mismo envoltorio que el adapter global: un tenant con su propio bucket no
    // puede quedarse sin optimización de imágenes por usar otro backend.
    const adapter = withImageOptimization(
      new S3StorageService({
        bucket: cfg.s3Bucket,
        region,
        endpoint,
        accessKeyId: cfg.s3AccessKeyId,
        secretAccessKey: sec.s3SecretAccessKey,
      }),
    );
    this.tenantStorageCache.set(tenantId, adapter);
    return adapter;
  }

  /** Invalidar el cache tras un cambio de config en /admin/configuracion. */
  invalidateTenantStorage(tenantId: string): void {
    this.tenantStorageCache.delete(tenantId);
  }

  isS3Storage(): boolean {
    return this.storage instanceof S3StorageService;
  }

  getTenantConfig(): PrismaTenantConfigService {
    if (!this.tenantConfig) {
      // Construido lazy si build() todavía no corrió (tests / cargas tempranas).
      const auditLog = new PrismaAuditLogService(this.prisma);
      this.tenantConfig = new PrismaTenantConfigService(this.prisma, this.cipher, auditLog);
    }
    return this.tenantConfig;
  }

  getPrisma(): PrismaService {
    return this.prisma;
  }

  getEventBus(): PersistentEventBus {
    // Construido lazy si build() todavía no corrió: en Nest 11 el orden de
    // inicialización de módulos es topológico y los bridges pueden pedir el
    // bus antes de que el registry llame a build().
    this.eventBus ??= new PersistentEventBus(
      this.prisma,
      this.adaptLogger(this.pino),
      this.outboxQueue,
    );
    return this.eventBus;
  }

  /** Cierra limpio el cliente Redis del publisher realtime al apagar la app. */
  async onApplicationShutdown(): Promise<void> {
    if (this.realtimeRedis) {
      try {
        await this.realtimeRedis.quit();
      } catch {
        // ignore — el proceso ya está bajando.
      }
      this.realtimeRedis = null;
    }
  }

  private adaptLogger(pino: PinoLogger): Logger {
    const wrap = (level: 'debug' | 'log' | 'warn' | 'error') => {
      return (message: string, meta?: Record<string, unknown>) => {
        pino[level](meta ?? {}, message);
      };
    };
    const adapted: Logger = {
      debug: wrap('debug'),
      info: wrap('log'),
      warn: wrap('warn'),
      error: wrap('error'),
      child: (_bindings) => adapted,
    };
    return adapted;
  }
}
