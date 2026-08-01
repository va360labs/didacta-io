'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Retorno del checkout PÚBLICO de un curso suelto (comprador anónimo).
 *
 * Como en el resto de retornos de Stripe, aquí NO se confirma contra la API:
 * el fulfillment lo hace el webhook (provisioning de la cuenta + matrícula
 * vía `billing.order.completed`). Esta página solo orienta al comprador:
 * si no tenía cuenta, el email de bienvenida trae el enlace para definir su
 * contraseña; si ya la tenía, entra por /signin y el curso está en la suya.
 *
 * `session_id` se muestra como referencia de soporte, nada más.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';

function SuccessContent() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');

  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 rounded-3xl border border-border bg-surface p-8 shadow-sm">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-success-100 text-success-700">
        <Icon name="check" className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-bold">¡Gracias por tu compra!</h1>
      <p className="text-text-muted">
        Tu pago se procesó correctamente y tu curso se está activando. Revisa tu correo: te hemos
        enviado un enlace para <strong>definir tu contraseña</strong> y entrar directamente. Si no
        lo ves en unos minutos, mira en spam o usa &ldquo;¿Olvidaste tu contraseña?&rdquo; en el
        inicio de sesión.
      </p>
      <p className="text-sm text-text-muted">
        ¿Ya tenías cuenta? Inicia sesión con tu email de siempre: el curso ya está en ella.
      </p>
      <div className="flex flex-wrap gap-3 pt-1">
        <Button asChild>
          <Link href="/signin">Ir al inicio de sesión</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/catalogo">Volver al catálogo</Link>
        </Button>
      </div>
      {sessionId ? (
        <p className="pt-3 text-xs text-text-subtle">
          Referencia de pago: <code className="font-mono">{sessionId}</code>
        </p>
      ) : null}
    </div>
  );
}

export default function PublicCheckoutSuccessPage() {
  // Suspense necesario porque `useSearchParams` requiere boundary en App Router.
  return (
    <Suspense fallback={<div className="skeleton mx-auto h-64 w-full max-w-lg rounded-3xl" />}>
      <SuccessContent />
    </Suspense>
  );
}
