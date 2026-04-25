import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type {
  AuditLogService,
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

class StubEventBus implements EventBus {
  constructor(private readonly logger: Logger) {}

  async publish(event: { name: string; metadata: { tenantId: string } }) {
    this.logger.info('event published (stub, sin outbox aún)', {
      event: event.name,
      tenantId: event.metadata.tenantId,
    });
  }

  subscribe() {
    return () => undefined;
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
      eventBus: new StubEventBus(adaptedLogger),
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
