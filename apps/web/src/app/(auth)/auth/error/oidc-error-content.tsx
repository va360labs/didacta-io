'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const REASON_MESSAGES: Record<string, { title: string; description: string }> = {
  state_invalid: {
    title: 'Sesión SSO inválida',
    description:
      'El token de seguridad de tu sesión no se reconoció. Esto suele pasar si abriste el flow en otra pestaña o esperaste más de 10 minutos. Reintentá iniciar sesión.',
  },
  state_expired: {
    title: 'Sesión SSO expirada',
    description:
      'Pasaron más de 10 minutos entre el redirect al IdP y la respuesta. Reintentá iniciar sesión.',
  },
  idp_error: {
    title: 'El proveedor de identidad rechazó la autorización',
    description:
      'Tu IdP corporativo no autorizó el login. Contactá al admin de tu organización si esto persiste.',
  },
  iss_mismatch: {
    title: 'Configuración SSO incorrecta',
    description:
      'El id_token vino con un issuer distinto al configurado. Pedile al admin que revise la configuración SSO.',
  },
  aud_mismatch: {
    title: 'Configuración SSO incorrecta',
    description:
      'El id_token tiene una audience distinta a nuestro client_id. Pedile al admin que revise la configuración SSO.',
  },
  nonce_mismatch: {
    title: 'Sesión SSO comprometida',
    description:
      'El nonce del id_token no coincide con el del flow. Por seguridad cancelamos el login. Reintentá.',
  },
  email_not_allowed: {
    title: 'Email no autorizado',
    description:
      'El email de tu IdP no pertenece a los dominios permitidos para SSO en este tenant. Contactá al admin para que lo añada.',
  },
  user_not_provisioned: {
    title: 'No tenés cuenta en este tenant',
    description:
      'El SSO te autenticó pero el admin no activó la creación automática de cuentas. Pedile al admin que te dé de alta.',
  },
  user_inactive: {
    title: 'Tu cuenta no está activa',
    description: 'Contactá al admin del tenant para reactivarla.',
  },
  tenant_not_configured: {
    title: 'SSO no disponible para esta organización',
    description: 'Pedile al admin que configure SSO o iniciá sesión con email + contraseña.',
  },
  idp_unreachable: {
    title: 'Tu IdP no responde',
    description:
      'No pudimos contactar al proveedor de identidad. Reintentá en unos minutos. Si persiste, avisá al admin.',
  },
  config_changed: {
    title: 'La configuración SSO cambió a mitad de login',
    description: 'Reintentá iniciar sesión. Si persiste, contactá al admin.',
  },
  bad_request: {
    title: 'Parámetros de callback inválidos',
    description:
      'Faltan datos en la URL de callback. Esto suele indicar que se accedió a /auth/callback fuera del flow OIDC.',
  },
  missing_tokens: {
    title: 'Tokens ausentes',
    description: 'No recibimos los tokens en el callback. Reintentá iniciar sesión.',
  },
  me_failed: {
    title: 'No pudimos cargar tu perfil',
    description: 'Tu autenticación fue exitosa pero la API rechazó el GET /me. Reintentá.',
  },
};

export function OidcErrorContent() {
  const params = useSearchParams();
  const reason = params.get('reason') ?? 'internal';
  const fallback = {
    title: 'No pudimos completar el inicio',
    description:
      'Algo no salió bien durante el inicio de sesión con SSO. Reintentá; si persiste, contactá al admin del tenant.',
  };
  const { title, description } = REASON_MESSAGES[reason] ?? fallback;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="text-xs text-text-subtle">
        <p>
          Código del error: <code className="font-mono">{reason}</code>
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/signin">Volver a iniciar sesión</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
