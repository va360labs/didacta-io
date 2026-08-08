'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  fundaeCompaniesApi,
  formatCents,
  type CreateCompanyInput,
  type FundaeCompany,
  type UpdateCompanyInput,
} from '@/modules/fundae';

/**
 * Vista admin de empresas bonificadas Fundae (LMS-79).
 * Lista + búsqueda + alta + edición inline de razón social/plantilla/crédito
 * + soft-delete con confirmación. El NIF no es editable: si una empresa
 * cambia de NIF hay que crear otra para preservar trazabilidad histórica
 * de grupos cerrados.
 */
export default function FundaeEmpresasPage() {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [companies, setCompanies] = useState<FundaeCompany[] | null>(null);
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FundaeCompany | null>(null);

  async function reload(searchOverride?: string) {
    try {
      setError(null);
      const list = await fundaeCompaniesApi.list({
        search: (searchOverride ?? search).trim() || undefined,
        includeDeleted,
      });
      setCompanies(list);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted]);

  async function handleDelete(c: FundaeCompany) {
    if (!confirm(t('companies.deleteConfirm', { razonSocial: c.razonSocial, nif: c.nif }))) {
      return;
    }
    try {
      await fundaeCompaniesApi.remove(c.id);
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('companies.title')}</h1>
          <p className="mt-1 max-w-3xl text-text-muted">{t('companies.description')}</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setEditing(null);
            setShowForm((v) => !v);
          }}
        >
          <Icon name="plus" size={16} />
          {showForm ? t('shared.close') : t('companies.newCompany')}
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1 space-y-1.5">
          <Label htmlFor="search">{t('companies.searchLabel')}</Label>
          <Input
            id="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void reload();
            }}
            placeholder={t('companies.searchPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="includeDeleted" className="cursor-pointer">
            <input
              id="includeDeleted"
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
              className="mr-2"
            />
            {t('companies.includeDeleted')}
          </Label>
        </div>
        <Button type="button" variant="secondary" onClick={() => void reload()}>
          <Icon name="search" size={14} />
          {t('companies.search')}
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm || editing ? (
        <CompanyForm
          editing={editing}
          onSaved={async () => {
            setShowForm(false);
            setEditing(null);
            await reload();
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      ) : null}

      {companies === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : companies.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">{t('companies.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('companies.emptyDescription')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {companies.map((c) => (
            <Card key={c.id} className={c.deletedAt ? 'opacity-60' : undefined}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-text">{c.nif}</code>
                    {c.deletedAt ? (
                      <Badge variant="muted">{t('companies.deletedBadge')}</Badge>
                    ) : null}
                    {c.cccPrincipal ? (
                      <Badge variant="info">
                        {t('companies.cccBadge', { ccc: c.cccPrincipal })}
                      </Badge>
                    ) : null}
                    {c.plantilla !== null ? (
                      <Badge variant="muted">
                        {t('companies.employeesBadge', { count: String(c.plantilla) })}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="font-display text-base font-semibold leading-tight text-text">
                    {c.razonSocial}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    {t('companies.creditSummary', {
                      total: formatCents(c.creditoTotalCents),
                      used: formatCents(c.creditoUsadoCents),
                    })}
                    {c.creditoDisponibleCents !== null ? (
                      <>
                        {' · '}
                        <span className="font-semibold text-text">
                          {t('companies.creditAvailable', {
                            available: formatCents(c.creditoDisponibleCents),
                          })}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {c.datosContacto?.contactoEmail || c.datosContacto?.ciudad ? (
                    <p className="text-xs text-text-subtle">
                      {[c.datosContacto?.contactoNombre, c.datosContacto?.contactoEmail]
                        .filter(Boolean)
                        .join(' · ')}
                      {c.datosContacto?.ciudad ? ` · ${c.datosContacto.ciudad}` : ''}
                    </p>
                  ) : null}
                  {c.notas ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{c.notas}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/admin/fundae/empresas/${c.id}` as never}>
                      {t('companies.detailLink')}
                    </Link>
                  </Button>
                  {!c.deletedAt ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowForm(false);
                          setEditing(c);
                        }}
                      >
                        <Icon name="edit" size={13} />
                        {t('companies.edit')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleDelete(c)}
                      >
                        <Icon name="trash" size={13} />
                        {t('companies.delete')}
                      </Button>
                    </>
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

function CompanyForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: FundaeCompany | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('adminFundae');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = editing !== null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const creditoEur = Number(form.get('creditoEur') ?? 0);
      const plantillaRaw = form.get('plantilla')?.toString() ?? '';
      const cccRaw = form.get('cccPrincipal')?.toString().trim() ?? '';
      const datosContacto = {
        contactoNombre: form.get('contactoNombre')?.toString().trim() || undefined,
        contactoEmail: form.get('contactoEmail')?.toString().trim() || undefined,
        contactoTelefono: form.get('contactoTelefono')?.toString().trim() || undefined,
        direccion: form.get('direccion')?.toString().trim() || undefined,
        ciudad: form.get('ciudad')?.toString().trim() || undefined,
        codigoPostal: form.get('codigoPostal')?.toString().trim() || undefined,
        provincia: form.get('provincia')?.toString().trim() || undefined,
      };

      if (isEdit && editing) {
        const dto: UpdateCompanyInput = {
          razonSocial: form.get('razonSocial')?.toString().trim() || undefined,
          cccPrincipal: cccRaw || null,
          plantilla: plantillaRaw === '' ? null : Number(plantillaRaw),
          creditoTotalCents: creditoEur > 0 ? Math.round(creditoEur * 100) : null,
          datosContacto,
          notas: form.get('notas')?.toString() || null,
        };
        await fundaeCompaniesApi.update(editing.id, dto);
      } else {
        const dto: CreateCompanyInput = {
          nif: form.get('nif')?.toString() ?? '',
          razonSocial: form.get('razonSocial')?.toString().trim() ?? '',
          cccPrincipal: cccRaw || undefined,
          plantilla: plantillaRaw === '' ? undefined : Number(plantillaRaw),
          creditoTotalCents: creditoEur > 0 ? Math.round(creditoEur * 100) : undefined,
          datosContacto,
          notas: form.get('notas')?.toString() || undefined,
        };
        await fundaeCompaniesApi.create(dto);
      }
      await onSaved();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {isEdit
            ? t('companies.editTitle', { razonSocial: editing!.razonSocial })
            : t('companies.createTitle')}
        </CardTitle>
        <CardDescription>
          {isEdit ? t('companies.editDescription') : t('companies.createDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nif">
                {t('companies.nifLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="nif"
                name="nif"
                required={!isEdit}
                disabled={isEdit}
                defaultValue={editing?.nif}
                maxLength={20}
                className="font-mono uppercase"
                placeholder={t('companies.nifPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="razonSocial">
                {t('companies.razonSocialLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="razonSocial"
                name="razonSocial"
                required
                defaultValue={editing?.razonSocial}
                maxLength={200}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cccPrincipal">{t('companies.cccLabel')}</Label>
              <Input
                id="cccPrincipal"
                name="cccPrincipal"
                defaultValue={editing?.cccPrincipal ?? ''}
                maxLength={15}
                placeholder={t('companies.cccPlaceholder')}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plantilla">{t('companies.plantillaLabel')}</Label>
              <Input
                id="plantilla"
                name="plantilla"
                type="number"
                min={0}
                defaultValue={editing?.plantilla ?? ''}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="creditoEur">{t('companies.creditLabel')}</Label>
              <Input
                id="creditoEur"
                name="creditoEur"
                type="number"
                step="0.01"
                min={0}
                defaultValue={
                  editing?.creditoTotalCents !== null && editing?.creditoTotalCents !== undefined
                    ? (editing.creditoTotalCents / 100).toFixed(2)
                    : ''
                }
                placeholder={t('companies.creditPlaceholder')}
              />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border-soft p-4">
            <legend className="px-1 text-sm font-semibold text-text-muted">
              {t('companies.contactLegend')}
            </legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="contactoNombre">{t('companies.contactNameLabel')}</Label>
                <Input
                  id="contactoNombre"
                  name="contactoNombre"
                  defaultValue={editing?.datosContacto?.contactoNombre ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactoEmail">{t('companies.contactEmailLabel')}</Label>
                <Input
                  id="contactoEmail"
                  name="contactoEmail"
                  type="email"
                  defaultValue={editing?.datosContacto?.contactoEmail ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactoTelefono">{t('companies.contactPhoneLabel')}</Label>
                <Input
                  id="contactoTelefono"
                  name="contactoTelefono"
                  defaultValue={editing?.datosContacto?.contactoTelefono ?? ''}
                  maxLength={40}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="direccion">{t('companies.addressLabel')}</Label>
                <Input
                  id="direccion"
                  name="direccion"
                  defaultValue={editing?.datosContacto?.direccion ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ciudad">{t('companies.cityLabel')}</Label>
                <Input
                  id="ciudad"
                  name="ciudad"
                  defaultValue={editing?.datosContacto?.ciudad ?? ''}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="codigoPostal">{t('companies.postalCodeLabel')}</Label>
                <Input
                  id="codigoPostal"
                  name="codigoPostal"
                  defaultValue={editing?.datosContacto?.codigoPostal ?? ''}
                  maxLength={5}
                  pattern="\d{5}"
                />
              </div>
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="notas">{t('companies.notesLabel')}</Label>
            <Textarea
              id="notas"
              name="notas"
              rows={2}
              maxLength={2000}
              defaultValue={editing?.notas ?? ''}
            />
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
              {pending
                ? t('companies.saving')
                : isEdit
                  ? t('companies.saveChanges')
                  : t('companies.createCompany')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              {t('shared.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
