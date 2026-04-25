'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { learningApi, type Invitation } from '@/lib/learning';

export function InvitationsPanel({ courseId }: { courseId: string }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [justCreated, setJustCreated] = useState<Invitation | null>(null);

  async function reload() {
    try {
      const list = await learningApi.listInvitations(courseId);
      setInvitations(list);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudieron cargar invitaciones');
    }
  }

  useEffect(() => {
    void reload();
  }, [courseId]);

  async function handleCreate(form: FormData) {
    setPending(true);
    setError(null);
    setJustCreated(null);
    try {
      const maxUsesValue = form.get('maxUses');
      const expiresAtValue = form.get('expiresAt');
      const created = await learningApi.createInvitation({
        courseId,
        maxUses: maxUsesValue ? Number(maxUsesValue) : undefined,
        expiresAt: expiresAtValue ? new Date(String(expiresAtValue)).toISOString() : undefined,
      });
      setJustCreated(created);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al crear invitación');
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    setPending(true);
    setError(null);
    try {
      await learningApi.revokeInvitation(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al revocar invitación');
    } finally {
      setPending(false);
    }
  }

  async function copy(text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invitaciones</CardTitle>
        <CardDescription>
          Generá códigos para que alumnos se matriculen sin abrir auto-matriculación pública.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={handleCreate}
          className="grid gap-2 rounded-md border border-dashed border-neutral-300 p-3 sm:grid-cols-12 dark:border-neutral-700"
        >
          <div className="sm:col-span-4">
            <Label htmlFor={`maxUses-${courseId}`} className="text-xs">
              Usos máx. (vacío = ilimitado)
            </Label>
            <Input id={`maxUses-${courseId}`} name="maxUses" type="number" min={1} />
          </div>
          <div className="sm:col-span-6">
            <Label htmlFor={`expiresAt-${courseId}`} className="text-xs">
              Expira (opcional)
            </Label>
            <Input id={`expiresAt-${courseId}`} name="expiresAt" type="datetime-local" />
          </div>
          <div className="flex items-end sm:col-span-2">
            <Button type="submit" size="sm" disabled={pending} className="w-full">
              Generar
            </Button>
          </div>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        {justCreated ? (
          <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950">
            <p className="font-medium text-green-900 dark:text-green-100">
              Código generado: <code className="ml-2 font-mono">{justCreated.code}</code>
            </p>
            <p className="mt-1 text-xs text-green-800 dark:text-green-200">
              Guardalo y compartilo. El token URL para link directo:
            </p>
            <code className="mt-1 block break-all rounded bg-white p-2 text-xs dark:bg-neutral-900">
              {justCreated.token}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void copy(justCreated.code)}
            >
              Copiar código
            </Button>
          </div>
        ) : null}

        {invitations && invitations.length === 0 ? (
          <p className="text-sm text-neutral-500">No hay invitaciones activas.</p>
        ) : null}

        {invitations && invitations.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div>
                  <code className="font-mono">{inv.code}</code>
                  <span className="ml-3 text-xs text-neutral-500">
                    Usos: {inv.usedCount}
                    {inv.maxUses ? ` / ${inv.maxUses}` : ' (ilimitado)'}
                    {inv.expiresAt
                      ? ` · expira ${new Date(inv.expiresAt).toLocaleString('es-ES')}`
                      : ''}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void handleRevoke(inv.id)}>
                  Revocar
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
