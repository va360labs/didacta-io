'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Aviso fijo en lo alto de la plataforma cuando NO hay ninguna salida de
/// correo configurada: ni SMTP propio del tenant ni fallback global del
/// despliegue. En ese estado el producto parece funcionar pero las altas, los
/// restablecimientos de contraseña y las notificaciones se pierden en
/// silencio, que es justo lo que reportan los que instalan la alpha en Docker.
///
/// Dos decisiones deliberadas:
///
/// - **Solo lo ven quienes pueden arreglarlo** (`super_admin` / `tenant_admin`).
///   Un alumno no puede configurar un SMTP; enseñárselo solo le diría que la
///   plataforma está rota. Además el endpoint que consultamos es admin-only,
///   así que preguntarlo con cualquier otro rol sería un 403 por cada carga
///   de página.
///
/// - **No se puede descartar.** No es una novedad que se anuncia, como el
///   aviso de versión nueva: es una avería. Desaparece solo en cuanto haya
///   una salida de correo, y mientras no la haya el aviso sigue siendo cierto.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { adminSmtpApi, deriveSmtpStatus, shouldShowSmtpBanner } from '@/lib/admin-smtp';

/// Ruta al tab de notificaciones del panel, enlazable desde fuera.
const RUTA_AJUSTES = '/admin/configuracion?tab=notifications';

export function NotificationsSetupBanner({ roles }: { roles: readonly string[] }) {
  const t = useTranslations('shell');
  const [visible, setVisible] = useState(false);

  // Pregunta solo si el rol puede arreglarlo; con cualquier otro, el endpoint
  // respondería 403 en cada carga de página sin que sirviera de nada.
  const puedeArreglarlo = roles.some((r) => r === 'super_admin' || r === 'tenant_admin');

  useEffect(() => {
    if (!puedeArreglarlo) return;
    let cancelado = false;
    void adminSmtpApi
      .get()
      .then((dto) => {
        if (!cancelado) setVisible(shouldShowSmtpBanner(roles, deriveSmtpStatus(dto)));
      })
      // Si la consulta falla (sesión recién expirada, API caída) no pintamos
      // nada: un aviso de configuración basado en una respuesta que no hemos
      // podido leer sería adivinar.
      .catch(() => undefined);
    return () => {
      cancelado = true;
    };
    // `roles` es un array nuevo en cada render del layout; la dependencia real
    // es si el rol puede o no arreglarlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puedeArreglarlo]);

  if (!visible) return null;

  return (
    /* Los tokens `warning` del sistema, no los de la barra lateral: aquí el
       fondo es claro y el amber-100 del aviso de versión —pensado para el
       rail oscuro— dejaba el texto prácticamente ilegible. */
    /* Una sola línea a propósito: esto roba alto en TODAS las pantallas de la
       plataforma hasta que alguien configure el SMTP. Sin `flex-wrap`, con el
       texto recortado en puntos suspensivos cuando no quepa —de ahí el
       `min-w-0`, que es lo que permite encogerse a un hijo flex— y el botón
       en `shrink-0` para que nunca sea él quien salte de línea. */
    <div
      role="status"
      className="flex items-center justify-center gap-3 border-b border-warning-200 bg-warning-50 px-4 py-1.5 text-[13px] text-warning-800"
    >
      <p className="min-w-0 truncate">
        <strong className="font-semibold">{t('smtpBanner.title')}</strong> {t('smtpBanner.body')}
      </p>
      <Link
        href={RUTA_AJUSTES}
        className="shrink-0 rounded border border-warning-300 bg-white/70 px-2 py-0.5 font-semibold text-warning-800 underline-offset-2 hover:bg-white hover:underline"
      >
        {t('smtpBanner.cta')}
      </Link>
    </div>
  );
}
