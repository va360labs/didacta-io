'use client';

/**
 * Panel admin · Conexiones de pago (mod.payment-connections).
 *
 * El admin conecta varias cuentas Stripe en modo SOLO LECTURA (clave restringida
 * read-only, cifrada en el backend) y reconcilia sus suscripciones activas contra
 * los usuarios de Didacta por email → dos tablas:
 *   A) usuarios de Didacta con suscripción activa,
 *   B) suscriptores que aún NO están en Didacta (con acción "Invitar").
 *
 * Cancelar una suscripción NO se hace desde aquí (la clave es read-only): se
 * ofrece un deep-link al dashboard de Stripe de esa cuenta.
 *
 * Solo super_admin (muestra PII de pagos). Todo el dato viene en vivo de la API
 * (Stripe + BD real). Cero datos de cartón.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  paymentConnectionsApi,
  paymentTiersApi,
  formatAmount,
  stripeSubscriptionUrl,
  type ConnectBody,
  type PaymentConnection,
  type PaymentConnectionStatus,
  type ReconcileResult,
  type StripeSubscriber,
  type InviteResultRow,
  type PaymentTier,
} from '@/lib/payment-connections';

const API_KEY_PATTERN = /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/;

export default function PaymentConnectionsPage() {
  const isSuperAdmin = useMemo(() => {
    const session = authStorage.getSession();
    return session?.user.roles.includes('super_admin') ?? false;
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">Conexiones de pago</h1>
        <p className="text-text-muted">
          Conecta tus cuentas de Stripe en modo <strong>solo lectura</strong> y comprueba qué
          suscriptores ya están en Didacta y cuáles no. PayPal llegará más adelante.
        </p>
      </header>

      {isSuperAdmin ? (
        <PaymentConnectionsPanel />
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">
            Esta sección es exclusiva de <strong>super_admin</strong> porque muestra datos de pago
            de tus clientes.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PaymentConnectionsPanel() {
  const [connections, setConnections] = useState<PaymentConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);

  // Form alta
  const [provider, setProvider] = useState<'stripe' | 'paypal'>('stripe');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [environment, setEnvironment] = useState<'live' | 'sandbox'>('live');
  const [creating, setCreating] = useState(false);

  // Reconciliación
  const [selected, setSelected] = useState<PaymentConnection | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) {
      setError('Sesión sin token. Vuelve a iniciar sesión.');
      return;
    }
    void (async () => {
      try {
        const res = await paymentConnectionsApi.list(token);
        setConnections(res.connections);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? e.message : 'No se pudieron cargar las conexiones de pago.',
        );
      }
    })();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token || !displayName.trim()) return;

    let body: ConnectBody;
    if (provider === 'stripe') {
      if (!API_KEY_PATTERN.test(apiKey.trim())) {
        setActionError(
          'La clave debe ser una Stripe API key (rk_live_… / rk_test_… / sk_live_… / sk_test_…) ' +
            'restringida con permisos Customers + Subscriptions = Read.',
        );
        return;
      }
      body = { provider: 'stripe', displayName: displayName.trim(), apiKey: apiKey.trim() };
    } else {
      if (!clientId.trim() || !clientSecret.trim()) {
        setActionError(
          'PayPal necesita el Client ID y el Secret de una app REST con el permiso «Transaction Search».',
        );
        return;
      }
      body = {
        provider: 'paypal',
        displayName: displayName.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        environment,
      };
    }

    setCreating(true);
    setActionError(null);
    setActionInfo(null);
    try {
      const { connection } = await paymentConnectionsApi.create(token, body);
      setConnections((prev) => (prev ? [connection, ...prev] : [connection]));
      setDisplayName('');
      setApiKey('');
      setClientId('');
      setClientSecret('');
      setActionInfo(`Cuenta "${connection.displayName}" conectada y verificada.`);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError
          ? e.message
          : 'No se pudo conectar la cuenta. Revisa las credenciales.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleVerify(conn: PaymentConnection) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusyId(conn.id);
    setActionError(null);
    setActionInfo(null);
    try {
      const { connection } = await paymentConnectionsApi.verify(token, conn.id);
      setConnections((prev) =>
        prev ? prev.map((c) => (c.id === connection.id ? connection : c)) : prev,
      );
      setActionInfo(`"${connection.displayName}" verificada correctamente.`);
    } catch (e) {
      // El backend ya marcó la conexión en ERROR; refrescamos el listado.
      await refreshList(token);
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo verificar la conexión.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect(conn: PaymentConnection) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      !window.confirm(
        `¿Desconectar "${conn.displayName}"? Se borrará la clave guardada. Las suscripciones en Stripe no se tocan.`,
      )
    )
      return;
    setBusyId(conn.id);
    setActionError(null);
    setActionInfo(null);
    try {
      await paymentConnectionsApi.remove(token, conn.id);
      setConnections((prev) => (prev ? prev.filter((c) => c.id !== conn.id) : prev));
      if (selected?.id === conn.id) {
        setSelected(null);
        setReconcile(null);
      }
      setActionInfo('Conexión desconectada.');
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo desconectar la conexión.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReconcile(conn: PaymentConnection) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSelected(conn);
    setReconcile(null);
    setReconciling(true);
    setActionError(null);
    setActionInfo(null);
    try {
      const res = await paymentConnectionsApi.reconcile(token, conn.id);
      setReconcile(res);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudieron leer las suscripciones de Stripe.',
      );
    } finally {
      setReconciling(false);
    }
  }

  async function refreshList(token: string) {
    try {
      const res = await paymentConnectionsApi.list(token);
      setConnections(res.connections);
    } catch {
      // Silencioso: el último error ya se muestra.
    }
  }

  if (connections === null && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  const list = connections ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Form alta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="plus" size={18} />
            Conectar una cuenta de pago
          </CardTitle>
          <CardDescription>
            {provider === 'stripe' ? (
              <>
                Crea una <strong>clave API restringida</strong> en{' '}
                <a
                  href="https://dashboard.stripe.com/apikeys/create"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 underline"
                >
                  tu panel de Stripe
                </a>{' '}
                con permisos <code className="font-mono">Customers = Read</code> y{' '}
                <code className="font-mono">Subscriptions = Read</code>. Se guarda cifrada.
              </>
            ) : (
              <>
                Usa el <strong>Client ID</strong> y <strong>Secret</strong> de una app REST de{' '}
                <a
                  href="https://developer.paypal.com/dashboard/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 underline"
                >
                  tu panel de PayPal
                </a>{' '}
                con el permiso <strong>Transaction Search</strong> activado. Se guardan cifrados.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider">Proveedor</Label>
                <Select
                  id="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'stripe' | 'paypal')}
                  disabled={creating}
                  className="min-w-32"
                >
                  <option value="stripe">Stripe</option>
                  <option value="paypal">PayPal</option>
                </Select>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="displayName">Nombre de la cuenta</Label>
                <Input
                  id="displayName"
                  placeholder={provider === 'stripe' ? 'Stripe ES' : 'PayPal ES'}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={creating}
                  maxLength={120}
                />
              </div>
            </div>

            {provider === 'stripe' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apiKey">Stripe API key (restringida, read-only)</Label>
                <Input
                  id="apiKey"
                  placeholder="rk_live_…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={creating}
                  type="password"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3 md:flex-row">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="clientId">PayPal Client ID</Label>
                  <Input
                    id="clientId"
                    placeholder="AeA1Q…"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="clientSecret">Secret</Label>
                  <Input
                    id="clientSecret"
                    placeholder="EJ2x…"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                    type="password"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="environment">Entorno</Label>
                  <Select
                    id="environment"
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value as 'live' | 'sandbox')}
                    disabled={creating}
                    className="min-w-32"
                  >
                    <option value="live">Live</option>
                    <option value="sandbox">Sandbox</option>
                  </Select>
                </div>
              </div>
            )}

            <div>
              <Button type="submit" disabled={creating || !displayName.trim()}>
                {creating ? 'Conectando…' : 'Conectar'}
              </Button>
            </div>
          </form>
          {actionError ? <p className="mt-3 text-sm text-danger-700">{actionError}</p> : null}
          {actionInfo ? <p className="mt-3 text-sm text-success-700">{actionInfo}</p> : null}
        </CardContent>
      </Card>

      {/* Lista de conexiones */}
      {list.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">
            Aún no has conectado ninguna cuenta de Stripe. Conecta una arriba para ver sus
            suscriptores.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              busy={busyId === conn.id}
              selected={selected?.id === conn.id}
              onReconcile={() => handleReconcile(conn)}
              onVerify={() => handleVerify(conn)}
              onDisconnect={() => handleDisconnect(conn)}
            />
          ))}
        </div>
      )}

      {/* Reconciliación */}
      {selected ? (
        <ReconcileSection
          connection={selected}
          loading={reconciling}
          data={reconcile}
          onInvited={(info) => setActionInfo(info)}
        />
      ) : null}

      <TierCatalogPanel />
    </div>
  );
}

