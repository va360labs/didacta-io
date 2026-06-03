import Link from 'next/link';
import { Suspense } from 'react';
import { ResetPasswordForm } from './reset-password-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: 'Definir nueva contraseña',
};

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Define tu nueva contraseña</CardTitle>
        <CardDescription>
          Elige una contraseña fuerte: mínimo 12 caracteres, mezcla mayúsculas, minúsculas, números
          y símbolos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense
          fallback={
            <div className="space-y-3">
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
            </div>
          }
        >
          <ResetPasswordForm />
        </Suspense>
      </CardContent>
      <CardFooter className="text-sm text-text-muted">
        ¿No tienes un enlace válido?{' '}
        <Link href="/forgot-password" className="ml-1 font-semibold text-brand-700 hover:underline">
          Pide uno nuevo
        </Link>
      </CardFooter>
    </Card>
  );
}
