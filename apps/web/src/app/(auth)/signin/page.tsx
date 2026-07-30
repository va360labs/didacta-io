import { SignInForm } from './signin-form';
import { AuthHeading } from '../auth-heading';

export const metadata = {
  title: 'Iniciar sesión',
};

export default function SignInPage() {
  return (
    <>
      <AuthHeading
        title="Bienvenido de nuevo"
        description="Entra con los datos de tu cuenta para acceder a tu panel."
      />
      <SignInForm />
    </>
  );
}
