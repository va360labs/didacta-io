'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { labelOr } from '@/lib/i18n/labels';

export function OidcErrorContent() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const reason = params.get('reason') ?? 'internal';
  // El `reason` viene de la URL (string abierto): las razones documentadas en
  // page.tsx viven en los grupos `oidcErrorTitle.*` / `oidcErrorDescription.*`
  // del catálogo; cualquier valor no reconocido cae al copy de `internal`.
  const title = labelOr(t, `oidcErrorTitle.${reason}`, t('oidcErrorTitle.internal'));
  const description = labelOr(
    t,
    `oidcErrorDescription.${reason}`,
    t('oidcErrorDescription.internal'),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="text-xs text-text-subtle">
        <p>
          {t('oidcError.codeLabel')} <code className="font-mono">{reason}</code>
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/signin">{t('oidcError.backToSignin')}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
