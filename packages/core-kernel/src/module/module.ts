import type { ModuleManifest } from './manifest.js';

/**
 * Logger mínimo que todo módulo recibe en su contexto.
 * Implementaciones concretas (Pino, etc.) viven fuera del core-kernel.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface EventMetadata {
  tenantId: string;
  userId?: string;
  timestamp: string;
  traceId: string;
  idempotencyKey: string;
}

export interface DomainEvent<TPayload = unknown> {
  name: string;
  version: number;
  data: TPayload;
  metadata: EventMetadata;
}

export interface EventBus {
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<void>;
  subscribe<TPayload>(
    eventName: string,
    handler: (event: DomainEvent<TPayload>) => Promise<void> | void,
  ): () => void;
}

export interface HookContext<TInput = unknown> {
  tenantId: string;
  input: TInput;
  metadata: Record<string, unknown>;
}

export interface HookRegistry {
  register<TInput>(
    hookName: string,
    handler: (ctx: HookContext<TInput>) => Promise<void> | void,
  ): void;
  run<TInput>(hookName: string, ctx: HookContext<TInput>): Promise<void>;
}

export interface StorageService {
  upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ key: string }>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export interface AuditLogService {
  record(entry: {
    tenantId: string;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<void>;
}

export interface EvidenceVaultService {
  store(artifact: {
    tenantId: string;
    resourceType: string;
    resourceId: string;
    data: Buffer | Uint8Array;
    contentType?: string;
  }): Promise<{ id: string; hash: string; storageKey: string }>;
}

export interface NotificationHubService {
  send(notification: {
    tenantId: string;
    channel: 'email' | 'in-app' | 'webhook';
    templateKey: string;
    locale: string;
    to: string;
    variables: Record<string, unknown>;
  }): Promise<void>;
}

export interface I18nService {
  t(key: string, variables?: Record<string, unknown>, locale?: string): string;
}

export interface TenantConfigService {
  get<T = unknown>(tenantId: string, moduleName: string, key: string): Promise<T | undefined>;
  set<T = unknown>(tenantId: string, moduleName: string, key: string, value: T): Promise<void>;
}

/**
 * Contexto que el core provee a cada módulo al registrarlo y activarlo.
 * Los módulos NUNCA deben crear sus propias instancias de estos servicios.
 */
export interface ModuleContext {
  eventBus: EventBus;
  hookRegistry: HookRegistry;
  storage: StorageService;
  auditLog: AuditLogService;
  evidenceVault: EvidenceVaultService;
  notificationHub: NotificationHubService;
  i18n: I18nService;
  logger: Logger;
  config: TenantConfigService;
}

/**
 * Contrato que todo módulo de Didacta debe implementar.
 * Ver docs/ARQUITECTURA-MODULAR.md §3.3
 */
export interface DidactaModule {
  readonly manifest: ModuleManifest;

  /** Ejecutado una vez al arrancar la plataforma (antes de activar en ningún tenant). */
  onRegister(ctx: ModuleContext): Promise<void>;

  /** Ejecutado cuando un tenant activa el módulo (puede ejecutarse N veces). */
  onEnable(tenantId: string, ctx: ModuleContext): Promise<void>;

  /** Ejecutado cuando un tenant desactiva el módulo. Los datos se conservan. */
  onDisable(tenantId: string, ctx: ModuleContext): Promise<void>;

  /** Ejecutado al desinstalar el módulo por completo. Los datos se archivan. */
  onUninstall(tenantId: string, ctx: ModuleContext): Promise<void>;
}
