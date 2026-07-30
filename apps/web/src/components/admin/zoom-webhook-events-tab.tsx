'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import {
  zoomLiveApi,
  type PaginatedWebhookEvents,
  type WebhookEventResult,
  type ZoomWebhookEventItem,
} from '@/modules/zoom-live';

const RESULT_VARIANT: Record<WebhookEventResult, 'success' | 'muted' | 'danger'> = {
  OK: 'success',
  IGNORED: 'muted',
  ERROR: 'danger',
};

const PAGE_SIZE = 25;

/** Pestaña "Zoom" de /admin/webhooks. Antes `/admin/zoom/webhook-events`. */
export function ZoomWebhookEventsTab() {
  const [data, setData] = useState<PaginatedWebhookEvents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState('');
  const [resultFilter, setResultFilter] = useState<'' | WebhookEventResult>('');
  const [page, setPage] = useState(1);

  async function reload() {
    try {
      setError(null);
      const res = await zoomLiveApi.listWebhookEvents({
        eventType: eventType.trim() || undefined,
        result: resultFilter || undefined,
        page,
        limit: PAGE_SIZE,
      });
      setData(res);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los eventos.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Eventos webhook · Zoom
          </h2>
          <p className="mt-1 text-text-muted">
            Trazabilidad de los eventos recibidos del webhook de Zoom. Útil para diagnosticar
            sesiones que no transicionan o grabaciones que no aparecen.
          </p>
        </div>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs font-semibold text-text-muted" htmlFor="eventType">
              Tipo de evento
            </label>
            <Input
              id="eventType"
              type="search"
              placeholder="ej. meeting.started"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1);
                  void reload();
                }
              }}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="result">
              Resultado
            </label>
            <Select
              id="result"
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value as '' | WebhookEventResult)}
              className="mt-1 min-w-[160px]"
            >
              <option value="">Todos</option>
              <option value="OK">OK</option>
              <option value="IGNORED">IGNORED</option>
              <option value="ERROR">ERROR</option>
            </Select>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setPage(1);
              void reload();
            }}
          >
            Aplicar
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : data === null ? (
        <div className="space-y-3">
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      ) : data.items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">Sin eventos</h3>
            <p className="max-w-md text-text-muted">
              Todavía no llegaron webhooks de Zoom para tu tenant, o ningún evento matchea los
              filtros.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{data.total} eventos</CardTitle>
            <CardDescription>
              Página {data.page} de {totalPages}.
            </CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-6 py-3 font-semibold">Recibido</th>
                  <th className="px-3 py-3 font-semibold">Evento</th>
                  <th className="px-3 py-3 font-semibold">Meeting</th>
                  <th className="px-3 py-3 font-semibold">Resultado</th>
                  <th className="px-6 py-3 font-semibold">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </tbody>
            </table>
          </div>
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Anterior
            </Button>
            <span className="text-xs text-text-muted">
              {data.items.length} de {data.total}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ZoomWebhookEventItem }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-surface-2">
      <td className="px-6 py-3 tabular-nums text-text-muted">
        {new Date(event.receivedAt).toLocaleString('es-ES')}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-text">{event.eventType}</td>
      <td className="px-3 py-3 font-mono text-xs text-text-muted">{event.meetingId ?? '—'}</td>
      <td className="px-3 py-3">
        <Badge variant={RESULT_VARIANT[event.result]}>{event.result}</Badge>
      </td>
      <td className="px-6 py-3 text-xs text-text-muted">
        {event.errorMessage ? (
          <span className="text-danger-700">{event.errorMessage}</span>
        ) : event.sessionId ? (
          <span className="font-mono">session: {event.sessionId.slice(0, 8)}…</span>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}
