'use client';

import { useEffect } from 'react';
import { fetchTenantContext } from '@/lib/tenant-context';

/**
 * "Didacta" nunca va solo en el título del navegador: siempre acompañado del
 * nombre del tenant ("Iniciar sesión | VA360 powered by Didacta").
 *
 * El nombre del tenant se resuelve por dominio contra la API, así que el
 * servidor no lo conoce al generar el `metadata` estático (haría dinámica toda
 * la app por un `headers()`). Este componente vive en el root layout, resuelve
 * el tenant una vez y reescribe el sufijo del `<title>` en cuanto lo sabe.
 *
 * Se usa un MutationObserver porque Next reescribe el `<title>` en cada
 * navegación del App Router (con el template `%s | Didacta` del layout raíz):
 * sin observar, el sufijo correcto solo duraría hasta el siguiente cambio de
 * ruta. La reescritura es idempotente — si el título ya lleva el sufijo del
 * tenant no se toca, así que el propio `document.title = …` no realimenta el
 * bucle.
 */
const BRAND = 'Didacta';
const PLAIN_SUFFIX = ` | ${BRAND}`;

/** Exportada para poder testear la regla sin DOM. */
export function withTenantBrand(title: string, tenantName: string): string {
  const name = tenantName.trim();
  // Un tenant que se llame igual que la plataforma no necesita el sufijo
  // ("Didacta powered by Didacta" no es un título, es un trabalenguas).
  if (!name || name === BRAND) return title;
  const branded = `${name} powered by ${BRAND}`;
  if (title.includes(branded)) return title;
  if (title === BRAND) return branded;
  if (title.endsWith(PLAIN_SUFFIX)) {
    return `${title.slice(0, -PLAIN_SUFFIX.length)} | ${branded}`;
  }
  return title;
}

export function TenantTitle() {
  useEffect(() => {
    let cancelled = false;
    let observer: MutationObserver | null = null;

    void fetchTenantContext().then((ctx) => {
      const name = ctx.tenant?.name;
      if (cancelled || !name) return;

      const apply = () => {
        const next = withTenantBrand(document.title, name);
        if (next !== document.title) document.title = next;
      };
      apply();

      // `head` en vez del `<title>` concreto: Next puede sustituir el nodo
      // entero al navegar, y un observer atado al nodo viejo se quedaría mudo.
      observer = new MutationObserver(apply);
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, []);

  return null;
}
