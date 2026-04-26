'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

interface AuthResponse {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  mfaRequired: boolean;
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const response = await apiFetch<AuthResponse>('/api/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug: String(form.get('tenantSlug')),
          email: String(form.get('email')),
          password: String(form.get('password')),
        }),
      });
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      authStorage.saveSession({ user: response.user, mfaRequired: response.mfaRequired });
      if (response.mfaRequired) {
        router.push(response.user.mfaEnabled ? '/mfa/verify' : '/mfa/setup');
      } else {
        router.push('/');
      }
    } catch (e) {
      if (e instanceof ApiHttpError) {
        setError(e.message);
      } else {
        setError('Error inesperado al iniciar sesión.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="tenantSlug">Tenant</Label>
        <Input
          id="tenantSlug"
          name="tenantSlug"
          autoComplete="organization"
          placeholder="va360"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Contraseña</Label>
          <Link
            href="/forgot-password"
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            ¿Olvidaste tu contraseña?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
