'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';

/** Mensajes que ve el APROBADOR tras procesar la solicitud desde el email. */
const OUTCOME_COPY: Record<string, { title: string; body: string; ok: boolean }> = {
  approved: {
    title: 'Solicitud aprobada',
    body: 'La solicitud fue aprobada. El miembro ya tiene acceso.',
    ok: true,
  },
  rejected: { title: 'Solicitud rechazada', body: 'La solicitud fue rechazada.', ok: false },
  already: {
    title: 'Ya procesada',
    body: 'Este registro ya fue procesado anteriormente.',
    ok: false,
  },
  invalid: { title: 'Enlace inválido', body: 'El enlace no es válido.', ok: false },
  expired: { title: 'Enlace expirado', body: 'El enlace expiró.', ok: false },
};

function DecisionContent() {
  const searchParams = useSearchParams();
  const outcome = searchParams.get('outcome') ?? '';
  const copy = OUTCOME_COPY[outcome] ?? OUTCOME_COPY.invalid;

  return (
    <Card>
      <CardContent className="space-y-3 p-8 text-center">
        <div
          aria-hidden="true"
          className={
            'mx-auto grid h-14 w-14 place-items-center rounded-full text-2xl text-white ' +
            (copy.ok ? 'bg-success-500' : 'bg-danger-500')
          }
        >
          {copy.ok ? '✓' : '✕'}
        </div>
        <h1 className="font-display text-xl font-bold tracking-tight">{copy.title}</h1>
        <p className="text-sm text-text-muted">{copy.body}</p>
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
  return (
    <Suspense
      fallback={
        <Card>
          <CardContent className="p-8 text-center text-text-muted">Cargando…</CardContent>
        </Card>
      }
    >
      <DecisionContent />
    </Suspense>
  );
}
