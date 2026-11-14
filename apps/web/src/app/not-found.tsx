/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { AcademyNotFound } from '@/components/academy-not-found';

/**
 * 404 del AULA (cualquier ruta que no existe en su dominio). Antes salía la
 * página genérica de Next, en inglés y sin marca. Ahora lleva la del aula y,
 * al pie, «Powered by Didacta», como el resto de pantallas del aula.
 *
 * SIN trabajo asíncrono aquí: Next prepara el 404 raíz en cada petición, y uno
 * que esperase a la API (la marca) retrasaba el envío de todas las páginas
 * hasta dejar su `<title>` pintado en el `<body>`. La marca la pone el cliente
 * (`AcademyNotFound`).
 *
 * Un dominio que no es de ningún aula no llega aquí (el middleware le contesta
 * un 404 pelado), y el sitio público tiene su propio 404 sin marca
 * (`app/site/not-found.tsx`).
 */
export default function AulaNotFound() {
  return <AcademyNotFound />;
}
