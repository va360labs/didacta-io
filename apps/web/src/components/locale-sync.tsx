'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Puente cookie ↔ perfil. Montado en el ROOT layout (dentro del provider de
 * next-intl):
 *
 *  1. Registra el locale activo y la timezone del perfil en el singleton de
 *     `user-prefs` para que los helpers de `@/lib/i18n/format` no necesiten
 *     parámetros en client components.
 *  2. Tras login (o tras guardar el idioma en /cuenta u onboarding, que ya
 *     disparan `didacta:session-updated`), si `profile.locale` difiere de la
 *     cookie `didacta_locale`, la reescribe y hace `router.refresh()` — los
 *     RSC se re-renderizan con `<html lang>` y catálogo nuevos, sin recarga
 *     dura.
 *
 * Vía elegida: `document.cookie` + refresh. Sin server actions ni route
 * handlers: no hay session server-side que validar (el JWT vive en el
 * navegador) y la cookie es una preferencia de presentación, no un secreto.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { toSupportedLocale } from '@/i18n/config';
import { authStorage } from '@/lib/auth-storage';
import { readLocaleCookie, writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { setUserFormatPrefs } from '@/lib/i18n/user-prefs';
import { meApi } from '@/lib/me';

export function LocaleSync() {
  const router = useRouter();
  const active = useLocale();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setUserFormatPrefs({ locale: active });
  }, [active]);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('didacta:session-updated', bump);
    return () => window.removeEventListener('didacta:session-updated', bump);
  }, []);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return; // páginas públicas: manda la cookie (o el default)
    let cancelled = false;
    meApi
      .getProfile(token)
      .then((p) => {
        if (cancelled) return;
        setUserFormatPrefs({ timeZone: p.timezone || undefined });
        const wanted = toSupportedLocale(p.locale);
        if (wanted !== toSupportedLocale(readLocaleCookie())) {
          writeLocaleCookie(wanted);
          router.refresh();
        }
      })
      .catch(() => {
        /* token caducado o sin red: no-op, la cookie actual manda */
      });
    return () => {
      cancelled = true;
    };
  }, [router, tick]);

  return null;
}
