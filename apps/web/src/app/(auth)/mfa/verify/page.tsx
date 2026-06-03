import { MfaVerifyForm } from './mfa-verify-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Verificar MFA' };

export default function MfaVerifyPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Segundo factor</CardTitle>
        <CardDescription>
          Introduce el código de 6 dígitos de tu app TOTP, o un recovery code si perdiste acceso.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MfaVerifyForm />
      </CardContent>
    </Card>
  );
}
