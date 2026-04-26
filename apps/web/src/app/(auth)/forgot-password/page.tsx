import Link from 'next/link';
import { ForgotPasswordForm } from './forgot-password-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: 'Recuperar contraseña',
};

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recuperá tu contraseña</CardTitle>
        <CardDescription>
          Ingresá el nombre de tu organización y tu email. Te enviaremos un enlace para definir una
          nueva contraseña.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm />
      </CardContent>
      <CardFooter className="text-sm text-text-muted">
        ¿Te acordaste?{' '}
        <Link href="/signin" className="ml-1 font-semibold text-brand-700 hover:underline">
          Volver a iniciar sesión
        </Link>
      </CardFooter>
    </Card>
  );
}
