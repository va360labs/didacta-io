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

/**
 * Backend de almacenamiento en crudo (disco, S3…). Escribe exactamente los
 * bytes que recibe: es lo que se quiere para un PDF, un ZIP o los assets de un
 * paquete SCORM, donde cualquier reescritura rompería el fichero.
 *
 * Los módulos NO reciben esto: reciben `StorageService`, que lo envuelve.
 */
export interface StorageAdapter {
  upload(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ key: string }>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export interface UploadImageOptions {
  /** Ancho máximo en px; nunca amplía. Default 1600. El core acota a [64, 4096]. */
  maxWidth?: number;
  /** Calidad de la recompresión. Default 80. El core acota a [40, 95]. */
  quality?: number;
  /**
   * Formato de salida. Default `'webp'`, que es lo que quiere la web.
   *
   * Usa `'png'` si la imagen también va a mostrarse en un CLIENTE DE EMAIL (el
   * logo del tenant, por ejemplo): WebP no es seguro ahí — hay clientes que no
   * lo pintan y otros que ignoran su canal alfa y dejan un rectángulo negro
   * donde debería haber transparencia.
   */
  format?: 'webp' | 'png';
}

export interface UploadedImage {
  /**
   * Key REAL bajo la que quedó el fichero. Puede diferir de la pedida: al
   * recomprimir a WebP se cambia la extensión para que el MIME servido case.
   * Persiste SIEMPRE esta, no la que pasaste.
   */
  key: string;
  /** ContentType real del blob almacenado (`image/webp` si se recomprimió). */
  contentType: string;
  /** false si se guardó el original (vector, formato desconocido, ya óptimo). */
  optimized: boolean;
  /** Bytes finales almacenados. */
  size: number;
  /** Bytes del original recibido. Igual a `size` si no se optimizó. */
  previousSize: number;
  width?: number;
  height?: number;
}

export interface StorageService extends StorageAdapter {
  /**
   * Sube una IMAGEN optimizándola primero (recompresión + redimensionado).
   * Úsalo para cualquier imagen que vaya a mostrarse en la plataforma: avatares,
   * portadas, logos, adjuntos de un post. Es la vía por defecto — `upload()`
   * queda para ficheros que deben conservarse byte a byte.
   *
   * Nunca falla por culpa de la imagen: si el formato no es optimizable (SVG),
   * si viene corrupta, o si comprimir no aporta nada, guarda el original y
   * devuelve `optimized: false`.
   */
  uploadImage(
    key: string,
    data: Buffer | Uint8Array,
    contentType: string,
    opts?: UploadImageOptions,
  ): Promise<UploadedImage>;
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

/**
 * Categoría de preferencia de notificación. Debe coincidir con el enum
 * `NotificationPreferenceCategory` de Prisma y con la matriz que el usuario
 * edita en su cuenta. Si el caller la provee, el hub respeta la preferencia
 * del usuario para ese (categoría, canal) antes de enviar.
 */
export type NotificationCategory = 'COMMUNITY' | 'LEARNING' | 'ASSESSMENTS' | 'SYSTEM';

export interface NotificationHubService {
  send(notification: {
    tenantId: string;
    channel: 'email' | 'in-app' | 'webhook';
    templateKey: string;
    locale: string;
    to: string;
    variables: Record<string, unknown>;
    /**
     * Opcional. Si se provee, el hub consulta la matriz de preferencias del
     * usuario (`user_notification_preference`) para (categoría, canal) y omite
     * el envío si el usuario deshabilitó ese canal. Sin `category`, el envío es
     * incondicional (comportamiento legacy — p. ej. avisos de sistema).
     */
    category?: NotificationCategory;
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
