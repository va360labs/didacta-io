'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { fundaeApi, type ActionStatus, type FundaeAction, type Modalidad } from '@/modules/fundae';

const STATUS_VARIANT: Record<ActionStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  ACTIVE: 'success',
  DRAFT: 'warning',
  CLOSED: 'muted',
  ARCHIVED: 'muted',
};

const STATUS_LABEL: Record<ActionStatus, string> = {
  ACTIVE: 'Activa',
  DRAFT: 'Borrador',
  CLOSED: 'Cerrada',
  ARCHIVED: 'Archivada',
};

const MODALIDAD_LABEL: Record<Modalidad, string> = {
  PRESENCIAL: 'Presencial',
  TELEFORMACION: 'Teleformación',
  MIXTA: 'Mixta',
};

export default function FundaePage() {
  const [actions, setActions] = useState<FundaeAction[] | null>(null);
  // Por acción: número si la API contestó OK, 'error' si falló, undefined si
  // todavía no se resolvió. Permite distinguir "0 participantes reales" de
  // "no pudimos consultar" en el badge.
  const [participantCounts, setParticipantCounts] = useState<Record<string, number | 'error'>>({});
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setError(null);
      const list = await fundaeApi.list();
      setActions(list);
      const withCourse = list.filter((a) => a.courseId);
      const entries = await Promise.all(
        withCourse.map(async (a) => {
          try {
            const { total } = await fundaeApi.countParticipants(a.id);
            return [a.id, total] as const;
          } catch {
            return [a.id, 'error' as const] as const;
          }
        }),
      );
      setParticipantCounts(Object.fromEntries(entries));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las acciones.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleArchive(id: string, codigo: string) {
    if (
      !confirm(`¿Archivar la acción "${codigo}"? La fila se preserva pero deja de aparecer activa.`)
    )
      return;
    try {
      await fundaeApi.archive(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos archivar.');
    }
  }

  async function handleExport(action: FundaeAction) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(fundaeApi.exportXmlUrl(action.id), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fundae-${action.codigoAccion}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos descargar el XML.');
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Fundae</h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Acciones formativas para presentar a la fundación. Cada acción puede vincularse a un
            curso del catálogo y exportarse como XML para subida manual al sistema oficial.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild type="button" variant="secondary">
            <Link href="/admin/fundae/empresas">
              <Icon name="building" size={14} />
              Empresas bonificadas
            </Link>
          </Button>
          <Button type="button" onClick={() => setShowForm((v) => !v)}>
            <Icon name="plus" size={16} />
            {showForm ? 'Cerrar' : 'Nueva acción'}
          </Button>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <CreateActionForm
          onCreated={async () => {
            setShowForm(false);
            await reload();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {actions === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : actions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="file" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Sin acciones formativas</h3>
            <p className="max-w-md text-text-muted">
              Empieza creando tu primera acción Fundae. Una vez creada, podrás generar el XML para
              presentar a la fundación.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {actions.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
                  style={{
                    background: 'var(--didacta-info-bg)',
                    color: 'var(--didacta-info-fg)',
                  }}
                >
                  <Icon name="file" size={22} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-text">
                      {a.codigoAccion}
                    </code>
                    <Badge variant={STATUS_VARIANT[a.status]} dot>
                      {STATUS_LABEL[a.status]}
                    </Badge>
                    <Badge variant="muted">{MODALIDAD_LABEL[a.modalidad]}</Badge>
                    {a.courseId ? (
                      participantCounts[a.id] === 'error' ? (
                        <Badge variant="warning" title="No pudimos cargar el contador">
                          <Icon name="users" size={12} />— participantes
                        </Badge>
                      ) : (
                        <Badge variant="info">
                          <Icon name="users" size={12} />
                          {participantCounts[a.id] ?? '…'} participantes
                        </Badge>
                      )
                    ) : null}
                  </div>
                  <p className="font-display text-base font-semibold leading-tight text-text">
                    {a.nombre}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    {a.fechaInicio} → {a.fechaFin} · {a.horasFormacion} h
                    {a.lugar ? ` · ${a.lugar}` : ''}
                  </p>
                  {a.notas ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{a.notas}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/admin/fundae/${a.id}` as never}>Ver bloques</Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => handleExport(a)}
                  >
                    <Icon name="file" size={13} />
                    Descargar XML
                  </Button>
                  {a.status !== 'ARCHIVED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleArchive(a.id, a.codigoAccion)}
                    >
                      <Icon name="trash" size={13} />
                      Archivar
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateActionForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      await fundaeApi.create({
        codigoAccion: String(form.get('codigoAccion') ?? '').trim(),
        nombre: String(form.get('nombre') ?? '').trim(),
        modalidad: form.get('modalidad') as Modalidad,
        horasFormacion: Number(form.get('horasFormacion') ?? 0),
        fechaInicio: String(form.get('fechaInicio') ?? ''),
        fechaFin: String(form.get('fechaFin') ?? ''),
        lugar: form.get('lugar') ? String(form.get('lugar')) : undefined,
        cifCentro: form.get('cifCentro') ? String(form.get('cifCentro')) : undefined,
        notas: form.get('notas') ? String(form.get('notas')) : undefined,
        courseId: form.get('courseId') ? String(form.get('courseId')) : undefined,
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos crear la acción.');
    } finally {
      setPending(false);
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
            <Icon name="plus" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle>Nueva acción formativa</CardTitle>
            <CardDescription>
              Datos requeridos por Fundae para presentar la acción. El código tiene que ser único
              dentro del tenant.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="codigoAccion">
                Código de acción <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="codigoAccion"
                name="codigoAccion"
                required
                maxLength={25}
                placeholder="Ej: AF-2026-001"
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="modalidad">
                Modalidad <span className="text-danger-700">*</span>
              </Label>
              <Select id="modalidad" name="modalidad" required defaultValue="TELEFORMACION">
                <option value="PRESENCIAL">Presencial</option>
                <option value="TELEFORMACION">Teleformación</option>
                <option value="MIXTA">Mixta</option>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nombre">
              Nombre <span className="text-danger-700">*</span>
            </Label>
            <Input id="nombre" name="nombre" required maxLength={200} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="fechaInicio">
                Fecha inicio <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaInicio" name="fechaInicio" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaFin">
                Fecha fin <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaFin" name="fechaFin" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="horasFormacion">
                Horas <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="horasFormacion"
                name="horasFormacion"
                type="number"
                step="0.5"
                min={0.5}
                max={9999}
                required
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lugar">Lugar</Label>
              <Input id="lugar" name="lugar" maxLength={200} placeholder="Ej: On-line" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cifCentro">CIF/NIF del centro</Label>
              <Input id="cifCentro" name="cifCentro" maxLength={20} className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="courseId">UUID del curso vinculado (opcional)</Label>
            <Input id="courseId" name="courseId" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notas">Notas internas (no van al XML)</Label>
            <Textarea id="notas" name="notas" rows={2} maxLength={2000} />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creando…' : 'Crear acción'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
