'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { academyApi as defaultAcademyApi, type Academy } from '@/lib/academy';
import { authStorage as defaultAuthStorage } from '@/lib/auth-storage';
import { cn } from '@/lib/utils';

export interface PublicHomeToggleProps {
  /** Inyectable para tests. */
  api?: Pick<typeof defaultAcademyApi, 'getMine' | 'update'>;
  authStorage?: Pick<typeof defaultAuthStorage, 'getAccessToken'>;
  /** `card` en Configuración del modo completo; `plain` dentro de Ajustes del sencillo. */
  variant?: 'card' | 'plain';
}

/**
 * «Página pública de la academia»: el interruptor que decide qué ve quien entra
 * SIN sesión en la raíz del aula: la portada con las opciones de acceso o,
 * apagado, la pantalla de acceso de siempre. Se guarda al pulsarlo.
 *
 * Vive en los Ajustes de los dos modos (sencillo: su sección; completo:
 * Configuración → General). Por defecto sigue al modo del aula (encendido en
 * el sencillo, apagado en el completo) hasta que alguien lo toca.
 */
export function PublicHomeToggle({
  api = defaultAcademyApi,
  authStorage = defaultAuthStorage,
  variant = 'card',
}: PublicHomeToggleProps = {}): React.JSX.Element {
  const t = useTranslations('adminMarca.paginaPublica');
  const [academy, setAcademy] = useState<Academy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = authStorage.getAccessToken();
    if (!token) {
      setLoadError(true);
      return;
    }
    api
      .getMine(token)
      .then((a) => {
        if (!cancelled) setAcademy(a);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authStorage]);

  async function toggle() {
    const token = authStorage.getAccessToken();
    if (!token || !academy) return;
    setSaving(true);
    setStatus(null);
    try {
      setAcademy(await api.update(token, { publicHome: !academy.publicHome }));
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  const on = academy?.publicHome === true;

  const body = loadError ? (
    <p role="alert" className="text-sm text-danger-700">
      {t('loadError')}
    </p>
  ) : academy === null ? (
    <div className="skeleton h-10 w-64" />
  ) : (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="pagina-publica-label"
          disabled={saving}
          onClick={() => void toggle()}
          data-testid="pagina-publica-switch"
          className={cn(
            'relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-100 disabled:opacity-60',
            on ? 'bg-brand-600' : 'bg-border-strong',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
              on ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
        <div className="min-w-0">
          <p id="pagina-publica-label" className="font-semibold text-text">
            {on ? t('on') : t('off')}
          </p>
          <p className="text-sm text-text-muted">{on ? t('onHelp') : t('offHelp')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {on ? (
          <a
            href="/?preview=1"
            target="_blank"
            rel="noopener"
            data-testid="pagina-publica-ver"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline"
          >
            <Icon name="eye" size={16} />
            {t('preview')}
          </a>
        ) : null}
        {status === 'saved' ? (
          <span role="status" className="text-sm font-semibold text-success-700">
            {t('saved')}
          </span>
        ) : status === 'error' ? (
          <span role="alert" className="text-sm font-semibold text-danger-700">
            {t('error')}
          </span>
        ) : null}
      </div>
    </div>
  );

  if (variant === 'plain') {
    return <div data-testid="pagina-publica">{body}</div>;
  }
  return (
    <Card data-testid="pagina-publica">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
