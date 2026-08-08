'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
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

const STATUS_VARIANT: Record<Broadcast['status'], 'muted' | 'info' | 'success' | 'danger'> = {
  PENDING: 'muted',
  RUNNING: 'info',
  DONE: 'success',
  FAILED: 'danger',
};

export default function CommunityBroadcastsAdminPage() {
  const t = useTranslations('adminMonetizacion.broadcasts');
  const tErrors = useTranslations('errors');
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
      setListError(apiErrorMessage(e, tErrors));
      return null;
    }
  }, [tErrors]);

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
      setNotice(t('queued'));
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-text-muted">{t('intro')}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ── Composición ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>{t('composeTitle')}</CardTitle>
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
                <Label htmlFor="broadcast-subject">{t('subjectLabel')}</Label>
                <Input
                  id="broadcast-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                  minLength={3}
                  maxLength={200}
                  placeholder={t('subjectPlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="broadcast-body">{t('bodyLabel')}</Label>
                <Textarea
                  id="broadcast-body"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  required
                  minLength={1}
                  rows={8}
                  placeholder={t('bodyPlaceholder')}
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
                  {t('importantLabel')}
                  <span className="mt-0.5 block text-xs text-text-subtle">
                    {t('importantHelp')}
                  </span>
                </span>
              </label>

              <div className="flex justify-end border-t border-border-soft pt-3">
                <Button type="submit" disabled={!canSend}>
                  {sending ? t('sending') : t('sendToAll')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* ── Historial de envíos ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>{t('historyTitle')}</CardTitle>
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
              <p className="py-6 text-center text-sm text-text-muted">{t('historyEmpty')}</p>
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
  const t = useTranslations('adminMonetizacion.broadcasts');
  const tStatus = useTranslations('adminMonetizacion.broadcastStatus');
  const createdAt = formatDateTime(broadcast.createdAt);

  return (
    <li className="rounded-lg border border-border-soft bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate font-medium text-text">{broadcast.subject}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {broadcast.important ? (
            <Badge variant="warning" dot>
              {t('importantBadge')}
            </Badge>
          ) : null}
          <Badge variant={STATUS_VARIANT[broadcast.status]} dot>
            {tStatus(broadcast.status)}
          </Badge>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="tabular-nums">
          {t('sentProgress', { sent: String(broadcast.sent), total: String(broadcast.total) })}
        </span>
        {broadcast.skipped > 0 ? (
          <span className="tabular-nums text-text-subtle">
            {t('skipped', { count: String(broadcast.skipped) })}
          </span>
        ) : null}
        {broadcast.failed > 0 ? (
          <span className="tabular-nums text-danger-700">
            {t('failed', { count: String(broadcast.failed) })}
          </span>
        ) : null}
        <span className="ml-auto text-text-subtle">{createdAt}</span>
      </div>
    </li>
  );
}
