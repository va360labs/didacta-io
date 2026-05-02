import Link from 'next/link';
import { SignUpForm } from './signup-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: 'Crear cuenta',
};

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Sumate a tu organización</CardTitle>
        <CardDescription>
          Si tienes un código de invitación, completalo en el campo de la organización. Si no, pedí
          ayuda al admin de tu equipo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignUpForm />
      </CardContent>
      <CardFooter className="text-sm text-text-muted">
        <span>¿Ya tienes cuenta?</span>
        <Link href="/signin" className="ml-2 font-semibold text-brand-700 hover:underline">
          Iniciá sesión
        </Link>
      </CardFooter>
    </Card>
  );
}
