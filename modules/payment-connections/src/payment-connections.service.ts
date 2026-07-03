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

import type { Prisma, PrismaClient } from '@didacta/database';
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
/** Key en tenant_setting donde se guarda la plantilla del email de renovación. */
const RENEWAL_TEMPLATE_KEY = 'renewal-template';
/** Key en tenant_setting con la URL del Customer Portal de Stripe (enlace de cancelación). */
const CANCEL_PORTAL_URL_KEY = 'cancel-portal-url';
/** Estados Stripe que cuentan como "suscripción activa" para reconciliar. */
export const STRIPE_ACTIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;
/** Tope defensivo de páginas por estado al listar suscripciones. */
export const DEFAULT_MAX_PAGES = 50;

/** Categoría normalizada del estado de una suscripción, transversal a proveedores. */
export type SubscriptionStatusCategory =
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'paused'
  | 'unknown';

export interface SubscriptionStatusInfo {
  category: SubscriptionStatusCategory;
  /** Etiqueta legible en español (p.ej. "Dada de baja", "En impago"). */
  label: string;
  /** Si el estado concede acceso vigente hoy (sirve para preseleccionar el tier). */
  entitled: boolean;
}

/**
 * Clasifica el `status` crudo de una suscripción (Stripe / WooCommerce / PayPal)
 * en una categoría normalizada + etiqueta legible. Permite mostrarle al aprobador
 * "Dada de baja" o "En impago" en lugar de ocultar la suscripción cuando ya no
 * está activa (un cancelado o un impago no es lo mismo que "sin suscripción").
 */
export function classifySubscriptionStatus(status: string): SubscriptionStatusInfo {
  switch ((status ?? '').toLowerCase().trim()) {
    case 'active':
      return { category: 'active', label: 'Activa', entitled: true };
    case 'trialing':
      return { category: 'active', label: 'En prueba', entitled: true };
    case 'past_due':
      return { category: 'past_due', label: 'Pago atrasado (impago)', entitled: true };
    case 'unpaid':
      return { category: 'unpaid', label: 'Impago — suspendida', entitled: false };
    case 'on-hold':
      // WooCommerce 'on-hold' = impago/espera de pago. El set activo de la
      // reconciliación de tiers (WC_ACTIVE_STATUSES) la cuenta como suscrita, así
      // que aquí también es `entitled` (con etiqueta de impago) para no contradecir
      // al sync de tiers — mismo criterio que el past_due de Stripe.
      return { category: 'past_due', label: 'En espera (impago)', entitled: true };
    case 'paused':
      return { category: 'paused', label: 'Pausada', entitled: false };
    case 'pending-cancel':
      return { category: 'canceled', label: 'Baja programada', entitled: true };
    case 'canceled':
    case 'cancelled':
      return { category: 'canceled', label: 'Dada de baja', entitled: false };
    case 'expired':
      return { category: 'canceled', label: 'Expirada', entitled: false };
    case 'incomplete':
    case 'incomplete_expired':
      return { category: 'incomplete', label: 'Pago no completado', entitled: false };
    case 'pending':
      return { category: 'incomplete', label: 'Pendiente de pago', entitled: false };
    default:
      return { category: 'unknown', label: status || 'Desconocido', entitled: false };
  }
}

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
export interface WooCommerceCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}
export type PaymentCredentials = StripeCredentials | PayPalCredentials | WooCommerceCredentials;

/** Construye un lector de SOLO LECTURA para el proveedor + credenciales dados. */
export type PaymentReadAdapterFactory = (
  provider: string,
  credentials: PaymentCredentials,
) => StripeReadAdapter;

/** Proveedores soportados (Stripe, PayPal, WooCommerce Subscriptions). */
export const SUPPORTED_PROVIDERS = ['stripe', 'paypal', 'woocommerce'] as const;

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

/** Una suscripción encontrada para un email concreto (lookup por-usuario). */
export interface MemberSubscriptionMatch {
  provider: string;
  connectionId: string;
  connectionName: string;
  planName: string | null;
  status: string;
  unitAmount: number | null;
  currency: string | null;
  subscriptionId: string;
}

/** Una conexión que NO se pudo consultar durante el lookup (caída, credencial inválida, timeout…). */
export interface MemberSubscriptionLookupFailure {
  provider: string;
  connectionName: string;
  message: string;
}

