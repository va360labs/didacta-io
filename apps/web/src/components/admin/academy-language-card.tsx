'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { ACADEMY_LOCALE_NAMES, ACADEMY_LOCALES, type AcademyLocale } from '@/i18n/config';
import { academyApi as defaultAcademyApi, type Academy } from '@/lib/academy';
import { authStorage as defaultAuthStorage } from '@/lib/auth-storage';

/**
 * ¿Se puede guardar? Si cambia, o si aún no está fijado (solo deducido): así
 * quien administra puede fijar el idioma que ya se está usando.
 */
export function canSaveAcademyLocale(
  academy: Pick<Academy, 'locale' | 'localeSource'> | null,
  draft: AcademyLocale,
  saving: boolean,
): boolean {
  if (academy === null || saving) return false;
  return draft !== academy.locale || academy.localeSource !== 'setting';
}

export interface AcademyLanguageCardProps {
  /** Inyectable para tests. */
  api?: Pick<typeof defaultAcademyApi, 'getMine' | 'update'>;
  authStorage?: Pick<typeof defaultAuthStorage, 'getAccessToken'>;
}

/**
 * «Idioma de la academia» en Configuración del modo completo (pestaña General).
 * Es el idioma con el que ve el aula quien aún no ha elegido el suyo: la venta,
 * el catálogo, el acceso y los correos. La preferencia de cada usuario sigue
 * mandando para ese usuario. El modo sencillo lo tiene en sus Ajustes.
 */
export function AcademyLanguageCard({
  api = defaultAcademyApi,
  authStorage = defaultAuthStorage,
}: AcademyLanguageCardProps = {}): React.JSX.Element {
  const t = useTranslations('adminMarca.idiomaAula');
  const [academy, setAcademy] = useState<Academy | null>(null);
  const [locale, setLocale] = useState<AcademyLocale>('es');
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
        if (cancelled) return;
        setAcademy(a);
        setLocale(a.locale);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authStorage]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSaving(true);
    setStatus(null);
    try {
      const a = await api.update(token, { locale });
      setAcademy(a);
      setLocale(a.locale);
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  const canSave = canSaveAcademyLocale(academy, locale, saving);

  return (
    <Card data-testid="idioma-academia">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <p role="alert" className="text-sm text-danger-700">
            {t('loadError')}
          </p>
        ) : academy === null ? (
          <div className="skeleton h-10 w-56" />
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="idioma-academia">{t('label')}</Label>
              <NativeSelect
                id="idioma-academia"
                value={locale}
                onChange={(e) => {
                  setLocale(e.target.value as AcademyLocale);
                  setStatus(null);
                }}
                className="max-w-xs"
              >
                {ACADEMY_LOCALES.map((l) => (
                  <option key={l} value={l} lang={l}>
                    {ACADEMY_LOCALE_NAMES[l]}
                  </option>
                ))}
              </NativeSelect>
              {academy.localeSource !== 'setting' ? (
                <p className="text-sm text-text-muted">{t('deducido')}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSave}>
                {saving ? t('saving') : t('save')}
              </Button>
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
          </form>
        )}
      </CardContent>
    </Card>
  );
}
