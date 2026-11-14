/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { getTranslations } from 'next-intl/server';

/**
 * 404 del sitio público.
 *
 * Escueto a propósito. Un visitante anónimo que pide una URL que no existe no
 * debe poder deducir de la respuesta qué hay detrás del dominio ni qué otros
 * sitios sirve la instancia: sin marca del aula, sin enlaces de sesión y sin
 * mencionar tenants. Solo el idioma: el del visitante o, sin cookie, el del
 * aula (`i18n/request.ts`), como el resto del sitio.
 */
export default async function SitioNotFound() {
  const t = await getTranslations('publicSite.siteNotFound');
  return (
    <main style={{ padding: '4rem 1.5rem', maxWidth: '36rem', margin: '0 auto' }}>
      <h1>{t('title')}</h1>
      <p>{t('body')}</p>
    </main>
  );
}
