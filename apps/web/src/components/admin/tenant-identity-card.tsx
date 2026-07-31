'use client';

/**
 * Tarjeta de identidad del tenant en `/admin/configuracion`. Permite al
 * super_admin renombrar la organización (campo `tenant.name`) desde la UI
 * sin tocar curl. Consume el endpoint `PATCH /api/v1/admin/tenants/:id`
 * (alpha.77, super_admin-only) y el `GET /api/v1/admin/tenants/:id` para
 * cargar el valor inicial.
 *
 * Decisiones:
 *  - Resolvemos el tenant actual via `session.tenantId` + `getOne(id)` en
 *    lugar de `list()[0]`: super_admin puede tener varios tenants y el
 *    primero de la lista (orden por createdAt) no es necesariamente el
 *    suyo. La sesión guarda el `tenantId` real del JWT.
 *  - El botón "Guardar" queda disabled si el valor no cambió o está vacío
 *    (validación de Zod en backend igualmente cubre).
 *  - Tras un guardado exitoso programamos `window.location.reload()` con
 *    1 s de delay para que sidebar/header (que tienen el nombre cacheado
 *    en `session.tenantSlug` / claims) muestren el valor nuevo.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  adminTenantsApi as defaultAdminTenantsApi,
  type TenantListItem,
} from '@/lib/admin-tenants';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage as defaultAuthStorage } from '@/lib/auth-storage';

export const MAX_TENANT_NAME_LEN = 120;
const MAX_NAME_LEN = MAX_TENANT_NAME_LEN;

/**
 * Decide si el botón "Guardar" debe estar habilitado para un nombre dado.
 * Extraído para testear sin DOM (no usamos RTL en `apps/web/src/*`, ver
 * `smtp-settings-card.test.ts`).
 *
 * Reglas:
 *  - Si el tenant aún no se cargó → false (no hay baseline a comparar).
 *  - Si está guardando ahora → false (evita doble submit).
 *  - Si el nombre trimmed iguala al actual → false (no hay cambio).
 *  - Si el nombre trimmed está vacío → false (backend valida min(1)).
 *  - Si excede MAX_TENANT_NAME_LEN → false (backend valida max(120)).
 *  - En cualquier otro caso → true.
 */
export function canSaveTenantName(args: {
  currentName: string | null;
  draftName: string;
  saving: boolean;
}): boolean {
  if (args.currentName === null) return false;
  if (args.saving) return false;
  const trimmed = args.draftName.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_TENANT_NAME_LEN) return false;
  if (trimmed === args.currentName) return false;
  return true;
}

interface ToastState {
  variant: 'success' | 'error';
  message: string;
}

export interface TenantIdentityCardProps {
  /** Inyectable para tests: por defecto usa `adminTenantsApi` real. */
  api?: typeof defaultAdminTenantsApi;
  /** Inyectable para tests: por defecto usa `authStorage` real (sessionStorage). */
  authStorage?: typeof defaultAuthStorage;
  /**
   * Si está set, lo invocamos en vez de `window.location.reload()` tras
   * guardar. Pensado para tests, no para prod.
   */
  onAfterSave?: (newName: string) => void;
}

export function TenantIdentityCard({
  api = defaultAdminTenantsApi,
  authStorage = defaultAuthStorage,
  onAfterSave,
}: TenantIdentityCardProps = {}): React.JSX.Element {
  const [tenant, setTenant] = useState<TenantListItem | null>(null);
  const [name, setName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Carga inicial del tenant actual usando session.tenantId del JWT.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = authStorage.getSession();
      const token = authStorage.getAccessToken();
      if (!session || !token) {
        if (!cancelled) {
          setLoadError('Sesión expirada. Inicia sesión otra vez para configurar la organización.');
        }
        return;
      }
      try {
        const dto = await api.getOne(token, session.user.tenantId);
        if (cancelled) return;
        setTenant(dto);
        setName(dto.name);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiHttpError
            ? err.message
            : 'No pudimos cargar la organización. Refresca la página.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, authStorage]);

  const trimmedName = name.trim();
  const isTooLong = trimmedName.length > MAX_NAME_LEN;
  const canSave = canSaveTenantName({
    currentName: tenant?.name ?? null,
    draftName: name,
    saving,
  });

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!tenant || !canSave) return;
    const token = authStorage.getAccessToken();
    if (!token) {
      setToast({ variant: 'error', message: 'Sesión expirada. Inicia sesión otra vez.' });
      return;
    }
    setSaving(true);
    setToast(null);
    try {
      const updated = await api.rename(token, tenant.id, trimmedName);
      setTenant(updated);
      setName(updated.name);
      setToast({
        variant: 'success',
        message: `Nombre actualizado. Los próximos emails usarán "${updated.name}".`,
      });
      // Refrescamos otros lugares (sidebar, header) que pueden tener el
      // nombre cacheado de la sesión previa. 1 s para que el operador
      // alcance a leer el toast antes del reload.
      if (onAfterSave) {
        onAfterSave(updated.name);
      } else if (typeof window !== 'undefined') {
        setTimeout(() => window.location.reload(), 1000);
      }
    } catch (err) {
      setToast({
        variant: 'error',
        message:
          err instanceof ApiHttpError ? err.message : 'No pudimos actualizar el nombre del tenant.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identidad de la organización</CardTitle>
        <CardDescription>
          El nombre aparece en los emails enviados desde tu plataforma (ej. &quot;Equipo
          {tenant ? ` ${tenant.name}` : ' {nombre}'}&quot;) y en el header del panel admin.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {loadError}
          </div>
        ) : tenant === null ? (
          <div className="space-y-2">
            <div className="skeleton h-5 w-48" />
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-9 w-32" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" aria-busy={saving}>
            <div className="space-y-1.5">
              <Label htmlFor="tenant-name">Nombre de la organización</Label>
              <Input
                id="tenant-name"
                required
                minLength={1}
                maxLength={MAX_NAME_LEN}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mi Academia"
              />
              <p className="text-xs text-text-subtle">
                Ej: &quot;Mi Academia&quot;, &quot;Mi Centro de Formación&quot;, &quot;Acme Corp
                Training&quot;.
              </p>
              {isTooLong ? (
                <p className="text-xs text-danger-700">
                  Máximo {MAX_NAME_LEN} caracteres ({trimmedName.length} actuales).
                </p>
              ) : null}
            </div>

            {toast ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="tenant-identity-toast"
                className={
                  'rounded-md border p-3 text-sm ' +
                  (toast.variant === 'success'
                    ? 'border-success-200 bg-success-50 text-success-700'
                    : 'border-danger-100 bg-danger-50 text-danger-700')
                }
              >
                {toast.message}
              </div>
            ) : null}

            <div className="flex justify-end border-t border-border-soft pt-4">
              <Button type="submit" disabled={!canSave}>
                {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
