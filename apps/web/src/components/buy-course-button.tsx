'use client';

/**
 * Botón "Comprar curso" — entry point al checkout de Stripe vía mod.billing.
 *
 * Comportamiento:
 *  1. Click → llama `billingApi.startCheckout(courseId)`.
 *  2. Backend crea la sesión Stripe y devuelve `{ url, orderId, sessionId }`.
 *  3. Redirigimos a `url` (hosted Stripe Checkout).
 *
 * No hay forma pública en el backend de saber si un curso tiene producto
 * asignado (los endpoints de admin requieren rol). Por eso este botón se
 * renderiza siempre que el componente padre lo invoque y, si el curso NO
 * es de pago, el backend responde 404 `BILLING_PRODUCT_NOT_FOUND` y aquí
 * lo traducimos a un mensaje claro al alumno. Igual con 503 si el módulo
 * no está configurado en el tenant.
 *
 * Estados visibles:
 *  - idle      → "Comprar curso"
 *  - loading   → "Redirigiendo a Stripe…", botón deshabilitado.
 *  - error     → mensaje rojo bajo el botón con `role="alert"`.
 *
 * Re-render seguro: el effect del padre no se descontrola porque el botón
 * mantiene su propio estado local (no propaga `pending` hacia arriba).
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { billingApi } from '@/modules/billing';

interface BuyCourseButtonProps {
  courseId: string;
  /** Texto del botón en estado idle. Default: "Comprar curso". */
  label?: string;
  /** Variant del Button del UI kit. Default: 'primary'. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'success';
  /** Tamaño del botón. Default: 'lg' (consistente con "Matricularme"). */
  size?: 'sm' | 'default' | 'lg';
  /** Clase extra opcional para layout. */
  className?: string;
}

export function BuyCourseButton({
  courseId,
  label = 'Comprar curso',
  variant = 'primary',
  size = 'lg',
  className,
}: BuyCourseButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const token = authStorage.getAccessToken();
      if (!token) {
        setError('Tu sesión expiró. Inicia sesión y vuelve a intentarlo.');
        setPending(false);
        return;
      }
      const { url } = await billingApi.startCheckout(courseId, token);
      // Redirigimos a la URL hosted de Stripe. NO usamos router.push() porque
      // es un dominio externo — sólo `window.location.href` cambia de origin.
      window.location.href = url;
      // No reseteamos `pending` adrede: la página se está descargando.
    } catch (e) {
      setError(translateBillingError(e));
      setPending(false);
    }
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? 'Redirigiendo a Stripe…' : label}
      </Button>
      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-danger-100 bg-danger-50 p-2 text-sm text-danger-700"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Traduce los errores semánticos de `BillingErrorFilter` a mensajes que el
 * alumno entienda. Los códigos vienen del filtro NestJS:
 *  - BILLING_PRODUCT_NOT_FOUND     (404) → curso no es de pago / aún no a la venta
 *  - BILLING_PRODUCT_INACTIVE      (409) → producto desactivado por el admin
 *  - BILLING_STRIPE_API_ERROR      (502) → Stripe falló (red, etc.)
 *  - BILLING_STRIPE_CONFIG_MISSING (503) → tenant sin Stripe configurado
 */
function translateBillingError(e: unknown): string {
  if (e instanceof ApiHttpError) {
    switch (e.code) {
      case 'BILLING_PRODUCT_NOT_FOUND':
        return 'Este curso aún no está disponible para la compra. Contacta a tu organización.';
      case 'BILLING_PRODUCT_INACTIVE':
        return 'La venta de este curso está pausada en este momento.';
      case 'BILLING_STRIPE_API_ERROR':
        return 'Hubo un problema con la pasarela de pago. Intenta de nuevo en unos minutos.';
      case 'BILLING_STRIPE_CONFIG_MISSING':
        return 'Los pagos no están habilitados en tu organización. Contacta al admin.';
      default:
        return e.message || 'No pudimos iniciar el pago. Intenta de nuevo.';
    }
  }
  return 'No pudimos iniciar el pago. Intenta de nuevo.';
}
