'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
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
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { paymentFlagsApi, parsePaymentFlagsCsv, type PaymentFlag } from '@/lib/payment-flags';

interface FormState {
  email: string;
  telegramId: string;
  name: string;
  isDelinquent: boolean;
  note: string;
}

const EMPTY_FORM: FormState = {
  email: '',
  telegramId: '',
  name: '',
  isDelinquent: true,
  note: '',
};

export default function ImpagosPage() {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
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
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('impagos.loadError'));
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
      email: flag.email ?? '',
      telegramId: flag.telegramId ?? '',
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
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.telegramId.trim() ? { telegramId: form.telegramId.trim() } : {}),
        name: form.name.trim() || null,
        isDelinquent: form.isDelinquent,
        note: form.note.trim() || null,
      });
      cancelEdit();
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('impagos.saveError'),
      );
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(flag: PaymentFlag) {
    const label = flag.name ?? flag.email ?? flag.telegramId ?? flag.id;
    if (!window.confirm(t('impagos.deleteConfirm', { name: label }))) return;
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
      setError(
        err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('impagos.deleteError'),
      );
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
        setError(t('impagos.csvNoRows'));
        return;
      }
      const res = await paymentFlagsApi.import(token, rows);
      setNotice(t('impagos.csvImported', { imported: res.imported, total: rows.length }));
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('impagos.importError'),
      );
    } finally {
      setImporting(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">{t('impagos.notAllowed')}</CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('impagos.title')}</h1>
          <p className="mt-1 max-w-2xl text-text-muted">{t('impagos.subtitle')}</p>
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
            {importing ? t('impagos.importingCta') : t('impagos.importCta')}
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
                {t('impagos.searchLabel')}
              </label>
              <Input
                id="search"
                type="search"
                placeholder={t('impagos.searchPh')}
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
                label={t('impagos.delinquentOnly')}
              />
              {t('impagos.delinquentOnly')}
            </label>
            <Button variant="secondary" onClick={applyFilters} className="ml-auto">
              {t('impagos.applyCta')}
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
              <h3 className="font-display text-lg font-semibold">{t('impagos.emptyTitle')}</h3>
              <p className="max-w-sm text-text-muted">{t('impagos.emptyHelp')}</p>
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-6 py-3 font-semibold">{t('impagos.colEmail')}</th>
                    <th className="px-3 py-3 font-semibold">{t('impagos.colTelegramId')}</th>
                    <th className="px-3 py-3 font-semibold">{t('impagos.colName')}</th>
                    <th className="px-3 py-3 font-semibold">{t('impagos.colStatus')}</th>
                    <th className="px-3 py-3 font-semibold">{t('impagos.colNote')}</th>
                    <th className="px-6 py-3 font-semibold text-right">
                      {t('impagos.colActions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => (
                    <tr
                      key={f.id}
                      className="border-b border-border last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-6 py-3 text-sm">
                        {f.email ?? (
                          <span className="text-xs italic text-text-subtle">
                            {t('impagos.noEmailLegacy')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-sm tabular-nums">
                        {f.telegramId ?? <span className="text-xs text-text-subtle">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        {f.name ? (
                          <span className="font-semibold text-text">{f.name}</span>
                        ) : (
                          <span className="text-xs italic text-text-subtle">
                            {t('impagos.noName')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {f.isDelinquent ? (
                          <Badge variant="danger" dot>
                            {t('impagos.delinquentBadge')}
                          </Badge>
                        ) : (
                          <Badge variant="success" dot>
                            {t('impagos.upToDateBadge')}
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
                            {t('impagos.editCta')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDelete(f)}
                            disabled={pending}
                            className="text-danger-700 hover:bg-danger-50"
                          >
                            {t('impagos.deleteCta')}
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
            <CardTitle>{editing ? t('impagos.editTitle') : t('impagos.newTitle')}</CardTitle>
            <CardDescription>
              {editing ? t('impagos.editHelp') : t('impagos.newHelp')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="flag-email">{t('impagos.emailLabel')}</Label>
                <Input
                  id="flag-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
                  placeholder={t('impagos.emailPh')}
                  disabled={!!editing && !!editing.email}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="telegram-id">
                  {t('impagos.telegramIdLabel')}{' '}
                  <span className="text-text-subtle text-xs">{t('impagos.telegramIdHint')}</span>
                </Label>
                <Input
                  id="telegram-id"
                  value={form.telegramId}
                  onChange={(e) => setForm((s) => ({ ...s, telegramId: e.target.value }))}
                  inputMode="numeric"
                  pattern="\d+"
                  placeholder={t('impagos.telegramIdPh')}
                  disabled={!!editing && !editing.email}
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="flag-name">{t('impagos.nameLabel')}</Label>
                <Input
                  id="flag-name"
                  value={form.name}
                  onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                  maxLength={120}
                  placeholder={t('impagos.namePh')}
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft bg-surface-2 px-3 py-2.5">
                <span className="text-sm font-medium text-text">{t('impagos.markDelinquent')}</span>
                <Switch
                  checked={form.isDelinquent}
                  onCheckedChange={(v) => setForm((s) => ({ ...s, isDelinquent: v }))}
                  label={t('impagos.markDelinquent')}
                />
              </label>

              <div className="space-y-1.5">
                <Label htmlFor="flag-note">{t('impagos.noteLabel')}</Label>
                <Textarea
                  id="flag-note"
                  value={form.note}
                  onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
                  maxLength={500}
                  placeholder={t('impagos.notePh')}
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    {t('impagos.cancelCta')}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    (form.email.trim().length === 0 && form.telegramId.trim().length === 0)
                  }
                >
                  {pending
                    ? t('impagos.savingCta')
                    : editing
                      ? t('impagos.saveChangesCta')
                      : t('impagos.createCta')}
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
