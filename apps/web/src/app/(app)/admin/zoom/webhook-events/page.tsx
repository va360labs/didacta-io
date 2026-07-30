'use client';

/**
 * Redirect de compatibilidad: /admin/zoom/webhook-events → /admin/webhooks?tab=zoom.
 *
 * Las entregas de Zoom son ahora una pestaña de Webhooks: tener dos entradas de
 * menú obligaba a saber de qué lado venía el evento antes de poder buscarlo. La
 * ruta se conserva para enlaces guardados de QA.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ZoomWebhookEventsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/webhooks?tab=zoom');
  }, [router]);
  return null;
}
