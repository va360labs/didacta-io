/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * 404 del sitio público.
 *
 * Escueto a propósito. Un visitante anónimo que pide una URL que no existe no
 * debe poder deducir de la respuesta qué hay detrás del dominio ni qué otros
 * sitios sirve la instancia: sin marca del aula, sin enlaces de sesión y sin
 * mencionar tenants.
 */
export default function SitioNotFound() {
  return (
    <main style={{ padding: '4rem 1.5rem', maxWidth: '36rem', margin: '0 auto' }}>
      <h1>Página no encontrada</h1>
      <p>La dirección que has pedido no existe en este sitio.</p>
    </main>
  );
}
