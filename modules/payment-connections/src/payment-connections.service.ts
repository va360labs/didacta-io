/**
 * PaymentConnectionsService — lógica de dominio de mod.payment-connections.
 *
 * Responsabilidades:
 *   - CRUD de conexiones Stripe (tabla mod_payment_connections_connection).
 *   - Guardar/leer la API key CIFRADA vía el puerto `config` (tenant_setting,
 *     AES-256-GCM, isSecret). La key NUNCA toca la tabla del módulo ni se
 *     devuelve a la UI.
 *   - Reconciliar las suscripciones activas de una cuenta contra los usuarios
 *     de Didacta por email normalizado (puerto `users`).
 *
 * Lo que NO hace:
 *   - Crear/cancelar cobros (es read-only; cancelar = deep-link al dashboard).
 *   - Invitar usuarios: lo orquesta el controller del host con AdminUsersService
 *     (evita acoplar el módulo al core de IAM).
 *   - Validar input HTTP: lo hace el controller con zod.
 *
 * Diseño testeable: recibe PUERTOS inyectados (config, adapterFactory, users)
 * en vez de servicios concretos, para mockear Stripe/DB/usuarios en unit tests.
 */

import type { PrismaClient } from '@didacta/database';
import {
  PaymentConnectionsError,
  PaymentConnectionAlreadyExistsError,
  PaymentConnectionNotFoundError,
  PaymentConnectionProviderNotSupportedError,
  StripeReadKeyInvalidError,
} from './errors.js';
import type { StripeReadAdapter, StripeSubscriberRecord } from './stripe-reader.client.js';

type ConnectionRow = Awaited<ReturnType<PrismaClient['modPaymentConnectionsConnection']['create']>>;

/** Slug del módulo usado como `moduleName` en tenant_setting. */
export const PAYMENT_CONNECTIONS_MODULE = 'payment-connections';
/** Estados Stripe que cuentan como "suscripción activa" para reconciliar. */
export const STRIPE_ACTIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;
/** Tope defensivo de páginas por estado al listar suscripciones. */
export const DEFAULT_MAX_PAGES = 50;

/**
 * Subconjunto del contrato del `TenantConfigService` del kernel que necesita
 * este módulo. Lo implementa `PrismaTenantConfigService` del host.
 */
export interface ConfigPort {
  get<T = unknown>(tenantId: string, moduleName: string, key: string): Promise<T | undefined>;
  set<T = unknown>(
    tenantId: string,
    moduleName: string,
    key: string,
    value: T,
    options?: { isSecret?: boolean; actorId?: string | null },
  ): Promise<void>;
  delete(
    tenantId: string,
    moduleName: string,
    key: string,
    options?: { actorId?: string | null },
  ): Promise<void>;
}

/** Usuario de Didacta resuelto para el panel (campos públicos no sensibles). */
export interface DidactaUserRecord {
  id: string;
  email: string;
  name: string | null;
  status: string;
  avatarUrl: string | null;
}

/**
 * Puerto de directorio de usuarios del core. La implementación del host hace
 * el match case-insensitive (lower(email)) contra la tabla `user` del tenant.
 */
export interface UserDirectoryPort {
  findByNormalizedEmails(
    tenantId: string,
    normalizedEmails: string[],
  ): Promise<DidactaUserRecord[]>;
}

/** Credenciales por proveedor (se guardan cifradas en tenant_setting). */
export interface StripeCredentials {
  apiKey: string;
}
export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'live';
}
export type PaymentCredentials = StripeCredentials | PayPalCredentials;

/** Construye un lector de SOLO LECTURA para el proveedor + credenciales dados. */
export type PaymentReadAdapterFactory = (
  provider: string,
  credentials: PaymentCredentials,
) => StripeReadAdapter;

/** Proveedores soportados en esta versión (multi-proveedor: WooCommerce en roadmap). */
export const SUPPORTED_PROVIDERS = ['stripe', 'paypal'] as const;

export interface AddConnectionInput {
  tenantId: string;
  actorId: string | null;
  provider: string;
  displayName: string;
  credentials: PaymentCredentials;
}

