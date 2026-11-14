'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { authStorage } from '@/lib/auth-storage';
import { formatDateTime } from '@/lib/i18n/format';
import { captureReferralFromLocation } from '@/lib/referral-links';

/**
 * Lo que la portada pública hace en el navegador.
 *
 * Quien ya tiene sesión no tiene nada que ver aquí: va a su inicio de siempre
 * (`/home`). La sesión vive en el almacenamiento del navegador, así que esto no
 * puede decidirlo el servidor: lo hace el script de `EARLY_SESSION_REDIRECT`
 * antes de pintar (entrada directa) y este efecto en la navegación interna.
 * Con `?preview=1` (el «Ver tu página pública» de Ajustes) se queda.
 *
 * El `?ref=` del visitante se guarda para que viaje a la compra aunque llegue
 * a ella por otro camino (los botones ya lo llevan en su enlace).
 */
export function AcademyHomeSession({ preview }: { preview: boolean }) {
  const router = useRouter();
  useEffect(() => {
    captureReferralFromLocation(window.location.search);
    if (!preview && authStorage.getSession()) router.replace('/home');
  }, [preview, router]);
  return null;
}

/**
 * Script en línea para la entrada directa: si hay sesión, se va a `/home`
 * antes de que la portada llegue a verse (sin parpadeo). Mismas claves que
 * `auth-storage.ts`.
 */
export const EARLY_SESSION_REDIRECT = `try{var k='didacta.session';if(localStorage.getItem(k)||sessionStorage.getItem(k)){document.documentElement.setAttribute('data-con-sesion','');location.replace('/home')}}catch(e){}`;

/**
 * Fecha del próximo directo en la hora de QUIEN MIRA. El servidor no conoce su
 * zona, así que se pinta tras montar (un hueco hasta entonces, nunca una hora
 * equivocada).
 */
export function LiveDate({ iso }: { iso: string }) {
  const locale = useLocale();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const out = formatDateTime(iso, {
      locale,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
    });
    setText(out.charAt(0).toLocaleUpperCase(locale) + out.slice(1));
  }, [iso, locale]);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text ?? ' '}
    </time>
  );
}
