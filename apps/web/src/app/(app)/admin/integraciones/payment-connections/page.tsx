'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCurrency, formatDateTime } from '@/lib/i18n/format';
import { SubscriptionsDashboard } from './subscriptions-dashboard';
import { SubscriptionAlertsSettings } from './subscription-alerts-settings';
import {
  connectionStatusStyle,
  paymentConnectionsApi,
  paymentTiersApi,
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

/** Importe en céntimos + moneda → moneda formateada según el locale activo. */
function fmtAmount(unitAmount: number | null, currency: string | null): string {
  if (unitAmount === null) return '—';
  const cur = (currency ?? 'eur').toUpperCase();
  try {
    return formatCurrency(unitAmount / 100, cur);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${cur}`;
  }
}

export default function PaymentConnectionsPage() {
  const t = useTranslations('adminPagos');
  const isSuperAdmin = useMemo(() => {
    const session = authStorage.getSession();
    return session?.user.roles.includes('super_admin') ?? false;
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('connections.title')}</h1>
        <p className="text-text-muted">
          {t.rich('connections.subtitle', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </header>

      {isSuperAdmin ? (
        <>
          <SubscriptionsDashboard />
          <SubscriptionAlertsSettings />
          <PaymentConnectionsPanel />
        </>
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">
            {t.rich('connections.superAdminOnly', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PaymentConnectionsPanel() {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [connections, setConnections] = useState<PaymentConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);

  // Form alta
  const [provider, setProvider] = useState<'stripe' | 'paypal' | 'woocommerce'>('stripe');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [environment, setEnvironment] = useState<'live' | 'sandbox'>('live');
  const [storeUrl, setStoreUrl] = useState('');
  const [wooKey, setWooKey] = useState('');
  const [wooSecret, setWooSecret] = useState('');
  const [creating, setCreating] = useState(false);

  // Reconciliación
  const [selected, setSelected] = useState<PaymentConnection | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) {
      setError(t('connections.noTokenError'));
      return;
    }
    void (async () => {
      try {
        const res = await paymentConnectionsApi.list(token);
        setConnections(res.connections);
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.loadError'),
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token || !displayName.trim()) return;

    let body: ConnectBody;
    if (provider === 'stripe') {
      if (!API_KEY_PATTERN.test(apiKey.trim())) {
        setActionError(t('connections.keyFormatError'));
        return;
      }
      body = { provider: 'stripe', displayName: displayName.trim(), apiKey: apiKey.trim() };
    } else if (provider === 'paypal') {
      if (!clientId.trim() || !clientSecret.trim()) {
        setActionError(t('connections.paypalCredsError'));
        return;
      }
      body = {
        provider: 'paypal',
        displayName: displayName.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        environment,
      };
    } else {
      if (!/^https:\/\//i.test(storeUrl.trim()) || !wooKey.trim() || !wooSecret.trim()) {
        setActionError(t('connections.wooCredsError'));
        return;
      }
      body = {
        provider: 'woocommerce',
        displayName: displayName.trim(),
        storeUrl: storeUrl.trim(),
        consumerKey: wooKey.trim(),
        consumerSecret: wooSecret.trim(),
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
      setStoreUrl('');
      setWooKey('');
      setWooSecret('');
      setActionInfo(t('connections.createdInfo', { name: connection.displayName }));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.createError'),
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
      setActionInfo(t('connections.verifiedInfo', { name: connection.displayName }));
    } catch (e) {
      // El backend ya marcó la conexión en ERROR; refrescamos el listado.
      await refreshList(token);
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.verifyError'),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect(conn: PaymentConnection) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('connections.disconnectConfirm', { name: conn.displayName }))) return;
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
      setActionInfo(t('connections.disconnectedInfo'));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.disconnectError'),
      );
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
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.reconcileError'),
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
            {t('connections.formTitle')}
          </CardTitle>
          <CardDescription>
            {provider === 'stripe'
              ? t.rich('connections.formHelpStripe', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                  link: (chunks) => (
                    <a
                      href="https://dashboard.stripe.com/apikeys/create"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-700 underline"
                    >
                      {chunks}
                    </a>
                  ),
                })
              : provider === 'paypal'
                ? t.rich('connections.formHelpPaypal', {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    link: (chunks) => (
                      <a
                        href="https://developer.paypal.com/dashboard/applications"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-700 underline"
                      >
                        {chunks}
                      </a>
                    ),
                  })
                : t.rich('connections.formHelpWoo', {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    em: (chunks) => <em>{chunks}</em>,
                  })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider">{t('connections.providerLabel')}</Label>
                <Select
                  id="provider"
                  value={provider}
                  onChange={(e) =>
                    setProvider(e.target.value as 'stripe' | 'paypal' | 'woocommerce')
                  }
                  disabled={creating}
                  className="min-w-32"
                >
                  <option value="stripe">Stripe</option>
                  <option value="paypal">PayPal</option>
                  <option value="woocommerce">WooCommerce</option>
                </Select>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="displayName">{t('connections.displayNameLabel')}</Label>
                <Input
                  id="displayName"
                  placeholder={
                    provider === 'stripe'
                      ? t('connections.displayNamePhStripe')
                      : provider === 'paypal'
                        ? t('connections.displayNamePhPaypal')
                        : t('connections.displayNamePhWoo')
                  }
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={creating}
                  maxLength={120}
                />
              </div>
            </div>

            {provider === 'stripe' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apiKey">{t('connections.apiKeyLabel')}</Label>
                <Input
                  id="apiKey"
                  placeholder={t('connections.apiKeyPh')}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={creating}
                  type="password"
                />
              </div>
            ) : provider === 'paypal' ? (
              <div className="flex flex-col gap-3 md:flex-row">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="clientId">{t('connections.clientIdLabel')}</Label>
                  <Input
                    id="clientId"
                    placeholder={t('connections.clientIdPh')}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="clientSecret">{t('connections.clientSecretLabel')}</Label>
                  <Input
                    id="clientSecret"
                    placeholder={t('connections.clientSecretPh')}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                    type="password"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="environment">{t('connections.environmentLabel')}</Label>
                  <Select
                    id="environment"
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value as 'live' | 'sandbox')}
                    disabled={creating}
                    className="min-w-32"
                  >
                    <option value="live">{t('connections.envLive')}</option>
                    <option value="sandbox">{t('connections.envSandbox')}</option>
                  </Select>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 md:flex-row">
                <div className="flex flex-[2] flex-col gap-1.5">
                  <Label htmlFor="storeUrl">{t('connections.storeUrlLabel')}</Label>
                  <Input
                    id="storeUrl"
                    placeholder={t('connections.storeUrlPh')}
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="wooKey">{t('connections.wooKeyLabel')}</Label>
                  <Input
                    id="wooKey"
                    placeholder={t('connections.wooKeyPh')}
                    value={wooKey}
                    onChange={(e) => setWooKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="wooSecret">{t('connections.wooSecretLabel')}</Label>
                  <Input
                    id="wooSecret"
                    placeholder={t('connections.wooSecretPh')}
                    value={wooSecret}
                    onChange={(e) => setWooSecret(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creating}
                    type="password"
                  />
                </div>
              </div>
            )}

            <div>
              <Button type="submit" disabled={creating || !displayName.trim()}>
                {creating ? t('connections.connectingCta') : t('connections.connectCta')}
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
            {t('connections.emptyList')}
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
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [tiers, setTiers] = useState<PaymentTier[] | null>(null);
  const [name, setName] = useState('');
  const [isFree, setIsFree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);

  async function loadTiers() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const res = await paymentTiersApi.listCatalog(token);
      setTiers(res.tiers);
    } catch (e) {
      setErr(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tiers.loadError'));
    }
  }

  useEffect(() => {
    void loadTiers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSync() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSyncing(true);
    setErr(null);
    setSyncInfo(null);
    try {
      const res = await paymentTiersApi.syncFromPayments(token);
      setSyncInfo(
        res.errors.length
          ? t('tiers.syncInfoWithErrors', {
              connections: res.connections,
              tiersCreated: res.tiersCreated,
              updated: res.updated,
              errors: res.errors.length,
            })
          : t('tiers.syncInfo', {
              connections: res.connections,
              tiersCreated: res.tiersCreated,
              updated: res.updated,
            }),
      );
      await loadTiers(); // refrescar para ver los tiers recién creados + sus conteos
    } catch (e) {
      setErr(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tiers.syncError'));
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
      setErr(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tiers.createError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(tier: PaymentTier) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('tiers.deleteConfirm', { name: tier.name }))) return;
    setErr(null);
    try {
      await paymentTiersApi.deleteTier(token, tier.id);
      setTiers((prev) => (prev ? prev.filter((x) => x.id !== tier.id) : prev));
    } catch (e) {
      setErr(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('tiers.deleteError'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon name="award" size={16} />
          {t('tiers.title')}
        </CardTitle>
        <CardDescription>
          {t.rich('tiers.help', { strong: (chunks) => <strong>{chunks}</strong> })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={handleSync} disabled={syncing}>
            <Icon name="trending" size={16} />
            {syncing ? t('tiers.syncingCta') : t('tiers.syncCta')}
          </Button>
          {syncInfo ? <span className="text-sm text-success-700">{syncInfo}</span> : null}
        </div>

        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tierName">{t('tiers.nameLabel')}</Label>
            <Input
              id="tierName"
              placeholder={t('tiers.namePh')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              maxLength={80}
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={isFree} onChange={(e) => setIsFree(e.target.checked)} />
            {t('tiers.isFreeLabel')}
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? t('tiers.creatingCta') : t('tiers.addCta')}
          </Button>
        </form>
        {err ? <p className="text-sm text-danger-700">{err}</p> : null}

        {tiers === null ? (
          <div className="skeleton h-16 w-full" />
        ) : tiers.length === 0 ? (
          <p className="text-sm text-text-muted">{t('tiers.empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tiers.map((tier) => (
              <li
                key={tier.id}
                className="flex items-center gap-2 rounded-lg border border-border-soft bg-surface-2 px-3 py-1.5 text-sm"
              >
                <span className="font-semibold">{tier.name}</span>
                {tier.isFree ? <Badge variant="outline">{t('tiers.freeBadge')}</Badge> : null}
                <span className="text-xs text-text-muted" title={t('tiers.memberCountTitle')}>
                  {t('tiers.memberCount', { count: tier.memberCount ?? 0 })}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(tier)}
                  className="text-text-subtle hover:text-danger-700"
                  title={t('tiers.deleteTitle')}
                  aria-label={t('tiers.deleteAria', { name: tier.name })}
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
  const t = useTranslations('adminPagos');
  const cfg = connectionStatusStyle(status);
  // `key: null` = estado que este front no conoce (ver `connectionStatusStyle`).
  // Se pinta el código crudo: feo, pero la pantalla se ve. Antes se indexaba el
  // mapa a pelo y un estado nuevo reventaba con un TypeError que subía al error
  // boundary y dejaba toda la pantalla en blanco.
  const label = cfg.key ? t(`connStatus.${cfg.key}`) : status;
  return cfg.className ? (
    <Badge className={cfg.className}>{label}</Badge>
  ) : (
    <Badge variant="outline">{label}</Badge>
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
  const t = useTranslations('adminPagos');
  const meta: NonNullable<PaymentConnection['publicMetadata']> = conn.publicMetadata ?? {};
  return (
    <Card className={selected ? 'border-brand-400' : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon name="building" size={18} />
          <span>{conn.displayName}</span>
          <StatusBadge status={conn.status} />
          {meta.livemode === false ? (
            <Badge variant="outline">{t('connections.modeTestBadge')}</Badge>
          ) : (
            <Badge className="bg-brand-600 text-white">{t('connections.liveBadge')}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {meta.businessName ? `${meta.businessName} · ` : ''}
          {meta.email ?? t('connections.noAccountEmail')}
          {meta.country ? ` · ${meta.country}` : ''}
          {conn.lastVerifiedAt
            ? ` · ${t('connections.verifiedOn', { date: formatDateTime(conn.lastVerifiedAt) })}`
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
            {t('connections.viewSubscribers')}
          </Button>
          <Button type="button" variant="secondary" onClick={onVerify} disabled={busy}>
            <Icon name="check" size={16} />
            {busy ? t('connections.verifyingCta') : t('connections.verifyCta')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDisconnect} disabled={busy}>
            <Icon name="trash" size={16} />
            {t('connections.disconnectCta')}
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
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
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
      onInvited(t('connections.inviteSentInfo', { count: invited }));
      setSelectedEmails(new Set());
    } catch (e) {
      setInviteError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('connections.inviteError'),
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
          {t('connections.reconcileTitle', { name: connection.displayName })}
        </h2>
        <Badge variant="outline">
          {t('connections.activeCount', { count: data.counts.total })}
        </Badge>
        <Badge className="bg-success-600 text-white">
          {t('connections.matchedCount', { count: data.counts.matched })}
        </Badge>
        <Badge className="bg-warning-600 text-white">
          {t('connections.unmatchedCount', { count: data.counts.unmatched })}
        </Badge>
      </div>

      {data.truncated ? (
        <div className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800">
          <Icon name="alert" size={14} /> {t('connections.truncatedWarning')}
        </div>
      ) : null}

      {/* Tabla A — en Didacta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon name="users" size={16} />
            {t('connections.matchedTitle', { count: data.matched.length })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.matched.length === 0 ? (
            <p className="text-sm text-text-muted">{t('connections.matchedEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border-soft border-b text-left text-text-muted">
                    <th className="py-2 pr-3 font-medium">{t('connections.colEmail')}</th>
                    <th className="py-2 pr-3 font-medium">{t('connections.colUser')}</th>
                    <th className="py-2 pr-3 font-medium">{t('connections.colUserStatus')}</th>
                    <th className="py-2 pr-3 font-medium">{t('connections.colSubscription')}</th>
                    <th className="py-2 pr-3 font-medium">{t('connections.colAmount')}</th>
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
                        {fmtAmount(s.unitAmount, s.currency)}
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
            {t('connections.unmatchedTitle', { count: data.unmatched.length })}
          </CardTitle>
          <CardDescription>{t('connections.unmatchedHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data.unmatched.length === 0 ? (
            <p className="text-sm text-text-muted">{t('connections.unmatchedEmpty')}</p>
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
                    ? t('connections.clearSelection')
                    : t('connections.selectAllWithEmail')}
                </Button>
                <Button
                  type="button"
                  onClick={handleInvite}
                  disabled={inviting || selectedEmails.size === 0}
                >
                  <Icon name="mail" size={16} />
                  {inviting
                    ? t('connections.invitingCta')
                    : t('connections.inviteCta', { count: selectedEmails.size })}
                </Button>
              </div>
              {inviteError ? <p className="text-sm text-danger-700">{inviteError}</p> : null}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-border-soft border-b text-left text-text-muted">
                      <th className="w-8 py-2" />
                      <th className="py-2 pr-3 font-medium">{t('connections.colEmail')}</th>
                      <th className="py-2 pr-3 font-medium">{t('connections.colNameStripe')}</th>
                      <th className="py-2 pr-3 font-medium">{t('connections.colSubscription')}</th>
                      <th className="py-2 pr-3 font-medium">{t('connections.colAmount')}</th>
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
  const t = useTranslations('adminPagos');
  return (
    <tr className="border-border-soft border-b last:border-0">
      <td className="py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!sub.email}
          aria-label={t('connections.selectAria', {
            email: sub.email ?? t('connections.noEmail'),
          })}
        />
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {sub.email ?? <span className="text-text-subtle">{t('connections.noEmail')}</span>}
      </td>
      <td className="py-2 pr-3">{sub.name ?? '—'}</td>
      <td className="py-2 pr-3">
        <Badge variant="outline">{sub.status}</Badge>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {fmtAmount(sub.unitAmount, sub.currency)}
        {sub.interval ? `/${sub.interval}` : ''}
      </td>
      <td className="py-2">
        <CancelLink livemode={livemode} subId={sub.subscriptionId} />
      </td>
    </tr>
  );
}

function CancelLink({ livemode, subId }: { livemode: boolean; subId: string }) {
  const t = useTranslations('adminPagos');
  return (
    <a
      href={stripeSubscriptionUrl(livemode, subId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-semibold text-brand-700 underline"
      title={t('connections.cancelLinkTitle')}
    >
      {t('connections.cancelLinkText')}
    </a>
  );
}

function InviteResults({ results }: { results: InviteResultRow[] }) {
  const t = useTranslations('adminPagos');
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2 p-3 text-sm">
      <p className="mb-2 font-semibold">{t('connections.inviteResultsTitle')}</p>
      <ul className="flex flex-col gap-1">
        {results.map((r) => (
          <li key={r.email} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{r.email}</span>
            {r.outcome === 'invited' ? (
              <Badge className="bg-success-600 text-white">{t('connections.outcomeInvited')}</Badge>
            ) : r.outcome === 'already_member' ? (
              <Badge variant="outline">{t('connections.outcomeAlreadyMember')}</Badge>
            ) : (
              <Badge className="bg-danger-600 text-white">
                {r.message
                  ? t('connections.outcomeErrorWithMessage', { message: r.message })
                  : t('connections.outcomeError')}
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
