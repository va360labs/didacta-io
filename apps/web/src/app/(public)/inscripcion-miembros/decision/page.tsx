'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';

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
type Action = 'APPROVE' | 'REJECT';

const BASE = '/api/v1/modules/member-registration';

function Resultado({ outcome }: { outcome: Outcome }) {
  const t = useTranslations('publicSite');
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
 * Paso de confirmación. Es lo que impide que la decisión la tome un robot: el
 * enlace del email ya no muta nada, solo trae aquí, y el cambio de estado sale
 * del POST que dispara este botón.
 */
function Confirmacion({
  token,
  action,
  member,
  onDecidido,
}: {
  token: string;
  action: Action;
  member: string;
  onDecidido: (outcome: Outcome) => void;
}) {
  const t = useTranslations('publicSite');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(false);

  async function confirmar() {
    setEnviando(true);
    setError(false);
    try {
      const res = await apiFetch<{ outcome: string }>(`${BASE}/decision`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      onDecidido(res.outcome in OUTCOME_OK ? (res.outcome as Outcome) : 'invalid');
    } catch {
      setError(true);
      setEnviando(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-8 text-center">
        <h1 className="font-display text-xl font-bold tracking-tight">
          {t(`decision.confirmTitle${action}`)}
        </h1>
        <p className="text-sm text-text-muted">
          {member
            ? t(`decision.confirmBody${action}`, { member })
            : t(`decision.confirmBody${action}NoName`)}
        </p>
        <Button
          type="button"
          variant={action === 'APPROVE' ? 'primary' : 'destructive'}
          onClick={() => void confirmar()}
          disabled={enviando}
        >
          {enviando ? t('decision.working') : t(`decision.confirmAction${action}`)}
        </Button>
        {error ? <p className="text-sm text-danger-600">{t('decision.confirmError')}</p> : null}
        <p className="text-xs text-text-muted">{t('decision.confirmNote')}</p>
      </CardContent>
    </Card>
  );
}

function DecisionContent() {
  const searchParams = useSearchParams();
  const [decidido, setDecidido] = useState<Outcome | null>(null);

  const raw = searchParams.get('outcome') ?? '';
  const token = searchParams.get('token') ?? '';
  const action = searchParams.get('action') ?? '';

  if (decidido) return <Resultado outcome={decidido} />;

  // Con token + acción, el backend dice que este enlace todavía se puede
  // ejecutar: toca confirmar. Sin ellos, viene con un `outcome` terminal.
  if (token && (action === 'APPROVE' || action === 'REJECT')) {
    return (
      <Confirmacion
        token={token}
        action={action}
        member={searchParams.get('member') ?? ''}
        onDecidido={setDecidido}
      />
    );
  }

  return <Resultado outcome={raw in OUTCOME_OK ? (raw as Outcome) : 'invalid'} />;
}

/**
 * Pantalla del APROBADOR.
 *
 * El enlace del email trae aquí SIN haber decidido nada: los escáneres de
 * seguridad del correo (Outlook SafeLinks, Mimecast, Proofpoint) hacen GET a
 * todos los enlaces de un mensaje, y mientras la decisión colgaba del GET era
 * el robot quien aprobaba o rechazaba antes de que el humano abriera el
 * correo — según cuál de los dos enlaces visitara primero. Aquí se confirma, y
 * el POST del botón es lo que aplica el cambio.
 *
 * `useSearchParams` exige Suspense en App Router.
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
