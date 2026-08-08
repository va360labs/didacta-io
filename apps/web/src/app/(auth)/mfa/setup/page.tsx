/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getTranslations } from 'next-intl/server';
import { MfaSetupFlow } from '@/components/mfa-setup-flow';
import { AuthHeading } from '../../auth-heading';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('mfaSetup.metaTitle') };
}

export default async function MfaSetupPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <AuthHeading title={t('mfaSetup.title')} description={t('mfaSetup.description')} />
      <MfaSetupFlow />
    </>
  );
}
