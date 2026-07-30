'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div role="alert" className="rounded-lg border border-danger-100 bg-danger-50 p-4">
        <h4 className="font-semibold text-danger-700">Falta el token</h4>
        <p className="mt-1 text-sm text-text">
          Este enlace no es válido. Pide uno nuevo desde la pantalla de recuperación.
        </p>
      </div>
    );
  }

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);

    const newPassword = String(form.get('newPassword'));
    const confirm = String(form.get('confirm'));

    if (newPassword !== confirm) {
      setError('Las contraseñas no coinciden.');
      setPending(false);
      return;
    }
    if (newPassword.length < 12) {
      setError('La contraseña debe tener al menos 12 caracteres.');
      setPending(false);
      return;
    }

    try {
      await apiFetch<{ ok: boolean; message: string }>('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      setDone(true);
      // Redirige a signin tras un momento corto para que el usuario lea el feedback.
      setTimeout(() => router.push('/signin'), 2000);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos actualizar tu contraseña. Prueba de nuevo o pide un nuevo enlace.',
      );
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-lg border border-success-200 bg-success-50 p-4">
        <h4 className="font-semibold text-success-700">¡Listo!</h4>
        <p className="mt-1 text-sm text-text">
          Tu contraseña fue actualizada. Te redirigimos a iniciar sesión…
        </p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="newPassword">Nueva contraseña</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-12"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">Confirma la contraseña</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-12"
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} size="lg" className="h-13 w-full">
        {pending ? 'Actualizando…' : 'Guardar nueva contraseña'}
      </Button>
    </form>
  );
}
