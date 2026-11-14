/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/** Idiomas con texto propio en los correos (los del aula). */
export type SaleEmailLang = 'es' | 'en' | 'pt';
export const SALE_EMAIL_LANGS: readonly SaleEmailLang[] = ['es', 'en', 'pt'];

export type SaleEmailKey =
  | 'purchase.receipt'
  | 'purchase.renewal_receipt'
  | 'purchase.payment_failed'
  | 'purchase.refund';

export type SaleEmailVariable =
  | 'name'
  | 'product'
  | 'amount'
  | 'order'
  | 'date'
  | 'academy'
  | 'email'
  | 'nextDate'
  | 'deadline';

export interface SaleEmailText {
  subject: string;
  body: string;
}

export interface SaleEmailTemplate {
  key: SaleEmailKey;
  variables: SaleEmailVariable[];
  defaults: Record<SaleEmailLang, SaleEmailText>;
  overrides: Partial<
    Record<SaleEmailLang, { subject: string | null; body: string; updatedAt: string }>
  >;
}

export interface SaleEmailsState {
  templates: SaleEmailTemplate[];
  /** Cómo se escribe cada dato en cada idioma («nombre», «name», «nome»…). */
  tokens: Record<SaleEmailLang, Record<SaleEmailVariable, string>>;
  settings: { refundPolicyUrl: string | null };
  academyLocale: SaleEmailLang;
}

export interface SaleEmailPreview {
  subject: string;
  html: string;
  text: string;
}

function token(): string {
  const t = authStorage.getAccessToken();
  if (!t)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return t;
}

const base = '/api/v1/admin/sale-emails';
const path = (key: SaleEmailKey, lang: SaleEmailLang) =>
  `${base}/${encodeURIComponent(key)}/${lang}`;

/** Correos de venta y acceso que el aula personaliza (`/admin/sale-emails`). */
export const saleEmailsApi = {
  list(): Promise<SaleEmailsState> {
    return apiFetch<SaleEmailsState>(base, { method: 'GET' }, token());
  },
  save(key: SaleEmailKey, lang: SaleEmailLang, text: SaleEmailText): Promise<SaleEmailText> {
    return apiFetch<SaleEmailText>(
      path(key, lang),
      { method: 'PUT', body: JSON.stringify(text) },
      token(),
    );
  },
  reset(key: SaleEmailKey, lang: SaleEmailLang): Promise<{ reset: true }> {
    return apiFetch<{ reset: true }>(path(key, lang), { method: 'DELETE' }, token());
  },
  preview(
    key: SaleEmailKey,
    lang: SaleEmailLang,
    draft: Partial<SaleEmailText> | null,
  ): Promise<SaleEmailPreview> {
    return apiFetch<SaleEmailPreview>(
      `${path(key, lang)}/preview`,
      { method: 'POST', body: JSON.stringify(draft ?? {}) },
      token(),
    );
  },
  test(
    key: SaleEmailKey,
    lang: SaleEmailLang,
    draft: Partial<SaleEmailText> | null,
  ): Promise<{ ok: true; sentTo: string }> {
    return apiFetch<{ ok: true; sentTo: string }>(
      `${path(key, lang)}/test`,
      { method: 'POST', body: JSON.stringify(draft ?? {}) },
      token(),
    );
  },
  saveSettings(settings: {
    refundPolicyUrl: string | null;
  }): Promise<{ refundPolicyUrl: string | null }> {
    return apiFetch<{ refundPolicyUrl: string | null }>(
      `${base}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
      token(),
    );
  },
};
