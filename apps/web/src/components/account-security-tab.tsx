'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { MfaSetupFlow } from '@/components/mfa-setup-flow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { meApi, type ActiveSession } from '@/lib/me';

/**
 * Contenido de la pestaña "Seguridad" del perfil (/cuenta): cambio de
 * contraseña, sesiones activas y MFA. Antes vivía en la ruta /cuenta/seguridad,
 * que se eliminó para consolidar todo en el perfil. El gate de contraseña
 * temporal (`mustChangePassword`) redirige a /cuenta?tab=seguridad.
 */
export function AccountSecurityTab() {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [mfaOpen, setMfaOpen] = useState(false);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // True si la contraseña actual es temporal (alta por inscripción externa):
  // el shell redirige aquí y mostramos un aviso explicando que debe cambiarla.
  const [mustChange, setMustChange] = useState(false);
  // Estado real del MFA (desde el perfil) y si el usuario es admin. La tarjeta de
  // MFA se ofrece SOLO a admins (super_admin/tenant_admin); para el resto de roles
  // el segundo factor no se exige, así que no la mostramos para no confundir.
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  async function loadSessions() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      setSessions(await meApi.listSessions(token));
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('security.sessionsLoadError'),
      );
    }
  }

  useEffect(() => {
    void loadSessions();
    const session = authStorage.getSession();
    setMustChange(session?.user.mustChangePassword ?? false);
    setIsAdmin(
      session?.user.roles?.some((r) => r === 'super_admin' || r === 'tenant_admin') ?? false,
    );
    const token = authStorage.getAccessToken();
    if (token) {
      meApi
        .getProfile(token)
        .then((p) => setMfaEnabled(p.mfaEnabled))
        .catch(() => setMfaEnabled(null));
    }
  }, []);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (newPassword !== confirmPassword) {
      setPwError(t('security.pwMismatch'));
      return;
    }
    if (newPassword.length < 12) {
      setPwError(t('security.pwTooShort'));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPending(true);
    try {
      await meApi.changePassword(token, { currentPassword, newPassword });
      setPwSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // El backend invalida todas las sessions; redirigimos a signin tras 2s.
      setTimeout(() => {
        authStorage.clear();
        router.replace('/signin');
      }, 2000);
    } catch (e) {
      setPwError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('security.pwChangeError'),
      );
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm(t('security.revokeConfirm'))) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy(`rm-${id}`);
    try {
      await meApi.revokeSession(token, id);
      await loadSessions();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('security.revokeError'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRevokeAll() {
    if (!confirm(t('security.revokeAllConfirm'))) {
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('all');
    try {
      await meApi.revokeAllSessions(token);
      authStorage.clear();
      router.replace('/signin');
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('security.revokeAllError'),
      );
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('security.changePasswordTitle')}</CardTitle>
          <CardDescription>{t('security.changePasswordDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {mustChange ? (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800"
            >
              {t('security.tempPasswordNotice')}
            </div>
          ) : null}
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">{t('security.currentPassword')}</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="newPassword">{t('security.newPassword')}</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
                <p className="text-xs text-text-subtle">{t('security.minChars')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">{t('security.confirmPassword')}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            </div>
            {pwError ? (
              <p role="alert" className="text-sm text-danger-700">
                {pwError}
              </p>
            ) : null}
            {pwSuccess ? (
              <div className="inline-flex items-center gap-2 rounded-lg bg-success-50 px-3 py-2 text-sm font-semibold text-success-700">
                <Icon name="check" size={16} />
                {t('security.pwChanged')}
              </div>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? t('security.saving') : t('security.changePasswordCta')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>{t('security.sessionsTitle')}</CardTitle>
              <CardDescription>{t('security.sessionsDesc')}</CardDescription>
            </div>
            <Button variant="destructive" onClick={handleRevokeAll} disabled={busy === 'all'}>
              {t('security.revokeAllCta')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-danger-700">{error}</p>
          ) : sessions === null ? (
            <div className="space-y-2">
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('security.noSessions')}</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-info-50 text-info-700"
                    >
                      <Icon name="lock" size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">
                        {parseUserAgent(s.userAgent, t)}
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-text-subtle">
                        {t('security.sessionMeta', {
                          time: relTime(s.createdAt, t),
                          ip: s.ip ?? '—',
                        })}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(s.id)}
                    disabled={busy === `rm-${s.id}`}
                    className="text-xs font-semibold text-danger-700 transition-colors hover:underline"
                  >
                    {t('security.revokeCta')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardContent className="flex flex-wrap items-start gap-4 p-6">
            <span
              aria-hidden="true"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-info-50 text-info-700"
            >
              <Icon name="shield" size={24} />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-lg font-semibold text-text">
                  {t('security.mfaTitle')}
                </h3>
                {mfaEnabled ? (
                  <Badge variant="success" dot>
                    {t('security.mfaEnabled')}
                  </Badge>
                ) : (
                  <Badge variant="warning" dot>
                    {t('security.mfaNotConfigured')}
                  </Badge>
                )}
              </div>
              <p className="text-sm leading-relaxed text-text-muted">
                {mfaEnabled ? t('security.mfaEnabledDesc') : t('security.mfaSetupDesc')}
              </p>
            </div>
            {mfaEnabled ? (
              <Badge variant="outline" className="gap-1.5">
                <Icon name="check" size={14} />
                {t('security.mfaConfigured')}
              </Badge>
            ) : (
              <Button onClick={() => setMfaOpen(true)}>
                <Icon name="lock" size={16} />
                {t('security.mfaSetupCta')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={mfaOpen}
        onOpenChange={(o) => {
          if (!o) setMfaOpen(false);
        }}
        ariaLabel={t('security.mfaSetupCta')}
        maxWidthClass="max-w-md"
        contentClassName="p-6"
      >
        <div className="mb-5">
          <h2 className="font-display text-lg font-bold tracking-tight text-text">
            {t('security.mfaDialogTitle')}
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">{t('security.mfaDialogDesc')}</p>
        </div>
        {mfaOpen ? (
          <MfaSetupFlow
            onDone={() => {
              setMfaOpen(false);
              // Recargamos para reflejar mfaEnabled=true en perfil y stats.
              window.location.reload();
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function relTime(iso: string, t: TranslatorLike): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('security.justNow');
  if (min < 60) return t('security.minutesAgo', { minutes: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('security.hoursAgo', { hours: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t('security.daysAgo', { days: d });
  return formatDate(iso);
}

function parseUserAgent(ua: string | null, t: TranslatorLike): string {
  if (!ua) return t('security.unknownDevice');
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0] ||
    /Chrome\/(\d+)/.exec(ua)?.[0] ||
    /Firefox\/(\d+)/.exec(ua)?.[0] ||
    /Safari\/(\d+)/.exec(ua)?.[0];
  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : null;
  if (browser && os) return t('security.browserOnOs', { browser, os });
  if (browser) return browser;
  if (os) return os;
  return ua.length > 60 ? ua.slice(0, 57) + '…' : ua;
}
