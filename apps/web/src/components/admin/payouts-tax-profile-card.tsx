'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Tus datos fiscales» (Administración → Cobros, solo en modo plataforma).
 *
 * Lo que necesita la factura de nuestra comisión y lo que nos pide Hacienda
 * (DAC7): nombre o razón social, NIF, dirección y, si eres persona física, tu
 * fecha de nacimiento. Lo que Stripe ya sabe viene escrito; el NIF hay que
 * ponerlo (Stripe no nos deja leerlo). El NIF nunca vuelve entero: se enseña
 * «•••• 678Z» y solo se escribe si cambia.
 *
 * Mientras falten, las ventas se cobran igual pero no se transfieren (el
 * dinero queda a salvo y sale solo al completarlos).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { labelOr } from '@/lib/i18n/labels';
import {
  countryOptions,
  payoutsApi,
  taxProfileFieldErrors,
  type PayoutsTaxEntityType,
  type PayoutsTaxProfileDto,
} from '@/lib/payouts';

/** Países de residencia fiscal posibles: los que admite el cobro de plataforma. */
export const TAX_COUNTRIES = [
  'ES',
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'SE',
  'NO',
  'LI',
  'GB',
  'CH',
  'US',
  'CA',
] as const;

const EU = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

interface FormState {
  entityType: PayoutsTaxEntityType;
  legalName: string;
  country: string;
  taxId: string;
  vatId: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  region: string;
  birthDate: string;
}

/** Del DTO al formulario (perfil guardado o, si no hay, lo que propone Stripe). Puro. */
export function formFromDto(dto: PayoutsTaxProfileDto): FormState {
  const source = dto.profile ?? dto.prefill;
  const address = source?.address ?? null;
  return {
    entityType: source?.entityType ?? 'individual',
    legalName: source?.legalName ?? '',
    country: source?.country ?? 'ES',
    taxId: '',
    vatId: '',
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    postalCode: address?.postalCode ?? '',
    city: address?.city ?? '',
    region: address?.region ?? '',
    birthDate: source?.birthDate ?? '',
  };
}

export interface PayoutsTaxProfileCardProps {
  api?: Pick<typeof payoutsApi, 'taxProfile' | 'saveTaxProfile'>;
  /** Avisa cuando se guardan (para recargar «Tus ventas»). */
  onSaved?: () => void;
}

