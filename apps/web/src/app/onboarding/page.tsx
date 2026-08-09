'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AvatarUpload } from '@/components/avatar-upload';
import { NotificationMatrix, fullMatrix } from '@/components/notification-preferences-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { consumeIntendedPath } from '@/lib/post-login-redirect';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { toSupportedLocale } from '@/i18n/config';
import { LOCALE_OPTIONS, meApi, TIMEZONE_OPTIONS, type NotificationPreference } from '@/lib/me';
import { useTenantContext } from '@/lib/tenant-context';
import { communityApi } from '@/modules/community';

/**
 * Onboarding de primera vez (gate bloqueante). El shell `(app)` redirige aquí
 * mientras `onboardingCompletedAt` sea null. Captura foto (obligatoria), nombre
 * (obligatorio), bio, idioma/zona horaria, DNI/NIE y preferencias de
 * notificación, y al completar marca el onboarding y entra a /inicio.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const { tenant } = useTenantContext();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [locale, setLocale] = useState('es-ES');
  const [timezone, setTimezone] = useState('UTC');
  const [documentId, setDocumentId] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreference[]>(fullMatrix([]));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    const session = authStorage.getSession();
    if (!token || !session) {
      router.replace('/signin');
      return;
    }
    let cancelled = false;
    void (async () => {
      // 1) Perfil: única llamada CRÍTICA. Si falla, mostramos el error.
      try {
        const p = await meApi.getProfile(token);
        if (cancelled) return;
        if (p.onboardingCompletedAt) {
          // Ya lo completó: no se repite el onboarding. Parcheamos la sesión
          // local con el flag (las sesiones SSO no lo traen) para que el gate
          // del shell no vuelva a mandar aquí en bucle, y si venía de un deep
          // link (enlace compartido), volvemos ahí.
          const session = authStorage.getSession();
          if (session && !session.user.onboardingCompletedAt) {
            session.user.onboardingCompletedAt = p.onboardingCompletedAt;
            authStorage.saveSession(session);
          }
          router.replace(consumeIntendedPath() ?? '/inicio');
          return;
        }
        setEmail(p.email);
        setName(p.name ?? '');
        setBio(p.bio ?? '');
        // Normalizado: ver el mismo comentario en `/cuenta`. Un locale
        // guardado que el selector ya no ofrece dejaría el `<select>` sin
        // opción que casar.
        setLocale(toSupportedLocale(p.locale));
        setTimezone(p.timezone);
        setDocumentId(p.documentId ?? '');
        setAvatarUrl(p.avatarUrl);
        setError(null);
      } catch {
        if (!cancelled) {
          setError(t('onboarding.loadProfileError'));
          setLoading(false);
        }
        return;
      }
      // 2) Preferencias de notificación: BEST-EFFORT. Un fallo aquí NO debe
      //    mostrar el error de perfil ni bloquear el onboarding — caemos al
      //    default (matriz todo-activado, ya en el estado inicial).
      try {
        let matrix = fullMatrix((await meApi.getNotificationPreferences(token)).preferences);
        try {
          const c = await communityApi.getMyPreferences();
          matrix = matrix.map((m) =>
            m.category === 'COMMUNITY' && m.channel === 'EMAIL'
              ? { ...m, enabled: !c.digestOptOut }
              : m,
          );
        } catch {
          /* community deshabilitado en este tenant: dejamos el default */
        }
        if (!cancelled) setPrefs(matrix);
      } catch {
        /* prefs no disponibles: dejamos la matriz por defecto */
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // `t` fuera de las deps a propósito: next-intl no garantiza identidad
    // estable y este efecto de carga inicial no debe re-ejecutarse por render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const steps = [
    t('onboarding.stepPhoto'),
    t('onboarding.stepData'),
    t('onboarding.stepNotifications'),
    t('onboarding.stepDone'),
  ];

  const canNext = step === 0 ? avatarUrl !== null : step === 1 ? name.trim().length > 0 : true;

  async function handleComplete() {
    const token = authStorage.getAccessToken();
    if (!token) {
      router.replace('/signin');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await meApi.updateProfile(token, {
        name: name.trim(),
        bio: bio.trim() === '' ? null : bio.trim(),
        locale,
        timezone,
        documentId: documentId.trim() === '' ? null : documentId.trim().toUpperCase(),
        avatarUrl,
      });
      await meApi.updateNotificationPreferences(token, prefs);
      // Reconciliar el digest de community (best-effort; ignoramos 403/404).
      const communityEmail = prefs.find((p) => p.category === 'COMMUNITY' && p.channel === 'EMAIL');
      if (communityEmail) {
        try {
          await communityApi.updateMyPreferences({ digestOptOut: !communityEmail.enabled });
        } catch {
          /* community deshabilitado */
        }
      }
      const res = await meApi.completeOnboarding(token);
      const session = authStorage.getSession();
      if (session) {
        session.user.onboardingCompletedAt = res.onboardingCompletedAt;
        // Refrescamos nombre y avatar en la sesión para que el sidebar los
        // muestre al instante (sin esperar a un nuevo login).
        session.user.name = name.trim();
        session.user.avatarUrl = avatarUrl;
        authStorage.saveSession(session);
      }
      // Deep link pendiente de antes del login (enlace compartido) → ahí.
      router.replace(consumeIntendedPath() ?? '/inicio');
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('onboarding.completeError'),
      );
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-text-muted">
          {t('onboarding.loading')}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="label-uppercase text-text-muted">
          {t('onboarding.welcome', { name: tenant?.name ?? 'Didacta' })}
        </p>
        <h1 className="font-display mt-2 text-2xl font-bold tracking-tight">
          {t('onboarding.title')}
        </h1>
        <p className="mt-1 text-sm text-text-subtle">{t('onboarding.subtitle')}</p>
      </header>

      <ol className="flex items-center justify-center gap-2">
        {steps.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                'grid h-7 w-7 place-items-center rounded-full text-xs font-bold ' +
                (i < step
                  ? 'bg-success-500 text-white'
                  : i === step
                    ? 'bg-brand-500 text-white'
                    : 'bg-surface-3 text-text-subtle')
              }
            >
              {i < step ? '✓' : i + 1}
            </span>
            {i < steps.length - 1 ? <span className="h-px w-6 bg-border-soft" /> : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-6">
          {step === 0 ? (
            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">{t('onboarding.photoTitle')}</h2>
                <p className="text-sm text-text-muted">{t('onboarding.photoDescription')}</p>
              </div>
              <AvatarUpload
                value={avatarUrl}
                onChange={setAvatarUrl}
                name={name || null}
                email={email}
              />
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('onboarding.dataTitle')}</h2>
                <p className="text-sm text-text-muted">{t('onboarding.dataDescription')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-name">
                  {t('onboarding.nameLabel')} <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ob-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder={t('onboarding.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-bio">
                  {t('onboarding.bioLabel')}{' '}
                  <span className="text-text-subtle text-xs">{t('onboarding.optionalTag')}</span>
                </Label>
                <Textarea
                  id="ob-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder={t('onboarding.bioPlaceholder')}
                />
                <p className="text-right text-xs text-text-subtle">{bio.length}/280</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ob-locale">{t('onboarding.localeLabel')}</Label>
                  <Select id="ob-locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
                    {LOCALE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ob-tz">{t('onboarding.timezoneLabel')}</Label>
                  <Select id="ob-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                    {TIMEZONE_OPTIONS.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.values.map((tz) => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-doc">
                  {t('onboarding.documentLabel')}{' '}
                  <span className="text-text-subtle text-xs">{t('onboarding.optionalTag')}</span>
                </Label>
                <Input
                  id="ob-doc"
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('onboarding.documentPlaceholder')}
                />
                <p className="text-xs text-text-subtle">{t('onboarding.documentHint')}</p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('onboarding.notificationsTitle')}</h2>
                <p className="text-sm text-text-muted">
                  {t('onboarding.notificationsDescription')}
                </p>
              </div>
              <NotificationMatrix value={prefs} onChange={setPrefs} />
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('onboarding.readyTitle')}</h2>
                <p className="text-sm text-text-muted">{t('onboarding.readyDescription')}</p>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-border-soft p-4">
                <div
                  aria-hidden="true"
                  className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full font-display font-bold text-white"
                  style={
                    avatarUrl
                      ? {
                          backgroundImage: `url(${avatarUrl})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }
                      : { background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }
                  }
                >
                  {avatarUrl ? null : (name || email).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">{name || '—'}</p>
                  <p className="truncate text-sm text-text-muted">{email}</p>
                  {bio ? <p className="mt-1 text-sm text-text-muted">{bio}</p> : null}
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              {t('onboarding.back')}
            </Button>
            {step < steps.length - 1 ? (
              <Button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                {t('onboarding.continue')}
              </Button>
            ) : (
              <Button type="button" disabled={submitting} onClick={() => void handleComplete()}>
                {submitting ? t('onboarding.submitPending') : t('onboarding.submit')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
