'use client';

/**
 * Panel admin · Límites API (sexto piloto License SDK).
 *
 * Reglas:
 *   - El panel informativo es SIEMPRE visible (a diferencia del panel de
 *     dominios/branding/etc., que se ocultaba completo en community). La
 *     idea es que el admin community pueda ver "estás en X req/min" y
 *     comparar con "podrías estar en Y req/min" sin tener que hablar con
 *     ventas para pedir un demo. El endpoint backend tampoco está gateado.
 *   - El botón "Upgrade a Enterprise" SÍ va envuelto en `<EeGate>` con
 *     `negate` (se muestra solo cuando la capability NO está activa) —
 *     el patrón es inverso al resto de pilotos.
 *   - Sin licencia EE, además del badge "community" mostramos un comparativo
 *     con las cifras enterprise para hacer el upsell claro.
 *
 * Endpoint backend: `GET /api/v1/admin/rate-limit/info`. El backend impone
 * el rate limit real vía `RateLimitInterceptor` (global) — esta página solo
 * lee la configuración, no la modifica.
 */

import { useEffect, useState } from 'react';
import { LICENSE_CAPABILITIES, useLicense } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { rateLimitApi, type RateLimitInfo } from '@/lib/rate-limit';

export default function AdminRateLimitPage() {
  const [info, setInfo] = useState<RateLimitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await rateLimitApi.info(token);
        setInfo(fresh);
      } catch (e) {
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No se pudo cargar la configuración de rate limit.',
        );
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Límites API</h1>
        <p className="text-text-muted">
          Cuotas por minuto que la API aplica a tu organización. Si superas el límite recibes
          respuesta <code>429 Too Many Requests</code> con cabeceras{' '}
          <code className="font-mono">Retry-After</code> y{' '}
          <code className="font-mono">X-RateLimit-*</code>.
        </p>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-danger-700">{error}</CardContent>
        </Card>
      ) : info === null ? (
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-32 w-full" />
        </div>
      ) : (
        <RateLimitPanel info={info} />
      )}
    </div>
  );
}

/**
 * Panel con badge del tier activo + tabla de límites por bucket. Si el tier
 * efectivo es `community`, además muestra una tarjeta de upsell con la
 * comparativa enterprise.
 */
function RateLimitPanel({ info }: { info: RateLimitInfo }) {
  const isEnterprise = info.tier === 'enterprise';

  return (
    <div className="flex flex-col gap-6">
      {/* Tier activo */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="trending" size={18} />
            Plan activo
            <TierBadge tier={info.tier} />
          </CardTitle>
          <CardDescription>
            Capability asociada: <code className="font-mono text-xs">{info.capability}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Bucket</th>
                  <th className="px-4 py-2 text-left font-semibold">Límite efectivo</th>
                  <th className="px-4 py-2 text-left font-semibold">Ventana</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Endpoints autenticados</td>
                  <td className="px-4 py-3 font-mono">{info.authenticated.limit} req</td>
                  <td className="px-4 py-3 font-mono">{info.authenticated.windowSeconds}s</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Endpoints públicos</td>
                  <td className="px-4 py-3 font-mono">{info.public.limit} req</td>
                  <td className="px-4 py-3 font-mono">{info.public.windowSeconds}s</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Comparativa community vs enterprise */}
      <Card>
        <CardHeader>
          <CardTitle>Comparativa de planes</CardTitle>
          <CardDescription>
            Cifras por minuto y por tenant. Los buckets son independientes — un pico de tráfico
            público no consume tu cuota autenticada.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Bucket</th>
                  <th className="px-4 py-2 text-left font-semibold">Community</th>
                  <th className="px-4 py-2 text-left font-semibold">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Autenticados</td>
                  <td className="px-4 py-3 font-mono">{info.community.authenticated} req/min</td>
                  <td className="px-4 py-3 font-mono">{info.enterprise.authenticated} req/min</td>
                </tr>
                <tr className="border-t border-border-soft">
                  <td className="px-4 py-3">Públicos</td>
                  <td className="px-4 py-3 font-mono">{info.community.public} req/min</td>
                  <td className="px-4 py-3 font-mono">{info.enterprise.public} req/min</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {!isEnterprise ? <UpgradeCta /> : null}
    </div>
  );
}

/**
 * Badge visual del tier — verde para enterprise, gris discreto para community.
 */
function TierBadge({ tier }: { tier: RateLimitInfo['tier'] }) {
  if (tier === 'enterprise') {
    return <Badge className="bg-success-600 text-white">Enterprise</Badge>;
  }
  return <Badge variant="outline">Community</Badge>;
}

/**
 * Llamada a la acción de upgrade. Va envuelta en `<EeGate>` invertido — el
 * `fallback` es lo que se muestra cuando la capability NO está activa, es
 * decir, exactamente el botón de upsell. Cuando la capability SÍ está, no
 * renderiza nada (no tiene sentido mostrar "actualiza" a alguien que ya
 * tiene EE).
 */
function UpgradeCta() {
  // Hook puro — usamos useLicense() en lugar de <EeGate> aquí porque
  // necesitamos el comportamiento "renderizar SI NO tiene la capability"
  // (negative gate). El componente <EeGate> está pensado para el caso
  // positivo y en este piloto el patrón se invierte para el botón.
  const { isCapabilityEnabled } = useLicense();
  if (isCapabilityEnabled(LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED)) {
    return null;
  }
  return (
    <Card role="region" aria-label="Upgrade a Enterprise" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          ¿Necesitas más capacidad?
        </CardTitle>
        <CardDescription>
          El plan Enterprise multiplica los límites por ~10x. Recomendado si tu integración hace
          polling agresivo, sincroniza Fundae XML al cierre de mes o sirve un portal público con
          tráfico estacional.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
