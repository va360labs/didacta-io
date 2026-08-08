'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Modal compartido para enviar el email de recordatorio de pago/renovación.
 *
 * Lo usan dos pantallas que envían el MISMO email con la misma plantilla del tenant:
 *   - Dashboard de control de suscripciones (mod.payment-connections).
 *   - Panel de solicitudes de inscripción (core).
 *
 * Es presentación pura: cada pantalla inyecta cómo cargar el contexto (plantilla +
 * enlace de renovación) y cómo enviar, vía `loadContext` y `send`. Al abrir, resuelve
 * la plantilla, sustituye las variables ({plan}, {enlace}, {importe}, {email}) y deja
 * asunto y cuerpo EDITABLES antes de enviar.
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents } from '@/lib/i18n/format';
import { type RenewalTemplate } from '@/lib/payment-connections';

export interface RenewalEmailModalProps {
  /** Email destinatario (a quién se le envía el recordatorio). */
  to: string;
  /** Nombre del plan/producto (para la variable {plan}). */
  productName: string | null;
  /** Importe en céntimos (para la variable {importe}). */
  unitAmount: number | null;
  /** Moneda ISO (para la variable {importe}). */
  currency: string | null;
  /** Carga la plantilla del tenant + el enlace de renovación (lazy). */
  loadContext: () => Promise<{ template: RenewalTemplate; renewalUrl: string | null }>;
  /** Envía el email ya editado. Devuelve el destinatario real para el aviso. */
  send: (payload: RenewalTemplate) => Promise<{ to: string }>;
  onClose: () => void;
  onSent: (msg: string) => void;
}

export function RenewalEmailModal({
  to,
  productName,
  unitAmount,
  currency,
  loadContext,
  send,
  onClose,
  onSent,
}: RenewalEmailModalProps) {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [renewalUrl, setRenewalUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { template, renewalUrl: url } = await loadContext();
        if (!active) return;
        const resolve = (s: string) =>
          s
            .replaceAll('{plan}', productName ?? t('renewal.yourPlan'))
            .replaceAll('{enlace}', url ?? t('renewal.linkUnavailable'))
            .replaceAll(
              '{importe}',
              unitAmount !== null ? formatCents(unitAmount, (currency ?? 'eur').toUpperCase()) : '',
            )
            .replaceAll('{email}', to);
        setRenewalUrl(url);
        setSubject(resolve(template.subject));
        setBody(resolve(template.body));
      } catch (e) {
        if (active) {
          setErr(
            e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('renewal.prepareError'),
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);

  async function submit() {
    setSending(true);
    setErr(null);
    try {
      const res = await send({ subject, body });
      onSent(t('renewal.sentMsg', { to: res.to }));
    } catch (e) {
      setErr(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('renewal.sendError'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold text-text">{t('renewal.title')}</h3>
          <p className="text-sm text-text-muted">
            {t('renewal.forRecipient', {
              to,
              product: productName ?? t('renewal.subscriptionFallback'),
            })}
          </p>
        </div>

        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            {!renewalUrl && (
              <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-700">
                {t('renewal.noLinkWarning')}
              </div>
            )}
            <div>
              <Label htmlFor="renew-subject">{t('renewal.subject')}</Label>
              <Input
                id="renew-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="renew-body">{t('renewal.message')}</Label>
              <textarea
                id="renew-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
              />
            </div>
            {err && <p className="text-sm text-danger">{err}</p>}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            {t('renewal.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={loading || sending || !subject || !body}>
            {sending ? t('renewal.sending') : t('renewal.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}
