/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import { accessChoiceFrom, accessChoiceToIds } from '@/lib/access-levels';
import { AccessLevelsField } from './access-levels-field';
import { AccessLevelsBadge, LockedByLevel } from './locked-by-level';

/**
 * Espacios y directos por nivel de membresía, en la web: la elección del
 * creador («Todos los miembros» / «Solo estos niveles») y lo que ve quien no
 * tiene el nivel (nombre, candado, niveles y botón a /join; nada más).
 */

const PRO = { id: '11111111-1111-4111-8111-111111111111', name: 'Pro' };
const VIP = { id: '22222222-2222-4222-8222-222222222222', name: 'VIP' };

function render(node: React.ReactNode, messages = es, locale: 'es-ES' | 'pt-BR' = 'es-ES') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('accessChoiceFrom / accessChoiceToIds', () => {
  it('lista vacía = todos; con ids = solo esos niveles', () => {
    expect(accessChoiceFrom([])).toEqual({ mode: 'all' });
    expect(accessChoiceFrom(undefined)).toEqual({ mode: 'all' });
    expect(accessChoiceFrom([PRO.id])).toEqual({ mode: 'levels', ids: [PRO.id] });
  });

  it('«Todos» manda []; «Solo estos» manda los marcados que existen, sin repetir', () => {
    expect(accessChoiceToIds({ mode: 'all' }, [PRO])).toEqual([]);
    expect(accessChoiceToIds({ mode: 'levels', ids: [PRO.id, PRO.id] }, [PRO, VIP])).toEqual([
      PRO.id,
    ]);
  });

  it('«Solo estos» sin ninguno (o solo con niveles borrados) está a medias: null', () => {
    expect(accessChoiceToIds({ mode: 'levels', ids: [] }, [PRO])).toBeNull();
    expect(accessChoiceToIds({ mode: 'levels', ids: ['borrado'] }, [PRO])).toBeNull();
  });
});

describe('AccessLevelsField', () => {
  it('pinta las dos opciones y, con «Solo estos niveles», una casilla por nivel', () => {
    const html = render(
      <AccessLevelsField
        idPrefix="x"
        value={{ mode: 'levels', ids: [PRO.id] }}
        onChange={() => {}}
        options={[PRO, VIP]}
      />,
    );
    expect(html).toContain('Quién puede verlo');
    expect(html).toContain('Todos los miembros');
    expect(html).toContain('Solo estos niveles');
    expect(html).toContain('>Pro<');
    expect(html).toContain('>VIP<');
    expect(html).toMatch(/id="x-nivel-11111111[^"]*"[^>]*checked/);
  });

  it('sin niveles en el aula: solo «Todos» y la frase que lo explica', () => {
    const html = render(
      <AccessLevelsField idPrefix="x" value={{ mode: 'all' }} onChange={() => {}} options={[]} />,
    );
    expect(html).toContain('Todavía no tienes niveles de membresía');
    expect(html).toMatch(/id="x-niveles"[^>]*disabled/);
  });

  it('a medias y al guardar: «Marca al menos un nivel»', () => {
    const html = render(
      <AccessLevelsField
        idPrefix="x"
        value={{ mode: 'levels', ids: [] }}
        onChange={() => {}}
        options={[PRO]}
        showIncomplete
      />,
    );
    expect(html).toContain('Marca al menos un nivel.');
  });
});

describe('LockedByLevel', () => {
  it('nombre, candado, «Disponible en» y botón a /join', () => {
    const html = render(<LockedByLevel kind="space" title="Sala Pro" levels={[PRO, VIP]} />);
    expect(html).toContain('Sala Pro');
    expect(html).toContain('Este espacio es solo para algunos niveles');
    expect(html).toContain('Disponible en: Pro, VIP');
    expect(html).toContain('href="/join"');
    expect(html).toContain('Ver planes');
  });

  it('sin niveles vivos: lo dice sin nombres; y en portugués habla de «assinatura»', () => {
    expect(render(<LockedByLevel kind="live" title="Clase" levels={[]} />)).toContain(
      'Disponible en otros niveles de la membresía.',
    );
    const ptHtml = render(<LockedByLevel kind="live" title="Aula" levels={[PRO]} />, pt, 'pt-BR');
    expect(ptHtml).toContain('Esta aula é só para alguns níveis da assinatura.');
    expect(ptHtml).toContain('Disponível em: Pro');
  });

  it('la marca del panel del creador solo sale si hay niveles', () => {
    expect(render(<AccessLevelsBadge groupIds={[]} levels={[]} />)).toBe('');
    expect(render(<AccessLevelsBadge groupIds={[PRO.id]} levels={[PRO]} />)).toContain(
      'Solo para: Pro',
    );
  });
});
