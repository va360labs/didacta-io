'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { useTenantContext } from '@/lib/tenant-context';

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

export function SignUpForm() {
  const router = useRouter();
  const { loading: tenantLoading, tenant } = useTenantContext();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const tenantSlug = tenant?.slug ?? (form.get('tenantSlug')?.toString().trim() || undefined);
      const response = await apiFetch<AuthResponse>('/api/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug,
          email: String(form.get('email')),
          password: String(form.get('password')),
          name: form.get('name') ? String(form.get('name')) : undefined,
        }),
      });
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      authStorage.saveSession({ user: response.user, mfaRequired: response.mfaRequired });
      router.push(response.mfaRequired ? '/mfa/setup' : '/');
    } catch (e) {
      if (e instanceof ApiHttpError) setError(e.message);
      else setError('No pudimos crear tu cuenta. Probá de nuevo en unos segundos.');
    } finally {
      setPending(false);
    }
  }

  if (tenantLoading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {tenant ? (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <span className="text-text-muted">Te registras en</span>{' '}
          <strong className="text-brand-700">{tenant.name}</strong>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="tenantSlug">
            Organización <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="tenantSlug"
            name="tenantSlug"
            autoComplete="organization"
            placeholder="va360"
            required
          />
          <p className="text-xs text-text-subtle">
            Pidele a tu admin el nombre corto de tu organización.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="name">Nombre completo</Label>
        <Input id="name" name="name" autoComplete="name" placeholder="María Pérez" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">
          Email <span className="text-danger-700">*</span>
        </Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">
          Contraseña <span className="text-danger-700">*</span>
        </Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className="text-xs text-text-subtle">
          Mínimo 12 caracteres. Mezclá mayúsculas, minúsculas, números y un símbolo.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full" size="lg">
        {pending ? 'Creando tu cuenta…' : 'Crear cuenta'}
      </Button>
    </form>
  );
}
