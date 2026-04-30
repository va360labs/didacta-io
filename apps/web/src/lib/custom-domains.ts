'use client';

/**
 * Cliente HTTP para dominios personalizados (cuarto piloto License SDK).
 *
 * Backend: `apps/api/src/admin/custom-domains/`. La capability EE
 * `feat:custom_domains` gatea TODOS los endpoints (a diferencia de
 * `mfa-policy`, donde el GET era libre). Sin licencia EE el cliente recibe
 * 402 vía `LicenseExceptionFilter`; el frontend lo intercepta y muestra el
 * upsell card sin emitir más requests.
 */

import { apiFetch } from './api-client';

export type CustomDomainStatus = 'pending' | 'verified' | 'inactive';

export interface CustomDomain {
  id: string;
  hostname: string;
  status: CustomDomainStatus;
  /** Valor que el cliente debe poner como CNAME en su DNS. */
  cnameTarget: string;
  /** Token TXT para DNS-01 challenge — el cliente lo usa en POST /verify. */
  verificationToken: string;
  createdAt: string;
  verifiedAt: string | null;
}

export interface CustomDomainsListResponse {
  domains: CustomDomain[];
  capability: string;
}

const BASE = '/api/v1/admin/custom-domains';

export const customDomainsApi = {
  async list(bearer: string): Promise<CustomDomainsListResponse> {
    return apiFetch<CustomDomainsListResponse>(BASE, { method: 'GET' }, bearer);
  },

  async add(bearer: string, hostname: string): Promise<CustomDomain> {
    return apiFetch<CustomDomain>(
      BASE,
      { method: 'POST', body: JSON.stringify({ hostname }) },
      bearer,
    );
  },

  async verify(bearer: string, id: string, providedToken: string): Promise<CustomDomain> {
    return apiFetch<CustomDomain>(
      `${BASE}/${id}/verify`,
      { method: 'POST', body: JSON.stringify({ providedToken }) },
      bearer,
    );
  },

  async setStatus(
    bearer: string,
    id: string,
    status: 'verified' | 'inactive',
  ): Promise<CustomDomain> {
    return apiFetch<CustomDomain>(
      `${BASE}/${id}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      bearer,
    );
  },

  async remove(bearer: string, id: string): Promise<{ id: string; removed: boolean }> {
    return apiFetch<{ id: string; removed: boolean }>(
      `${BASE}/${id}`,
      { method: 'DELETE' },
      bearer,
    );
  },
};