export interface ReconcileResult {
  connectionId: string;
  accountId: string | null;
  livemode: boolean;
  /** Suscriptores Stripe cuyo email SÍ corresponde a un usuario de Didacta. */
  matched: Array<{ subscription: StripeSubscriberRecord; user: DidactaUserRecord }>;
  /** Suscriptores Stripe que NO están en Didacta (incluye los sin email). */
  unmatched: StripeSubscriberRecord[];
  truncated: boolean;
  counts: { total: number; matched: number; unmatched: number; withoutEmail: number };
}

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export class PaymentConnectionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: ConfigPort,
    private readonly adapterFactory: PaymentReadAdapterFactory,
    private readonly users: UserDirectoryPort,
  ) {}

  // ---------------- Conexiones (admin) ----------------

  /**
   * Conecta una cuenta Stripe nueva: valida la key con accounts.retrieve,
   * persiste la fila (metadata, sin secreto) y guarda la key cifrada aparte.
   */
  async addConnection(input: AddConnectionInput): Promise<ConnectionRow> {
    if (!SUPPORTED_PROVIDERS.includes(input.provider as (typeof SUPPORTED_PROVIDERS)[number])) {
      throw new PaymentConnectionProviderNotSupportedError(input.provider);
    }
    const displayName = input.displayName.trim();

    const existing = await this.prisma.modPaymentConnectionsConnection.findFirst({
      where: { tenantId: input.tenantId, provider: input.provider, displayName },
    });
    if (existing) throw new PaymentConnectionAlreadyExistsError(displayName);

    // Valida las credenciales (lanza si son inválidas) y obtiene metadata.
    const account = await this.adapterFactory(input.provider, input.credentials).retrieveAccount();
    const livemode = computeLivemode(input.provider, input.credentials);

    const row = await this.prisma.modPaymentConnectionsConnection.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        displayName,
        status: 'VERIFIED',
        publicMetadata: {
          accountId: account.id,
          email: account.email,
          country: account.country,
          businessName: account.businessName,
          livemode,
        },
        lastVerifiedAt: new Date(),
      },
    });

    await this.config.set(
      input.tenantId,
      PAYMENT_CONNECTIONS_MODULE,
      this.credKeyName(input.provider, row.id),
      input.credentials,
      { isSecret: true, actorId: input.actorId },
    );

    return row;
  }

  async listConnections(tenantId: string): Promise<ConnectionRow[]> {
    return this.prisma.modPaymentConnectionsConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getConnection(tenantId: string, id: string): Promise<ConnectionRow> {
    const row = await this.prisma.modPaymentConnectionsConnection.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new PaymentConnectionNotFoundError(id);
    return row;
  }

  /** Re-valida las credenciales y refresca metadata/status. */
  async verifyConnection(
    tenantId: string,
    id: string,
    actorId: string | null,
  ): Promise<ConnectionRow> {
    void actorId;
    const row = await this.getConnection(tenantId, id);
    const credentials = await this.loadCredentials(tenantId, id, row.provider);
    try {
      const account = await this.adapterFactory(row.provider, credentials).retrieveAccount();
      const livemode = computeLivemode(row.provider, credentials);
      return await this.prisma.modPaymentConnectionsConnection.update({
        where: { id: row.id },
        data: {
          status: 'VERIFIED',
          lastVerifiedAt: new Date(),
          lastError: null,
          lastErrorAt: null,
          publicMetadata: {
            accountId: account.id,
            email: account.email,
            country: account.country,
            businessName: account.businessName,
            livemode,
          },
        },
      });
    } catch (err) {
      await this.prisma.modPaymentConnectionsConnection.update({
        where: { id: row.id },
        data: {
          status: 'ERROR',
          lastError: ((err as Error).message ?? 'error').slice(0, 500),
          lastErrorAt: new Date(),
        },
      });
      throw err instanceof PaymentConnectionsError
        ? err
        : new StripeReadKeyInvalidError((err as Error).message ?? 'error');
    }
  }

  /** Desconecta: borra la fila y el secret cifrado. */
  async disconnectConnection(tenantId: string, id: string, actorId: string | null): Promise<void> {
    const row = await this.getConnection(tenantId, id);
    await this.config
      .delete(tenantId, PAYMENT_CONNECTIONS_MODULE, this.credKeyName(row.provider, id), { actorId })
      .catch(() => {
        // El secret puede no existir (conexión vieja); el borrado de la fila manda.
      });
    // Compat: borra también el secret legacy de Stripe si existiera.
    if (row.provider === 'stripe') {
      await this.config
        .delete(tenantId, PAYMENT_CONNECTIONS_MODULE, `stripe:${id}:api_key`, { actorId })
        .catch(() => {});
    }
    await this.prisma.modPaymentConnectionsConnection.delete({ where: { id: row.id } });
  }

  // ---------------- Reconciliación ----------------

  /**
   * Lee las suscripciones activas de la cuenta y las separa en:
   *   - matched: su email corresponde a un usuario de Didacta del tenant.
   *   - unmatched: no está en Didacta (o no tiene email en Stripe).
   * El match es por email NORMALIZADO (lowercase + trim) en ambos lados.
   */
  async reconcile(tenantId: string, id: string): Promise<ReconcileResult> {
    const row = await this.getConnection(tenantId, id);
    const credentials = await this.loadCredentials(tenantId, id, row.provider);

    const { subscribers, truncated } = await this.adapterFactory(
      row.provider,
      credentials,
    ).listActiveSubscriptions({
      statuses: [...STRIPE_ACTIVE_STATUSES],
      maxPages: DEFAULT_MAX_PAGES,
    });

    await this.prisma.modPaymentConnectionsConnection
      .update({ where: { id: row.id }, data: { lastSyncedAt: new Date() } })
      .catch(() => {
        // No bloquear la reconciliación por un fallo al estampar lastSyncedAt.
      });

    const normalizedEmails = Array.from(
      new Set(
        subscribers.map((s) => normalizeEmail(s.email)).filter((e): e is string => e !== null),
      ),
    );

    const users =
      normalizedEmails.length > 0
        ? await this.users.findByNormalizedEmails(tenantId, normalizedEmails)
        : [];
    const userByEmail = new Map<string, DidactaUserRecord>();
    for (const u of users) {
      const n = normalizeEmail(u.email);
      if (n && !userByEmail.has(n)) userByEmail.set(n, u);
    }

    const matched: ReconcileResult['matched'] = [];
    const unmatched: StripeSubscriberRecord[] = [];
    let withoutEmail = 0;

    for (const sub of subscribers) {
      const n = normalizeEmail(sub.email);
      if (!n) {
        withoutEmail += 1;
        unmatched.push(sub);
        continue;
      }
      const user = userByEmail.get(n);
      if (user) matched.push({ subscription: sub, user });
      else unmatched.push(sub);
    }

    const meta = (row.publicMetadata ?? {}) as { accountId?: string; livemode?: boolean };
    return {
      connectionId: row.id,
      accountId: meta.accountId ?? null,
      livemode: meta.livemode ?? true,
      matched,
      unmatched,
      truncated,
      counts: {
        total: subscribers.length,
        matched: matched.length,
        unmatched: unmatched.length,
        withoutEmail,
      },
    };
  }

  // ---------------- internos ----------------

  private credKeyName(provider: string, connectionId: string): string {
    return `${provider}:${connectionId}:credentials`;
  }

  private async loadCredentials(
    tenantId: string,
    id: string,
    provider: string,
  ): Promise<PaymentCredentials> {
    const creds = await this.config.get<PaymentCredentials>(
      tenantId,
      PAYMENT_CONNECTIONS_MODULE,
      this.credKeyName(provider, id),
    );
    if (creds) return creds;
    // Compat: conexiones Stripe viejas guardaban la api key como string suelto.
    if (provider === 'stripe') {
      const legacy = await this.config.get<string>(
        tenantId,
        PAYMENT_CONNECTIONS_MODULE,
        `stripe:${id}:api_key`,
      );
      if (legacy) return { apiKey: legacy };
    }
    throw new StripeReadKeyInvalidError(
      'la credencial de esta conexión no está disponible (¿se borró o cambió la clave de cifrado del servidor?)',
    );
  }
}

/** Determina si la conexión es de producción (live) según sus credenciales. */
function computeLivemode(provider: string, credentials: PaymentCredentials): boolean {
  if (provider === 'stripe') {
    const key = (credentials as StripeCredentials).apiKey ?? '';
    return key.startsWith('sk_live') || key.startsWith('rk_live');
  }
  if (provider === 'paypal') {
    return (credentials as PayPalCredentials).environment === 'live';
  }
  return true;
}
