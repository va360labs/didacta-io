'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, type RefObject } from 'react';

/**
 * Gestión de foco para un diálogo modal (LMS-122).
 *
 * Los diálogos del aula ya declaraban `role="dialog"`, `aria-modal="true"` y
 * cierre con Escape, pero el foco se quedaba donde estaba: detrás del diálogo,
 * en la página que el overlay acaba de tapar. Con teclado o lector de pantalla
 * eso significa que al abrir un modal no pasa nada audible, que el tabulador
 * recorre los controles del fondo —que el usuario no ve— y que al cerrar el
 * punto de partida se ha perdido. Es lo que exigen tanto la WAI-ARIA APG como
 * los requisitos de accesibilidad y diseño universal que pide Fundae.
 *
 * Hace las tres cosas que faltaban:
 *
 *   1. Al abrir, lleva el foco DENTRO: a lo que el diálogo marque con
 *      `data-autofocus`, y si no marca nada, al propio panel — que para eso
 *      necesita `tabIndex={-1}`, responsabilidad de quien lo llama.
 *   2. Mientras está abierto, el tabulador CICLA dentro: Tab en el último
 *      vuelve al primero y Shift+Tab en el primero salta al último.
 *   3. Al cerrar, DEVUELVE el foco al elemento que abrió el diálogo. Se guarda
 *      el `activeElement` del momento de abrir, no el de montar: un diálogo
 *      controlado se monta antes de abrirse.
 *
 * Se apoya en la lista de enfocables recalculada en cada Tab, y no en una
 * cacheada al abrir, porque el contenido de estos diálogos cambia mientras
 * están abiertos (un formulario que revela campos, una lista que carga).
 */

/**
 * Selector de «enfocable». `:not([disabled])` descarta los controles apagados y
 * `tabindex="-1"` queda fuera a propósito: es enfocable por programa, pero no
 * forma parte del recorrido del tabulador y meterlo rompería el ciclo.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/**
 * A dónde va el foco al pulsar Tab dentro de un diálogo, o `null` si no hay que
 * intervenir (el navegador ya lo lleva bien al elemento siguiente).
 *
 * Va suelta y sin tocar el DOM para poder probar el ciclo —que es la parte con
 * casos límite— sin montar un navegador: lista vacía, foco escapado fuera del
 * panel, y los dos extremos en las dos direcciones.
 *
 * @param count          Cuántos elementos enfocables hay ahora mismo dentro.
 * @param currentIndex   Posición del que tiene el foco, o -1 si está fuera.
 * @param shiftKey       ¿Shift+Tab?
 * @returns `'first'` | `'last'` | `'panel'` (no hay enfocables) | `null`.
 */
export function nextFocusTarget(
  count: number,
  currentIndex: number,
  shiftKey: boolean,
): 'first' | 'last' | 'panel' | null {
  // Sin nada enfocable dentro, el tabulador no tiene a dónde ir: se queda en el
  // panel en lugar de escaparse a la página de detrás, que está tapada.
  if (count === 0) return 'panel';
  // Foco fuera del panel (se escapó por un clic al fondo antes de que llegara el
  // overlay): el siguiente Tab lo trae de vuelta, en vez de seguir fuera.
  const outside = currentIndex < 0;
  if (shiftKey) return currentIndex === 0 || outside ? 'last' : null;
  return currentIndex === count - 1 || outside ? 'first' : null;
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // `offsetParent === null` descarta lo oculto con display:none y lo que está
    // dentro de una sección colapsada; comprobar `hidden` cubre el resto.
    (el) =>
      !el.hasAttribute('hidden') && (el.offsetParent !== null || el === document.activeElement),
  );
}

export function useFocusTrap(panelRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Quién tenía el foco ANTES de abrir: es a quien hay que devolvérselo.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // El foco inicial se pide en el siguiente frame: el panel acaba de
    // montarse y su contenido (un input que se renderiza condicionalmente,
    // p. ej.) puede no estar todavía en el DOM.
    const raf = requestAnimationFrame(() => {
      // Orden: lo que el diálogo marque, y si no marca nada, el PANEL — no su
      // primer control. Enfocar el primer control hace que el lector anuncie
      // «Cerrar, botón» en lugar del diálogo, y en un modal lo primero que hay
      // que oír es dónde has entrado. Desde el panel, un Tab lleva al primer
      // control (ver `nextFocusTarget`), así que no se pierde nada.
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? panel).focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // La lista se recalcula en CADA Tab, no se cachea al abrir: el contenido
      // de estos diálogos cambia mientras están abiertos (un formulario que
      // revela campos, una lista que termina de cargar).
      const focusables = focusableWithin(panel);
      const current = document.activeElement as HTMLElement | null;
      const target = nextFocusTarget(
        focusables.length,
        current ? focusables.indexOf(current) : -1,
        e.shiftKey,
      );
      if (target === null) return;
      e.preventDefault();
      if (target === 'panel') panel.focus();
      else if (target === 'first') focusables[0]!.focus();
      else focusables[focusables.length - 1]!.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      // Solo se devuelve el foco si sigue vivo y en la página: si el disparador
      // se desmontó con el diálogo (un botón de una fila que se borra),
      // enfocarlo no haría nada y el foco quedaría en <body>.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [panelRef, active]);
}