/**
 * Resultado del lookup de suscripción de un email. `matches` son las suscripciones
 * encontradas; `failures` son las conexiones VERIFIED que fallaron al consultarse.
 * Distinguir ambos es clave: `matches: []` + `failures: []` = "no tiene suscripción",
 * pero `matches: []` + `failures: [...]` = "no se pudo verificar" (NO afirmar que no paga).
 */
export interface MemberSubscriptionLookupResult {
  matches: MemberSubscriptionMatch[];
  failures: MemberSubscriptionLookupFailure[];
}

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Dashboard de control de suscripciones (tabla materializada) ───────────────

/** Resultado de una corrida de `syncSubscribers`. */
export interface SubscriberSyncResult {
  /** Nº de conexiones VERIFIED procesadas. */
  connections: number;
  /** Filas de suscriptor insertadas/actualizadas. */
  upserted: number;
  /** Suscriptores marcados como baja por no aparecer en esta corrida (churn). */
  markedGone: number;
  /** Conexiones que fallaron (no tumban el resto). */
  failures: MemberSubscriptionLookupFailure[];
}

/** Filtros + paginación del listado del dashboard. */
export interface SubscriberListOptions {
  statusCategory?: string;
  provider?: string;
  connectionId?: string;
  /** Solo suscriptores que aún no son usuarios de Didacta. */
  onlyUnmatched?: boolean;
  /** Búsqueda por email (substring, normalizado). */
  q?: string;
  limit?: number;
  offset?: number;
}

/** Fila de suscriptor materializado que lee el dashboard. */
export interface SubscriberRow {
  id: string;
  connectionId: string;
  provider: string;
  subscriptionId: string;
  subscriptionCustomerId: string | null;
  userId: string | null;
  userEmail: string;
  status: string;
  statusCategory: string;
  entitled: boolean;
  productName: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: Date | null;
  renewalUrl: string | null;
  lastSeenAt: Date;
}

/** Agregaciones de cabecera del dashboard. */
export interface SubscriberSummary {
  total: number;
  byCategory: Record<string, number>;
  byProvider: Record<string, number>;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
}

/** Plantilla editable del email de recordatorio de renovación (por tenant). */
export interface RenewalTemplate {
  subject: string;
  body: string;
}

/** Plantilla por defecto si el tenant no ha personalizado ninguna. */
export const DEFAULT_RENEWAL_TEMPLATE: RenewalTemplate = {
  subject: 'Renueva tu suscripción',
  body:
    'Hola,\n\n' +
    'Hemos visto que tu suscripción ({plan}) está pendiente de pago. ' +
    'Puedes renovarla desde este enlace:\n\n{enlace}\n\n' +
    'Si ya lo has resuelto, ignora este mensaje. Gracias.',
};

/** Suscripción próxima a renovarse/caducar (para el resumen diario del admin). */
export interface UpcomingRenewal {
  userEmail: string;
  productName: string | null;
  currentPeriodEnd: Date;
  unitAmount: number | null;
  currency: string | null;
}

/** Suscriptor a avisar de su próxima renovación (aviso 7 días antes). */
export interface SubscriberToWarn {
  id: string;
  userEmail: string;
  productName: string | null;
  currentPeriodEnd: Date;
  unitAmount: number | null;
  currency: string | null;
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

  // ---------------- Lookup por usuario (job de inscripción) ----------------

