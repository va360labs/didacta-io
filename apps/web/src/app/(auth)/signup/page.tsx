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
        <CardTitle>Crear cuenta</CardTitle>
        <CardDescription>Necesitás el slug del tenant para registrarte.</CardDescription>
      </CardHeader>
      <CardContent>
        <SignUpForm />
      </CardContent>
      <CardFooter className="text-sm text-neutral-500">
        ¿Ya tenés cuenta?{' '}
        <Link
          href="/signin"
          className="ml-1 font-medium text-neutral-900 underline dark:text-neutral-50"
        >
          Iniciá sesión
        </Link>
      </CardFooter>
    </Card>
  );
}
