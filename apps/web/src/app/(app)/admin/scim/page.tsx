'use client';

/**
 * Panel admin · SCIM Provisioning (séptimo piloto License SDK).
 *
 * Reglas:
 *   - El panel completo va envuelto en `<EeGate>` con `LICENSE_CAPABILITIES.SCIM`.
 *     Sin licencia EE se muestra el upsell card (mismo patrón que white-label,
 *     custom-domains y mfa-enforcement).
 *   - El backend GATEA además todos los endpoints (token CRUD + /scim/v2/*) —
 *     esta página solo es UX. Sin la capability cualquier llamada vuelve con
 *     402 vía LicenseExceptionFilter.
 *
 * Flujo end-to-end del admin:
 *   1. Genera token nuevo → modal muestra el token plano UNA SOLA VEZ.
 *   2. Admin lo copia y lo pega en el panel del IdP (Okta, Azure AD, etc.).
 *   3. El IdP empieza a hacer requests a /scim/v2/Users con ese Bearer.
 *   4. Si el admin pierde el token o quiere rotarlo: revocar + crear nuevo.
 */

import { useEffect, useState } from 'react';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { scimTokenApi, type ScimTokenCreated, type ScimTokenStatus } from '@/lib/scim';

export default function AdminScimPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">SCIM Provisioning</h1>
        <p className="text-text-muted">
          Permite a tu IdP (Okta, Azure AD, Auth0, Google Workspace) crear, actualizar y desactivar
          usuarios automáticamente en Didacta — sin que tu equipo tenga que mantener listas
          duplicadas.
        </p>
      </header>

      <EeGate capability={LICENSE_CAPABILITIES.SCIM} fallback={<ScimUpsellCard />}>
        <ScimPanel />
      </EeGate>
    </div>
  );
}

/**
 * Panel principal — solo se renderiza cuando la capability está activa.
 */
