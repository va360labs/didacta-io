/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { Figtree, Inter, Sora } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { LocaleSync } from '@/components/locale-sync';
import { getAcademyLocale, publicHost } from '@/lib/academy-locale';
import { ACADEMY_ICON_PATH } from '@/lib/academy-mark';
import { SubscriptionGate } from '@/components/subscription-gate';
import { TenantThemeProvider } from '@/components/tenant-theme-provider';
import { TenantTitle } from '@/components/tenant-title';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const sora = Sora({
  subsets: ['latin'],
  variable: '--font-sora',
  display: 'swap',
  weight: ['400', '600', '700', '800'],
});

/**
 * Tipografía del MODO SENCILLO (aulas de Didacta Cloud). Solo se aplica cuando
 * `<html>` lleva la clase `modo-sencillo`; sin `preload` para que el modo
 * completo no descargue nada nuevo en su primera carga.
 */
const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
  preload: false,
});

/**
 * El sufijo de marca base es "Didacta" porque el servidor no sabe a qué tenant
 * pertenece el visitante (se resuelve por dominio contra la API). `TenantTitle`
 * lo completa en el cliente a "<Tenant> powered by Didacta" en cuanto conoce el
 * tenant — "Didacta" no debe aparecer solo cuando hay tenant resuelto.
 *
 * Favicon de TODAS las páginas del aula: `app/academy-brand/icon` sirve el del
 * aula (su favicon, su logo o, si no tiene ninguno, sus iniciales sobre su
 * color) — nunca el logo de Didacta. Es una ruta relativa: no necesita conocer
 * el dominio, así que los metadatos de la raíz siguen siendo estáticos (un
 * `generateMetadata` aquí los haría dinámicos en todas las páginas: ver
 * `lib/academy-og.ts`). La vista previa en redes por defecto la ponen las
 * páginas de venta (portada, catálogo, fichas y /join).
 */
export const metadata: Metadata = {
  title: {
    default: 'Didacta',
    template: '%s | Didacta',
  },
  description: 'Plataforma educativa modular, abierta y preparada para escalar.',
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: ACADEMY_ICON_PATH }],
    apple: [{ url: `${ACADEMY_ICON_PATH}?size=180`, sizes: '180x180' }],
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Idioma por cookie `didacta_locale` (ver src/i18n/request.ts). LocaleSync
  // la mantiene alineada con user.locale tras el login.
  const locale = await getLocale();
  // Idioma del aula (cacheado por host): con él se pinta quien entra sin cookie
  // y LocaleSync lo adopta en el primer acceso de quien aún no eligió el suyo.
  const h = await headers();
  const academyLocale = await getAcademyLocale(publicHost(h), h.get('x-forwarded-for'));
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={`${inter.variable} ${sora.variable} ${figtree.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/*
         * TenantThemeProvider en el ROOT para que el branding por tenant
         * (colores, fuentes, favicon, logo en sidebar) cubra TANTO la app
         * autenticada (app) como las pantallas de auth ((auth)/signin,
         * reset-password). Es un client component que envuelve children —
         * los children pueden seguir siendo server components.
         */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TenantTitle />
          {/*
           * Puerta de suscripción: con el aula en pausa, su pantalla sustituye
           * al contenido en cualquier ruta salvo las de entrar. Va dentro del
           * tema para pintarse con la marca del tenant.
           */}
          <TenantThemeProvider>
            <SubscriptionGate>{children}</SubscriptionGate>
          </TenantThemeProvider>
          <LocaleSync academyLocale={academyLocale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
