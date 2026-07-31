'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ReactNode } from 'react';
import { LicenseProvider as SdkLicenseProvider } from '@didacta/license-sdk/react';

/**
 * Wrapper del LicenseProvider del SDK pre-configurado para el frontend Didacta.
 *
 * Apunta al endpoint público `/api/license` del backend, que devuelve el estado
 * serializado de la licencia (status, capabilities, warnings) sin filtrar
 * secretos. La fuente de verdad SIEMPRE es el backend — este provider solo
 * habilita renderizar UI distinta cuando una capability EE no está activa
 * (mensaje "Función Enterprise — actualiza tu plan", paneles ocultos, etc.).
 *
 * Cualquier endpoint del API sigue protegido por LicenseGuard; este provider
 * NO autoriza ni desautoriza acciones, solo mejora la UX para que el admin
 * sepa de antemano qué requiere upgrade.
 */
export function LicenseProvider({ children }: { children: ReactNode }) {
  return <SdkLicenseProvider endpoint="/api/license">{children}</SdkLicenseProvider>;
}
