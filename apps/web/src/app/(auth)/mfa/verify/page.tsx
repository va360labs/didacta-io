/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getTranslations } from 'next-intl/server';
import { MfaVerifyForm } from './mfa-verify-form';
import { AuthHeading } from '../../auth-heading';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('mfaVerify.metaTitle') };
}

export default async function MfaVerifyPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('mfaVerify.title')} description={t('mfaVerify.description')} />
      <MfaVerifyForm />
    </>
  );
}
