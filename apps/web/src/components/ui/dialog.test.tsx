// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El fondo de los modales no puede ser un segundo control con el mismo nombre
 * que el cierre del propio diálogo.
 *
 * Lo que pasaba: el fondo era un `<button aria-label="Cerrar">` a pantalla
 * completa. Con la X del diálogo eso daba DOS botones «Cerrar» (y en «Nuevo
 * espacio», donde el fondo se llamaba como el botón del pie, dos «Cancelar»).
 * Un lector de pantalla los anunciaba los dos y los E2E de espacios y del
 * calendario de clases fallaban por ambigüedad.
 *
 * Se pinta de verdad (react-dom + catálogos reales) y se mira lo que vería un
 * lector: los botones que no cuelgan de nada `aria-hidden`.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/messages/es';
import { CreateSpaceModal } from '@/components/create-space-modal';
import { Dialog, DialogContent } from './dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

async function render(node: ReactNode): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="es-ES" messages={es as never} timeZone="UTC">
        {node}
      </NextIntlClientProvider>,
    );
  });
}

function hiddenFromScreenReaders(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

/** Nombre accesible simplificado: `aria-label` o, si no hay, el texto. */
function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

/** Los botones que anuncia un lector de pantalla con ese nombre. */
function announcedButtons(name: string): Element[] {
  return [...document.body.querySelectorAll('button, [role="button"]')].filter(
    (b) => !hiddenFromScreenReaders(b) && accessibleName(b) === name,
  );
}

function backdrop(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[data-testid="dialog-backdrop"]');
  if (!el) throw new Error('el modal no tiene fondo');
  return el;
}

describe('fondo de los modales', () => {
  it('diálogo con título: un solo «Cerrar» anunciado y el fondo cierra con el ratón', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange} title="Añadir al calendario">
        <p>Contenido</p>
      </Dialog>,
    );

    expect(announcedButtons('Cerrar')).toHaveLength(1);
    expect(backdrop().getAttribute('aria-hidden')).toBe('true');
    expect(backdrop().tagName).not.toBe('BUTTON');

    await act(async () => backdrop().click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('diálogo compuesto (DialogContent): un solo «Cerrar» anunciado', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <p>Contenido</p>
        </DialogContent>
      </Dialog>,
    );

    expect(announcedButtons('Cerrar')).toHaveLength(1);
    await act(async () => backdrop().click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('«Nuevo espacio»: un solo «Cancelar», el del pie, y el fondo sigue cerrando', async () => {
    const onClose = vi.fn();
    await render(<CreateSpaceModal open onClose={onClose} />);

    const cancelar = announcedButtons('Cancelar');
    expect(cancelar).toHaveLength(1);
    expect(cancelar[0]!.closest('[role="dialog"]')).not.toBeNull();

    await act(async () => backdrop().click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
