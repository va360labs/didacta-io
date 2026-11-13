'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { modernizeUrl } from './legacy-routes';

/**
 * Si la URL trae algo de antes en español (un valor de `?tab=`, una clave o
 * un valor de query, un ancla), la cambia por la de ahora sin entrada nueva
 * en el historial. La pantalla ya pinta lo correcto con el valor viejo
 * (`modernTab`); esto solo deja la barra de direcciones en inglés.
 *
 * `search`: la query que ve la pantalla, para volver a mirar cuando cambia sin
 * cambiar de ruta (un enlace guardado a `/admin?tab=negocio` pulsado desde el
 * propio panel). `extra`: valores de pestaña de antes que declaran los
 * módulos; tiene que ser una referencia estable.
 */
export function useModernUrl(
  options: { search?: string | null; extra?: Readonly<Record<string, string>> } = {},
): void {
  const router = useRouter();
  const pathname = usePathname();
  const { search, extra } = options;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // El ancla de antes no casaba con ningún `id`: el navegador no bajó. Se baja
    // en cuanto la sección aparezca (puede llegar con los datos de la API).
    function scrollTo(id: string, tries = 0) {
      if (cancelled) return;
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ block: 'start' });
      else if (tries < 40) timer = setTimeout(() => scrollTo(id, tries + 1), 150);
    }

    function modernize() {
      const { pathname: path, search: query, hash } = window.location;
      const href = modernizeUrl(path, query, hash, extra);
      if (!href) return;
      const [withoutHash, anchor = ''] = href.split('#');
      if (withoutHash === `${path}${query}`) {
        window.history.replaceState(window.history.state, '', href);
      } else {
        router.replace(href as never, { scroll: false });
      }
      if (anchor && `#${anchor}` !== hash) scrollTo(anchor);
    }

    modernize();
    window.addEventListener('hashchange', modernize);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('hashchange', modernize);
    };
  }, [pathname, search, extra, router]);
}
