'use client';

/**
 * Panel admin · Seguridad → Política MFA tenant-wide (tercer piloto License SDK).
 *
 * Reglas:
 *   - El toggle "Requerir MFA a todos los usuarios" se gatea con `<EeGate>`
 *     usando `LICENSE_CAPABILITIES.MFA_ENFORCEMENT`. Sin licencia EE se
 *     muestra una upsell card (mismo patrón que `WhiteLabelUpsellCard`).
 *   - El backend GATEA además el PUT — la UI es solo UX. Cualquier intento de
 *     persistir sin la capability vuelve con 402 vía LicenseExceptionFilter.
 *   - El grace period es siempre editable desde la UI siempre que la
 *     capability esté activa; en plan community el card entero se reemplaza
 *     por la upsell.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { MFA_GRACE_PERIOD_OPTIONS_DAYS, mfaPolicyApi, type MfaPolicyState } from '@/lib/mfa-policy';

export default function AdminSeguridadPage() {
  const [state, setState] = useState<MfaPolicyState | null>(null);
  const [requiredForAll, setRequiredForAll] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(7);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await mfaPolicyApi.get(token);
        setState(fresh);
        setRequiredForAll(fresh.policy.requiredForAll);
        setGracePeriodDays(fresh.policy.gracePeriodDays);
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar la política MFA.');
      }
    })();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    setStatus('saving');
    setError(null);
    try {
      const updated = await mfaPolicyApi.update(token, {
        requiredForAll,
        gracePeriodDays,
      });
      setState(updated);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setStatus('error');
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No se pudo actualizar la política. Prueba nuevamente.',
      );
    }
  }

  if (!state && !error) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-3xl font-bold">Seguridad</h1>
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-48 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Seguridad</h1>
        <p className="text-text-muted">
          Política de autenticación de tu organización. Estos ajustes afectan a todos los usuarios
          del tenant.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="shield" size={18} />
            Estado actual
          </CardTitle>
          <CardDescription>
            En plan Community el MFA es obligatorio para roles administrativos (super_admin,
            tenant_admin) y opcional para el resto. La política tenant-wide te permite{' '}
            <strong>forzar MFA a todos los usuarios</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-text-muted">Plan:</span>
          {state?.licensed ? (
            <Badge variant="outline" className="border-success-200 bg-success-50 text-success-700">
              Enterprise
            </Badge>
          ) : (
            <Badge variant="outline">Community</Badge>
          )}
          <span className="text-text-muted">·</span>
          <span className="text-text-muted">Enforcement tenant-wide:</span>
          {state?.enforcementActive ? (
            <Badge className="bg-success-600 text-white">Activo</Badge>
          ) : (
            <Badge variant="outline">Inactivo</Badge>
          )}
        </CardContent>
      </Card>

      {/*
       * Política MFA — toggle + grace period. La capability EE
       * `feat:mfa.enforcement` desbloquea la sección entera. Si no hay
       * licencia, mostramos `MfaEnforcementUpsellCard`.
       */}
      <EeGate
        capability={LICENSE_CAPABILITIES.MFA_ENFORCEMENT}
        fallback={<MfaEnforcementUpsellCard />}
      >
        <Card>
          <CardHeader>
            <CardTitle>Política de MFA</CardTitle>
            <CardDescription>
              Esto afecta a TODOS los usuarios actuales del tenant (incluidos alumnos). Tienen el
              período de gracia configurado para activar MFA antes de que se les bloquee el login.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={requiredForAll}
                  onChange={(e) => setRequiredForAll(e.target.checked)}
                  className="mt-1 h-4 w-4 cursor-pointer rounded border-border text-brand-600 focus:ring-brand-300"
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-text">
                    Requerir MFA a todos los usuarios
                  </span>
                  <span className="block text-xs text-text-muted">
                    Cuando esto está activo y la licencia Enterprise sigue válida, cualquier usuario
                    sin MFA configurado fuera del período de gracia recibirá un 401 al iniciar
                    sesión y será dirigido al flujo de setup MFA.
                  </span>
                </span>
              </label>

              <div className="flex max-w-sm flex-col gap-1.5">
                <Label htmlFor="gracePeriodDays">Período de gracia (días)</Label>
                <Select
                  id="gracePeriodDays"
                  value={String(gracePeriodDays)}
                  onChange={(e) => setGracePeriodDays(Number(e.target.value))}
                >
                  {MFA_GRACE_PERIOD_OPTIONS_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d} {d === 1 ? 'día' : 'días'}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-text-subtle">
                  Aplica desde el momento en que se guarda la política. Pasado el plazo, los
                  usuarios sin MFA no pueden iniciar sesión hasta configurarlo.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={status === 'saving'}>
                  {status === 'saving' ? 'Guardando…' : 'Guardar política'}
                </Button>
                {status === 'saved' ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-700">
                    <Icon name="check" size={16} />
                    Política actualizada
                  </span>
                ) : null}
                {status === 'error' && error ? (
                  <span className="text-sm font-semibold text-danger-700">{error}</span>
                ) : null}
              </div>
            </form>

            {state?.policy.updatedAt ? (
              <p className="mt-6 text-xs text-text-subtle">
                Última actualización: {new Date(state.policy.updatedAt).toLocaleString('es-ES')}
                {state.policy.updatedBy ? ` · por ${state.policy.updatedBy}` : ''}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </EeGate>

      {error && !state ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE). Mismo patrón que
 * `WhiteLabelUpsellCard`. Recordatorio: el backend gatea la mutación con
 * @RequiresCapability — esto solo es UX.
 */
function MfaEnforcementUpsellCard() {
  return (
    <Card
      role="region"
      aria-label="Política MFA tenant-wide (Enterprise)"
      className="border-dashed"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          Forzar MFA a todos los usuarios del tenant es parte del paquete de seguridad Didacta
          Enterprise. Tu plan actual (community) ya obliga MFA a los administradores; con Enterprise
          puedes extenderlo a alumnos, formadores y managers con período de gracia configurable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:mfa.enforcement
          </code>
          . Si tu licencia Enterprise expira o se revoca, el enforcement se desactiva
          automáticamente — la configuración guardada queda inerte hasta renovar.
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