function ScimPanel() {
  const [status, setStatus] = useState<ScimTokenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ScimTokenCreated | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await scimTokenApi.status(token);
        setStatus(fresh);
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar el estado SCIM.');
      }
    })();
  }, []);

  async function refresh() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const fresh = await scimTokenApi.status(token);
      setStatus(fresh);
    } catch {
      // El último error ya se muestra; mantenemos estado anterior.
    }
  }

  async function handleCreate() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      status?.active &&
      !window.confirm(
        '¿Generar un token nuevo? El token actual quedará revocado y el IdP recibirá 401 hasta que pegues el nuevo.',
      )
    ) {
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const created = await scimTokenApi.create(token);
      setRevealed(created);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo generar el token. Reintentá.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      !window.confirm(
        '¿Revocar el token SCIM? El IdP recibirá 401 inmediatamente y dejará de provisionar usuarios.',
      )
    ) {
      return;
    }
    setRevoking(true);
    setActionError(null);
    try {
      await scimTokenApi.revoke(token);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo revocar el token. Reintentá.',
      );
    } finally {
      setRevoking(false);
    }
  }

  if (status === null && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Estado actual */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="lock" size={18} />
            Token de provisioning
            <ScimStatusBadge active={status?.active ?? false} />
          </CardTitle>
          <CardDescription>
            El IdP envía este token como <code className="font-mono">Authorization: Bearer …</code>{' '}
            en cada request a <code className="font-mono">/scim/v2/Users</code>. Per-tenant.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status?.active ? (
            <div className="rounded-lg border border-border-soft bg-surface-2 p-4 text-sm">
              <p>
                Token activo: <code className="font-mono">{status.prefix}…</code>
              </p>
              <p className="text-text-muted">
                Creado {new Date(status.createdAt).toLocaleString('es-ES')}
                {status.lastUsedAt
                  ? ` · usado por última vez ${new Date(status.lastUsedAt).toLocaleString('es-ES')}`
                  : ' · aún no usado por el IdP'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              Aún no has generado un token SCIM. Generá uno para que el IdP empiece a provisionar.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={handleCreate} disabled={creating}>
              {creating ? 'Generando…' : status?.active ? 'Rotar token' : 'Generar token'}
            </Button>
            {status?.active ? (
              <Button type="button" variant="ghost" onClick={handleRevoke} disabled={revoking}>
                {revoking ? 'Revocando…' : 'Revocar'}
              </Button>
            ) : null}
          </div>

          {actionError ? <p className="text-sm text-danger-700">{actionError}</p> : null}
        </CardContent>
      </Card>

      {/* Token revelado (UNA SOLA VEZ) */}
      {revealed ? <RevealedTokenCard reveal={revealed} onClose={() => setRevealed(null)} /> : null}

      {/* URL del endpoint SCIM */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="code" size={18} />
            Endpoint SCIM
          </CardTitle>
          <CardDescription>
            Configurá esta URL en el panel SCIM del IdP. Per-tenant — el token resuelve la
            organización.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm">
            {typeof window !== 'undefined' ? `${window.location.origin}/scim/v2` : '/scim/v2'}
          </code>
        </CardContent>
      </Card>

      {/* Instrucciones de configuración */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="help" size={18} />
            Configurar tu IdP
          </CardTitle>
          <CardDescription>
            Pasos genéricos que aplican a Okta / Azure AD / Auth0 / Google Workspace. Los nombres de
            campos pueden variar levemente entre IdPs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">1. Crear app SCIM en el IdP</p>
            <p className="text-text-muted">
              En el catálogo de aplicaciones del IdP, buscá &ldquo;SCIM 2.0&rdquo; o creá una app
              custom con &ldquo;SCIM Provisioning&rdquo; activado.
            </p>
          </div>
          <div>
            <p className="font-semibold">2. Configurar la URL del endpoint</p>
            <p className="text-text-muted">
              Pegá la URL de la sección anterior en el campo{' '}
              <code className="font-mono">SCIM Connector base URL</code> (Okta) /{' '}
              <code className="font-mono">Tenant URL</code> (Azure AD) / similar.
            </p>
          </div>
          <div>
            <p className="font-semibold">3. Configurar el token</p>
            <p className="text-text-muted">
              Pegá el token generado más arriba en el campo{' '}
              <code className="font-mono">OAuth Bearer Token</code> /{' '}
              <code className="font-mono">Secret Token</code>. Marcá el método de auth como{' '}
              <strong>Bearer</strong>.
            </p>
          </div>
          <div>
            <p className="font-semibold">4. Mapear atributos</p>
            <p className="text-text-muted">
              Mapeá <code className="font-mono">userName</code> al email del usuario,{' '}
              <code className="font-mono">name.givenName</code> y{' '}
              <code className="font-mono">name.familyName</code> a los campos de nombre, y{' '}
              <code className="font-mono">active</code> al campo de estado del usuario en el IdP.
            </p>
          </div>
          <div>
            <p className="font-semibold">5. Probar conexión</p>
            <p className="text-text-muted">
              El IdP suele tener un botón &ldquo;Test Connection&rdquo; — al pulsarlo hace un{' '}
              <code className="font-mono">GET /scim/v2/ServiceProviderConfig</code>. Si responde
              200, listo.
            </p>
          </div>
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-warning-800">
            <p className="font-semibold">Nota: solo Users en este piloto</p>
            <p className="text-xs">
              Groups (sincronización de grupos) NO está soportado todavía — los IdPs lo intentarán y
              recibirán <code className="font-mono">501 Not Implemented</code> o{' '}
              <code className="font-mono">404</code>. Las asignaciones de roles las seguís haciendo
              desde <a href="/admin/usuarios">Usuarios</a>.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ScimStatusBadge({ active }: { active: boolean }) {
  if (active) return <Badge className="bg-success-600 text-white">Activo</Badge>;
  return <Badge variant="outline">Sin token</Badge>;
}

/**
 * Modal-card que muestra el token plano UNA SOLA VEZ. Diseñado para ser
 * intrusivo: el usuario debe pulsar &ldquo;Ya lo copié&rdquo; para hacerlo
 * desaparecer.
 */
function RevealedTokenCard({ reveal, onClose }: { reveal: ScimTokenCreated; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(reveal.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin clipboard API (browser viejo / iframe) → mostramos el token igual,
      // el usuario lo selecciona a mano.
    }
  }

  return (
    <Card
      role="region"
      aria-label="Token SCIM recién generado"
      className="border-warning-300 bg-warning-50"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-warning-900">
          <Icon name="lock" size={18} />
          Token generado — copialo AHORA
        </CardTitle>
        <CardDescription className="text-warning-800">{reveal.warning}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block break-all rounded border border-warning-300 bg-surface px-3 py-2 font-mono text-sm">
          {reveal.token}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={handleCopy}>
            {copied ? '¡Copiado!' : 'Copiar al portapapeles'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Ya lo copié, cerrar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE).
 */
export function ScimUpsellCard() {
  return (
    <Card role="region" aria-label="SCIM Provisioning (Enterprise)" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          SCIM 2.0 (System for Cross-domain Identity Management) es parte del paquete Didacta
          Enterprise. Permite que tu IdP (Okta, Azure AD, Auth0, Google Workspace) cree, actualice y
          desactive usuarios en Didacta automáticamente — sin que tu equipo tenga que mantener
          listas duplicadas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">feat:scim</code>.
          Sin Enterprise, los endpoints <code className="font-mono">/scim/v2/Users</code> devuelven{' '}
          <code className="font-mono">402 Payment Required</code> y los IdPs no pueden provisionar.
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
