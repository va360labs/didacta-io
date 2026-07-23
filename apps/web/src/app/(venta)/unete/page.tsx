import { Suspense } from 'react';
import { UneteView } from './unete-view';

export const metadata = {
  title: 'Únete',
};

/**
 * Página PÚBLICA de compra de la membresía. Todo el contenido (planes, cursos,
 * precios, testimonial) sale de la API real (`GET /api/v1/membership/page`,
 * tenant por dominio) — aquí no hay ni un dato inventado. El pago es Stripe
 * Checkout hosted (redirect).
 */
export default function UnetePage() {
  return (
    <Suspense fallback={null}>
      <UneteView />
    </Suspense>
  );
}
