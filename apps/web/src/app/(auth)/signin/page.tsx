import Link from 'next/link';
import { SignInForm } from './signin-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: 'Iniciar sesión',
};

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Bienvenido de nuevo</CardTitle>
        <CardDescription>
          Ingresá los datos de tu organización para entrar a tu panel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignInForm />
      </CardContent>
      <CardFooter className="text-sm text-text-muted">
        <span>¿Todavía no tienes cuenta?</span>
        <Link href="/signup" className="ml-2 font-semibold text-brand-700 hover:underline">
          Crear cuenta
        </Link>
      </CardFooter>
    </Card>
  );
}
