'use client';

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
import { EeGate, LICENSE_CAPABILITIES, useLicense } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  webhooksApi,
  type WebhookDeadLetterItem,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhooksInfo,
} from '@/lib/webhooks';

export default function AdminWebhooksPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Webhooks salientes</h1>
        <p className="text-text-muted">
          Configura URLs externas que reciban una notificación cada vez que sucede un evento en la
          plataforma (alumno completa curso, nuevo post en comunidad, etc.). Útil para integrar con
          sistemas internos (Slack, CRM, ERP) o automatizaciones n8n / Zapier.
        </p>
      </header>

      <WebhooksDashboard />
    </div>
  );
}

function WebhooksDashboard() {
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
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No se pudo cargar la información de webhooks salientes.',
      );
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
            Plan activo
            <TierBadge tier={info.tier} />
          </CardTitle>
          <CardDescription>
            Capability asociada: <code className="font-mono text-xs">{info.capability}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-text-muted">Endpoints máximos</div>
              <div className="font-mono text-lg">{info.limits.maxEndpoints}</div>
            </div>
            <div>
              <div className="text-text-muted">Eventos por endpoint</div>
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
          <CardTitle>Comparativa de planes</CardTitle>
          <CardDescription>
            En Community, las entregas son síncronas best-effort (1 reintento). En Enterprise,
            BullMQ con reintentos exponenciales, firma HMAC-SHA256 y dead-letter persistido.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Característica</th>
                  <th className="px-4 py-2 text-left font-semibold">Community</th>
                  <th className="px-4 py-2 text-left font-semibold">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Endpoints / tenant</td>
                  <td className="px-4 py-3 font-mono">{info.community.maxEndpoints}</td>
                  <td className="px-4 py-3 font-mono">{info.enterprise.maxEndpoints}</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Eventos / endpoint</td>
                  <td className="px-4 py-3 font-mono">{info.community.maxEventsPerEndpoint}</td>
                  <td className="px-4 py-3 font-mono">
                    {info.enterprise.maxEventsPerEndpoint === 0
                      ? 'Ilimitado'
                      : info.enterprise.maxEventsPerEndpoint}
                  </td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Reintentos</td>
                  <td className="px-4 py-3">1 reintento síncrono</td>
                  <td className="px-4 py-3">5 reintentos exp. (30s/2m/8m/30m/2h)</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Firma HMAC-SHA256</td>
                  <td className="px-4 py-3">No</td>
                  <td className="px-4 py-3">Sí (X-Didacta-Signature)</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Dead-letter persistido</td>
                  <td className="px-4 py-3">No</td>
                  <td className="px-4 py-3">Sí — reintento manual desde UI</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Métricas Prometheus</td>
                  <td className="px-4 py-3">Básicas</td>
                  <td className="px-4 py-3">Latencia P50/P95/P99, queue depth</td>
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
  const [showCreate, setShowCreate] = useState(false);
  const reachedLimit = endpoints.length >= info.limits.maxEndpoints;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Endpoints configurados</CardTitle>
          <CardDescription>
            {endpoints.length} / {info.limits.maxEndpoints} endpoint(s) usados
          </CardDescription>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)} disabled={reachedLimit}>
          {showCreate ? 'Cancelar' : 'Nuevo endpoint'}
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
          <p className="text-sm text-text-muted">
            Aún no configuraste ningún endpoint. Pulsa &ldquo;Nuevo endpoint&rdquo; para crear el
            primero.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {endpoints.map((ep) => (
              <EndpointRow key={ep.id} endpoint={ep} onChange={onChange} />
            ))}
          </div>
        )}

        {reachedLimit ? (
          <p className="text-sm text-warning-700">
            Alcanzaste el límite de tu plan. Borra alguno o actualiza a Enterprise para subir el
            límite a {info.enterprise.maxEndpoints}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreateEndpointForm({ info, onCreated }: { info: WebhooksInfo; onCreated: () => void }) {
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
      setError('Indica al menos un tipo de evento (separados por coma).');
      return;
    }
    try {
      const res = await webhooksApi.createEndpoint(token, {
        url,
        eventTypes: events,
      });
      setCreated(res);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo crear el endpoint.');
    }
  };

  if (created) {
    return (
      <Card className="border-success-300 bg-success-50">
        <CardHeader>
          <CardTitle className="text-success-800">Endpoint creado</CardTitle>
          <CardDescription>
            Guarda este secret AHORA. No volveremos a mostrarlo en ninguna otra pantalla.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>URL</Label>
            <code className="block break-all rounded-md bg-surface-2 p-2 font-mono text-xs">
              {created.url}
            </code>
          </div>
          <div>
            <Label>Secret (one-shot)</Label>
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
            He guardado el secret
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border-soft p-4">
      <div>
        <Label htmlFor="webhook-url">URL del webhook</Label>
        <Input
          id="webhook-url"
          type="url"
          placeholder="https://example.com/hooks/didacta"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="webhook-events">Eventos suscritos (separados por coma)</Label>
        <Input
          id="webhook-events"
          placeholder="learning.course.completed, learning.enrollment.created"
          value={eventCsv}
          onChange={(e) => setEventCsv(e.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          Eventos disponibles: <span className="font-mono">{info.knownEventTypes.join(', ')}</span>
        </p>
        <p className="mt-1 text-xs text-text-muted">
          Tu plan permite máximo{' '}
          {info.limits.maxEventsPerEndpoint === 0 ? '∞' : info.limits.maxEventsPerEndpoint} tipos
          por endpoint.
        </p>
      </div>
      {error ? <p className="text-sm text-danger-700">{error}</p> : null}
      <Button onClick={handleSubmit} disabled={!url || !eventCsv}>
        Crear endpoint
      </Button>
    </div>
  );
}

function EndpointRow({ endpoint, onChange }: { endpoint: WebhookEndpoint; onChange: () => void }) {
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
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo actualizar el endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`¿Borrar el endpoint ${endpoint.url}?`)) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await webhooksApi.deleteEndpoint(token, endpoint.id);
      onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo borrar el endpoint.');
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
            Secret <span className="font-mono">{endpoint.secretMasked}</span> · creado{' '}
            {new Date(endpoint.createdAt).toLocaleString('es-ES')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={endpoint.active}
            onCheckedChange={handleToggle}
            disabled={busy}
            aria-label={endpoint.active ? 'Desactivar endpoint' : 'Activar endpoint'}
          />
          <Button variant="outline" size="sm" onClick={handleDelete} disabled={busy}>
            Borrar
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
  const [items, setItems] = useState<WebhookDeadLetterItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const page = await webhooksApi.listDeadLetter(token);
      setItems(page.items);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar el dead-letter.');
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
      setError(e instanceof ApiHttpError ? e.message : 'Reintento falló.');
    }
  };

  const handleDismiss = async (id: string) => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm('¿Descartar esta entrada del dead-letter?')) return;
    try {
      await webhooksApi.dismissDeadLetter(token, id);
      void refresh();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo descartar.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="shield" size={18} />
          Dead-letter (Enterprise)
          <Badge className="bg-success-600 text-white">Estás usando path Enterprise</Badge>
        </CardTitle>
        <CardDescription>
          Eventos cuyas entregas agotaron los 5 reintentos exponenciales. Reintenta manualmente o
          descarta tras corregir la causa.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? <p className="mb-3 text-sm text-danger-700">{error}</p> : null}
        {items === null ? (
          <div className="skeleton h-24 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted">
            Sin entradas en dead-letter. Todas las entregas recientes tuvieron éxito.
          </p>
        ) : (
          <div className="space-y-3">
            {items.map((it) => (
              <div key={it.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {it.eventType}
                  </Badge>
                  <span className="text-xs text-text-muted">
                    {it.attempts} intento(s) · {new Date(it.createdAt).toLocaleString('es-ES')}
                  </span>
                </div>
                <div className="mt-2 break-all rounded-md bg-danger-50 p-2 font-mono text-xs text-danger-800">
                  {it.lastError}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => handleRetry(it.id)}>
                    Reintentar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleDismiss(it.id)}>
                    Descartar
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
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Dead-letter & métricas avanzadas
          <Badge variant="outline">Enterprise</Badge>
        </CardTitle>
        <CardDescription>
          En tu plan actual, las entregas fallidas se loguean y descartan. En Enterprise, quedan
          registradas en una bandeja de dead-letter con reintento manual + métricas Prometheus
          (latencia P50/P95/P99, queue depth, success rate por endpoint).
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: WebhooksInfo['tier'] }) {
  if (tier === 'enterprise') {
    return <Badge className="bg-success-600 text-white">Enterprise</Badge>;
  }
  return <Badge variant="outline">Community</Badge>;
}

/**
 * Botón de upsell. Visible solo cuando la capability EE no está activa
 * (negative gate, mismo patrón que rate-limit/page.tsx).
 */
function UpgradeCta() {
  const { isCapabilityEnabled } = useLicense();
  if (isCapabilityEnabled(LICENSE_CAPABILITIES.API_WEBHOOKS_HIGH_THROUGHPUT)) {
    return null;
  }
  return (
    <Card role="region" aria-label="Upgrade a Enterprise" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          ¿Tu integración necesita más fiabilidad?
        </CardTitle>
        <CardDescription>
          Enterprise sube a 20 endpoints por tenant, eventos ilimitados, firma HMAC, reintentos
          exponenciales y dead-letter persistido. Recomendado si tus webhooks alimentan facturación,
          CRM o sistemas críticos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
