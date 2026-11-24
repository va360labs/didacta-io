/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch, ApiHttpError } from './api-client';

/**
 * «Dirección de tu academia»: el administrador cambia él solo el subdominio de
 * su aula. Ver `AcademyAddressController` en la API. Solo existe si la
 * instancia configura `TENANT_SUBDOMAIN_SUFFIX`; si no, la API responde 404 y
 * la tarjeta no se pinta.
 */

export type AddressBlockedReason = 'no_address' | 'own_domain' | 'limit';

export interface AcademyAddressState {
  suffix: string;
  hostname: string | null;
  label: string | null;
  canChange: boolean;
  blockedReason: AddressBlockedReason | null;
  maxChanges: number;
  windowDays: number;
  changesLeft: number;
  nextChangeAt: string | null;
}

export type AddressAvailabilityStatus = 'available' | 'current' | 'invalid' | 'reserved' | 'taken';

export interface AddressAvailability {
  label: string;
  hostname: string | null;
  status: AddressAvailabilityStatus;
}

export interface AddressChangeResult {
  previousHostname: string;
  hostname: string;
  state: AcademyAddressState;
}

const BASE = '/api/v1/admin/tenant-settings/academy/address';

export const academyAddressApi = {
  /** `null` si la instancia no tiene la función (404): no se pinta nada. */
  async getState(bearer: string): Promise<AcademyAddressState | null> {
    try {
      return await apiFetch<AcademyAddressState>(BASE, { method: 'GET' }, bearer);
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 404) return null;
      throw e;
    }
  },
  async check(bearer: string, label: string): Promise<AddressAvailability> {
    return apiFetch<AddressAvailability>(
      `${BASE}/availability?label=${encodeURIComponent(label)}`,
      { method: 'GET' },
      bearer,
    );
  },
  async change(bearer: string, label: string): Promise<AddressChangeResult> {
    return apiFetch<AddressChangeResult>(
      BASE,
      { method: 'PUT', body: JSON.stringify({ label }) },
      bearer,
    );
  },
};

/** Lo más largo que admite una etiqueta DNS. */
export const MAX_LABEL_LENGTH = 63;

/**
 * Lo que se escribe en el campo, llevado a lo que admite una dirección
 * mientras se teclea: minúsculas, sin tildes («Academía Pérez» →
 * «academia-perez»), espacios y signos a guion, sin guiones repetidos. No
 * recorta el guion final mientras se escribe (se está a mitad de palabra);
 * eso, y el resto, lo decide la API al comprobar.
 */
export function toLabelDraft(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_LABEL_LENGTH);
}

/**
 * La pantalla de acceso de la dirección NUEVA, con el mismo esquema y puerto
 * que la actual (en producción, `https://<nueva>/signin`; en local, el puerto
 * de la web). Las sesiones no pasan de una dirección a otra: hay que entrar.
 */
export function signinUrlAt(
  hostname: string,
  current: Pick<Location, 'protocol' | 'port'>,
): string {
  const port = current.port ? `:${current.port}` : '';
  return `${current.protocol}//${hostname}${port}/signin`;
}

/** Qué dice la línea de debajo del campo. */
export type AddressHint =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: AddressAvailabilityStatus; hostname: string | null };

/**
 * ¿Se puede pulsar «Cambiar dirección»? Solo con la comprobación EN VIVO
 * diciendo «libre» para lo que hay escrito ahora mismo (no para lo de hace
 * un momento) y con cambios disponibles.
 */
export function canSubmitAddress(
  state: Pick<AcademyAddressState, 'canChange'> | null,
  draft: string,
  checked: AddressAvailability | null,
  busy: boolean,
): boolean {
  if (!state?.canChange || busy || !checked) return false;
  return checked.status === 'available' && checked.label === draft;
}
