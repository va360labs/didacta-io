'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { meApi, type ActiveSession } from '@/lib/me';

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-AR');
}

export default function SeguridadPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

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
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Seguridad</h1>
          <p className="mt-1 text-text-muted">
            Cambiá tu contraseña, gestioná tus sesiones activas y configurá MFA.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/cuenta">← Volver al perfil</Link>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Cambiar contraseña</CardTitle>
          <CardDescription>
            Al cambiar la contraseña se cerrarán TODAS tus sesiones. Vas a tener que iniciar sesión
            otra vez con la nueva.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                <Label htmlFor="confirmPassword">Confirmá la nueva</Label>
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
              <p className="text-sm text-success-700">
                ✓ Contraseña actualizada. Te redirigimos a iniciar sesión otra vez…
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Guardando…' : 'Cambiar contraseña'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle>Sesiones activas</CardTitle>
              <CardDescription>
                Estas son las sesiones abiertas en tus distintos dispositivos. Si ves alguna que no
                reconocés, cerrala.
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
            <p className="text-sm text-text-subtle">No tenés sesiones activas registradas.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-text-subtle truncate">
                      {s.userAgent ?? 'Dispositivo desconocido'}
                    </p>
                    <p className="text-xs text-text-muted tabular-nums">
                      iniciada {relTime(s.createdAt)} · IP {s.ip ?? '—'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(s.id)}
                    disabled={busy === `rm-${s.id}`}
                    className="text-xs font-semibold text-danger-700 hover:underline"
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
        <CardHeader>
          <CardTitle>Autenticación de dos factores (MFA)</CardTitle>
          <CardDescription>
            Para roles administrativos es obligatorio. Para alumnos y formadores es opcional pero
            recomendado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/mfa/setup">Configurar MFA</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
