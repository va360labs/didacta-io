import { describe, expect, it } from 'vitest';
import { nextFocusTarget } from './use-focus-trap';

/**
 * El ciclo del tabulador dentro de un diálogo modal (LMS-122).
 *
 * Antes no había ninguno: los diálogos del aula se anunciaban como
 * `aria-modal="true"` y dejaban el foco en la página de detrás, así que el
 * tabulador recorría controles que el overlay estaba tapando.
 */
describe('nextFocusTarget', () => {
  it('en medio de la lista no interviene: el navegador ya hace lo correcto', () => {
    expect(nextFocusTarget(5, 2, false)).toBeNull();
    expect(nextFocusTarget(5, 2, true)).toBeNull();
  });

  it('Tab en el último vuelve al primero', () => {
    expect(nextFocusTarget(5, 4, false)).toBe('first');
  });

  it('Shift+Tab en el primero salta al último', () => {
    expect(nextFocusTarget(5, 0, true)).toBe('last');
  });

  it('Tab en el primero sigue hacia dentro; Shift+Tab en el último también', () => {
    expect(nextFocusTarget(5, 0, false)).toBeNull();
    expect(nextFocusTarget(5, 4, true)).toBeNull();
  });

  it('con un solo elemento enfocable, el foco se queda en él en las dos direcciones', () => {
    expect(nextFocusTarget(1, 0, false)).toBe('first');
    expect(nextFocusTarget(1, 0, true)).toBe('last');
  });

  it('sin nada enfocable dentro, el foco se queda en el panel y no escapa al fondo', () => {
    expect(nextFocusTarget(0, -1, false)).toBe('panel');
    expect(nextFocusTarget(0, -1, true)).toBe('panel');
  });

  it('si el foco se escapó fuera del panel, el siguiente Tab lo trae de vuelta', () => {
    expect(nextFocusTarget(5, -1, false)).toBe('first');
    expect(nextFocusTarget(5, -1, true)).toBe('last');
  });
});
