import { MfaSetupFlow } from './mfa-setup-flow';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Configurar MFA' };

export default function MfaSetupPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configurar segundo factor</CardTitle>
        <CardDescription>
          Tu rol exige autenticación en dos pasos. Escaneá el QR con tu app TOTP (Google
          Authenticator, 1Password, Authy) y confirmá el código.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MfaSetupFlow />
      </CardContent>
    </Card>
  );
}
