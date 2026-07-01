'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { communityApi, type Broadcast } from '@/modules/community';

/**
 * Avisos masivos de comunidad — compone y encola un aviso (email + campana) a
 * TODOS los miembros del tenant, y muestra el estado/progreso de cada envío.
 *
 * El envío es asíncrono en el backend (se procesa por lotes), así que la lista
 * se re-consulta cada ~5s mientras haya algún broadcast PENDING o RUNNING.
 * Todos los datos vienen de la API (`communityApi`); cero datos de cartón.
 */

/** Cada cuánto refrescamos la lista mientras haya envíos activos (ms). */
const POLL_INTERVAL_MS = 5000;

/** ¿Hay algún broadcast en curso? Determina si mantenemos el polling vivo. */
function hasActive(list: Broadcast[]): boolean {
  return list.some((b) => b.status === 'PENDING' || b.status === 'RUNNING');
}

const STATUS_META: Record<
  Broadcast['status'],
  { label: string; variant: 'muted' | 'info' | 'success' | 'danger' }
> = {
  PENDING: { label: 'En cola', variant: 'muted' },
  RUNNING: { label: 'Enviando', variant: 'info' },
  DONE: { label: 'Enviado', variant: 'success' },
  FAILED: { label: 'Fallido', variant: 'danger' },
};

export default function CommunityBroadcastsAdminPage() {
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [important, setImportant] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await communityApi.listBroadcasts();
      setBroadcasts(list);
      setListError(null);
      return list;
    } catch (e) {
      setListError(
        e instanceof ApiHttpError ? e.message : 'No pudimos cargar los avisos enviados.',
      );
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Polling: mientras haya algún aviso PENDING/RUNNING, re-consultamos la lista
  // cada POLL_INTERVAL_MS. En cuanto ninguno esté activo, paramos el intervalo.
  // El efecto depende de `broadcasts` para re-evaluar si sigue habiendo activos
  // tras cada refresco (y así detenerse solo cuando todos terminaron).
  const active = broadcasts ? hasActive(broadcasts) : false;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      void reloadRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  const canSend = subject.trim().length >= 3 && bodyText.trim().length >= 1 && !sending;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await communityApi.createBroadcast({
        subject: subject.trim(),
        bodyText: bodyText.trim(),
        important,
      });
      setSubject('');
      setBodyText('');
      setImportant(false);
      setNotice('Aviso encolado: se irá enviando por lotes.');
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos encolar el aviso.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">Avisos a la comunidad</h1>
        <p className="mt-1 max-w-2xl text-text-muted">
          Envía un email + notificación a todos los miembros. Se manda por lotes para no saturar el
          correo; cada email lleva enlace de baja.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ── Composición ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Nuevo aviso</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
                >
                  {error}
                </div>
              ) : null}
              {notice ? (
                <div
                  role="status"
                  className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-700"
                >
                  {notice}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="broadcast-subject">Asunto</Label>
                <Input
                  id="broadcast-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                  minLength={3}
                  maxLength={200}
                  placeholder="Novedades de la comunidad…"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="broadcast-body">Mensaje</Label>
                <Textarea
                  id="broadcast-body"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  required
                  minLength={1}
                  rows={8}
                  placeholder="Escribe aquí el contenido del aviso…"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-text">
                <input
                  type="checkbox"
                  checked={important}
                  onChange={(e) => setImportant(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand-500 focus:ring-brand-500"
                />
                <span>
                  Marcar como importante (ignora las bajas)
                  <span className="mt-0.5 block text-xs text-text-subtle">
                    Los avisos importantes se envían incluso a quienes se dieron de baja de los
                    correos de la comunidad.
                  </span>
                </span>
              </label>

              <div className="flex justify-end border-t border-border-soft pt-3">
                <Button type="submit" disabled={!canSend}>
                  {sending ? 'Enviando…' : 'Enviar a todos'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* ── Historial de envíos ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Envíos</CardTitle>
          </CardHeader>
          <CardContent>
            {listError ? (
              <div
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {listError}
              </div>
            ) : broadcasts === null ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-20 w-full rounded-lg" />
                ))}
              </div>
            ) : broadcasts.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">
                Aún no has enviado ningún aviso.
              </p>
            ) : (
              <ul className="space-y-3">
                {broadcasts.map((b) => (
                  <BroadcastRow key={b.id} broadcast={b} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/** Fila de un aviso: asunto, estado, progreso y fecha. */
function BroadcastRow({ broadcast }: { broadcast: Broadcast }) {
  const meta = STATUS_META[broadcast.status];
  const createdAt = new Date(broadcast.createdAt).toLocaleString('es-ES');

  return (
    <li className="rounded-lg border border-border-soft bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate font-medium text-text">{broadcast.subject}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {broadcast.important ? (
            <Badge variant="warning" dot>
              Importante
            </Badge>
          ) : null}
          <Badge variant={meta.variant} dot>
            {meta.label}
          </Badge>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="tabular-nums">
          {broadcast.sent}/{broadcast.total} enviados
        </span>
        {broadcast.skipped > 0 ? (
          <span className="tabular-nums text-text-subtle">{broadcast.skipped} omitidos</span>
        ) : null}
        {broadcast.failed > 0 ? (
          <span className="tabular-nums text-danger-700">{broadcast.failed} fallidos</span>
        ) : null}
        <span className="ml-auto text-text-subtle">{createdAt}</span>
      </div>
    </li>
  );
}
