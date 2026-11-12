/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

'use client';

/**
 * «Correo para respuestas» del aula: el Reply-To de los correos que reciben
 * sus alumnos. Vive en Configuración → Notificaciones, encima del servidor de
 * correo, porque es lo único de esa pestaña que un creador sin conocimientos
 * técnicos necesita tocar: el resto (SMTP propio) es modo avanzado.
 *
 * Enseña adónde van HOY las respuestas (lo calcula el servidor con el mismo
 * resolver que usan los envíos), para que dejarlo vacío no sea un misterio.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  adminSenderApi,
  isValidReplyToInput,
  normalizeReplyToInput,
  type AdminSenderDto,
} from '@/lib/admin-smtp';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';

interface Props {
  api?: typeof adminSenderApi;
}

export function ReplyToCard({ api = adminSenderApi }: Props): React.JSX.Element {
  const t = useTranslations('adminSso');
  const tErrors = useTranslations('errors');
  const [dto, setDto] = useState<AdminSenderDto | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get();
        if (cancelled) return;
        setDto(data);
        setValue(data.replyToEmail ?? '');
      } catch (err) {
        if (cancelled) return;
        setMessage({
          ok: false,
          text:
            err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('replyTo.loadError'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setMessage(null);
    if (!isValidReplyToInput(value)) {
      setMessage({ ok: false, text: t('replyTo.invalid') });
      return;
    }
    setSaving(true);
    try {
      const updated = await api.save(normalizeReplyToInput(value));
      setDto(updated);
      setValue(updated.replyToEmail ?? '');
      setMessage({ ok: true, text: t('replyTo.saved') });
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('replyTo.saveError'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="reply-to-card">
      <CardHeader>
        <CardTitle>{t('replyTo.title')}</CardTitle>
        <CardDescription>{t('replyTo.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="reply-to-email">{t('replyTo.label')}</Label>
            <Input
              id="reply-to-email"
              type="email"
              autoComplete="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('replyTo.placeholder')}
              maxLength={254}
            />
            {dto ? (
              <p className="text-xs text-text-subtle" data-testid="reply-to-effective">
                {dto.effectiveReplyTo
                  ? t('replyTo.effective', { email: dto.effectiveReplyTo })
                  : t('replyTo.effectiveNone')}
              </p>
            ) : null}
          </div>
          {message ? (
            <div
              role="status"
              aria-live="polite"
              className={
                'rounded-md border p-3 text-sm ' +
                (message.ok
                  ? 'border-success-200 bg-success-50 text-success-700'
                  : 'border-danger-100 bg-danger-50 text-danger-700')
              }
            >
              {message.text}
            </div>
          ) : null}
          <Button type="submit" disabled={saving || !dto}>
            {saving ? t('replyTo.saving') : t('replyTo.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
