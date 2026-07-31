/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { ForgotPasswordForm } from './forgot-password-form';
import { AuthHeading } from '../auth-heading';

export const metadata = {
  title: 'Recuperar contraseña',
};

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeading
        title="Recupera tu contraseña"
        description="Escribe tu email y te enviaremos un enlace para definir una nueva contraseña."
      />
      <ForgotPasswordForm />
      <div className="mt-7 h-px w-full bg-border-soft" />
      <p className="mt-5 text-center text-[0.9375rem] text-text-muted">
        ¿Te acordaste?{' '}
        <Link href="/signin" className="font-semibold text-brand-600 hover:underline">
          Volver a iniciar sesión
        </Link>
      </p>
    </>
  );
}