  /**
   * Busca las suscripciones de UN email en TODAS las cuentas conectadas
   * (Stripe + PayPal + WooCommerce). Best-effort por conexión: si una falla, se
   * registra y se sigue con las demás. Lo usa el job de inscripción de miembros.
   */
  async findUserSubscriptions(
    tenantId: string,
    email: string,
  ): Promise<MemberSubscriptionLookupResult> {
    const norm = normalizeEmail(email);
    if (!norm) return { matches: [], failures: [] };
    const conns = await this.listConnections(tenantId);
    const matches: MemberSubscriptionMatch[] = [];
    const failures: MemberSubscriptionLookupFailure[] = [];
    for (const c of conns) {
      if (c.status !== 'VERIFIED') continue;
      try {
        const credentials = await this.loadCredentials(tenantId, c.id, c.provider);
        const adapter = this.adapterFactory(c.provider, credentials);
        if (!adapter.findSubscriptionsByEmail) continue;
        const subs = await adapter.findSubscriptionsByEmail(norm);
        for (const s of subs) {
          matches.push({
            provider: c.provider,
            connectionId: c.id,
            connectionName: c.displayName,
            planName: s.productName ?? null,
            status: s.status,
            unitAmount: s.unitAmount,
            currency: s.currency,
            subscriptionId: s.subscriptionId,
          });
        }
      } catch (err) {
        // Una cuenta caída no debe tumbar el lookup completo, pero SÍ debe
        // registrarse para no presentarle al aprobador un "sin suscripción"
        // falso (la cuenta podría tener una y no haberse podido consultar).
        failures.push({
          provider: c.provider,
          connectionName: c.displayName,
          message: ((err as Error)?.message ?? 'error').slice(0, 300),
        });
      }
    }
    return { matches, failures };
  }

  // ---------------- Dashboard de control de suscripciones ----------------

  /**
   * Materializa los suscriptores de TODAS las cuentas VERIFIED en
   * `mod_payment_connections_subscriber` (la fuente del dashboard). Por conexión:
   * `reconcile` (en vivo) → upsert de matched + unmatched (clave lógica
   * tenant+connection+subscription); los que ya no aparecen se marcan baja (churn),
   * salvo si la conexión vino truncada (no se listaron todos → no marcar bajas
   * falsas). Registra cada corrida en SyncHistory. Best-effort por conexión.
   */
  async syncSubscribers(tenantId: string): Promise<SubscriberSyncResult> {
    const conns = await this.listConnections(tenantId);
    const verified = conns.filter((c) => c.status === 'VERIFIED');
    let upserted = 0;
    let markedGone = 0;
    const failures: MemberSubscriptionLookupFailure[] = [];

    for (const c of verified) {
      const run = await this.prisma.modPaymentConnectionsSyncHistory.create({
        data: { tenantId, connectionId: c.id, status: 'running' },
      });
      try {
        const rec = await this.reconcile(tenantId, c.id);
        const now = new Date();
        const rows: Array<{ sub: StripeSubscriberRecord; userId: string | null }> = [
          ...rec.matched.map((m) => ({ sub: m.subscription, userId: m.user.id as string | null })),
          ...rec.unmatched.map((sub) => ({ sub, userId: null as string | null })),
        ];
        for (const { sub, userId } of rows) {
          const info = classifySubscriptionStatus(sub.status);
          const data = {
            provider: c.provider,
            subscriptionCustomerId: sub.customerId ?? null,
            userId,
            userEmail: normalizeEmail(sub.email) ?? sub.email?.trim() ?? '',
            status: sub.status,
            statusCategory: info.category,
            entitled: info.entitled,
            productName: sub.productName ?? null,
            unitAmount: sub.unitAmount ?? null,
            currency: sub.currency ?? null,
            interval: sub.interval ?? null,
            currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
            lastSeenAt: now,
          };
          await this.prisma.modPaymentConnectionsSubscriber.upsert({
            where: {
              tenantId_connectionId_subscriptionId: {
                tenantId,
                connectionId: c.id,
                subscriptionId: sub.subscriptionId,
              },
            },
            create: { tenantId, connectionId: c.id, subscriptionId: sub.subscriptionId, ...data },
            update: data,
          });
          upserted += 1;
        }
        if (!rec.truncated) {
          const gone = await this.prisma.modPaymentConnectionsSubscriber.updateMany({
            where: {
              tenantId,
              connectionId: c.id,
              lastSeenAt: { lt: now },
              statusCategory: { not: 'canceled' },
            },
            data: { statusCategory: 'canceled', entitled: false },
          });
          markedGone += gone.count;
        }
        await this.prisma.modPaymentConnectionsSyncHistory.update({
          where: { id: run.id },
          data: {
            status: 'success',
            matchedCount: rec.matched.length,
            unmatchedCount: rec.unmatched.length,
            truncated: rec.truncated,
            completedAt: new Date(),
          },
        });
      } catch (err) {
        const message = ((err as Error)?.message ?? 'error').slice(0, 500);
        failures.push({ provider: c.provider, connectionName: c.displayName, message });
        await this.prisma.modPaymentConnectionsSyncHistory.update({
          where: { id: run.id },
          data: { status: 'error', errorMessage: message, completedAt: new Date() },
        });
      }
    }
    return { connections: verified.length, upserted, markedGone, failures };
  }

