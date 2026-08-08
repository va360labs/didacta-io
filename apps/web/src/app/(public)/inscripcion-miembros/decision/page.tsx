'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Outcomes que ve el APROBADOR tras procesar la solicitud desde el email. Los
 * textos viven en `publicSite.decision.*` (grupo por enum cerrado).
 */
const OUTCOME_OK = {
  approved: true,
  rejected: false,
  already: false,
  invalid: false,
  expired: false,
} as const;

type Outcome = keyof typeof OUTCOME_OK;

function DecisionContent() {
  const t = useTranslations('publicSite');
  const searchParams = useSearchParams();
  const raw = searchParams.get('outcome') ?? '';
  const outcome: Outcome = raw in OUTCOME_OK ? (raw as Outcome) : 'invalid';
  const ok = OUTCOME_OK[outcome];

  return (
    <Card>
      <CardContent className="space-y-3 p-8 text-center">
        <div
          aria-hidden="true"
          className={
            'mx-auto grid h-14 w-14 place-items-center rounded-full text-2xl text-white ' +
            (ok ? 'bg-success-500' : 'bg-danger-500')
          }
        >
          {ok ? '✓' : '✕'}
        </div>
        <h1 className="font-display text-xl font-bold tracking-tight">
          {t(`decision.${outcome}Title`)}
        </h1>
        <p className="text-sm text-text-muted">{t(`decision.${outcome}Body`)}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Pantalla de confirmación para el APROBADOR. Tras procesar la decisión desde
 * el email, el backend redirige aquí con `?outcome=approved|rejected|already|
 * invalid|expired`. El frontend solo lee el outcome y muestra el mensaje — no
 * llama a ningún endpoint. `useSearchParams` exige Suspense en App Router.
 */
export default function InscripcionDecisionPage() {
  const t = useTranslations('publicSite');
  return (
    <Suspense
      fallback={
        <Card>
          <CardContent className="p-8 text-center text-text-muted">{t('loading')}</CardContent>
        </Card>
      }
    >
      <DecisionContent />
    </Suspense>
  );
}