export function PayoutsTaxProfileCard({
  api = payoutsApi,
  onSaved,
}: PayoutsTaxProfileCardProps): React.JSX.Element | null {
  const t = useTranslations('adminPagos.payouts.tax');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [dto, setDto] = useState<PayoutsTaxProfileDto | null | undefined>(undefined);
  const [form, setForm] = useState<FormState | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.taxProfile();
      setDto(next);
      if (next) {
        setForm(formFromDto(next));
        setEditing(next.status !== 'complete');
      }
    } catch (err) {
      setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('loadError'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const countries = useMemo(
    () => countryOptions([...TAX_COUNTRIES], locale).filter((c) => c.supported),
    [locale],
  );

  if (dto === null) return null;
  if (dto === undefined || !form) {
    return error ? (
      <p role="alert" className="text-sm text-danger-700">
        {error}
      </p>
    ) : null;
  }

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const fieldError = (field: string) =>
    fieldErrors[field]
      ? labelOr(t, `fieldErrors.${fieldErrors[field]}`, t('fieldErrors.invalid'))
      : null;
  const isEu = EU.has(form.country);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      const next = await api.saveTaxProfile({
        entityType: form.entityType,
        legalName: form.legalName,
        country: form.country,
        ...(form.taxId.trim() ? { taxId: form.taxId.trim() } : {}),
        ...(isEu && form.vatId.trim() ? { vatId: form.vatId.trim() } : {}),
        ...(!isEu ? { vatId: '' } : {}),
        address: {
          line1: form.line1,
          line2: form.line2 || null,
          postalCode: form.postalCode,
          city: form.city,
          region: form.region || null,
        },
        birthDate: form.entityType === 'individual' ? form.birthDate || null : null,
      });
      setDto(next);
      setForm(formFromDto(next));
      setEditing(next.status !== 'complete');
      setSaved(true);
      onSaved?.();
    } catch (err) {
      if (err instanceof ApiHttpError && err.code === 'PAYOUTS_TAX_PROFILE_INVALID') {
        setFieldErrors(taxProfileFieldErrors(err.detail));
      }
      setError(err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  const status = dto.status;
  const profile = dto.profile;

  return (
    <Card data-testid="payouts-tax-profile" data-status={status}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-lg">{t('title')}</CardTitle>
          <Badge variant={status === 'complete' ? 'success' : 'warning'}>
            {t(`status.${status}`)}
          </Badge>
        </div>
        <CardDescription className="max-w-2xl">{t('intro')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status !== 'complete' && dto.required ? (
          <p
            role="status"
            className="rounded-lg border border-warning-200 bg-warning-50 p-3.5 text-[0.9375rem] leading-relaxed text-warning-700"
          >
            {dto.heldSales > 0 ? t('heldNotice', { count: dto.heldSales }) : t('requiredNotice')}
          </p>
        ) : null}
        {saved && status === 'complete' ? (
          <p
            role="status"
            className="rounded-lg border border-success-200 bg-success-50 p-3.5 text-sm text-success-700"
          >
            {t('savedComplete')}
          </p>
        ) : null}

        {!editing && profile ? (
          <div className="space-y-3">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">{t('legalNameLabel')}</dt>
                <dd className="font-medium text-text">{profile.legalName}</dd>
              </div>
              <div>
                <dt className="text-text-muted">{t('taxIdLabel')}</dt>
                <dd className="font-medium text-text">
                  {profile.taxIdHint ? `•••• ${profile.taxIdHint}` : '—'}
                </dd>
              </div>
              {profile.vatIdHint ? (
                <div>
                  <dt className="text-text-muted">{t('vatIdLabel')}</dt>
                  <dd className="font-medium text-text">
                    {`•••• ${profile.vatIdHint}`}{' '}
                    <span className="text-xs text-text-muted">
                      {labelOr(t, `vatStatus.${profile.vatStatus}`, '')}
                    </span>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-text-muted">{t('addressLabel')}</dt>
                <dd className="font-medium text-text">
                  {[profile.address?.line1, profile.address?.postalCode, profile.address?.city]
                    .filter(Boolean)
                    .join(', ')}
                </dd>
              </div>
            </dl>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            {dto.status === 'missing' && dto.prefill?.legalName ? (
              <p className="text-sm text-text-muted">{t('prefillNote')}</p>
            ) : null}
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-sm font-medium text-text">{t('entityLabel')}</legend>
              <div className="flex flex-col gap-2 sm:flex-row">
                {(['individual', 'company'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border-strong px-3 py-2 text-[0.9375rem] has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
                  >
                    <input
                      type="radio"
                      name="tax-entity"
                      value={value}
                      checked={form.entityType === value}
                      onChange={() => set({ entityType: value })}
                    />
                    {t(`entity.${value}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="tax-legal-name"
                label={form.entityType === 'company' ? t('companyNameLabel') : t('personNameLabel')}
                error={fieldError('legalName')}
              >
                <Input
                  id="tax-legal-name"
                  value={form.legalName}
                  autoComplete="name"
                  onChange={(e) => set({ legalName: e.target.value })}
                />
              </Field>
              <Field id="tax-country" label={t('countryLabel')} error={fieldError('country')}>
                <NativeSelect
                  id="tax-country"
                  value={form.country}
                  onChange={(e) => set({ country: e.target.value })}
                >
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                id="tax-id"
                label={t('taxIdLabel')}
                hint={
                  profile?.taxIdHint
                    ? t('taxIdSavedHint', { hint: profile.taxIdHint })
                    : form.country === 'ES'
                      ? t('taxIdHintEs')
                      : t('taxIdHintOther')
                }
                error={fieldError('taxId')}
              >
                <Input
                  id="tax-id"
                  value={form.taxId}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set({ taxId: e.target.value })}
                />
              </Field>
              {isEu ? (
                <Field
                  id="tax-vat-id"
                  label={t('vatIdOptionalLabel')}
                  hint={
                    profile?.vatIdHint
                      ? t('vatIdSavedHint', { hint: profile.vatIdHint })
                      : form.country === 'ES'
                        ? t('vatIdHintEs')
                        : t('vatIdHintEu')
                  }
                  error={fieldError('vatId')}
                >
                  <Input
                    id="tax-vat-id"
                    value={form.vatId}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => set({ vatId: e.target.value })}
                  />
                </Field>
              ) : null}
              <Field id="tax-line1" label={t('line1Label')} error={fieldError('address.line1')}>
                <Input
                  id="tax-line1"
                  value={form.line1}
                  autoComplete="address-line1"
                  onChange={(e) => set({ line1: e.target.value })}
                />
              </Field>
              <Field id="tax-line2" label={t('line2Label')}>
                <Input
                  id="tax-line2"
                  value={form.line2}
                  autoComplete="address-line2"
                  onChange={(e) => set({ line2: e.target.value })}
                />
              </Field>
              <Field
                id="tax-postal"
                label={t('postalCodeLabel')}
                error={fieldError('address.postalCode')}
              >
                <Input
                  id="tax-postal"
                  value={form.postalCode}
                  autoComplete="postal-code"
                  onChange={(e) => set({ postalCode: e.target.value })}
                />
              </Field>
              <Field id="tax-city" label={t('cityLabel')} error={fieldError('address.city')}>
                <Input
                  id="tax-city"
                  value={form.city}
                  autoComplete="address-level2"
                  onChange={(e) => set({ city: e.target.value })}
                />
              </Field>
              <Field id="tax-region" label={t('regionLabel')}>
                <Input
                  id="tax-region"
                  value={form.region}
                  autoComplete="address-level1"
                  onChange={(e) => set({ region: e.target.value })}
                />
              </Field>
              {form.entityType === 'individual' ? (
                <Field
                  id="tax-birth"
                  label={t('birthDateLabel')}
                  hint={t('birthDateHint')}
                  error={fieldError('birthDate')}
                >
                  <Input
                    id="tax-birth"
                    type="date"
                    value={form.birthDate}
                    autoComplete="bday"
                    onChange={(e) => set({ birthDate: e.target.value })}
                  />
                </Field>
              ) : null}
            </div>
            <p className="text-xs text-text-muted">{t('privacyNote')}</p>
            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? t('saving') : t('save')}
              </Button>
              {status === 'complete' ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setForm(formFromDto(dto));
                    setEditing(false);
                  }}
                >
                  {t('cancel')}
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | null;
  error?: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-danger-700" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
