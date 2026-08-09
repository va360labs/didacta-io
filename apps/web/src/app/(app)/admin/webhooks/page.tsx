'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Webhooks salientes (10º piloto License SDK).
 *
 * Sigue el patrón del 6º piloto (rate-limit) — feature usable en community
 * con upsell para Enterprise. La división:
 *
 *   - Header (h1 + descripción): SIEMPRE visible.
 *   - CRUD de endpoints: SIEMPRE visible. Backend impone los límites del
 *     tier (1 endpoint, 3 eventos en community; 20 / ilimitado en EE).
 *   - Comparativa community vs enterprise: SIEMPRE visible — UX de upsell.
 *   - Dead-letter & métricas avanzadas: GATEADO con `<EeGate>` (solo EE).
 *   - Botón "Upgrade a Enterprise": GATEADO inverso (solo si NO hay EE).
 *
 * Endpoints backend:
 *   GET  /api/v1/webhooks/info             — info (tier + límites)
 *   GET  /api/v1/webhooks/endpoints        — lista
 *   POST /api/v1/webhooks/endpoints        — crear (devuelve secret one-shot)
 *   PUT  /api/v1/webhooks/endpoints/:id    — editar (rotar secret incluido)
 *   DELETE /api/v1/webhooks/endpoints/:id  — borrar
 *   GET  /api/v1/admin/webhooks/dead-letter        — solo EE
 *   POST /api/v1/admin/webhooks/dead-letter/:id/retry  — solo EE
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES, useLicense } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { ZoomWebhookEventsTab } from '@/components/admin/zoom-webhook-events-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import {
  webhooksApi,
  type WebhookDeadLetterItem,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhooksInfo,
} from '@/lib/webhooks';

const TABS = ['salientes', 'zoom'] as const;
type TabKey = (typeof TABS)[number];

/**
 * Admin · Webhooks — salientes (los que emite Didacta) y entrantes de Zoom.
 *
 * Las entregas de Zoom vivían en `/admin/zoom/webhook-events`, otra entrada del
 * menú: mirar "qué webhooks se han movido" obligaba a saber de antemano de qué
 * lado venía el evento. Esa ruta redirige ahora a la pestaña "Zoom".
 */
