import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'LearnShip',
    template: '%s · LearnShip',
  },
  description: 'Plataforma LMS modular de VA360 LABS',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-ES" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
