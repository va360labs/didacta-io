'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { consumeIntendedPath } from '@/lib/post-login-redirect';

interface VerifyResponse {
  verified: boolean;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

export function MfaVerifyForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const access = authStorage.getAccessToken();
      if (!access) {
        router.replace('/signin');
        return;
      }
      const response = await apiFetch<VerifyResponse>(
        '/api/v1/auth/mfa/verify',
        { method: 'POST', body: JSON.stringify({ code: String(form.get('code')) }) },
        access,
      );
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      // Deep link pendiente de antes del login (enlace compartido) → volvemos ahí.
      router.push(consumeIntendedPath() ?? '/');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Código incorrecto');
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">Código</Label>
        <Input
          id="code"
          name="code"
          inputMode="text"
          minLength={6}
          maxLength={10}
          placeholder="123456 o recovery code"
          required
          autoFocus
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Verificando…' : 'Verificar'}
      </Button>
    </form>
  );
}
