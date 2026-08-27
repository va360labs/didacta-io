/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Filtro común de toda lectura de matrículas que acabe en algo que se comunica
 * a Fundae — el XML, los CSV, el recuento de participantes, los PDF de
 * evidencia, la importación de participantes al grupo.
 *
 * `CANCELLED` fuera porque una matrícula cancelada no es un participante. Y
 * `INSPECTION` fuera porque tampoco lo es: es la cuenta de seguimiento que el
 * centro comunica a la Fundación para que la inspección recorra el curso
 * (LMS-123). Está matriculada de verdad —el contenido se gatea por matrícula,
 * no por rol—, así que sin este filtro el propio inspector aparecería en el
 * listado nominal de la acción que viene a inspeccionar.
 */
export const PARTICIPANT_ENROLLMENT_FILTER = {
  status: { not: 'CANCELLED' },
  source: { not: 'INSPECTION' },
} as const;
