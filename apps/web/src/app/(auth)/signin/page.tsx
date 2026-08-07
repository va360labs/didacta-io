/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getTranslations } from 'next-intl/server';
import { SignInForm } from './signin-form';
import { AuthHeading } from '../auth-heading';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return {
    title: t('signin.metaTitle'),
  };
}

export default async function SignInPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('signin.title')} description={t('signin.description')} />
      <SignInForm />
    </>
  );
}
