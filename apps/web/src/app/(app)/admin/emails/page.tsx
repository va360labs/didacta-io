'use client';

/// Sección de administración `/admin/emails` — personalización de todos los
/// emails y notificaciones que envía la plataforma. Antes vivía como tab
/// "Plantillas" de /admin/configuracion y solo cubría las keys del hub; en
/// alpha.83 se consolidó aquí (regla #5) sobre el catálogo completo, que
/// incluye también los emails transaccionales (reset de contraseña, OTP,
/// bienvenidas, membresía, avisos de renovación…).
///
/// La configuración del TRANSPORTE (SMTP) sigue en /admin/configuracion,
/// tab "Notificaciones": es infraestructura, no contenido.

import Link from 'next/link';
import { EmailTemplatesManager } from '@/modules/notifications';

export default function AdminEmailsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">Emails de la plataforma</h1>
        <p className="mt-1 text-sm text-text-muted">
          Personaliza el asunto y el cuerpo de cada email que envía la plataforma. Si no
          personalizas uno, se usa el texto por defecto del producto. El servidor de envío (SMTP) se
          configura en{' '}
          <Link href="/admin/configuracion" className="text-brand-700 hover:underline">
            Configuración → Notificaciones
          </Link>
          .
        </p>
      </div>
      <EmailTemplatesManager />
    </div>
  );
}