/// Catálogo de tiers del tenant. El admin define aquí los tiers (Free, Básico,
/// Pro…) que luego asigna a usuarios manualmente desde /admin/usuarios.
function TierCatalogPanel() {
  const [tiers, setTiers] = useState<PaymentTier[] | null>(null);
  const [name, setName] = useState('');
  const [isFree, setIsFree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const res = await paymentTiersApi.listCatalog(token);
        setTiers(res.tiers);
      } catch (e) {
        setErr(e instanceof ApiHttpError ? e.message : 'No se pudo cargar el catálogo de tiers.');
      }
    })();
  }, []);

  async function handleSync() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSyncing(true);
    setErr(null);
    setSyncInfo(null);
    try {
      const res = await paymentTiersApi.syncFromPayments(token);
      const errSuffix = res.errors.length ? ` · ${res.errors.length} cuenta(s) con error` : '';
      setSyncInfo(
        `Sincronizadas ${res.connections} cuenta(s): ${res.updated} usuario(s) con tier de pago${errSuffix}.`,
      );
    } catch (e) {
      setErr(e instanceof ApiHttpError ? e.message : 'No se pudo sincronizar desde pagos.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { tier } = await paymentTiersApi.createTier(token, { name: name.trim(), isFree });
      setTiers((prev) => [...(prev ?? []), tier]);
      setName('');
      setIsFree(false);
    } catch (e) {
      setErr(e instanceof ApiHttpError ? e.message : 'No se pudo crear el tier.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(t: PaymentTier) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      !window.confirm(`¿Borrar el tier "${t.name}"? Las asignaciones manuales quedarán sin tier.`)
    )
      return;
    setErr(null);
    try {
      await paymentTiersApi.deleteTier(token, t.id);
      setTiers((prev) => (prev ? prev.filter((x) => x.id !== t.id) : prev));
    } catch (e) {
      setErr(e instanceof ApiHttpError ? e.message : 'No se pudo borrar el tier.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon name="award" size={16} />
          Catálogo de tiers
        </CardTitle>
        <CardDescription>
          Define los planes (Free, Básico, Pro…). Luego los asignas a cada usuario desde{' '}
          <strong>Usuarios</strong>. El tier de pago real se rellena con «Sincronizar desde pagos».
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={handleSync} disabled={syncing}>
            <Icon name="trending" size={16} />
            {syncing ? 'Sincronizando…' : 'Sincronizar tiers desde pagos'}
          </Button>
          {syncInfo ? <span className="text-sm text-success-700">{syncInfo}</span> : null}
        </div>

        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tierName">Nombre del tier</Label>
            <Input
              id="tierName"
              placeholder="Pro"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              maxLength={80}
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={isFree} onChange={(e) => setIsFree(e.target.checked)} />
            Es el tier gratuito
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creando…' : 'Añadir tier'}
          </Button>
        </form>
        {err ? <p className="text-sm text-danger-700">{err}</p> : null}

        {tiers === null ? (
          <div className="skeleton h-16 w-full" />
        ) : tiers.length === 0 ? (
          <p className="text-sm text-text-muted">Aún no hay tiers. Crea el primero arriba.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tiers.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded-lg border border-border-soft bg-surface-2 px-3 py-1.5 text-sm"
              >
                <span className="font-semibold">{t.name}</span>
                {t.isFree ? <Badge variant="outline">free</Badge> : null}
                <button
                  type="button"
                  onClick={() => handleDelete(t)}
                  className="text-text-subtle hover:text-danger-700"
                  title="Borrar tier"
                  aria-label={`Borrar ${t.name}`}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: PaymentConnectionStatus }) {
  const map: Record<
    PaymentConnectionStatus,
    { label: string; className?: string; variant?: 'outline' }
  > = {
    VERIFIED: { label: 'Verificada', className: 'bg-success-600 text-white' },
    ERROR: { label: 'Error', className: 'bg-danger-600 text-white' },
    PENDING: { label: 'Pendiente', variant: 'outline' },
    DISCONNECTED: { label: 'Desconectada', variant: 'outline' },
  };
  const cfg = map[status];
  return cfg.className ? (
    <Badge className={cfg.className}>{cfg.label}</Badge>
  ) : (
    <Badge variant="outline">{cfg.label}</Badge>
  );
}

function ConnectionRow({
  conn,
  busy,
  selected,
  onReconcile,
  onVerify,
  onDisconnect,
}: {
  conn: PaymentConnection;
  busy: boolean;
  selected: boolean;
  onReconcile: () => void;
  onVerify: () => void;
  onDisconnect: () => void;
}) {
  const meta: NonNullable<PaymentConnection['publicMetadata']> = conn.publicMetadata ?? {};
  return (
    <Card className={selected ? 'border-brand-400' : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon name="building" size={18} />
          <span>{conn.displayName}</span>
          <StatusBadge status={conn.status} />
          {meta.livemode === false ? (
            <Badge variant="outline">Modo test</Badge>
          ) : (
            <Badge className="bg-brand-600 text-white">Live</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {meta.businessName ? `${meta.businessName} · ` : ''}
          {meta.email ?? 'sin email de cuenta'}
          {meta.country ? ` · ${meta.country}` : ''}
          {conn.lastVerifiedAt
            ? ` · verificada ${new Date(conn.lastVerifiedAt).toLocaleString('es-ES')}`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {conn.status === 'ERROR' && conn.lastError ? (
          <p className="text-sm text-danger-700">
            <Icon name="alert" size={14} /> {conn.lastError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onReconcile} disabled={busy}>
            <Icon name="users" size={16} />
            Ver suscriptores
          </Button>
          <Button type="button" variant="secondary" onClick={onVerify} disabled={busy}>
            <Icon name="check" size={16} />
            {busy ? 'Verificando…' : 'Verificar'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDisconnect} disabled={busy}>
            <Icon name="trash" size={16} />
            Desconectar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReconcileSection({
  connection,
  loading,
  data,
  onInvited,
}: {
  connection: PaymentConnection;
  loading: boolean;
  data: ReconcileResult | null;
  onInvited: (info: string) => void;
}) {
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResultRow[] | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const invitableEmails = useMemo(
    () => (data?.unmatched ?? []).map((s) => s.email).filter((e): e is string => !!e),
    [data],
  );

  function toggle(email: string) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function toggleAll() {
    setSelectedEmails((prev) =>
      prev.size === invitableEmails.length ? new Set() : new Set(invitableEmails),
    );
  }

  async function handleInvite() {
    const token = authStorage.getAccessToken();
    if (!token || selectedEmails.size === 0) return;
    setInviting(true);
    setInviteError(null);
    setInviteResults(null);
    try {
      const res = await paymentConnectionsApi.invite(token, connection.id, [...selectedEmails]);
      setInviteResults(res.results);
      const invited = res.results.filter((r) => r.outcome === 'invited').length;
      onInvited(`${invited} invitación(es) enviada(s).`);
      setSelectedEmails(new Set());
    } catch (e) {
      setInviteError(
        e instanceof ApiHttpError ? e.message : 'No se pudieron enviar las invitaciones.',
      );
    } finally {
      setInviting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-64" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-bold tracking-tight">
          Suscriptores de «{connection.displayName}»
        </h2>
        <Badge variant="outline">{data.counts.total} activas</Badge>
        <Badge className="bg-success-600 text-white">{data.counts.matched} en Didacta</Badge>
        <Badge className="bg-warning-600 text-white">{data.counts.unmatched} fuera</Badge>
      </div>

      {data.truncated ? (
        <div className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800">
          <Icon name="alert" size={14} /> La cuenta tiene muchas suscripciones y se alcanzó el
          límite de lectura: la lista puede estar incompleta.
        </div>
      ) : null}

      {/* Tabla A — en Didacta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon name="users" size={16} />
            En Didacta con suscripción activa ({data.matched.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.matched.length === 0 ? (
            <p className="text-sm text-text-muted">
              Ningún suscriptor coincide con un usuario de Didacta.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border-soft border-b text-left text-text-muted">
                    <th className="py-2 pr-3 font-medium">Email</th>
                    <th className="py-2 pr-3 font-medium">Usuario</th>
                    <th className="py-2 pr-3 font-medium">Estado usuario</th>
                    <th className="py-2 pr-3 font-medium">Suscripción</th>
                    <th className="py-2 pr-3 font-medium">Importe</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {data.matched.map(({ subscription: s, user }) => (
                    <tr
                      key={s.subscriptionId}
                      className="border-border-soft border-b last:border-0"
                    >
                      <td className="py-2 pr-3 font-mono text-xs">{s.email}</td>
                      <td className="py-2 pr-3">{user.name ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline">{user.status}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline">{s.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {formatAmount(s.unitAmount, s.currency)}
                        {s.interval ? `/${s.interval}` : ''}
                      </td>
                      <td className="py-2">
                        <CancelLink livemode={data.livemode} subId={s.subscriptionId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabla B — fuera de Didacta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Icon name="user" size={16} />
            Suscritos que NO están en Didacta ({data.unmatched.length})
          </CardTitle>
          <CardDescription>
            Selecciona y pulsa «Invitar» para crearles una cuenta (PENDING) y enviarles email de
            activación.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data.unmatched.length === 0 ? (
            <p className="text-sm text-text-muted">
              Todos los suscriptores ya están en Didacta. 🎉
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={toggleAll}
                  disabled={invitableEmails.length === 0}
                >
                  {selectedEmails.size === invitableEmails.length && invitableEmails.length > 0
                    ? 'Quitar selección'
                    : 'Seleccionar todos con email'}
                </Button>
                <Button
                  type="button"
                  onClick={handleInvite}
                  disabled={inviting || selectedEmails.size === 0}
                >
                  <Icon name="mail" size={16} />
                  {inviting ? 'Invitando…' : `Invitar (${selectedEmails.size})`}
                </Button>
              </div>
              {inviteError ? <p className="text-sm text-danger-700">{inviteError}</p> : null}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-border-soft border-b text-left text-text-muted">
                      <th className="w-8 py-2" />
                      <th className="py-2 pr-3 font-medium">Email</th>
                      <th className="py-2 pr-3 font-medium">Nombre (Stripe)</th>
                      <th className="py-2 pr-3 font-medium">Suscripción</th>
                      <th className="py-2 pr-3 font-medium">Importe</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.unmatched.map((s) => (
                      <UnmatchedRow
                        key={s.subscriptionId}
                        sub={s}
                        livemode={data.livemode}
                        checked={!!s.email && selectedEmails.has(s.email)}
                        onToggle={() => s.email && toggle(s.email)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {inviteResults ? <InviteResults results={inviteResults} /> : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UnmatchedRow({
  sub,
  livemode,
  checked,
  onToggle,
}: {
  sub: StripeSubscriber;
  livemode: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="border-border-soft border-b last:border-0">
      <td className="py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!sub.email}
          aria-label={`Seleccionar ${sub.email ?? 'sin email'}`}
        />
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {sub.email ?? <span className="text-text-subtle">sin email</span>}
      </td>
      <td className="py-2 pr-3">{sub.name ?? '—'}</td>
      <td className="py-2 pr-3">
        <Badge variant="outline">{sub.status}</Badge>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {formatAmount(sub.unitAmount, sub.currency)}
        {sub.interval ? `/${sub.interval}` : ''}
      </td>
      <td className="py-2">
        <CancelLink livemode={livemode} subId={sub.subscriptionId} />
      </td>
    </tr>
  );
}

function CancelLink({ livemode, subId }: { livemode: boolean; subId: string }) {
  return (
    <a
      href={stripeSubscriptionUrl(livemode, subId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-semibold text-brand-700 underline"
      title="Gestionar / cancelar esta suscripción en Stripe"
    >
      Gestionar en Stripe ↗
    </a>
  );
}

function InviteResults({ results }: { results: InviteResultRow[] }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2 p-3 text-sm">
      <p className="mb-2 font-semibold">Resultado de las invitaciones</p>
      <ul className="flex flex-col gap-1">
        {results.map((r) => (
          <li key={r.email} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{r.email}</span>
            {r.outcome === 'invited' ? (
              <Badge className="bg-success-600 text-white">Invitado</Badge>
            ) : r.outcome === 'already_member' ? (
              <Badge variant="outline">Ya estaba en Didacta</Badge>
            ) : (
              <Badge className="bg-danger-600 text-white">
                Error{r.message ? `: ${r.message}` : ''}
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
