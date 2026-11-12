/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Doble del `PurchaseConsentService` para los tests de los controladores de
 * compra que no van de la casilla: la da por marcada y apunta lo que recibe.
 * Los tests DE la casilla usan el servicio real
 * (`tests/purchase-consent.test.ts`).
 */

import { vi } from 'vitest';

export function fakeConsents() {
  return {
    accept: vi.fn(async () => 'consent-test-id'),
    attachSession: vi.fn(async () => undefined),
    confirmCheckout: vi.fn(async () => undefined),
  };
}
