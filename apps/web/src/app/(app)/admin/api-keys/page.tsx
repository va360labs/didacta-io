'use client';

/**
 * Admin · Claves API.
 *
 * Dos pestañas: las claves en sí y la documentación EN VIVO para integradores
 * (antes `/admin/integraciones/api`, una página huérfana del menú a la que solo
 * se llegaba por un enlace enterrado en esta misma cabecera).
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiDocsTab } from '@/components/admin/api-docs-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminApiKeysApi,
  API_KEY_SCOPES,
  API_KEY_SCOPE_LABELS,
  type ApiKeyScope,
  type CreatedApiKey,
  type TenantApiKey,
} from '@/lib/admin-api-keys';
import { authStorage } from '@/lib/auth-storage';

function fmtDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

const TABS = ['claves', 'docs'] as const;
type TabKey = (typeof TABS)[number];

export default function ApiKeysPage() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'claves';

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Claves API</h1>
        <p className="mt-1 text-sm text-text-muted">
          Cómo inscriben alumnos tus sistemas externos (tu página de ventas, n8n, WooCommerce…) vía{' '}
          <code>POST /api/v1/inscribe</code>.
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          router.replace(next === 'claves' ? '/admin/api-keys' : `/admin/api-keys?tab=${next}`)
        }
      >
        <TabsList>
          <TabsTrigger value="claves">Claves</TabsTrigger>
          <TabsTrigger value="docs">Documentación</TabsTrigger>
        </TabsList>

        <TabsContent value="claves" className="mt-5">
          <KeysTab />
        </TabsContent>
        <TabsContent value="docs" className="mt-5">
          <ApiDocsTab />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function KeysTab() {
  const [keys, setKeys] = useState<TenantApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [pending, setPending] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const list = await adminApiKeysApi.list(token);
      setKeys(list);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las claves API.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    const token = authStorage.getAccessToken();
    if (!token || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const created = await adminApiKeysApi.create(token, {
        name: name.trim(),
        // La integración externa necesita ambos: inscribir/dar de baja y listar
        // cursos para mapear su producto → curso.
        scopes: [...API_KEY_SCOPES],
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setCreatedKey(created);
      setName('');
      setExpiresAt('');
      setCreating(false);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos crear la clave.');
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm('¿Revocar esta clave? Las integraciones que la usen dejarán de funcionar.'))
      return;
    setError(null);
    try {
      await adminApiKeysApi.revoke(token, id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos revocar la clave.');
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          El contrato estático y público está en <code>/api/docs</code>; la pestaña
          &ldquo;Documentación&rdquo; muestra tus grupos y cursos reales con payloads listos para
          copiar.
        </p>
        {!creating ? <Button onClick={() => setCreating(true)}>Crear clave</Button> : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {createdKey ? (
        <Card className="border-success-200">
          <CardHeader>
            <CardTitle className="text-base">Clave creada: {createdKey.name}</CardTitle>
            <CardDescription>
              Cópiala ahora. Por seguridad, no se volverá a mostrar el token completo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={createdKey.token}
                readOnly
                className="flex-1 font-mono text-xs"
                aria-label="Token de la API key"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(createdKey.token);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>
              Ya la guardé
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nueva clave API</CardTitle>
            <CardDescription>
              Permisos que se otorgan:{' '}
              {API_KEY_SCOPES.map((s, i) => (
                <span key={s}>
                  {i > 0 ? ' · ' : ''}
                  <strong>{API_KEY_SCOPE_LABELS[s]}</strong>
                </span>
              ))}
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">
                Nombre <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="p.ej. Página de ventas"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-expires">Caduca (opcional)</Label>
              <Input
                id="key-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 border-t border-border-soft pt-4">
              <Button onClick={handleCreate} disabled={pending || !name.trim()}>
                {pending ? 'Creando…' : 'Crear clave'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setName('');
                  setExpiresAt('');
                }}
                disabled={pending}
              >
                Cancelar
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {keys === null ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : keys.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">
              Aún no hay claves API. Crea una para integrar tu página de ventas.
            </p>
          ) : (
            <div className="divide-y divide-border-soft">
              {keys.map((k) => {
                const revoked = Boolean(k.revokedAt);
                const expired = k.expiresAt ? new Date(k.expiresAt).getTime() < Date.now() : false;
                return (
                  <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text">{k.name}</span>
                        {revoked ? (
                          <Badge variant="danger">Revocada</Badge>
                        ) : expired ? (
                          <Badge variant="warning">Caducada</Badge>
                        ) : (
                          <Badge variant="success">Activa</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-subtle">
                        {k.scopes
                          .map((s) => API_KEY_SCOPE_LABELS[s as ApiKeyScope] ?? s)
                          .join(', ')}
                      </p>
                      <p className="mt-0.5 text-xs text-text-subtle">
                        Creada {fmtDate(k.createdAt)}
                        {k.createdByEmail ? ` por ${k.createdByEmail}` : ''} · Último uso{' '}
                        {fmtDate(k.lastUsedAt)}
                        {k.expiresAt ? ` · Caduca ${fmtDate(k.expiresAt)}` : ''}
                      </p>
                    </div>
                    {!revoked ? (
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(k.id)}>
                        Revocar
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
