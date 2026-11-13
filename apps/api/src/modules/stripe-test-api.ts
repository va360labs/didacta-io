/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Doble de Stripe para pruebas de extremo a extremo.
 *
 * Con `STRIPE_TEST_API_URL` (p. ej. `http://127.0.0.1:12111`), el SDK de
 * Stripe habla con ese servidor en vez de con api.stripe.com, pero SOLO con
 * claves de prueba (`sk_test_…`): una clave real nunca sale hacia otro sitio,
 * aunque la variable esté puesta por error. Sin la variable, el constructor es
 * el de siempre.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeCtor = new (key: string, opts?: any) => any;

export function withStripeTestApi<T extends StripeCtor>(
  Ctor: T,
  env: Record<string, string | undefined> = process.env,
): T {
  const raw = env['STRIPE_TEST_API_URL']?.trim();
  if (!raw) return Ctor;
  const url = new URL(raw);
  const protocol = url.protocol.replace(':', '');
  const port = Number(url.port || (protocol === 'https' ? 443 : 80));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Wrapped = function (this: unknown, key: string, opts?: any) {
    if (!key.startsWith('sk_test_')) return new Ctor(key, opts);
    return new Ctor(key, { ...(opts ?? {}), host: url.hostname, port, protocol });
  };
  return Wrapped as unknown as T;
}
