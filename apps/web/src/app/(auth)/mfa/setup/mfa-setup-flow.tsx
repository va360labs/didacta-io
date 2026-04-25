'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

interface SetupResponse {
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

interface EnableResponse {
  enabled: boolean;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

export function MfaSetupFlow() {
  const router = useRouter();
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let aborted = false;
    async function loadSetup() {
      try {
        const access = authStorage.getAccessToken();
        if (!access) {
          router.replace('/signin');
          return;
        }
        const response = await apiFetch<SetupResponse>(
          '/api/v1/auth/mfa/setup',
          { method: 'POST', body: '{}' },
          access,
        );
        if (!aborted) setSetup(response);
      } catch (e) {
        if (!aborted) {
          setError(e instanceof ApiHttpError ? e.message : 'No se pudo iniciar setup');
        }
      }
    }
    void loadSetup();
    return () => {
      aborted = true;
    };
  }, [router]);

  async function onConfirm(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const access = authStorage.getAccessToken();
      if (!access) {
        router.replace('/signin');
        return;
      }
      const response = await apiFetch<EnableResponse>(
        '/api/v1/auth/mfa/enable',
        { method: 'POST', body: JSON.stringify({ code: String(form.get('code')) }) },
        access,
      );
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      router.push('/');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo confirmar el código');
    } finally {
      setPending(false);
    }
  }

  if (error && !setup) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }

  if (!setup) {
    return <p className="text-sm text-neutral-500">Generando código…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3">
        <Image
          src={setup.qrCodeDataUrl}
          alt="QR de configuración TOTP"
          width={192}
          height={192}
          unoptimized
          className="rounded-md border border-neutral-200 dark:border-neutral-800"
        />
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">URL otpauth (manual)</summary>
          <code className="mt-2 block break-all rounded bg-neutral-100 p-2 dark:bg-neutral-800">
            {setup.otpauthUrl}
          </code>
        </details>
      </div>

      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">Guardá estos recovery codes en un lugar seguro.</p>
        <p className="mt-1">Cada uno funciona una sola vez si perdés el acceso a tu app TOTP.</p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
          {setup.recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      <form action={onConfirm} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="code">Código de la app</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            required
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Verificando…' : 'Confirmar y activar MFA'}
        </Button>
      </form>
    </div>
  );
}
