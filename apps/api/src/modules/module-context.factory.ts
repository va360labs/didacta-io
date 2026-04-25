import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type {
  AuditLogService,
  DomainEvent,
  EventBus,
  EvidenceVaultService,
  HookContext,
  HookRegistry,
  I18nService,
  Logger,
  ModuleContext,
  NotificationHubService,
  StorageService,
  TenantConfigService,
} from '@learnship/core-kernel';
import { PrismaService } from '../prisma/prisma.service';

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
 * Implementación in-memory del EventBus. Despacha a handlers locales sincrónicamente.
 * No persiste eventos (cuando llegue mod.outbox lo reemplazamos).
 */
type AnyEventHandler = (event: DomainEvent<unknown>) => Promise<void> | void;

class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<AnyEventHandler>>();

  constructor(private readonly logger: Logger) {}

  async publish<TPayload>(event: DomainEvent<TPayload>) {
    this.logger.info('event published', {
      event: event.name,
      tenantId: event.metadata.tenantId,
    });
    const set = this.handlers.get(event.name);
    if (!set) return;
    for (const handler of set) {
      try {
        await handler(event as DomainEvent<unknown>);
      } catch (error) {
        this.logger.error('event handler falló', {
          event: event.name,
          error: (error as Error).message,
        });
      }
    }
  }

  subscribe<TPayload>(
    eventName: string,
    handler: (event: DomainEvent<TPayload>) => Promise<void> | void,
  ) {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    const wrapped = handler as AnyEventHandler;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }
}

const stubStorage: StorageService = {
  async upload(key: string) {
    return { key };
  },
  async download() {
    throw new Error('StubStorage: no implementado');
  },
  async delete() {
    /* noop */
  },
  async getSignedUrl(key: string) {
    return `https://stub.local/${key}`;
  },
};

const stubAuditLog: AuditLogService = {
  async record() {
    /* noop hasta T-1A-008 */
  },
};

const stubEvidenceVault: EvidenceVaultService = {
  async store({ resourceId }) {
    return { id: resourceId, hash: 'stub', storageKey: `stub/${resourceId}` };
  },
};

const stubNotificationHub: NotificationHubService = {
  async send() {
    /* noop hasta T-1A-009 */
  },
};

const stubI18n: I18nService = {
  t(key: string) {
    return key;
  },
};

class StubTenantConfig implements TenantConfigService {
  private readonly mem = new Map<string, unknown>();
  async get<T = unknown>(
    tenantId: string,
    moduleName: string,
    key: string,
  ): Promise<T | undefined> {
    return this.mem.get(`${tenantId}:${moduleName}:${key}`) as T | undefined;
  }
  async set<T = unknown>(tenantId: string, moduleName: string, key: string, value: T) {
    this.mem.set(`${tenantId}:${moduleName}:${key}`, value);
  }
}

@Injectable()
export class ModuleContextFactory {
  private readonly hookRegistry = new InMemoryHookRegistry();
  private readonly tenantConfig = new StubTenantConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pino: PinoLogger,
  ) {}

  build(): ModuleContext {
    const adaptedLogger = this.adaptLogger(this.pino);
    return {
      eventBus: new InMemoryEventBus(adaptedLogger),
      hookRegistry: this.hookRegistry,
      storage: stubStorage,
      auditLog: stubAuditLog,
      evidenceVault: stubEvidenceVault,
      notificationHub: stubNotificationHub,
      i18n: stubI18n,
      logger: adaptedLogger,
      config: this.tenantConfig,
    };
  }

  getPrisma(): PrismaService {
    return this.prisma;
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
