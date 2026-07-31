'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
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
  const [copied, setCopied] = useState(false);

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
    setCopied(false);
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="users" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">Invitaciones</CardTitle>
            <CardDescription>
              Genera códigos para que alumnos se matriculen sin abrir auto-matriculación pública.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={handleCreate}
          className="grid gap-3 rounded-lg border border-dashed border-border-strong bg-surface-2 p-4 sm:grid-cols-12"
        >
          <div className="space-y-1.5 sm:col-span-4">
            <Label htmlFor={`maxUses-${courseId}`} className="text-xs">
              Usos máx. (vacío = ilimitado)
            </Label>
            <Input id={`maxUses-${courseId}`} name="maxUses" type="number" min={1} />
          </div>
          <div className="space-y-1.5 sm:col-span-6">
            <Label htmlFor={`expiresAt-${courseId}`} className="text-xs">
              Expira (opcional)
            </Label>
            <Input id={`expiresAt-${courseId}`} name="expiresAt" type="datetime-local" />
          </div>
          <div className="flex items-end sm:col-span-2">
            <Button type="submit" size="sm" disabled={pending} className="w-full">
              <Icon name="plus" size={14} />
              Generar
            </Button>
          </div>
        </form>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}

        {justCreated ? (
          <div
            className="rounded-lg p-4 text-sm"
            style={{
              background: 'var(--didacta-success-bg)',
              color: 'var(--didacta-success-fg)',
            }}
          >
            <div className="flex items-center gap-2">
              <Icon name="check" size={16} />
              <p className="font-semibold">Código generado</p>
            </div>
            <p className="mt-2 font-mono text-base font-bold tracking-wider">{justCreated.code}</p>
            <p className="mt-2 text-xs opacity-80">Token URL para link directo:</p>
            <code className="mt-1 block break-all rounded-md bg-white p-2 text-xs text-text">
              {justCreated.token}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void copy(justCreated.code)}
            >
              {copied ? '✓ Copiado' : 'Copiar código'}
            </Button>
          </div>
        ) : null}

        {invitations && invitations.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-sm text-text-subtle">
            No hay invitaciones activas.
          </p>
        ) : null}

        {invitations && invitations.length > 0 ? (
          <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
            {invitations.map((inv) => {
              const expired = inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now();
              const exhausted = inv.maxUses && inv.usedCount >= inv.maxUses;
              return (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm font-semibold text-text">{inv.code}</code>
                      {expired ? <Badge variant="muted">Expirada</Badge> : null}
                      {exhausted ? <Badge variant="muted">Agotada</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-text-subtle">
                      Usos: {inv.usedCount}
                      {inv.maxUses ? ` / ${inv.maxUses}` : ' (ilimitado)'}
                      {inv.expiresAt
                        ? ` · expira ${new Date(inv.expiresAt).toLocaleString('es-ES')}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(inv.code)}
                      aria-label="Copiar código"
                    >
                      Copiar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void handleRevoke(inv.id)}>
                      Revocar
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
