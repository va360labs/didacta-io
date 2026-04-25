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
        <CardTitle>Iniciar sesión</CardTitle>
        <CardDescription>Accedé a tu cuenta del tenant.</CardDescription>
      </CardHeader>
      <CardContent>
        <SignInForm />
      </CardContent>
      <CardFooter className="text-sm text-neutral-500">
        ¿No tenés cuenta?{' '}
        <Link
          href="/signup"
          className="ml-1 font-medium text-neutral-900 underline dark:text-neutral-50"
        >
          Registrate
        </Link>
      </CardFooter>
    </Card>
  );
}
