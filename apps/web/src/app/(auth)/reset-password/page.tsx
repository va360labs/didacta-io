/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from './reset-password-form';
import { AuthHeading } from '../auth-heading';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return {
    title: t('reset.metaTitle'),
  };
}

export default async function ResetPasswordPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('reset.title')} description={t('reset.description')} />
      <Suspense
        fallback={
          <div className="space-y-3">
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
          </div>
        }
      >
        <ResetPasswordForm />
      </Suspense>
      <div className="mt-7 h-px w-full bg-border-soft" />
      <p className="mt-5 text-center text-[0.9375rem] text-text-muted">
        {t('reset.noLinkPrompt')}{' '}
        <Link href="/forgot-password" className="font-semibold text-brand-600 hover:underline">
          {t('reset.requestNewLink')}
        </Link>
      </p>
    </>
  );
}
