'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import { LOCALE_OPTIONS, meApi, TIMEZONE_OPTIONS, type NotificationPreference } from '@/lib/me';
import { useTenantContext } from '@/lib/tenant-context';
import { communityApi } from '@/modules/community';

const STEPS = ['Foto', 'Tus datos', 'Notificaciones', 'Listo'];

/**
 * Onboarding de primera vez (gate bloqueante). El shell `(app)` redirige aquí
 * mientras `onboardingCompletedAt` sea null. Captura foto (obligatoria), nombre
 * (obligatorio), bio, idioma/zona horaria, DNI/NIE y preferencias de
 * notificación, y al completar marca el onboarding y entra a /inicio.
 */
export default function OnboardingPage() {
  const router = useRouter();
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
          // Ya lo completó: no se repite el onboarding.
          router.replace('/inicio');
          return;
        }
        setEmail(p.email);
        setName(p.name ?? '');
        setBio(p.bio ?? '');
        setLocale(p.locale);
        setTimezone(p.timezone);
        setDocumentId(p.documentId ?? '');
        setAvatarUrl(p.avatarUrl);
        setError(null);
      } catch {
        if (!cancelled) {
          setError('No pudimos cargar tu perfil. Recarga la página.');
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
  }, [router]);

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
      router.replace('/inicio');
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos completar el onboarding. Revisa tus datos e inténtalo de nuevo.',
      );
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-text-muted">Cargando…</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="label-uppercase text-text-muted">
          Bienvenido/a a {tenant?.name ?? 'Didacta'}
        </p>
        <h1 className="font-display mt-2 text-2xl font-bold tracking-tight">
          Completa tu perfil para empezar
        </h1>
        <p className="mt-1 text-sm text-text-subtle">
          Solo te llevará un momento. Podrás cambiar todo esto luego en tu perfil.
        </p>
      </header>

      <ol className="flex items-center justify-center gap-2">
        {STEPS.map((label, i) => (
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
            {i < STEPS.length - 1 ? <span className="h-px w-6 bg-border-soft" /> : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-6">
          {step === 0 ? (
            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">Tu foto de perfil</h2>
                <p className="text-sm text-text-muted">
                  Sube una imagen para que la comunidad te reconozca. Es obligatoria.
                </p>
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
                <h2 className="text-lg font-semibold">Tus datos</h2>
                <p className="text-sm text-text-muted">
                  Cómo te verán y cómo localizamos tu cuenta.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-name">
                  Nombre de perfil <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ob-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder="Tu nombre"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ob-bio">
                  Biografía <span className="text-text-subtle text-xs">(opcional)</span>
                </Label>
                <Textarea
                  id="ob-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder="Cuéntanos algo sobre ti (máx 280 caracteres)"
                />
                <p className="text-right text-xs text-text-subtle">{bio.length}/280</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ob-locale">Idioma</Label>
                  <Select id="ob-locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
                    {LOCALE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ob-tz">Zona horaria</Label>
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
                  DNI / NIE <span className="text-text-subtle text-xs">(opcional)</span>
                </Label>
                <Input
                  id="ob-doc"
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="12345678Z o X1234567L"
                />
                <p className="text-xs text-text-subtle">
                  Solo necesario para solicitar facturas de pago.
                </p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Tus notificaciones</h2>
                <p className="text-sm text-text-muted">
                  Elige cómo quieres que te avisemos. Podrás cambiarlo cuando quieras.
                </p>
              </div>
              <NotificationMatrix value={prefs} onChange={setPrefs} />
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">¡Todo listo!</h2>
                <p className="text-sm text-text-muted">
                  Revisa y confirma para entrar a la plataforma.
                </p>
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
              Atrás
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Continuar
              </Button>
            ) : (
              <Button type="button" disabled={submitting} onClick={() => void handleComplete()}>
                {submitting ? 'Guardando…' : 'Entrar a la plataforma'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