export default function AdminWebhooksPage() {
  const t = useTranslations('adminApi');
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'salientes';

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('webhooks.title')}</h1>
        <p className="text-text-muted">{t('webhooks.subtitle')}</p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          router.replace(next === 'salientes' ? '/admin/webhooks' : `/admin/webhooks?tab=${next}`)
        }
      >
        <TabsList>
          <TabsTrigger value="salientes">{t('webhooks.tabOutbound')}</TabsTrigger>
          <TabsTrigger value="zoom">{t('webhooks.tabZoom')}</TabsTrigger>
        </TabsList>

        <TabsContent value="salientes" className="mt-5">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">{t('webhooks.outboundIntro')}</p>
            <WebhooksDashboard />
          </div>
        </TabsContent>
        <TabsContent value="zoom" className="mt-5">
          <ZoomWebhookEventsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WebhooksDashboard() {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [info, setInfo] = useState<WebhooksInfo | null>(null);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const [freshInfo, freshList] = await Promise.all([
        webhooksApi.info(token),
        webhooksApi.listEndpoints(token),
      ]);
      setInfo(freshInfo);
      setEndpoints(freshList);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.loadError'));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">{error}</CardContent>
      </Card>
    );
  }

  if (info === null || endpoints === null) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Tier activo */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="trending" size={18} />
            {t('webhooks.activePlan')}
            <TierBadge tier={info.tier} />
          </CardTitle>
          <CardDescription>
            {t('webhooks.capabilityLabel')}{' '}
            <code className="font-mono text-xs">{info.capability}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-text-muted">{t('webhooks.maxEndpoints')}</div>
              <div className="font-mono text-lg">{info.limits.maxEndpoints}</div>
            </div>
            <div>
              <div className="text-text-muted">{t('webhooks.eventsPerEndpoint')}</div>
              <div className="font-mono text-lg">
                {info.limits.maxEventsPerEndpoint === 0 ? '∞' : info.limits.maxEventsPerEndpoint}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Endpoints (CRUD) */}
      <EndpointsPanel info={info} endpoints={endpoints} onChange={() => void refresh()} />

      {/* Comparativa CE vs EE */}
      <Card>
        <CardHeader>
          <CardTitle>{t('webhooks.planComparison')}</CardTitle>
          <CardDescription>{t('webhooks.planComparisonDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">{t('webhooks.colFeature')}</th>
                  <th className="px-4 py-2 text-left font-semibold">{t('tier.community')}</th>
                  <th className="px-4 py-2 text-left font-semibold">{t('tier.enterprise')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowEndpointsPerTenant')}</td>
                  <td className="px-4 py-3 font-mono">{info.community.maxEndpoints}</td>
                  <td className="px-4 py-3 font-mono">{info.enterprise.maxEndpoints}</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowEventsPerEndpoint')}</td>
                  <td className="px-4 py-3 font-mono">{info.community.maxEventsPerEndpoint}</td>
                  <td className="px-4 py-3 font-mono">
                    {info.enterprise.maxEventsPerEndpoint === 0
                      ? t('webhooks.unlimited')
                      : info.enterprise.maxEventsPerEndpoint}
                  </td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowRetries')}</td>
                  <td className="px-4 py-3">{t('webhooks.retriesCommunity')}</td>
                  <td className="px-4 py-3">{t('webhooks.retriesEnterprise')}</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowHmac')}</td>
                  <td className="px-4 py-3">{t('webhooks.no')}</td>
                  <td className="px-4 py-3">{t('webhooks.hmacEnterprise')}</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowDeadLetter')}</td>
                  <td className="px-4 py-3">{t('webhooks.no')}</td>
                  <td className="px-4 py-3">{t('webhooks.deadLetterEnterprise')}</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">{t('webhooks.rowMetrics')}</td>
                  <td className="px-4 py-3">{t('webhooks.metricsCommunity')}</td>
                  <td className="px-4 py-3">{t('webhooks.metricsEnterprise')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Dead-letter & métricas (EE) */}
      <EeGate
        capability={LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT}
        fallback={<DeadLetterUpsell />}
      >
        <DeadLetterPanel />
      </EeGate>

      <UpgradeCta />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Endpoints — CRUD
// ---------------------------------------------------------------------------

function EndpointsPanel({
  info,
  endpoints,
  onChange,
}: {
  info: WebhooksInfo;
  endpoints: WebhookEndpoint[];
  onChange: () => void;
}) {
  const t = useTranslations('adminApi');
  const [showCreate, setShowCreate] = useState(false);
  const reachedLimit = endpoints.length >= info.limits.maxEndpoints;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{t('webhooks.endpointsTitle')}</CardTitle>
          <CardDescription>
            {t('webhooks.endpointsUsed', {
              used: endpoints.length,
              max: info.limits.maxEndpoints,
            })}
          </CardDescription>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)} disabled={reachedLimit}>
          {showCreate ? t('webhooks.cancel') : t('webhooks.newEndpoint')}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showCreate ? (
          <CreateEndpointForm
            info={info}
            onCreated={() => {
              setShowCreate(false);
              onChange();
            }}
          />
        ) : null}

        {endpoints.length === 0 ? (
          <p className="text-sm text-text-muted">{t('webhooks.emptyEndpoints')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {endpoints.map((ep) => (
              <EndpointRow key={ep.id} endpoint={ep} onChange={onChange} />
            ))}
          </div>
        )}

        {reachedLimit ? (
          <p className="text-sm text-warning-700">
            {t('webhooks.limitReached', { max: info.enterprise.maxEndpoints })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreateEndpointForm({ info, onCreated }: { info: WebhooksInfo; onCreated: () => void }) {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [url, setUrl] = useState('');
  const [eventCsv, setEventCsv] = useState('learning.course.completed');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebhookEndpointCreated | null>(null);

  const handleSubmit = async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setError(null);
    const events = eventCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (events.length === 0) {
      setError(t('webhooks.eventsRequired'));
      return;
    }
    try {
      const res = await webhooksApi.createEndpoint(token, {
        url,
        eventTypes: events,
      });
      setCreated(res);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.createError'));
    }
  };

  if (created) {
    return (
      <Card className="border-success-300 bg-success-50">
        <CardHeader>
          <CardTitle className="text-success-800">{t('webhooks.endpointCreated')}</CardTitle>
          <CardDescription>{t('webhooks.saveSecretNow')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>{t('webhooks.urlLabel')}</Label>
            <code className="block break-all rounded-md bg-surface-2 p-2 font-mono text-xs">
              {created.url}
            </code>
          </div>
          <div>
            <Label>{t('webhooks.secretOneShot')}</Label>
            <code className="block break-all rounded-md bg-warning-50 p-2 font-mono text-xs">
              {created.secret}
            </code>
          </div>
          <Button
            onClick={() => {
              setCreated(null);
              onCreated();
            }}
          >
            {t('webhooks.secretSaved')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border-soft p-4">
      <div>
        <Label htmlFor="webhook-url">{t('webhooks.webhookUrlLabel')}</Label>
        <Input
          id="webhook-url"
          type="url"
          placeholder="https://example.com/hooks/didacta"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="webhook-events">{t('webhooks.subscribedEvents')}</Label>
        <Input
          id="webhook-events"
          placeholder="learning.course.completed, learning.enrollment.created"
          value={eventCsv}
          onChange={(e) => setEventCsv(e.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          {t('webhooks.availableEvents')}{' '}
          <span className="font-mono">{info.knownEventTypes.join(', ')}</span>
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {t('webhooks.maxEventTypes', {
            max:
              info.limits.maxEventsPerEndpoint === 0
                ? '∞'
                : String(info.limits.maxEventsPerEndpoint),
          })}
        </p>
      </div>
      {error ? <p className="text-sm text-danger-700">{error}</p> : null}
      <Button onClick={handleSubmit} disabled={!url || !eventCsv}>
        {t('webhooks.createEndpoint')}
      </Button>
    </div>
  );
}

function EndpointRow({ endpoint, onChange }: { endpoint: WebhookEndpoint; onChange: () => void }) {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await webhooksApi.updateEndpoint(token, endpoint.id, { active: !endpoint.active });
      onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.updateError'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t('webhooks.confirmDelete', { url: endpoint.url }))) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await webhooksApi.deleteEndpoint(token, endpoint.id);
      onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.deleteError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border-soft p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="break-all font-mono text-sm">{endpoint.url}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {endpoint.eventTypes.map((evt) => (
              <Badge key={evt} variant="outline" className="font-mono text-xs">
                {evt}
              </Badge>
            ))}
          </div>
          <div className="mt-2 text-xs text-text-muted">
            {t.rich('webhooks.secretLine', {
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
              masked: endpoint.secretMasked,
              date: formatDateTime(endpoint.createdAt),
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={endpoint.active}
            onCheckedChange={handleToggle}
            disabled={busy}
            aria-label={
              endpoint.active ? t('webhooks.deactivateEndpoint') : t('webhooks.activateEndpoint')
            }
          />
          <Button variant="outline" size="sm" onClick={handleDelete} disabled={busy}>
            {t('webhooks.delete')}
          </Button>
        </div>
      </div>
      {error ? <p className="mt-2 text-sm text-danger-700">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dead-letter (EE)
// ---------------------------------------------------------------------------

function DeadLetterPanel() {
  const t = useTranslations('adminApi');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<WebhookDeadLetterItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const page = await webhooksApi.listDeadLetter(token);
      setItems(page.items);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.deadLetterLoadError'),
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleRetry = async (id: string) => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      await webhooksApi.retryDeadLetter(token, id);
      void refresh();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.retryFailed'));
    }
  };

  const handleDismiss = async (id: string) => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('webhooks.confirmDismiss'))) return;
    try {
      await webhooksApi.dismissDeadLetter(token, id);
      void refresh();
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('webhooks.dismissError'),
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="shield" size={18} />
          {t('webhooks.deadLetterTitle')}
          <Badge className="bg-success-600 text-white">{t('webhooks.enterprisePathBadge')}</Badge>
        </CardTitle>
        <CardDescription>{t('webhooks.deadLetterDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <p className="mb-3 text-sm text-danger-700">{error}</p> : null}
        {items === null ? (
          <div className="skeleton h-24 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted">{t('webhooks.deadLetterEmpty')}</p>
        ) : (
          <div className="space-y-3">
            {items.map((it) => (
              <div key={it.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {it.eventType}
                  </Badge>
                  <span className="text-xs text-text-muted">
                    {t('webhooks.attemptsLine', {
                      attempts: it.attempts,
                      date: formatDateTime(it.createdAt),
                    })}
                  </span>
                </div>
                <div className="mt-2 break-all rounded-md bg-danger-50 p-2 font-mono text-xs text-danger-800">
                  {it.lastError}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => handleRetry(it.id)}>
                    {t('webhooks.retry')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleDismiss(it.id)}>
                    {t('webhooks.dismiss')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeadLetterUpsell() {
  const t = useTranslations('adminApi');
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('webhooks.upsellTitle')}
          <Badge variant="outline">{t('tier.enterprise')}</Badge>
        </CardTitle>
        <CardDescription>{t('webhooks.upsellDescription')}</CardDescription>
      </CardHeader>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: WebhooksInfo['tier'] }) {
  const t = useTranslations('adminApi');
  if (tier === 'enterprise') {
    return <Badge className="bg-success-600 text-white">{t('tier.enterprise')}</Badge>;
  }
  return <Badge variant="outline">{t('tier.community')}</Badge>;
}

/**
 * Botón de upsell. Visible solo cuando la capability EE no está activa
 * (negative gate, mismo patrón que rate-limit/page.tsx).
 */
function UpgradeCta() {
  const t = useTranslations('adminApi');
  const { isCapabilityEnabled } = useLicense();
  if (isCapabilityEnabled(LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT)) {
    return null;
  }
  return (
    <Card role="region" aria-label={t('webhooks.upgradeAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('webhooks.upgradeTitle')}
        </CardTitle>
        <CardDescription>{t('webhooks.upgradeDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('webhooks.seePlans')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
