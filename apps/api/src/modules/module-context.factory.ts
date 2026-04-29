import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
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
import { OutboxQueueService } from './outbox-queue.service';
import { PersistentEventBus } from './persistent-event-bus';
import { PrismaAuditLogService } from './prisma-audit-log.service';
import { PrismaEvidenceVaultService } from './prisma-evidence-vault.service';
import { PrismaNotificationHubService } from './prisma-notification-hub.service';
import { PrismaTenantConfigService } from './prisma-tenant-config.service';
import { SecretCipherService } from './secret-cipher.service';
import { SmtpAdapterService } from './smtp-adapter.service';

function loadCipherKey(): string {
  const key = process.env.TENANT_SETTINGS_ENC_KEY;
  if (!key || key.trim().length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TENANT_SETTINGS_ENC_KEY es obligatoria en producción. Generala con: openssl rand -hex 32',
      );
    }
    // Dev fallback: clave determinística para tests/local sin .env (ÚNICAMENTE dev).
    return '0'.repeat(64);
  }
  return key;
}

/**
 * Selecciona el storage backend según `STORAGE_DRIVER`. `s3` requiere las
 * S3_* vars (endpoint, bucket, creds). `local` usa el disco bajo
 * `STORAGE_ROOT`. Sin var explícita: si las S3_* están completas → s3,
 * sino → local.
 */
function buildStorage(): StorageService & {
  /** Solo presente si el driver activo es S3. Permite check de health. */
  ping?: () => Promise<boolean>;
} {
  const driver = process.env['STORAGE_DRIVER'];
  if (driver === 'local') {
    return new LocalDiskStorageService();
  }
  const s3 = buildS3StorageFromEnv();
  if (s3) {
    return s3;
  }
  if (driver === 's3') {
    throw new Error(
      'STORAGE_DRIVER=s3 pero faltan S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY',
    );
  }
  return new LocalDiskStorageService();
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
export class ModuleContextFactory {
  private readonly hookRegistry = new InMemoryHookRegistry();
  private readonly storage = buildStorage();
  private readonly cipher = new SecretCipherService(loadCipherKey());
  private readonly smtp = new SmtpAdapterService();
  private tenantConfig?: PrismaTenantConfigService;
  private eventBus?: PersistentEventBus;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pino: PinoLogger,
    @Inject(forwardRef(() => OutboxQueueService))
    private readonly outboxQueue: OutboxQueueService,
  ) {}

  build(): ModuleContext {
    const adaptedLogger = this.adaptLogger(this.pino);
    this.eventBus = new PersistentEventBus(this.prisma, adaptedLogger, this.outboxQueue);
    const auditLog = new PrismaAuditLogService(this.prisma);
    const evidenceVault = new PrismaEvidenceVaultService(this.prisma, this.storage);
    this.tenantConfig = new PrismaTenantConfigService(this.prisma, this.cipher, auditLog);
    const notificationHub = new PrismaNotificationHubService(
      this.prisma,
      this.pino,
      this.tenantConfig,
      this.smtp,
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
    );
  }

  getSmtpAdapter(): SmtpAdapterService {
    return this.smtp;
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
    const adapter = new S3StorageService({
      bucket: cfg.s3Bucket,
      region,
      endpoint,
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: sec.s3SecretAccessKey,
    });
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
    if (!this.eventBus) throw new Error('EventBus aún no construido (build() no fue llamado)');
    return this.eventBus;
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
