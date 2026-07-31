/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { Suspense } from 'react';
import { ResetPasswordForm } from './reset-password-form';
import { AuthHeading } from '../auth-heading';

export const metadata = {
  title: 'Definir nueva contraseña',
};

export default function ResetPasswordPage() {
  return (
    <>
      <AuthHeading
        title="Define tu nueva contraseña"
        description="Elige una contraseña fuerte: mínimo 12 caracteres, mezcla mayúsculas, minúsculas, números y símbolos."
      />
      <Suspense
        fallback={
          <div className="space-y-3">
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
          </div>
        }
      >
        <ResetPasswordForm />
      </Suspense>
      <div className="mt-7 h-px w-full bg-border-soft" />
      <p className="mt-5 text-center text-[0.9375rem] text-text-muted">
        ¿No tienes un enlace válido?{' '}
        <Link href="/forgot-password" className="font-semibold text-brand-600 hover:underline">
          Pide uno nuevo
        </Link>
      </p>
    </>
  );
}
