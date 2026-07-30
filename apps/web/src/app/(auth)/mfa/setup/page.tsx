import { MfaSetupFlow } from '@/components/mfa-setup-flow';
import { AuthHeading } from '../../auth-heading';

export const metadata = { title: 'Configurar MFA' };

export default function MfaSetupPage() {
  return (
    <>
      <AuthHeading
        title="Configurar segundo factor"
        description="Tu rol exige autenticación en dos pasos. Escanea el QR con tu app TOTP (Google Authenticator, 1Password, Authy) y confirma el código."
      />
      <MfaSetupFlow />
    </>
  );
}
