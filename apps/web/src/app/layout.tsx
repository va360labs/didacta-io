import type { Metadata } from 'next';
import { Inter, Sora } from 'next/font/google';
import type { ReactNode } from 'react';
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
 * El sufijo de marca base es "Didacta" porque el servidor no sabe a qué tenant
 * pertenece el visitante (se resuelve por dominio contra la API). `TenantTitle`
 * lo completa en el cliente a "<Tenant> powered by Didacta" en cuanto conoce el
 * tenant — "Didacta" no debe aparecer solo cuando hay tenant resuelto.
 */
export const metadata: Metadata = {
  title: {
    default: 'Didacta',
    template: '%s | Didacta',
  },
  description: 'Plataforma educativa modular, abierta y preparada para escalar.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-ES" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <body>
        {/*
         * TenantThemeProvider en el ROOT para que el branding por tenant
         * (colores, fuentes, favicon, logo en sidebar) cubra TANTO la app
         * autenticada (app) como las pantallas de auth ((auth)/signin,
         * reset-password). Es un client component que envuelve children —
         * los children pueden seguir siendo server components.
         */}
        <TenantTitle />
        <TenantThemeProvider>{children}</TenantThemeProvider>
      </body>
    </html>
  );
}