  /** Lista paginada + filtrada de suscriptores materializados (para el dashboard). */
  async listSubscribers(
    tenantId: string,
    opts: SubscriberListOptions = {},
  ): Promise<{ rows: SubscriberRow[]; total: number }> {
    const where: Prisma.ModPaymentConnectionsSubscriberWhereInput = { tenantId };
    if (opts.statusCategory) where.statusCategory = opts.statusCategory;
    if (opts.provider) where.provider = opts.provider;
    if (opts.connectionId) where.connectionId = opts.connectionId;
    if (opts.onlyUnmatched) where.userId = null;
    const q = opts.q?.trim().toLowerCase();
    if (q) where.userEmail = { contains: q };
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const [found, total] = await Promise.all([
      this.prisma.modPaymentConnectionsSubscriber.findMany({
        where,
        orderBy: [{ statusCategory: 'asc' }, { unitAmount: 'desc' }],
        take,
        skip,
      }),
      this.prisma.modPaymentConnectionsSubscriber.count({ where }),
    ]);
    const rows: SubscriberRow[] = found.map((r) => ({
      id: r.id,
      connectionId: r.connectionId,
      provider: r.provider,
      subscriptionId: r.subscriptionId,
      subscriptionCustomerId: r.subscriptionCustomerId,
      userId: r.userId,
      userEmail: r.userEmail,
      status: r.status,
      statusCategory: r.statusCategory,
      entitled: r.entitled,
      productName: r.productName,
      unitAmount: r.unitAmount,
      currency: r.currency,
      interval: r.interval,
      currentPeriodEnd: r.currentPeriodEnd,
      renewalUrl: r.renewalUrl,
      lastSeenAt: r.lastSeenAt,
    }));
    return { rows, total };
  }

