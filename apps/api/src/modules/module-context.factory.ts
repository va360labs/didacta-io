import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type {
  HookContext,
  HookRegistry,
  I18nService,
  Logger,
  ModuleContext,
  NotificationHubService,
} from '@learnship/core-kernel';
import { PrismaService } from '../prisma/prisma.service';
import { LocalDiskStorageService } from './local-disk-storage.service';
import { OutboxQueueService } from './outbox-queue.service';
import { PersistentEventBus } from './persistent-event-bus';
import { PrismaAuditLogService } from './prisma-audit-log.service';
import { PrismaEvidenceVaultService } from './prisma-evidence-vault.service';
import { PrismaNotificationHubService } from './prisma-notification-hub.service';
import { PrismaTenantConfigService } from './prisma-tenant-config.service';
import { SecretCipherService } from './secret-cipher.service';

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
  private readonly storage = new LocalDiskStorageService();
  private readonly cipher = new SecretCipherService(loadCipherKey());
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
    const notificationHub = new PrismaNotificationHubService(this.prisma, this.pino);
    this.tenantConfig = new PrismaTenantConfigService(this.prisma, this.cipher, auditLog);
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
    return new PrismaNotificationHubService(this.prisma, this.pino);
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
