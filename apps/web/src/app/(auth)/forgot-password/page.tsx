/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from './forgot-password-form';
import { AuthHeading } from '../auth-heading';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return {
    title: t('forgot.metaTitle'),
  };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('forgot.title')} description={t('forgot.description')} />
      <ForgotPasswordForm />
      <div className="mt-7 h-px w-full bg-border-soft" />
      <p className="mt-5 text-center text-[0.9375rem] text-text-muted">
        {t('forgot.rememberedPrompt')}{' '}
        <Link href="/signin" className="font-semibold text-brand-600 hover:underline">
          {t('forgot.backToSignin')}
        </Link>
      </p>
    </>
  );
}
