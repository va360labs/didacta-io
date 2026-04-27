'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import {
  certificateTemplatesApi,
  type CertificateTemplate,
  type CertificateTemplateInput,
} from '@/lib/certificates';

const EMPTY: CertificateTemplateInput = {
  name: '',
  body: 'Certifica que ha completado satisfactoriamente el curso indicado, cumpliendo con los criterios de finalización establecidos.',
  primaryColor: '#0f172a',
  logoUrl: '',
  signerName: '',
  signerTitle: '',
  isDefault: false,
};

export default function CertificateTemplatesPage() {
  const [items, setItems] = useState<CertificateTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CertificateTemplate | null>(null);
  const [draft, setDraft] = useState<CertificateTemplateInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setItems(await certificateTemplatesApi.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las plantillas.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startCreate() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function startEdit(t: CertificateTemplate) {
    setEditing(t);
    setDraft({
      name: t.name,
      body: t.body,
      primaryColor: t.primaryColor,
      logoUrl: t.logoUrl ?? '',
      signerName: t.signerName ?? '',
      signerTitle: t.signerTitle ?? '',
      isDefault: t.isDefault,
    });
    setShowForm(true);
  }

  function cancel() {
    setShowForm(false);
    setEditing(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: CertificateTemplateInput = {
        ...draft,
        logoUrl: draft.logoUrl ? draft.logoUrl : null,
        signerName: draft.signerName || null,
        signerTitle: draft.signerTitle || null,
      };
      if (editing) {
        await certificateTemplatesApi.update(editing.id, payload);
      } else {
        await certificateTemplatesApi.create(payload);
      }
      setShowForm(false);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la plantilla.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefault(t: CertificateTemplate) {
    setBusy(true);
    try {
      await certificateTemplatesApi.setDefault(t.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos marcarla como default.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(t: CertificateTemplate) {
    if (!confirm(`¿Eliminar la plantilla "${t.name}"?`)) return;
    setBusy(true);
    try {
      await certificateTemplatesApi.remove(t.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar la plantilla.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Plantillas de certificado
          </h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Personalizá el certificado que reciben tus alumnos. La plantilla marcada como{' '}
            <strong>default</strong> se usa para cualquier curso que no tenga una asignada.
          </p>
        </div>
        <Button type="button" onClick={startCreate} disabled={showForm}>
          + Nueva plantilla
        </Button>
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
        <Card>
          <CardHeader>
            <CardTitle>{editing ? 'Editar plantilla' : 'Nueva plantilla'}</CardTitle>
            <CardDescription>
              Soporta variables en el cuerpo:{' '}
              <code className="font-mono text-xs">{'{{alumno}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{curso}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{fecha}}'}</code>,{' '}
              <code className="font-mono text-xs">{'{{numero}}'}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-name">Nombre interno</Label>
                <Input
                  id="tpl-name"
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Ej. Default VA360, Plantilla Fundae 2026"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">Cuerpo</Label>
                <Textarea
                  id="tpl-body"
                  required
                  rows={4}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-color">Color principal (hex)</Label>
                <Input
                  id="tpl-color"
                  required
                  pattern="^#[0-9a-fA-F]{6}$"
                  value={draft.primaryColor ?? '#0f172a'}
                  onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })}
                  placeholder="#0f172a"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-logo">Logo URL (opcional)</Label>
                <Input
                  id="tpl-logo"
                  type="url"
                  value={draft.logoUrl ?? ''}
                  onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-signer">Firmante (nombre)</Label>
                <Input
                  id="tpl-signer"
                  value={draft.signerName ?? ''}
                  onChange={(e) => setDraft({ ...draft, signerName: e.target.value })}
                  placeholder="Ej. Valentín Ayesa"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-signer-title">Firmante (cargo)</Label>
                <Input
                  id="tpl-signer-title"
                  value={draft.signerTitle ?? ''}
                  onChange={(e) => setDraft({ ...draft, signerTitle: e.target.value })}
                  placeholder="Director de formación"
                />
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.isDefault ?? false}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                Marcar como plantilla default del tenant (desmarca la actual)
              </label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy}>
                  {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear plantilla'}
                </Button>
                <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {items === null ? (
        <div className="space-y-2">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-text-muted">
            Aún no creaste ninguna plantilla. La primera que marques como default se aplicará a
            todos los cursos del tenant.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{t.name}</h3>
                    {t.isDefault ? <Badge variant="success">Default</Badge> : null}
                  </div>
                  <p className="line-clamp-2 text-sm text-text-muted">{t.body}</p>
                  <p className="text-xs text-text-subtle">
                    Color{' '}
                    <span
                      aria-hidden="true"
                      className="ml-1 inline-block h-3 w-3 rounded-full align-middle ring-1 ring-border"
                      style={{ backgroundColor: t.primaryColor }}
                    />{' '}
                    <span className="font-mono">{t.primaryColor}</span>
                    {t.signerName ? <> · firma {t.signerName}</> : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!t.isDefault ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleSetDefault(t)}
                      disabled={busy}
                    >
                      Marcar default
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => startEdit(t)}
                    disabled={busy}
                  >
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleDelete(t)}
                    disabled={busy || t.isDefault}
                    title={t.isDefault ? 'No se puede eliminar la plantilla default.' : undefined}
                  >
                    Eliminar
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
