'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { useTenantContext } from '@/lib/tenant-context';

interface ForgotResponse {
  ok: boolean;
  message: string;
}

export function ForgotPasswordForm() {
  const { loading: tenantLoading, tenant } = useTenantContext();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(form: FormData) {
    setError(null);
    setSuccess(null);
    setPending(true);
    try {
      const tenantSlug = tenant?.slug ?? (form.get('tenantSlug')?.toString().trim() || undefined);
      const response = await apiFetch<ForgotResponse>('/api/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ tenantSlug, email: String(form.get('email')) }),
      });
      setSuccess(response.message);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? e.message : 'No pudimos procesar tu pedido. Prueba de nuevo.',
      );
    } finally {
      setPending(false);
    }
  }

  if (success) {
    return (
      <div role="status" className="space-y-3">
        <div className="rounded-lg border border-success-200 bg-success-50 p-4">
          <h4 className="font-semibold text-success-700">Revisa tu email</h4>
          <p className="mt-1 text-sm text-text">{success}</p>
        </div>
        <p className="text-sm text-text-subtle">
          Si no aparece en pocos minutos, revisa la carpeta de spam o pide un nuevo enlace.
        </p>
      </div>
    );
  }

  if (tenantLoading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {tenant ? (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <span className="text-text-muted">Recuperas contraseña para</span>{' '}
          <strong className="text-brand-700">{tenant.name}</strong>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="tenantSlug">
            Organización <span className="text-text-subtle text-xs">(opcional)</span>
          </Label>
          <Input
            id="tenantSlug"
            name="tenantSlug"
            autoComplete="organization"
            placeholder="mi-academia"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
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
        {pending ? 'Enviando…' : 'Enviar enlace'}
      </Button>
    </form>
  );
}
