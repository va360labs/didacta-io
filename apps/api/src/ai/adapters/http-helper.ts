/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type ProviderId,
} from '../types/contracts';

/**
 * Wrapper de fetch que mapea errores HTTP a errores tipados del gateway.
 * Cada adapter lo usa para tener manejo de errores consistente.
 */
export async function aiFetchJson<T>(
  url: string,
  init: RequestInit,
  provider: ProviderId,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Errores de red (DNS, conexión, timeout)
    throw new ProviderUnavailableError(
      provider,
      0,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError(provider);
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new ProviderRateLimitError(provider, retryAfter ? parseInt(retryAfter, 10) : undefined);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderUnavailableError(provider, res.status, body);
  }

  return (await res.json()) as T;
}
