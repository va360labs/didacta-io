'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { paymentFlagsApi, parsePaymentFlagsCsv, type PaymentFlag } from '@/lib/payment-flags';

interface FormState {
  telegramId: string;
  name: string;
  isDelinquent: boolean;
  note: string;
}

const EMPTY_FORM: FormState = { telegramId: '', name: '', isDelinquent: true, note: '' };

export default function ImpagosPage() {
  const [flags, setFlags] = useState<PaymentFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Filtros.
  const [search, setSearch] = useState('');
  const [delinquentOnly, setDelinquentOnly] = useState(false);

  // Form de alta/edición. `editing` guarda el flag en edición (null = alta).
  const [editing, setEditing] = useState<PaymentFlag | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Import CSV.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  // Sólo super_admin/tenant_admin gestionan impagos. El backend ya rechaza
  // cualquier acción no autorizada — esta verificación sólo evita mostrar la
  // pantalla a quien no corresponde y dar un mensaje claro en su lugar.
  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const res = await paymentFlagsApi.list(token, {
        q: search.trim() || undefined,
        delinquentOnly: delinquentOnly || undefined,
      });
      setFlags(res);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los impagos.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters() {
    void reload();
  }

  function startEdit(flag: PaymentFlag) {
    setEditing(flag);
    setForm({
      telegramId: flag.telegramId,
      name: flag.name ?? '',
      isDelinquent: flag.isDelinquent,
      note: flag.note ?? '',
    });
    setNotice(null);
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await paymentFlagsApi.upsert(token, {
        telegramId: form.telegramId.trim(),
        name: form.name.trim() || null,
        isDelinquent: form.isDelinquent,
        note: form.note.trim() || null,
      });
      cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos guardar el registro.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(flag: PaymentFlag) {
    if (!window.confirm(`¿Eliminar el registro de "${flag.name ?? flag.telegramId}"?`)) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await paymentFlagsApi.remove(token, flag.id);
      if (editing?.id === flag.id) cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos eliminar el registro.');
    } finally {
      setPending(false);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reseteamos el input para que el mismo archivo pueda re-seleccionarse.
    e.target.value = '';
    if (!file) return;
    const token = authStorage.getAccessToken();
    if (!token) return;

    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      // Leemos el CSV en el CLIENTE (FileReader) y lo parseamos a filas. NO se
      // sube multipart: se manda el array ya parseado al endpoint /import.
      const text = await readFileAsText(file);
      const rows = parsePaymentFlagsCsv(text);
      if (rows.length === 0) {
        setError('No encontramos filas válidas en el CSV (revisá la columna user_id).');
        return;
      }
      const res = await paymentFlagsApi.import(token, rows);
      setNotice(
        `Importados ${res.imported} de ${rows.length} registro${rows.length === 1 ? '' : 's'} del CSV.`,
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos importar el CSV.');
    } finally {
      setImporting(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">
          Solo los administradores del tenant pueden gestionar los impagos.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Impagos</h1>
          <p className="mt-1 max-w-2xl text-text-muted">
            Marca miembros con cuotas pendientes por su Telegram ID. La inscripción usa estas marcas
            para bloquear o avisar a quien tenga pagos al día sin regularizar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void handleImportFile(e)}
          />
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || pending}
          >
            {importing ? 'Importando…' : 'Importar CSV'}
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
      {notice ? (
        <div className="rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-700">
          {notice}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* === Listado + filtros === */}
        <Card>
          <CardContent className="flex flex-wrap items-end gap-4 p-4">
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs font-semibold text-text-muted" htmlFor="search">
                Buscar
              </label>
              <Input
                id="search"
                type="search"
                placeholder="Telegram ID o nombre…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFilters();
                }}
                className="mt-1"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-text">
              <Switch
                checked={delinquentOnly}
                onCheckedChange={setDelinquentOnly}
                label="Solo impagos"
              />
              Solo impagos
            </label>
            <Button variant="secondary" onClick={applyFilters} className="ml-auto">
              Aplicar
            </Button>
          </CardContent>

          {flags === null ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : flags.length === 0 ? (
            <CardContent className="flex flex-col items-center gap-2 p-12 text-center">
              <h3 className="font-display text-lg font-semibold">Sin registros</h3>
              <p className="max-w-sm text-text-muted">
                No hay impagos con estos filtros. Carga un CSV o crea uno manualmente desde el
                formulario.
              </p>
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-6 py-3 font-semibold">Telegram ID</th>
                    <th className="px-3 py-3 font-semibold">Nombre</th>
                    <th className="px-3 py-3 font-semibold">Estado</th>
                    <th className="px-3 py-3 font-semibold">Nota</th>
                    <th className="px-6 py-3 font-semibold text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => (
                    <tr
                      key={f.id}
                      className="border-b border-border last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-6 py-3 font-mono text-sm tabular-nums">{f.telegramId}</td>
                      <td className="px-3 py-3">
                        {f.name ? (
                          <span className="font-semibold text-text">{f.name}</span>
                        ) : (
                          <span className="text-xs italic text-text-subtle">Sin nombre</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {f.isDelinquent ? (
                          <Badge variant="danger" dot>
                            Impago
                          </Badge>
                        ) : (
                          <Badge variant="success" dot>
                            Al día
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 max-w-[260px]">
                        {f.note ? (
                          <span className="line-clamp-2 text-sm text-text-muted">{f.note}</span>
                        ) : (
                          <span className="text-xs text-text-subtle">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(f)}
                            disabled={pending}
                          >
                            Editar
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDelete(f)}
                            disabled={pending}
                            className="text-danger-700 hover:bg-danger-50"
                          >
                            Eliminar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* === Form alta / edición === */}
        <Card>
          <CardHeader>
            <CardTitle>{editing ? 'Editar registro' : 'Nuevo registro'}</CardTitle>
            <CardDescription>
              {editing
                ? 'Modifica el estado o la nota. El Telegram ID identifica unívocamente al miembro.'
                : 'Marca manualmente a un miembro por su Telegram ID. Si ya existe, se actualiza.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="telegram-id">Telegram ID</Label>
                <Input
                  id="telegram-id"
                  value={form.telegramId}
                  onChange={(e) => setForm((s) => ({ ...s, telegramId: e.target.value }))}
                  required
                  inputMode="numeric"
                  pattern="\d+"
                  placeholder="123456789"
                  disabled={!!editing}
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="flag-name">Nombre</Label>
                <Input
                  id="flag-name"
                  value={form.name}
                  onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                  maxLength={120}
                  placeholder="Nombre visible (opcional)"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft bg-surface-2 px-3 py-2.5">
                <span className="text-sm font-medium text-text">Marcar como impago</span>
                <Switch
                  checked={form.isDelinquent}
                  onCheckedChange={(v) => setForm((s) => ({ ...s, isDelinquent: v }))}
                  label="Marcar como impago"
                />
              </label>

              <div className="space-y-1.5">
                <Label htmlFor="flag-note">Nota</Label>
                <Textarea
                  id="flag-note"
                  value={form.note}
                  onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
                  maxLength={500}
                  placeholder="Motivo, fecha del último pago, etc. (opcional)"
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    Cancelar
                  </Button>
                ) : null}
                <Button type="submit" disabled={pending || form.telegramId.trim().length === 0}>
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear registro'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Lee un File como texto (UTF-8) con la API FileReader del navegador. */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('No pudimos leer el archivo.'));
    reader.readAsText(file);
  });
}
