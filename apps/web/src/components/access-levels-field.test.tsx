// @vitest-environment jsdom
/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { AccessChoice } from '@/lib/access-levels';
import { AccessLevelsField } from './access-levels-field';

/**
 * «Quién puede verlo», con clics de verdad: al pasar a «Solo estos niveles»
 * salen TODOS marcados (un nivel no incluye a otro) y debajo lo dice la nota.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASICO = { id: '11111111-1111-4111-8111-111111111111', name: 'Básico' };
const PRO = { id: '22222222-2222-4222-8222-222222222222', name: 'Pro' };

let container: HTMLDivElement;
let root: Root;
let last: AccessChoice | null;

function Harness({ initial }: { initial: AccessChoice }) {
  const [value, setValue] = useState<AccessChoice>(initial);
  return (
    <AccessLevelsField
      idPrefix="e"
      value={value}
      onChange={(next) => {
        last = next;
        setValue(next);
      }}
      options={[BASICO, PRO]}
    />
  );
}

function mount(
  initial: AccessChoice,
  messages = es,
  locale: 'es-ES' | 'en-US' | 'pt-BR' = 'es-ES',
) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <Harness initial={initial} />
      </NextIntlClientProvider>,
    );
  });
}

const checkbox = (id: string) => container.querySelector<HTMLInputElement>(`#e-nivel-${id}`)!;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  last = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AccessLevelsField — pasar a «Solo estos niveles»', () => {
  it('marca TODOS los niveles y enseña la nota', () => {
    mount({ mode: 'all' });
    expect(container.querySelector('[data-testid="e-nota-niveles"]')).toBeNull();
    act(() => {
      container.querySelector<HTMLInputElement>('#e-niveles')!.click();
    });
    expect(last).toEqual({ mode: 'levels', ids: [BASICO.id, PRO.id] });
    expect(checkbox(BASICO.id).checked).toBe(true);
    expect(checkbox(PRO.id).checked).toBe(true);
    expect(container.querySelector('[data-testid="e-nota-niveles"]')!.textContent).toBe(
      'Un nivel no incluye a otro: marca todos los que deben verlo.',
    );
  });

  it('desmarcar uno deja solo el otro (la elección sigue siendo del creador)', () => {
    mount({ mode: 'all' });
    act(() => {
      container.querySelector<HTMLInputElement>('#e-niveles')!.click();
    });
    act(() => {
      checkbox(BASICO.id).click();
    });
    expect(last).toEqual({ mode: 'levels', ids: [PRO.id] });
  });

  it('un espacio que YA estaba restringido conserva sus niveles al abrirlo', () => {
    mount({ mode: 'levels', ids: [PRO.id] });
    expect(checkbox(BASICO.id).checked).toBe(false);
    expect(checkbox(PRO.id).checked).toBe(true);
    expect(last).toBeNull();
  });

  it('la nota también en inglés y en portugués', () => {
    mount({ mode: 'levels', ids: [PRO.id] }, en, 'en-US');
    expect(container.textContent).toContain(
      "One level doesn't include another: tick every level that should see it.",
    );
    act(() => root.unmount());
    root = createRoot(container);
    mount({ mode: 'levels', ids: [PRO.id] }, pt, 'pt-BR');
    expect(container.textContent).toContain(
      'Um nível não inclui outro: marque todos os que devem ver.',
    );
  });
});
