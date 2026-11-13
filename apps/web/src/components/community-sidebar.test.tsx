// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La tarjeta de la academia de /community pintada de verdad (react-dom a
 * pelo, con los catálogos reales): con y sin cada dato de presentación
 * (portada, descripción, enlaces). Un dato que falta no deja hueco.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import type { CommunitySidebar } from '@/modules/community';
import { AcademyCard } from './community-sidebar';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function data(academy: Partial<CommunitySidebar['academy']> = {}): CommunitySidebar {
  return {
    academy: {
      name: 'Morning Pour',
      logoUrl: '/api/v1/modules/theming/tenants/t/logo?v=1',
      logoDisplayMode: 'logo_and_name',
      coverUrl: null,
      description: null,
      host: null,
      links: [],
      ...academy,
    },
    members: { total: 3, admins: 1, online: null, faces: [] },
    leaderboard: null,
    recentComments: [],
    canManage: false,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(d: CommunitySidebar) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en-US" messages={en} timeZone="Europe/Madrid">
        <AcademyCard data={d} />
      </NextIntlClientProvider>,
    );
  });
}

const q = (sel: string) => host.querySelector(sel);

describe('tarjeta de la academia', () => {
  it('sin portada, descripción ni enlaces: la banda de color y nada más', () => {
    render(data());
    expect(q('[data-testid="academy-cover"]')).toBeNull();
    expect(q('[data-testid="academy-description"]')).toBeNull();
    expect(q('[data-testid="academy-links"]')).toBeNull();
    // La banda con el logo sobre el color del aula.
    expect(host.innerHTML).toContain('var(--color-brand-100)');
    expect(host.textContent).toContain('Morning Pour');
  });

  it('con portada: la imagen sustituye a la banda y el logo queda encima', () => {
    render(data({ coverUrl: '/api/v1/modules/theming/tenants/t/cover?v=2' }));
    const cover = q('[data-testid="academy-cover"]') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('/api/v1/modules/theming/tenants/t/cover?v=2');
    expect(host.innerHTML).not.toContain('var(--color-brand-100)');
    // El logo sigue, superpuesto a la portada.
    const logo = cover.parentElement!.querySelector('img[src*="/logo"]');
    expect(logo).not.toBeNull();
  });

  it('con descripción: se pinta tal cual (texto, no HTML)', () => {
    render(data({ description: 'Home baristas <b>learning</b> together.' }));
    const p = q('[data-testid="academy-description"]')!;
    expect(p.textContent).toBe('Home baristas <b>learning</b> together.');
    expect(p.querySelector('b')).toBeNull();
  });

  it('con enlaces: icono de su red, pestaña nueva sin opener ni referrer', () => {
    render(
      data({
        links: [
          { kind: 'instagram', url: 'https://instagram.com/' },
          { kind: 'whatsapp', url: 'https://wa.me/' },
          { kind: 'web', url: 'https://www.morningpour.example.com/' },
        ],
      }),
    );
    const as = [...host.querySelectorAll('[data-testid="academy-links"] a')];
    expect(as.map((a) => a.getAttribute('href'))).toEqual([
      'https://instagram.com/',
      'https://wa.me/',
      'https://www.morningpour.example.com/',
    ]);
    for (const a of as) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.querySelector('svg')).not.toBeNull();
    }
    expect(as.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Instagram (opens in a new tab)',
      'WhatsApp (opens in a new tab)',
      'morningpour.example.com (opens in a new tab)',
    ]);
    expect(as.map((a) => a.getAttribute('data-kind'))).toEqual(['instagram', 'whatsapp', 'web']);
  });
});
