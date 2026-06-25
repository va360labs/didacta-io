'use client';

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
import { meApi, type ActiveSession } from '@/lib/me';

/**
 * Contenido de la pestaña "Seguridad" del perfil (/cuenta): cambio de
 * contraseña, sesiones activas y MFA. Antes vivía en la ruta /cuenta/seguridad,
 * que se eliminó para consolidar todo en el perfil. El gate de contraseña
 * temporal (`mustChangePassword`) redirige a /cuenta?tab=seguridad.
 */
export function AccountSecurityTab() {
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
  const [mustChange, setMustChange] = useState(false);

  async function loadSessions() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      setSessions(await meApi.listSessions(token));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar tus sesiones.');
    }
  }

  useEffect(() => {
    void loadSessions();
    setMustChange(authStorage.getSession()?.user.mustChangePassword ?? false);
  }, []);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (newPassword !== confirmPassword) {
      setPwError('Las contraseñas nuevas no coinciden.');
      return;
    }
    if (newPassword.length < 12) {
      setPwError('La nueva contraseña debe tener al menos 12 caracteres.');
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
      setPwError(e instanceof ApiHttpError ? e.message : 'No pudimos cambiar tu contraseña.');
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm('¿Cerrar esta sesión?')) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy(`rm-${id}`);
    try {
      await meApi.revokeSession(token, id);
      await loadSessions();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cerrar la sesión.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRevokeAll() {
    if (
      !confirm(
        '¿Cerrar TODAS las sesiones, incluyendo la actual? Vas a tener que volver a iniciar sesión.',
      )
    ) {
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cerrar las sesiones.');
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Cambiar contraseña</CardTitle>
          <CardDescription>
            Al cambiar la contraseña se cerrarán TODAS tus sesiones. Vas a tener que iniciar sesión
            otra vez con la nueva.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mustChange ? (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800"
            >
              Tu contraseña es temporal. Por seguridad, debes establecer una nueva antes de seguir
              usando la plataforma. Introduce la contraseña temporal que recibiste por email como
              «contraseña actual».
            </div>
          ) : null}
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Contraseña actual</Label>
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
                <Label htmlFor="newPassword">Nueva contraseña</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
                <p className="text-xs text-text-subtle">Mínimo 12 caracteres.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">Confirma la nueva</Label>
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
                Contraseña actualizada. Te redirigimos a iniciar sesión otra vez…
              </div>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Guardando…' : 'Cambiar contraseña'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Sesiones activas</CardTitle>
              <CardDescription>
                Estas son las sesiones abiertas en tus distintos dispositivos. Si ves alguna que no
                reconoces, ciérrala.
              </CardDescription>
            </div>
            <Button variant="destructive" onClick={handleRevokeAll} disabled={busy === 'all'}>
              Cerrar todas las sesiones
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
            <p className="text-sm text-text-subtle">No tienes sesiones activas registradas.</p>
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
                        {parseUserAgent(s.userAgent)}
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-text-subtle">
                        Iniciada {relTime(s.createdAt)} · IP {s.ip ?? '—'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(s.id)}
                    disabled={busy === `rm-${s.id}`}
                    className="text-xs font-semibold text-danger-700 transition-colors hover:underline"
                  >
                    Cerrar sesión
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
                Autenticación de dos factores (MFA)
              </h3>
              <Badge variant="warning" dot>
                Recomendado
              </Badge>
            </div>
            <p className="text-sm leading-relaxed text-text-muted">
              Obligatorio para super_admin y tenant_admin. Opcional pero muy recomendado para
              alumnos y formadores — añade una capa extra contra contraseñas robadas.
            </p>
          </div>
          <Button onClick={() => setMfaOpen(true)}>
            <Icon name="lock" size={16} />
            Configurar MFA
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={mfaOpen}
        onOpenChange={(o) => {
          if (!o) setMfaOpen(false);
        }}
        ariaLabel="Configurar MFA"
        maxWidthClass="max-w-md"
        contentClassName="p-6"
      >
        <div className="mb-5">
          <h2 className="font-display text-lg font-bold tracking-tight text-text">
            Configurar segundo factor
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            Escanea el QR con tu app TOTP (Google Authenticator, 1Password, Authy) y confirma el
            código.
          </p>
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

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-ES');
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Dispositivo desconocido';
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
  if (browser && os) return `${browser} en ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 60 ? ua.slice(0, 57) + '…' : ua;
}
