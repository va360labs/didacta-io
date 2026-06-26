'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { invalidateCommunitySpacesCache } from '@/modules/community';
import { buildOidcStartUrl, buildWpSsoTryUrl, fetchOidcStatus, fetchWpSsoStatus } from '@/lib/sso';
import { useTenantContext } from '@/lib/tenant-context';
import { requestThemeRefresh } from '@/lib/theming';

interface AuthResponse {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  mfaRequired: boolean;
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl?: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
    mustChangePassword?: boolean;
    onboardingCompletedAt?: string | null;
  };
}

interface AmbiguousTenantError {
  code: 'AMBIGUOUS_TENANT';
  candidateSlugs: string[];
  message: string;
}

export function SignInForm() {
  const router = useRouter();
  const { loading: tenantLoading, tenant } = useTenantContext();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tenantCandidates, setTenantCandidates] = useState<string[] | null>(null);
  // 8º piloto License SDK (`feat:sso.oidc`): si el tenant resuelto por host
  // tiene SSO OIDC habilitado, mostramos un botón "Iniciar sesión con SSO"
  // arriba del form clásico. Sin tenant resuelto NO mostramos el botón —
  // requiere conocer el slug para construir el endpoint /auth/oidc/:slug/start.
  const [ssoEnabled, setSsoEnabled] = useState<boolean>(false);
  // mod.wp-sso: auto-bounce TRANSPARENTE a WordPress (VA360.academy). Si hay
  // sesión WP, el usuario vuelve autenticado sin tocar este form.
  const [wpBouncing, setWpBouncing] = useState<boolean>(false);
  const [wpLoginRequired, setWpLoginRequired] = useState<boolean>(false);

  useEffect(() => {
    if (!tenant?.slug) {
      setSsoEnabled(false);
      return;
    }
    let aborted = false;
    void fetchOidcStatus(tenant.slug).then((res) => {
      if (!aborted) setSsoEnabled(res.enabled);
    });
    return () => {
      aborted = true;
    };
  }, [tenant?.slug]);

  // Auto-bounce a WordPress: si WP-SSO está configurado con auto-redirect y no
  // hay sesión Didacta, rebotamos al WP en modo `try` (silencioso). El plugin,
  // si no hay sesión WP, nos devuelve con ?wp_sso=login_required y mostramos el
  // form clásico. El flag de sessionStorage evita bucles de redirect.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const wpSso = params.get('wp_sso');
    if (wpSso) {
      sessionStorage.setItem('wp_sso_attempted', '1');
      if (wpSso === 'login_required') setWpLoginRequired(true);
      return;
    }
    if (!tenant?.slug) return; // necesitamos el slug del tenant para el status/bounce
    if (authStorage.getAccessToken()) return; // ya hay sesión Didacta
    if (sessionStorage.getItem('wp_sso_attempted')) return; // ya lo intentamos

    let aborted = false;
    void fetchWpSsoStatus(tenant.slug).then((s) => {
      if (aborted) return;
      if (s.configured && s.autoRedirect && s.wordpressUrl) {
        sessionStorage.setItem('wp_sso_attempted', '1');
        setWpBouncing(true);
        window.location.href = buildWpSsoTryUrl(s.wordpressUrl);
      }
    });
    return () => {
      aborted = true;
    };
  }, [tenant?.slug]);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    try {
      const tenantSlug = tenant?.slug ?? (form.get('tenantSlug')?.toString().trim() || undefined);
      const response = await apiFetch<AuthResponse>('/api/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug,
          email: String(form.get('email')),
          password: String(form.get('password')),
        }),
      });
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      authStorage.saveSession({ user: response.user, mfaRequired: response.mfaRequired });
      // Arranca el sidebar de espacios desde cero con el token ya válido (evita
      // arrastrar un cache vacío o de otro tenant entre navegaciones SPA).
      invalidateCommunitySpacesCache();
      // El TenantThemeProvider (root layout) no se re-monta en la navegación SPA
      // post-login, así que pedimos que recoja el branding (logo) ahora mismo.
      requestThemeRefresh();
      if (response.mfaRequired) {
        router.push(response.user.mfaEnabled ? '/mfa/verify' : '/mfa/setup');
      } else if (response.user.onboardingCompletedAt === null) {
        // Usuario que aún no completó el onboarding de primera vez.
        router.push('/onboarding');
      } else {
        router.push('/');
      }
    } catch (e) {
      if (e instanceof ApiHttpError) {
        // Caso especial: el email pertenece a varios tenants → mostrar selector.
        const issuesAny = (e as { issues?: unknown }).issues as AmbiguousTenantError | undefined;
        if (issuesAny && (issuesAny as { candidateSlugs?: string[] }).candidateSlugs) {
          setTenantCandidates((issuesAny as { candidateSlugs: string[] }).candidateSlugs);
          setError('Tu email pertenece a más de una organización. Elige cuál quieres usar:');
        } else {
          setError(e.message);
        }
      } else {
        setError('No pudimos completar el ingreso. Prueba de nuevo en unos segundos.');
      }
    } finally {
      setPending(false);
    }
  }

  // Rebotando a VA360.academy (WordPress) para SSO transparente.
  if (wpBouncing) {
    return (
      <div className="flex items-center gap-3 py-4">
        <div className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
        <p className="text-sm text-text-muted">Conectando con VA360.academy…</p>
      </div>
    );
  }

  // Estado de carga inicial (evita flash de campo "Organización" innecesario).
  if (tenantLoading) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Volvimos de WordPress sin sesión activa: explicamos por qué ven el form. */}
      {wpLoginRequired ? (
        <div className="rounded-lg border border-border-soft bg-surface-2 p-3 text-sm text-text-muted">
          No detectamos una sesión activa en VA360.academy. Inicia sesión aquí con tu email y
          contraseña.
        </div>
      ) : null}

      {/* Botón SSO — solo si el tenant resuelto tiene OIDC habilitado.
          Se renderiza ARRIBA del form clásico para que sea la opción
          preferida en tenants enterprise. */}
      {ssoEnabled && tenant ? (
        <div className="space-y-3">
          <a
            href={buildOidcStartUrl(tenant.slug)}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface text-sm font-semibold transition-colors hover:bg-surface-2"
          >
            <span aria-hidden="true">🔐</span>
            Iniciar sesión con SSO
          </a>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border-soft" />
            <span className="text-xs uppercase tracking-wide text-text-subtle">
              o con tu contraseña
            </span>
            <div className="h-px flex-1 bg-border-soft" />
          </div>
        </div>
      ) : null}

      <form action={onSubmit} className="space-y-4">
        {/* El tenant se identifica por el dominio (o por el email en el backend);
          el form solo pide email y contraseña. El logo del tenant va en el header.
          NO mostramos ni el campo "Organización" ni un banner de tenant. */}
        {tenantCandidates && tenantCandidates.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="tenantSlugSelect">Elige tu organización</Label>
            <select
              id="tenantSlugSelect"
              name="tenantSlug"
              required
              className="flex h-10 w-full rounded-lg bg-surface px-3.5 py-2 pr-9 text-[0.9375rem] text-text border border-border-strong"
            >
              {tenantCandidates.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="email">
            Email <span className="text-danger-700">*</span>
          </Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">
              Contraseña <span className="text-danger-700">*</span>
            </Label>
            <Link
              href="/forgot-password"
              className="text-xs font-semibold text-brand-700 hover:underline"
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
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full" size="lg">
          {pending ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </div>
  );
}
