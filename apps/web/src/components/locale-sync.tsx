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
 *  2. Tras login (o tras guardar el idioma en /account u onboarding, que ya
 *     disparan `didacta:session-updated`), si `profile.locale` difiere del
 *     idioma con el que se está pintando (la cookie `didacta_locale` o, sin
 *     ella, el idioma del aula), reescribe la cookie y hace `router.refresh()`
 *     — los RSC se re-renderizan con `<html lang>` y catálogo nuevos, sin
 *     recarga dura. La preferencia de cada usuario manda para ese usuario.
 *  3. Primer acceso (sin onboarding terminado): el idioma con el que está
 *     viendo el aula (su cookie o, sin ella, el del aula) pasa a su perfil.
 *
 * Vía elegida: `document.cookie` + refresh. Sin server actions ni route
 * handlers: no hay session server-side que validar (el JWT vive en el
 * navegador) y la cookie es una preferencia de presentación, no un secreto.
 */

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import type { AcademyLocale } from '@/i18n/config';
import { authStorage } from '@/lib/auth-storage';
import { readLocaleCookie, writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { firstAccessPatch, profileLocaleToApply, viewingLocale } from '@/lib/i18n/first-access';
import { getBrowserTimeZone, setUserFormatPrefs } from '@/lib/i18n/user-prefs';
import { meApi } from '@/lib/me';

export function LocaleSync({ academyLocale = null }: { academyLocale?: AcademyLocale | null }) {
  const router = useRouter();
  const active = useLocale();
  // El idioma con el que se está pintando, sin volver a pedir el perfil cada
  // vez que cambia (el efecto de abajo lo lee al terminar).
  const activeRef = useRef(active);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    activeRef.current = active;
    setUserFormatPrefs({ locale: active });
  }, [active]);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('didacta:session-updated', bump);
    return () => window.removeEventListener('didacta:session-updated', bump);
  }, []);

  // Tras iniciar sesión, el acceso navega en cliente (`router.push`): este
  // componente no se vuelve a montar y, sin esto, el idioma del perfil no se
  // aplicaba hasta la siguiente recarga completa (quien entraba en un aula en
  // inglés con el perfil en español seguía viéndola en inglés). Al cambiar de
  // ruta, si hay un token que aún no se había visto, se vuelve a sincronizar.
  const pathname = usePathname();
  const seenToken = useRef<string | null>(authStorage.getAccessToken());
  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (token && token !== seenToken.current) {
      seenToken.current = token;
      setTick((n) => n + 1);
    }
  }, [pathname]);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return; // páginas públicas: manda la cookie (o el default)
    let cancelled = false;
    meApi
      .getProfile(token)
      .then(async (p) => {
        if (cancelled) return;
        // Primer acceso: la zona y el idioma del navegador pasan al perfil, en
        // vez de que el perfil por defecto (UTC, español) se imponga.
        const patch = firstAccessPatch({
          onboarded: Boolean(
            p.onboardingCompletedAt ?? authStorage.getSession()?.user.onboardingCompletedAt,
          ),
          profileLocale: p.locale,
          profileTimeZone: p.timezone,
          // Sin cookie, el idioma del aula: es con el que está viendo el aula.
          cookieLocale: viewingLocale(readLocaleCookie(), academyLocale),
          browserTimeZone: getBrowserTimeZone(),
        });
        if (patch) {
          try {
            await meApi.updateProfile(token, patch);
            if (patch.timezone) p = { ...p, timezone: patch.timezone };
            if (patch.locale) p = { ...p, locale: patch.locale };
          } catch {
            /* sin red: se reintenta en la próxima carga */
          }
          if (cancelled) return;
        }
        setUserFormatPrefs({ timeZone: p.timezone || undefined });
        // Se compara con lo que se está pintando, no con la cookie: sin cookie
        // se pinta el idioma del aula, y el perfil de quien entra manda.
        const wanted = profileLocaleToApply(p.locale, readLocaleCookie(), activeRef.current);
        if (wanted) {
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
  }, [router, tick, academyLocale]);

  return null;
}