  /** Agregaciones para la cabecera del dashboard (contadores + frescura). */
  async subscriberSummary(tenantId: string): Promise<SubscriberSummary> {
    const [byCat, byProv, total, lastRun] = await Promise.all([
      this.prisma.modPaymentConnectionsSubscriber.groupBy({
        by: ['statusCategory'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.modPaymentConnectionsSubscriber.groupBy({
        by: ['provider'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.modPaymentConnectionsSubscriber.count({ where: { tenantId } }),
      this.prisma.modPaymentConnectionsSyncHistory.findFirst({
        where: { tenantId, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true, status: true },
      }),
    ]);
    const byCategory: Record<string, number> = {};
    for (const g of byCat) byCategory[g.statusCategory] = g._count._all;
    const byProvider: Record<string, number> = {};
    for (const g of byProv) byProvider[g.provider] = g._count._all;
    return {
      total,
      byCategory,
      byProvider,
      lastSyncedAt: lastRun?.completedAt ?? null,
      lastSyncStatus: lastRun?.status ?? null,
    };
  }

  /** Un suscriptor materializado por id (del tenant), o null. */
  async getSubscriber(tenantId: string, id: string): Promise<SubscriberRow | null> {
    const r = await this.prisma.modPaymentConnectionsSubscriber.findFirst({
      where: { tenantId, id },
    });
    if (!r) return null;
    return {
      id: r.id,
      connectionId: r.connectionId,
      provider: r.provider,
      subscriptionId: r.subscriptionId,
      subscriptionCustomerId: r.subscriptionCustomerId,
      userId: r.userId,
      userEmail: r.userEmail,
      status: r.status,
      statusCategory: r.statusCategory,
      entitled: r.entitled,
      productName: r.productName,
      unitAmount: r.unitAmount,
      currency: r.currency,
      interval: r.interval,
      currentPeriodEnd: r.currentPeriodEnd,
      renewalUrl: r.renewalUrl,
      lastSeenAt: r.lastSeenAt,
    };
  }

  /**
   * Resuelve el enlace de renovación READ-ONLY a partir de la referencia cruda
   * (connection + provider + subscription), SIN depender de la tabla materializada
   * del dashboard. Stripe: hosted_invoice_url de la factura abierta/impaga (necesita
   * permiso de lectura de Facturas en la key; si no, null). WooCommerce/PayPal: null
   * en v1. Best-effort: ante cualquier fallo devuelve null (no rompe el envío del email).
   *
   * Lo usa tanto `resolveRenewalUrl` (por id del registro materializado) como el panel
   * de solicitudes de inscripción (que solo tiene la referencia cruda del lookup en vivo).
   */
  async resolveRenewalUrlByRef(
    tenantId: string,
    connectionId: string,
    provider: string,
    subscriptionId: string,
  ): Promise<string | null> {
    if (provider !== 'stripe') return null;
    try {
      const credentials = await this.loadCredentials(tenantId, connectionId, provider);
      const adapter = this.adapterFactory(provider, credentials);
      if (!adapter.readOpenInvoiceUrl) return null;
      return (await adapter.readOpenInvoiceUrl(subscriptionId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve (lazy) el enlace de renovación READ-ONLY del suscriptor materializado
   * y lo cachea. Delega la resolución en vivo en `resolveRenewalUrlByRef` y, si no
   * la consigue, cae al `renewalUrl` ya guardado. Best-effort.
   */
  async resolveRenewalUrl(tenantId: string, id: string): Promise<string | null> {
    const r = await this.prisma.modPaymentConnectionsSubscriber.findFirst({
      where: { tenantId, id },
    });
    if (!r) return null;
    if (r.provider !== 'stripe') return r.renewalUrl ?? null;
    const url = await this.resolveRenewalUrlByRef(
      tenantId,
      r.connectionId,
      r.provider,
      r.subscriptionId,
    );
    if (url && url !== r.renewalUrl) {
      await this.prisma.modPaymentConnectionsSubscriber.update({
        where: { id: r.id },
        data: { renewalUrl: url },
      });
    }
    return url ?? r.renewalUrl ?? null;
  }

  /** Plantilla del email de renovación del tenant (o la por defecto). */
  async getRenewalTemplate(tenantId: string): Promise<RenewalTemplate> {
    const stored = await this.config.get<RenewalTemplate>(
      tenantId,
      PAYMENT_CONNECTIONS_MODULE,
      RENEWAL_TEMPLATE_KEY,
    );
    if (stored && typeof stored.subject === 'string' && typeof stored.body === 'string') {
      return stored;
    }
    return DEFAULT_RENEWAL_TEMPLATE;
  }

  /** Personaliza la plantilla del email de renovación del tenant. */
  async setRenewalTemplate(
    tenantId: string,
    template: RenewalTemplate,
    actorId: string | null,
  ): Promise<RenewalTemplate> {
    await this.config.set(tenantId, PAYMENT_CONNECTIONS_MODULE, RENEWAL_TEMPLATE_KEY, template, {
      actorId,
    });
    return template;
  }

  /**
   * URL del Customer Portal de Stripe del tenant. Va en el aviso de "se renovará en
   * 7 días" para que el cliente pueda cancelar solo (las keys son read-only, no
   * podemos generar la sesión por API). null si no está configurada.
   */
  async getCancelPortalUrl(tenantId: string): Promise<string | null> {
    const v = await this.config.get<string>(
      tenantId,
      PAYMENT_CONNECTIONS_MODULE,
      CANCEL_PORTAL_URL_KEY,
    );
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  async setCancelPortalUrl(
    tenantId: string,
    url: string | null,
    actorId: string | null,
  ): Promise<void> {
    await this.config.set(tenantId, PAYMENT_CONNECTIONS_MODULE, CANCEL_PORTAL_URL_KEY, url ?? '', {
      actorId,
    });
  }

  /**
   * Datos del resumen diario para el admin: nº de suscripciones activas (entitled)
   * y las que se renuevan/caducan en los próximos `days` días (con fecha e importe).
   * Solo las que tienen `currentPeriodEnd` (Stripe; Woo/PayPal suelen venir sin fecha).
   */
  async getSubscriptionDigest(
    tenantId: string,
    days: number,
  ): Promise<{ activeCount: number; upcoming: UpcomingRenewal[] }> {
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const [activeCount, rows] = await Promise.all([
      this.prisma.modPaymentConnectionsSubscriber.count({ where: { tenantId, entitled: true } }),
      this.prisma.modPaymentConnectionsSubscriber.findMany({
        where: { tenantId, entitled: true, currentPeriodEnd: { gt: now, lte: until } },
        orderBy: { currentPeriodEnd: 'asc' },
        take: 500,
        select: {
          userEmail: true,
          productName: true,
          currentPeriodEnd: true,
          unitAmount: true,
          currency: true,
        },
      }),
    ]);
    return {
      activeCount,
      upcoming: rows.map((r) => ({
        userEmail: r.userEmail,
        productName: r.productName,
        currentPeriodEnd: r.currentPeriodEnd as Date,
        unitAmount: r.unitAmount,
        currency: r.currency,
      })),
    };
  }

  /**
   * Suscriptores a los que hay que avisar de que se renuevan en ≤`days` días y que
   * AÚN no se avisaron para este periodo (idempotencia por `renewalWarnedPeriodEnd`).
   */
  async listSubscribersToWarn(tenantId: string, days: number): Promise<SubscriberToWarn[]> {
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const rows = await this.prisma.modPaymentConnectionsSubscriber.findMany({
      where: { tenantId, entitled: true, currentPeriodEnd: { gt: now, lte: until } },
      take: 1000,
      select: {
        id: true,
        userEmail: true,
        productName: true,
        currentPeriodEnd: true,
        unitAmount: true,
        currency: true,
        renewalWarnedPeriodEnd: true,
      },
    });
    return rows
      .filter(
        (r) =>
          r.currentPeriodEnd != null &&
          r.renewalWarnedPeriodEnd?.getTime() !== r.currentPeriodEnd.getTime(),
      )
      .map((r) => ({
        id: r.id,
        userEmail: r.userEmail,
        productName: r.productName,
        currentPeriodEnd: r.currentPeriodEnd as Date,
        unitAmount: r.unitAmount,
        currency: r.currency,
      }));
  }

  /** Marca que ya se avisó a un suscriptor de la renovación de este periodo. */
  async markRenewalWarned(subscriberId: string, periodEnd: Date): Promise<void> {
    await this.prisma.modPaymentConnectionsSubscriber.update({
      where: { id: subscriberId },
      data: { renewalWarnedPeriodEnd: periodEnd },
    });
  }

  /** Emails de los admins (super_admin/tenant_admin) ACTIVE — destinatarios del resumen diario. */
  async listTenantAdminEmails(tenantId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: ['super_admin', 'tenant_admin'] } } } },
      },
      select: { email: true },
    });
    return [...new Set(users.map((u) => u.email))];
  }

  /**
   * Nombres de planes del CATÁLOGO de todas las cuentas VERIFIED (parte B del sync
   * de tiers): incluye planes que aún NO tienen ningún suscriptor. Best-effort por
   * conexión: una cuenta sin permiso de lectura de Productos no rompe el resto.
   */
  async listPlanCatalogLabels(tenantId: string): Promise<string[]> {
    const conns = await this.listConnections(tenantId);
    const labels = new Set<string>();
    for (const c of conns) {
      if (c.status !== 'VERIFIED') continue;
      try {
        const credentials = await this.loadCredentials(tenantId, c.id, c.provider);
        const adapter = this.adapterFactory(c.provider, credentials);
        if (!adapter.listPlanCatalog) continue;
        for (const n of await adapter.listPlanCatalog()) {
          const t = n.trim();
          if (t) labels.add(t);
        }
      } catch {
        // best-effort
      }
    }
    return [...labels];
  }

  /**
   * Tenants con AL MENOS una conexión VERIFIED. Lo usa el scheduler periódico para
   * saber a qué tenants sincronizar. OJO: query CROSS-TENANT (sin filtro tenantId)
   * — solo correcta en contexto de worker (sin RLS de request); en prod el rol de
   * la app bypasa RLS (mismo modelo que el resto de workers del host).
   */
  async listTenantsWithVerifiedConnections(): Promise<string[]> {
    const rows = await this.prisma.modPaymentConnectionsConnection.findMany({
      where: { status: 'VERIFIED' },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return rows.map((r) => r.tenantId);
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
  // WooCommerce no tiene test/live: la tienda es la que es.
  return true;
}
