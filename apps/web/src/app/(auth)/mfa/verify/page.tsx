import { MfaVerifyForm } from './mfa-verify-form';
import { AuthHeading } from '../../auth-heading';

export const metadata = { title: 'Verificar MFA' };

export default function MfaVerifyPage() {
  return (
    <>
      <AuthHeading
        title="Segundo factor"
        description="Introduce el código de 6 dígitos de tu app TOTP, o un recovery code si perdiste acceso."
      />
      <MfaVerifyForm />
    </>
  );
}
